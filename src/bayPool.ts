import { jobLanes, jobPort, portWorker } from './jobs/jobPool';
import type { Bay } from '@sim/agents/bay';
import { type LotAsk, shareOf } from '@sim/agents/lotBays';
import type { BayWorkers } from '@sim/agents/parking';

/** THE LOTS' BAYS WORKED OUT ON THE OTHER CORES (`bays.worker.ts`). */
interface Lane {
  readonly worker: Worker;
  readonly waiting: Map<number, { resolve(answer: Bay[][]): void; reject(error: Error): void }>;
  /** When the worker last spoke, or was handed a job (`performance.now()`). */
  heard: number;
  /** Whether this stretch of silence was already said. */
  told: boolean;
}

/** DO NOT take a silent worker for a dead one: it shares the job pool's workers and the CPU share; a failure comes as an error (`onerror`, an `error` answer). */
const SILENCE_MS = 10_000;

/** Most workers the pool opens. */
const MOST_LANES = 4;

export class BayPool implements BayWorkers {
  /** `ports`: the page's lanes for this thread (`jobPool.ts` jobChannel, the simulation's worker): DO NOT open a pool here when given them. None: lanes of this thread's own pool (the page). */
  constructor(private readonly ports: readonly MessagePort[] | null = null) {}

  private lanes: Lane[] | null = null;
  private broken = false;
  private nextId = 1;
  /** The lane the next ask starts on: a few lots asked at a time go round the workers. */
  private turn = 0;

  work(asks: readonly LotAsk[]): Promise<Bay[][]> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no workers in this browser'));
    // Contiguous shares, one a lane: neighbouring lots read the same lanes and walls, copied once a share.
    const per = Math.ceil(asks.length / lanes.length);
    const parts: Promise<Bay[][]>[] = [];
    for (let k = 0; k * per < asks.length; k++) {
      const lane = lanes[(this.turn + k) % lanes.length]!;
      const share = shareOf(asks.slice(k * per, (k + 1) * per));
      const id = this.nextId++;
      parts.push(new Promise<Bay[][]>((resolve, reject) => {
        lane.waiting.set(id, { resolve, reject });
        lane.heard = performance.now();
        lane.worker.postMessage({ id, share });
      }));
    }
    this.turn = (this.turn + parts.length) % lanes.length;
    return Promise.all(parts).then((answers) => answers.flat());
  }

  check(now = performance.now()): void {
    for (const lane of this.lanes ?? []) {
      if (lane.told || !lane.waiting.size || now - lane.heard <= SILENCE_MS) continue;
      // Said once a stretch, and waited for: the page working the lots out itself would stall it.
      lane.told = true;
      console.warn(`[parking] a bays worker has been silent for ${Math.round(now - lane.heard)} ms with lots waiting (busy or without CPU); still waiting`);
    }
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken) return this.lanes;
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const count = this.ports ? this.ports.length : jobLanes(MOST_LANES);
    const lanes: Lane[] = [];
    try {
      for (let k = 0; k < count; k++) {
        const worker = this.ports ? portWorker(this.ports[k]!) : jobPort('bays');
        const lane: Lane = { worker, waiting: new Map(), heard: performance.now(), told: false };
        worker.onmessage = (event: MessageEvent<{ id: number; beat?: true; bays?: Bay[][]; error?: string; laneFailed?: string }>) => {
          if (this.lanes !== lanes) return;
          if (event.data.laneFailed !== undefined) { this.fail(`a bays lane could not load: ${event.data.laneFailed}`); return; }
          // Any word from the worker, a beat or an answer: it is alive.
          lane.heard = performance.now();
          lane.told = false;
          const job = event.data.beat ? undefined : lane.waiting.get(event.data.id);
          if (!job) return;
          lane.waiting.delete(event.data.id);
          if (event.data.bays) job.resolve(event.data.bays);
          else job.reject(new Error(event.data.error ?? 'bays worker failed'));
        };
        worker.onerror = (event) => this.fail(`a bays worker failed: ${event.message}`);
        worker.onmessageerror = () => this.fail('a bays worker sent a message that cannot be read');
        lanes.push(lane);
      }
      this.lanes = lanes;
    } catch (error) {
      console.warn('[parking] the bays workers are unavailable; the lots are worked out on the page', error);
      // The lanes made before the one that failed let go: none is left holding its place on a worker of the job pool.
      for (const lane of lanes) lane.worker.terminate();
      this.broken = true;
      this.lanes = null;
    }
    return this.lanes;
  }

  /** The pool fails: every job waiting on ANY of its workers is rejected */
  private fail(why: string): void {
    if (this.broken) return;
    console.warn(`[parking] ${why}; the lots are worked out on the page`);
    this.broken = true;
    this.end(new Error(why));
  }

  /** The worker serving the page's lanes failed (`jobPool.ts` jobChannel's `lost`): every job waiting on them rejected, the lots worked out here. */
  lanesLost(why: string): void {
    this.fail(why);
  }

  /** Ends the workers, every job still waiting rejected. */
  dispose(): void {
    this.broken = true;
    this.end(new Error('the bays pool was closed'));
  }

  private end(error: Error): void {
    for (const lane of this.lanes ?? []) {
      for (const job of lane.waiting.values()) job.reject(error);
      lane.waiting.clear();
      lane.worker.terminate();
    }
    this.lanes = null;
  }
}
