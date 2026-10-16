import { jobLanes, jobPort } from '../jobs/jobPool';
import type { BlockDigestAsk, GroundJob, GroundJobAnswer, GroundShapeAsk, PlateShapeAnswer } from './groundShape';

/** DO NOT take a silent worker for a dead one: it shares the job pool's workers and the CPU share (a failure comes as an error). */
interface Lane {
  readonly worker: Worker;
  readonly waiting: Map<number, { resolve(answer: GroundJobAnswer): void; reject(error: Error): void }>;
  /** When the worker last answered, or was handed a job (`performance.now()`). */
  heard: number;
  /** Whether this stretch of silence was already said. */
  told: boolean;
}

/** Silence past which a worker with jobs waiting is reported: a city's whole ground is seconds of work. */
const SILENCE_MS = 20_000;
/** Most workers the pool opens. */
const MOST_LANES = 2;

/** What does the ground's work off the page (`renderer.ts` `shapeGround`, `changedBlocks`). */
interface GroundWorkers {
  /** Whether jobs can be handed off the page at all (false: no workers here, or the pool failed). */
  readonly available: boolean;
  shape(ask: GroundShapeAsk): Promise<PlateShapeAnswer[]>;
  digest(ask: BlockDigestAsk): Promise<Float64Array[]>;
  /** Called while waiting: reports a worker with jobs waiting silent too long (queued behind other work or without CPU, still waited for). */
  check(now?: number): void;
}

export class GroundShapePool implements GroundWorkers {
  private lanes: Lane[] | null = null;
  private broken = false;
  private nextId = 1;

  get available(): boolean {
    return this.start() !== null;
  }

  shape(ask: GroundShapeAsk): Promise<PlateShapeAnswer[]> {
    return this.run({ kind: 'shape', ask }) as Promise<PlateShapeAnswer[]>;
  }

  digest(ask: BlockDigestAsk): Promise<Float64Array[]> {
    return this.run({ kind: 'blocks', ask }) as Promise<Float64Array[]>;
  }

  check(now = performance.now()): void {
    for (const lane of this.lanes ?? []) {
      if (lane.told || !lane.waiting.size || now - lane.heard <= SILENCE_MS) continue;
      // Said once a stretch, and waited for: the page shaping the ground itself would stall every frame after it.
      lane.told = true;
      console.warn(`[ground] a ground worker has been silent for ${Math.round(now - lane.heard)} ms with jobs waiting (busy or without CPU); still waiting`);
    }
  }

  private run(job: GroundJob): Promise<GroundJobAnswer> {
    const lanes = this.start();
    if (!lanes) return Promise.reject(new Error('no ground workers in this browser'));
    let lane = lanes[0]!;
    for (const other of lanes) if (other.waiting.size < lane.waiting.size) lane = other;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (lane.waiting.size === 0) { lane.heard = performance.now(); lane.told = false; }
      lane.waiting.set(id, { resolve, reject });
      lane.worker.postMessage({ id, job });
    });
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken) return this.lanes;
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const count = jobLanes(MOST_LANES);
    const lanes: Lane[] = [];
    try {
      for (let k = 0; k < count; k++) {
        const worker = jobPort('groundShape');
        const lane: Lane = { worker, waiting: new Map(), heard: performance.now(), told: false };
        worker.onmessage = (event: MessageEvent<{ id: number; answer?: GroundJobAnswer; error?: string }>) => {
          if (this.lanes !== lanes) return;
          lane.heard = performance.now();
          lane.told = false;
          const job = lane.waiting.get(event.data.id);
          if (!job) return;
          lane.waiting.delete(event.data.id);
          if (event.data.answer) job.resolve(event.data.answer);
          else job.reject(new Error(event.data.error ?? 'ground worker failed'));
        };
        worker.onerror = (event) => this.fail(`a ground worker failed: ${event.message}`);
        worker.onmessageerror = () => this.fail('a ground worker sent a message that cannot be read');
        lanes.push(lane);
      }
      this.lanes = lanes;
    } catch (error) {
      console.warn('[ground] the ground workers are unavailable; the ground is shaped on the page', error);
      // The lanes made before the one that failed let go: none is left holding its place on a worker of the job pool.
      for (const lane of lanes) lane.worker.terminate();
      this.broken = true;
      this.lanes = null;
    }
    return this.lanes;
  }

  /** The pool fails: every job waiting rejected (done on the page by its asker), every worker ended. */
  private fail(why: string): void {
    if (this.broken) return;
    console.warn(`[ground] ${why}; the ground is shaped on the page`);
    this.broken = true;
    this.end(new Error(why));
  }

  /** Ends the workers, every job still waiting rejected. */
  dispose(): void {
    this.broken = true;
    this.end(new Error('the ground pool was closed'));
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
