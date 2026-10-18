/** A job thread for the tests (`jobs.spec.ts`): what it is sent posted back; a message with a port answered on it, what comes on that port told back; `crash` throws. */
const { parentPort } = require('node:worker_threads');

parentPort.on('message', (data) => {
  if (data && data.crash) throw new Error('the thread was told to fail');
  if (data && data.port && typeof data.port.on === 'function') {
    data.port.on('message', (message) => parentPort.postMessage({ onPort: message }));
    data.port.postMessage({ hello: 'from the thread' });
    return;
  }
  parentPort.postMessage({ echo: data });
});
