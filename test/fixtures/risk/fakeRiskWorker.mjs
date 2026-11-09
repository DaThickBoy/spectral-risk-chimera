// Test double for the risk worker protocol (task 12.4). Plain JavaScript, so it runs in a worker
// thread under Vitest without a TypeScript loader. A request whose input names the portfolio
// "crash" throws outside any handler, which ends the worker with an error; every other request is
// answered with a calculation failure, which proves the worker is alive.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (message) => {
  if (typeof message.input === 'string' && message.input.includes('"portfolioId":"crash"')) {
    setImmediate(() => {
      throw new Error('simulated worker crash');
    });
    return;
  }
  parentPort.postMessage({ id: message.id, ok: false, code: 'CALCULATION_ERROR' });
});
