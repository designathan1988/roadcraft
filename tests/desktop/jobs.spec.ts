import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { MessageChannel, type MessagePort as NodePort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessWorker, unshared } from '@/jobs/processWorker';
import { desktopJobWorkers } from '@/desktopJobs';

/** THE DESKTOP'S JOB PROCESSES: a long job worker's messages as another process can take them (`src/jobs/processWorker.ts`), and the process's bridge from the page's port to a thread of its own (`desktop/jobs.cjs`) */

/** A port of the shell's (`MessagePortMain`): its messages as `{ data, ports }`, `start`, `close`. */
interface MainPort { on(event: string, listener: (...args: never[]) => void): void; postMessage(data: unknown): void; start(): void }
const { serve } = createRequire(import.meta.url)('../../desktop/jobs.cjs') as { serve(page: MainPort, host: string): void };
const ECHO = fileURLToPath(new URL('./support/echoThread.cjs', import.meta.url));

/** The page's end as the job process sees it: what the test sends comes as the shell's messages do; what the process posts back is kept. */
function pageEnd(): { readonly port: MainPort; send(data: unknown, ports?: MainPort[]): void; readonly got: unknown[]; next(): Promise<unknown> } {
  const events = new EventEmitter();
  const got: unknown[] = [];
  const waiting: ((value: unknown) => void)[] = [];
  const port: MainPort = {
    on: (event, listener) => { events.on(event, listener as (...args: unknown[]) => void); },
    postMessage: (data) => { const w = waiting.shift(); if (w) w(data); else got.push(data); },
    start: () => {},
  };
  return {
    port, got,
    send: (data, ports = []) => events.emit('message', { data, ports }),
    next: () => (got.length ? Promise.resolve(got.shift()) : new Promise((done) => waiting.push(done))),
  };
}

/** A port of the shell's over a Node channel: the other end held by the test. */
function mainPortPair(): { readonly main: MainPort; readonly other: NodePort } {
  const { port1, port2 } = new MessageChannel();
  const events = new EventEmitter();
  port1.on('message', (data) => events.emit('message', { data, ports: [] }));
  return { main: { on: (e, l) => { events.on(e, l as (...args: unknown[]) => void); }, postMessage: (d) => port1.postMessage(d), start: () => {} }, other: port2 };
}

const closers: (() => void)[] = [];
afterEach(() => { for (const close of closers.splice(0)) close(); });

describe("a long job worker's message to another process", () => {
  it('has every shared buffer copied, once however often named, and keeps what is not shared as it is', () => {
    const shared = new SharedArrayBuffer(16);
    new Float64Array(shared)[1] = 42;
    const plain = { n: 3, list: [1, 2], buffer: new ArrayBuffer(8) };
    expect(unshared(plain)).toBe(plain);
    const message = { far: { ground: { plates: new Map([[7, shared]]) } }, view: new Float64Array(shared, 8, 1), again: shared, plain };
    const out = unshared(message);
    const copy = out.far.ground.plates.get(7)!;
    expect(copy).toBeInstanceOf(ArrayBuffer);
    expect(copy).not.toBeInstanceOf(SharedArrayBuffer);
    expect(new Float64Array(copy)[1]).toBe(42);
    expect(out.again).toBe(copy);
    expect(out.view.buffer).toBe(copy);
    expect(out.view[0]).toBe(42);
    expect(out.plain).toBe(plain);
    // The copy is the bytes now: the page writing the plate after does not reach it.
    new Float64Array(shared)[1] = 7;
    expect(new Float64Array(copy)[1]).toBe(42);
    expect(() => structuredClone(out)).not.toThrow();
  });

  it('is held until its port comes, then sent in order; the thread failing is told as a worker error', async () => {
    let give: ((port: MessagePort) => void) | null = null;
    const worker = new ProcessWorker(() => new Promise((done) => { give = done; }));
    worker.postMessage({ k: 1 });
    worker.postMessage({ k: 2 });
    const { port1, port2 } = new MessageChannel();
    closers.push(() => { port1.close(); port2.close(); });
    const seen: unknown[] = [];
    // Both held messages come once the port is given: waited for, not for a time.
    const both = new Promise<void>((done) => port2.on('message', (data) => { seen.push(data); if (seen.length === 2) done(); }));
    give!(port1 as unknown as MessagePort);
    await both;
    expect(seen).toEqual([{ k: 1 }, { k: 2 }]);
    const failed = new Promise<string>((done) => { worker.onerror = (event) => done(event.message); });
    port2.postMessage({ threadFailed: 'the job thread stopped (1)' });
    expect(await failed).toBe('the job thread stopped (1)');
    // Nothing sent to a failed worker: its port closed, the message dropped where it is posted.
    worker.postMessage({ k: 3 });
    await Promise.resolve();
    expect(seen).toHaveLength(2);
  });
});

describe("a job process's thread", () => {
  it("is posted what the page sends, and the page what it posts", async () => {
    const page = pageEnd();
    serve(page.port, ECHO);
    page.send({ port: 3, service: 'growth', data: { i: 1, j: 2, bytes: new Uint8Array([1, 2, 3]) } });
    const answer = (await page.next()) as { echo: { data: { bytes: Uint8Array } } };
    expect(answer.echo.data.bytes).toEqual(new Uint8Array([1, 2, 3]));
    page.send({ crash: true });
    expect(await page.next()).toEqual({ threadFailed: 'the thread was told to fail' });
  });

  it("is handed a port in a message as a port of its own (the store's), both ways", async () => {
    const page = pageEnd();
    serve(page.port, ECHO);
    const store = mainPortPair();
    closers.push(() => store.other.close());
    const fromThread = new Promise((done) => store.other.once('message', done));
    page.send({ storeSetup: true, port: null }, [store.main]);
    expect(await fromThread).toEqual({ hello: 'from the thread' });
    store.other.postMessage({ answer: 9 });
    expect(await page.next()).toEqual({ onPort: { answer: 9 } });
    page.send({ crash: true });
    await page.next();
  });
});

describe('the pool of a browser and of the desktop', () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  /** A window as the page has one: its messages' listeners, and the shell's calls when there is a shell. */
  const windowWith = (desktop?: object): unknown => ({ addEventListener: () => {}, ...(desktop ? { roadcraftDesktop: desktop } : {}) });

  it('in a browser (no shell, or a shell with no job processes) makes no worker of its own: the pool makes its workers as ever', () => {
    vi.stubGlobal('window', windowWith());
    expect(desktopJobWorkers()).toBeNull();
    vi.stubGlobal('window', windowWith({ connectSaves: () => {} }));
    expect(desktopJobWorkers()).toBeNull();
    // The page sets the pool's maker only where there is one (`main.ts`), and the pool falls back on its own Worker (`jobPool.ts` grow).
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toMatch(/const desktopJobs = desktopJobWorkers\(\);\s*if \(desktopJobs\) setJobWorkerMaker\(/);
    expect(readFileSync('src/jobs/jobPool.ts', 'utf8')).toMatch(/const made = system\.makeWorker\?\.\(long\) \?\? null;[\s\S]*?const worker = made \?\? new Worker\(/);
  });

  it('on the desktop puts the long side in a job process, the short side on the page', () => {
    let asked = 0;
    vi.stubGlobal('window', windowWith({ connectJobs: () => { asked++; } }));
    const make = desktopJobWorkers()!;
    expect(make(false)).toBeNull();
    expect(asked).toBe(0);
    const long = make(true);
    expect(long).toBeInstanceOf(ProcessWorker);
    expect(asked).toBe(1);
    long!.terminate();
  });
});

