/** THE SAVES' WRITER: a utility process (Electron `utilityProcess`) that keeps the map as plain files in the saves folder Steam Auto-Cloud syncs */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { promisify } = require('node:util');

const gzip = promisify(zlib.gzip);
/** Files open at once: more than libuv's thread pool runs (UV_THREADPOOL_SIZE, 4 by default), far under the open-file limit (Linux 1024 by default). */
const OPEN_FILES = 16;
/** `run(i)` for each i below `count`, OPEN_FILES at a time: DO NOT open a whole map's thousands of files together. */
async function eachLimited(count, run) {
  let next = 0;
  const lane = async () => { for (let i = next++; i < count; i = next++) await run(i); };
  await Promise.all(Array.from({ length: Math.min(OPEN_FILES, count) }, lane));
}

/** A key as a file name: only `[a-z0-9._-]` kept, every other character `%` and its code, so no two keys meet on a case-blind disk (Windows) and none is a reserved name. */
const fileOf = (key) => `k_${key.replace(/[^a-z0-9._-]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}`;
const keyOf = (file) => file.slice(2).replace(/%([0-9a-f]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)));

/** Bytes written and flushed to the disk (an IndexedDB transaction is durable once complete; this is that for one file). */
async function writeDurable(file, bytes) {
  const handle = await fs.promises.open(file, 'w');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const ignoreMissing = (error) => { if (error?.code !== 'ENOENT') throw error; };

/** The store over one saves folder (`main.cjs` `SAVES`); beside it, outside what Steam syncs, the batch being written. */
function createSaves(saves) {
  const staging = `${saves}.staging`;
  const commitFile = path.join(staging, 'commit.json');

  /** The committed batch moved into the saves folder: each rename replaces one file whole; run again after a crash, it finishes what is left. */
  async function apply(commit) {
    for (const [staged, key] of commit.put) await fs.promises.rename(path.join(staging, staged), path.join(saves, fileOf(key))).catch(ignoreMissing);
    for (const key of commit.remove) await fs.promises.unlink(path.join(saves, fileOf(key))).catch(ignoreMissing);
    await fs.promises.rm(staging, { recursive: true, force: true });
  }

  /** A batch cut by a crash: applied when its commit was written, dropped when not (the folder still holds the save before it). */
  async function recover() {
    await fs.promises.mkdir(saves, { recursive: true });
    let commit = null;
    try { commit = JSON.parse(await fs.promises.readFile(commitFile, 'utf8')); } catch (error) { ignoreMissing(error); }
    if (commit) await apply(commit);
    else await fs.promises.rm(staging, { recursive: true, force: true });
  }

  /** Puts and removes as one transaction: every file staged and flushed, then the commit (the point of no return), then the renames. */
  async function write(put, remove) {
    // A batch committed but not yet moved (a rename refused last time) is finished first, never thrown away.
    await recover();
    await fs.promises.mkdir(staging, { recursive: true });
    await eachLimited(put.length, (i) => writeDurable(path.join(staging, String(i)), put[i][1]));
    const commit = { put: put.map(([key], i) => [String(i), key]), remove };
    await writeDurable(`${commitFile}.tmp`, JSON.stringify(commit));
    await fs.promises.rename(`${commitFile}.tmp`, commitFile);
    await apply(commit);
    return true;
  }

  /** A save's batch encoded here, off the page (`save.worker.ts` `writeBatch`: JSON, gzip when `packed`), then written as one transaction. */
  async function writeBatch(batch) {
    const put = [];
    for (const entry of batch.put) {
      const text = JSON.stringify(entry.value);
      put.push([entry.key, entry.packed ? await gzip(text) : Buffer.from(text)]);
    }
    return write(put, batch.remove);
  }

  async function get(keys) {
    const found = keys.map(() => null);
    await eachLimited(keys.length, async (i) => {
      try {
        const bytes = await fs.promises.readFile(path.join(saves, fileOf(keys[i])));
        found[i] = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      } catch (error) {
        ignoreMissing(error);
      }
    });
    return found;
  }

  const keys = async () => (await fs.promises.readdir(saves)).filter((file) => file.startsWith('k_')).map(keyOf);

  /** Every key starting with `prefix` and its bytes, in one request: a world's tile marks (`src/editor/tileBlob.ts` tileMarkKey), never one request a tile. */
  async function marks(prefix) {
    const found = (await keys()).filter((key) => key.startsWith(prefix));
    const bytes = await get(found);
    return found.map((key, i) => [key, bytes[i]]).filter(([, b]) => b !== null);
  }

  // One request at a time, in order, the recovery first: a read sees every write asked before it and never a batch halfway, as in one IndexedDB database.
  let queue = recover().catch((error) => console.error('[saves] the interrupted write could not be finished', error));
  const ops = { get: (r) => get(r.keys), write: (r) => write(r.put, r.remove), batch: (r) => writeBatch(r.batch), keys: () => keys(), marks: (r) => marks(String(r.prefix)) };
  /** Answers a request (`src/desktopSaves.ts`), after every one asked before it. */
  function run(request) {
    const op = Object.hasOwn(ops, request?.op) ? ops[request.op] : null;
    const result = queue.then(() => (op ? op(request) : Promise.reject(new Error(`unknown request ${request?.op}`))));
    queue = result.catch(() => undefined);
    return result;
  }
  /** Resolves once every request asked so far is done (the exit waits for it, `main.cjs` will-quit). */
  const drained = () => queue.then(() => true);
  return { run, drained };
}

// In the utility process: each page gets a port of its own (`main.cjs` `saves:connect`); answers go back by the request's id.
if (process.parentPort) {
  const store = createSaves(process.argv[2]);
  process.parentPort.on('message', (event) => {
    // The game exiting: told once every write asked before is on the disk.
    if (event.data?.op === 'drain') { void store.drained().then(() => process.parentPort.postMessage({ drained: true })); return; }
    const [port] = event.ports;
    if (!port) return;
    port.on('message', ({ data }) => {
      store.run(data).then(
        (result) => port.postMessage({ id: data.id, ok: true, result }),
        (error) => { console.error('[saves]', data?.op, error); port.postMessage({ id: data?.id, ok: false }); },
      );
    });
    port.start();
  });
}

module.exports = { createSaves, fileOf, keyOf };
