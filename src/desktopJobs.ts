import { ProcessWorker, type WorkerLike } from './jobs/processWorker';
import { isRecordTable } from '@world/buildings/recordTable';

/** THE DESKTOP'S JOB PROCESSES: the long-running job workers (the tiles' maker, the growth) in utility processes of the shell (`desktop/jobs.cjs`), each process a V8 cage of its own, so a 20 km map's tile workers no longer fill the page's (V8 pointer compression: one cage a process, the page and its workers sharing it); none in a browser */

interface JobsBridge { connectJobs(): void }

/** The window messages the preload hands on (`desktop/preload.cjs`): a thread's port, and a process stopped (its threads' ports dead). */
interface PortMessage { readonly roadcraftJobsPort: number }
interface LostMessage { readonly roadcraftJobsLost: number }
const isPortMessage = (data: unknown): data is PortMessage => typeof (data as PortMessage | null)?.roadcraftJobsPort === 'number';
const isLostMessage = (data: unknown): data is LostMessage => typeof (data as LostMessage | null)?.roadcraftJobsLost === 'number';

/** What makes the pool's workers on the desktop (`jobPool.ts` setJobWorkerMaker): a worker in a job process for the long side, none (the page's own) for the short; null where the page has no desktop shell, or one without job processes. */
export function desktopJobWorkers(): ((long: boolean) => WorkerLike | null) | null {
  const bridge = (window as unknown as { roadcraftDesktop?: Partial<JobsBridge> }).roadcraftDesktop;
  if (!bridge || typeof bridge.connectJobs !== 'function') return null;
  const connect = (): void => bridge.connectJobs!();
  // Each port asked is handed the next that comes, in order (the shell answers each `connectJobs` with one), with the process it is in.
  const asked: ((port: MessagePort, process: number) => void)[] = [];
  const living = new Map<number, Set<ProcessWorker>>();
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (isPortMessage(event.data) && event.ports[0]) { asked.shift()?.(event.ports[0], event.data.roadcraftJobsPort); return; }
    // A process stopped: each of its workers fails as a worker does (the pool gives their jobs to others, `jobPool.ts` failHost).
    if (isLostMessage(event.data)) {
      const workers = living.get(event.data.roadcraftJobsLost);
      living.delete(event.data.roadcraftJobsLost);
      for (const worker of workers ?? []) worker.fail('the job process stopped');
    }
  });
  return (long) => {
    if (!long) return null;
    let made: ProcessWorker | null = null;
    made = new ProcessWorker(() => new Promise<MessagePort>((resolve) => {
      asked.push((port, process) => {
        let set = living.get(process);
        if (!set) living.set(process, set = new Set());
        if (made) set.add(made);
        resolve(port);
      });
      connect();
    }), isRecordTable);
    return made;
  };
}
