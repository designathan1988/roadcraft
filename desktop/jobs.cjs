/** A JOB PROCESS: a utility process (Electron `utilityProcess`) whose threads run the page's long job workers (`src/desktopJobs.ts`), each port from the page a thread of its own (Node `worker_threads`), so their heaps are in this process's V8 cage, not the page's */
const { MessageChannel, Worker } = require('node:worker_threads');

/** Every buffer of its own in `value` (not shared), each once: moved to the thread, not copied a second time. */
function buffersIn(value, out = new Set(), seen = new Set()) {
  if (typeof value !== 'object' || value === null || seen.has(value)) return out;
  seen.add(value);
  if (value instanceof ArrayBuffer) { out.add(value); return out; }
  if (ArrayBuffer.isView(value)) { if (value.buffer instanceof ArrayBuffer) out.add(value.buffer); return out; }
  if (value instanceof Map) { for (const [k, v] of value) { buffersIn(k, out, seen); buffersIn(v, out, seen); } return out; }
  if (value instanceof Set) { for (const v of value) buffersIn(v, out, seen); return out; }
  for (const key of Object.keys(value)) buffersIn(value[key], out, seen);
  return out;
}

/** A port of the shell's (`MessagePortMain`) as a port a thread can hold: a Node channel, each message handed across both ways. */
function threadPort(main) {
  const { port1, port2 } = new MessageChannel();
  main.on('message', ({ data }) => port1.postMessage(data, [...buffersIn(data)]));
  port1.on('message', (data) => main.postMessage(data));
  main.on('close', () => port1.close());
  main.start();
  return port2;
}

/** The page's port to one thread: what comes from the page posted to the thread (a port in it made a thread's, `threadPort`), what the thread posts sent back; the thread's failure said as a message (`src/jobs/processWorker.ts` ThreadFailed). */
function serve(page, host) {
  const thread = new Worker(host);
  let failed = false;
  const fail = (why) => {
    if (failed) return;
    failed = true;
    try { page.postMessage({ threadFailed: why }); } catch (error) { console.error('[jobs] the page could not be told', error); }
  };
  page.on('message', ({ data, ports }) => {
    // A port in the message (the store's, `editor/workerParts.ts`; a lane's, `jobPool.ts` jobChannel): the field that named it given the thread's end.
    const given = ports.map(threadPort);
    const message = given.length && data && typeof data === 'object' ? { ...data, port: given[0] } : data;
    thread.postMessage(message, [...given, ...buffersIn(data)]);
  });
  thread.on('message', (data) => page.postMessage(data));
  thread.on('error', (error) => { console.error('[jobs] a job thread failed', error); fail(error instanceof Error ? error.message : String(error)); });
  thread.on('exit', (code) => fail(`the job thread stopped (${code})`));
  page.on('close', () => { void thread.terminate(); });
  page.start();
}

// In the utility process: each port the shell hands (`main.cjs` jobs:connect) a thread of its own; the threads' code is argv[2].
if (process.parentPort) {
  const host = process.argv[2];
  process.parentPort.on('message', (event) => {
    const [page] = event.ports;
    if (page) serve(page, host);
  });
}

module.exports = { buffersIn, serve, threadPort };
