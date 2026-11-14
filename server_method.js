const express = require('express');
const { Sequelize, DataTypes, Op } = require('sequelize');
const Redis = require('ioredis');
const pidusage = require('pidusage');

const app = express();
const port = 3000;

app.use(express.json());

const redis = new Redis({
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

const sequelize = new Sequelize('mydb', 'root', 'password', {
  host: 'localhost',
  dialect: 'mysql',
  logging: false,
  pool: {
    max: 30,
    min: 5,
    acquire: 120000,
    idle: 10000
  }
});


const Movie = sequelize.define('Movie', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  title: DataTypes.STRING,
  description: DataTypes.TEXT,
  release_date: { type: DataTypes.DATEONLY, allowNull: false }
}, { timestamps: false, tableName: 'movies' });

const Review = sequelize.define('Review', {
  id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  movie_id: DataTypes.INTEGER,
  score: DataTypes.INTEGER,
  content: DataTypes.TEXT
}, { timestamps: false, tableName: 'reviews' });

Movie.hasMany(Review, { foreignKey: 'movie_id' });
Review.belongsTo(Movie, { foreignKey: 'movie_id' });

let writesCountInWindow = 0;   
let currentWriteRate = 0;      
let currentAdaptiveTTL = 30;   

setInterval(() => {
  currentWriteRate = parseFloat((writesCountInWindow / 3).toFixed(2));
  writesCountInWindow = 0; 

  const prevTTL = currentAdaptiveTTL;

  if (currentWriteRate < 1.2) {
    currentAdaptiveTTL = 100; 
  } else if (currentWriteRate < 3.8) {
    currentAdaptiveTTL = 60; 
  } else if (currentWriteRate < 8.5) {
    currentAdaptiveTTL = 30; 
  } else if (currentWriteRate < 18.0) {
    currentAdaptiveTTL = 10;  
  } else {
    currentAdaptiveTTL = 2;   
  }

  if (prevTTL !== currentAdaptiveTTL) {
    console.log(`\x1b[36m%s\x1b[0m`, `[АДАПТАЦИЯ] Интенсивность = ${currentWriteRate} зап/сек -> Смена TTL: ${prevTTL}s => ${currentAdaptiveTTL}s`);
  }
}, 3000);

let cacheHits = 0;
let cacheMisses = 0;
let freshResponses = 0;
let staleResponses = 0;
let lastDbWriteTime = 0;

app.get('/movies', async (req, res) => {
  const { start_date, end_date } = req.query;
  const startTime = Date.now();
  const cacheKey = `movies_avg:${start_date}:${end_date}`;

  try {
    const rawCached = await redis.get(cacheKey);

    if (rawCached) {
      cacheHits++;
      const cachedPayload = JSON.parse(rawCached);

      // Проверка актуальности
      if (lastDbWriteTime > cachedPayload.cachedAt) {
        staleResponses++;
      } else {
        freshResponses++;
      }

      const duration = Date.now() - startTime;
      res.set('X-Response-Time', `${duration}ms`);
      res.set('X-Cache', 'HIT');
      return res.json({ executionTime: `${duration}ms`, source: 'Redis', data: cachedPayload.data });
    }

    cacheMisses++;
    freshResponses++;

    const resultMovies = await Movie.findAll({
      attributes: [
        'id', 'title', 'release_date',
        [sequelize.fn('AVG', sequelize.col('Reviews.score')), 'average_score']
      ],
      include: [{ model: Review, attributes: [] }],
      where: { release_date: { [Op.between]: [start_date || '2020-01-01', end_date || '2025-12-31'] } },
      group: ['Movie.id'],
      order: [[sequelize.literal('average_score'), 'DESC']],
      limit: 100,
      subQuery: false,
      raw: true,
    });

    const payloadToCache = {
      cachedAt: Date.now(),
      data: resultMovies
    };

    await redis.set(cacheKey, JSON.stringify(payloadToCache), 'EX', currentAdaptiveTTL);

    const duration = Date.now() - startTime;
    res.set('X-Response-Time', `${duration}ms`);
    res.set('X-Cache', 'MISS');
    res.json({ executionTime: `${duration}ms`, source: 'MySQL', data: resultMovies });

  } catch (error) {
    console.log("!!! ОШИБКА GET:", error.name, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/movies/:id/reviews', async (req, res) => {
  try {
    const { id } = req.params;
    const { score, content } = req.body;

    await Review.create({ movie_id: id, score: score || 10, content: content || 'Test' });

    writesCountInWindow++;
    lastDbWriteTime = Date.now();

    res.status(201).json({ message: 'OK' });
  } catch (error) {
    console.log("!!! ОШИБКА POST:", error.message);
    res.status(500).json({ error: error.message });
  }
});

setInterval(() => {
  const total = cacheHits + cacheMisses;
  const hitRatio = total > 0 ? ((cacheHits / total) * 100).toFixed(2) : 0;
  const totalResponses = freshResponses + staleResponses;
  const freshnessRatio = totalResponses > 0 ? ((freshResponses / totalResponses) * 100).toFixed(2) : 100;

  console.log(`\n===============================================================`);
  console.log(`[СТАТУС] Интенсивность: ${currentWriteRate} зап/с | Текущий TTL: ${currentAdaptiveTTL}s`);
  console.log(`[Критерий 1] Свежесть данных: ${freshnessRatio}% (Свежих: ${freshResponses}, Устаревших: ${staleResponses})`);
  console.log(`[Критерий 2] Hit Ratio: ${hitRatio}% (Хитов: ${cacheHits}, Промахов: ${cacheMisses})`);
  console.log(`===============================================================\n`);
}, 10000);

const server = app.listen(port, () => {
  console.log(`\n>>> АДАПТИВНЫЙ СЕРВЕР ЗАПУЩЕН НА ПОРТУ ${port} <<<\n`);
});
server.timeout = 300000;