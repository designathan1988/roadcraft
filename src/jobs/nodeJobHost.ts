import { parentPort } from 'node:worker_threads';
import { isForgetKept, restoreKept } from './processWorker';

/** A JOB WORKER AS A THREAD OF THE DESKTOP'S JOB PROCESS (`desktop/jobs.cjs`): the page's `job.worker.ts` as it is, its `self` the thread's port (Node `worker_threads` parentPort), built for Node (`scripts/vite/desktop-jobs.config.ts`) */

type Listener = ((event: MessageEvent) => void) | null;

/** The thread's `self` (`job.worker.ts` reads it as a worker's): its listener, and the messages that came before the worker's module set it, handed to it in order once it does. */
class ThreadSelf {
  private listener: Listener = null;
  private readonly early: MessageEvent[] = [];
  /** The buffers the page sent once and names since (`processWorker.ts` KeptBuffer): its record tables. */
  private readonly kept = new Map<number, ArrayBuffer>();

  constructor(private readonly port: NonNullable<typeof parentPort>) {
    port.on('message', (data: unknown) => {
      if (isForgetKept(data)) { for (const id of data.forgetKept) this.kept.delete(id); return; }
      const event = new MessageEvent('message', { data: restoreKept(data, this.kept) });
      if (this.listener) this.listener(event);
      else this.early.push(event);
    });
  }

  get onmessage(): Listener { return this.listener; }
  set onmessage(next: Listener) {
    this.listener = next;
    if (next) for (const event of this.early.splice(0)) next(event);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.port.postMessage(message, transfer as never);
  }
}

if (!parentPort) throw new Error('the job host runs as a thread of a job process');
(globalThis as unknown as { self: ThreadSelf }).self = new ThreadSelf(parentPort);
await import('../job.worker');
