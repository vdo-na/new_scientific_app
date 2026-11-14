const autocannon = require('autocannon');

async function runMixedTest() {
  console.log('===============================================================');
  console.log('>>> ЗАПУСК ТРЕХФАЗНОЙ ВОЛНОВОЙ НАГРУЗКИ (120 СЕКУНД) <<<');
  console.log('Фаза 1 (0–40 с):   Затишье (0.5% записи) -> Ожидаем TTL = 100s');
  console.log('Фаза 2 (40–80 с):  ШКВАЛ ТРАНЗАКЦИЙ (20% записи) -> Ожидаем сжатие TTL до 2s');
  console.log('Фаза 3 (80–120 с): Спад активности (0.5% записи) -> Ожидаем возврат к 60-100s');
  console.log('===============================================================\n');

  const testStartTime = Date.now();

  const instance = autocannon({
    url: 'http://localhost:3000',
    connections: 10,
    duration: 120,
    timeout: 120000,
    requests: [
      {
        setupRequest: (request) => {
          const elapsedSec = (Date.now() - testStartTime) / 1000;

          let writeProbability = 0.005; 

          if (elapsedSec >= 40 && elapsedSec < 80) {
            writeProbability = 0.20; 
          }

          if (Math.random() < writeProbability) {
            const randomMovieId = Math.floor(Math.random() * 100000) + 1;
            request.method = 'POST';
            request.path = `/movies/${randomMovieId}/reviews`;
            request.headers = { 'Content-Type': 'application/json' };
            request.body = JSON.stringify({ 
              score: Math.floor(Math.random() * 10) + 1, 
              content: 'Wave transaction review' 
            });
          } else {
            request.method = 'GET';
            request.path = '/movies?start_date=2025-03-01&end_date=2025-03-20';
            request.headers = {};
            request.body = undefined;
          }

          return request;
        }
      }
    ]
  });

  autocannon.track(instance, { renderProgressBar: true });

  const result = await instance;
  console.log('\n===============================================================');
  console.log('--- ИТОГИ ВОЛНОВОГО ИСПЫТАНИЯ АДАПТИВНОГО МЕТОДА ---');
  console.log(`Среднее время ответа (Avg Latency): ${result.latency.average} ms`);
  console.log(`Пропускная способность (Avg RPS):   ${result.requests.average}`);
  console.log(`Всего выполненных запросов:         ${result.requests.total}`);
  console.log('===============================================================');
}

runMixedTest();