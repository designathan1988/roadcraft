import type { KitBoxes } from './cellArrays';
import { type CellJob, CellWork, replyBuffers } from './cellWork';

/**
 * One worker of the buildings' cells (`cellPool.ts`): the page's messages -
 * a cell to put together, the readings and light slots it asked for, a cell
 * let go - answered by its `CellWork`, each reply's arrays handed over.
 */
type Message =
  | { readonly type: 'init'; readonly boxes: KitBoxes; readonly budget: number }
  | { readonly type: 'start'; readonly job: CellJob }
  | { readonly type: 'readings' | 'slots'; readonly job: number; readonly values: Float64Array }
  | { readonly type: 'release'; readonly cell: string }
  | { readonly type: 'cancel'; readonly job: number };

/** The worker's messages answered by the one `CellWork` it makes on `init`. */
function serve(scope: Worker): void {
  let work: CellWork | null = null;
  scope.onmessage = (event: MessageEvent<Message>) => {
    const message = event.data;
    if (message.type === 'init') { work = new CellWork(message.boxes, message.budget); return; }
    if (message.type === 'release') { work!.release(message.cell); return; }
    if (message.type === 'cancel') { work!.cancel(message.job); return; }
    const job = message.type === 'start' ? message.job.id : message.job;
    try {
      const reply = message.type === 'start' ? work!.start(message.job)
        : message.type === 'readings' ? work!.readings(message.job, message.values) : work!.slots(message.job, message.values);
      scope.postMessage(reply, replyBuffers(reply));
    } catch (error) {
      // Reported to the page, which puts this cell together itself (`cellPool.ts`).
      console.error('[buildings] cell worker', error);
      scope.postMessage({ kind: 'error', job, message: String((error as Error)?.stack ?? error) });
    }
  };
}

serve(self as unknown as Worker);
