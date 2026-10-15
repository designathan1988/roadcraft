import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import type { Finish } from '@world/buildings/materials';
import type { KitBoxes } from './cellArrays';
import { type CellEntry, type CellJob, type CellResult, CellWork, GROUND, type JobKind, NATURAL, PAVED, type WorkReply } from './cellWork';

/**
 * THE PAGE'S SIDE OF THE CELLS PUT TOGETHER IN WORKERS (`cellWork.ts`,
 * `cell.worker.ts`): a cell always goes to the same worker, which emits its
 * buildings and keeps nothing of them; the page answers the readings of the ground a job asks
 * for, and is handed the cell's batches as arrays. Cesium's
 * `TaskProcessor`: a worker made on the first task, the result handed back
 * with its buffers transferred. The workers are as many as the cores the
 * browser reports, one left to the page, at most `MOST_LANES`.
 *
 * Where no worker runs (a test, a browser without them) the same work is done
 * on the page, and a job is done before `run` returns: what the layer waits for
 * is the same either way. A worker that fails hands its jobs to the page.
 */

/** What a job reads on the page: the ground as drawn and as it was, and the paving. */
export interface CellEnv {
  readonly groundAt: GroundAt;
  readonly naturalAt: GroundAt;
  readonly pavedAt?: PavedAt;
}

interface Running { readonly job: CellJob; readonly env: CellEnv; readonly done: (result: CellResult) => void; readonly lane: Lane | null; readonly rank: number }

/** A worker, the jobs it is working on, and those waiting their turn, in the order asked. */
interface Lane { readonly worker: Worker; readonly jobs: Map<number, Running>; readonly queue: Running[] }

/** Most workers the pool opens. */
const MOST_LANES = 4;
/**
 * Jobs a worker works on at once; the rest wait on the page (Cesium's
 * `TaskProcessor` `maximumActiveTasks`). DO NOT post every job at once: a
 * worker reads its messages in order, so the readings a job waited for queued
 * behind every other job's first round, and no cell landed until the worker had
 * been through them all (36 cells asked, none landed in 8 s, 2026-10-14).
 */
const ACTIVE_PER_LANE = 1;
/** Which jobs a lane begins first (lower first). */
const PRIORITY: Readonly<Record<JobKind, number>> = { cell: 0, faded: 0, mass: 1, summary: 2 };

export class CellPool {
  private lanes: Lane[] | null = null;
  private broken = false;
  private local: CellWork | null = null;
  private nextId = 1;
  /** Begun jobs whose results nobody wants any more (`supersede`). */
  private readonly abandoned = new Set<number>();

  /** `workers`: false does every job on the page (tests). `tone`: each finish's colour from afar, for the masses (`kit.ts`). */
  /** `text`: an entry's record as text, for the job's message (the page keeps none). */
  constructor(private readonly boxes: () => KitBoxes, private readonly text: (entry: CellEntry) => string, private readonly workers = true,
    private readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>) {}

  /** Jobs handed out or waiting their turn, not done yet. */
  get running(): number {
    let n = 0;
    for (const lane of this.lanes ?? []) n += lane.jobs.size + lane.queue.length;
    return n;
  }

  /**
   * A cell's job: its batches ('cell', 'faded') or its buildings' summaries
   * ('summary'), `done` called with the result - at once where no worker runs.
   * The id it returns cancels it.
   */
  run(kind: JobKind, cell: string, entries: readonly CellEntry[], env: CellEnv, done: (result: CellResult) => void): number {
    // Each record's text written for this job's message alone (`CellJobEntry`).
    const job: CellJob = { id: this.nextId++, kind, cell, entries: entries.map((e) => ({ ...e, record: this.text(e) })), paved: env.pavedAt !== undefined };
    const lanes = this.start();
    const lane = lanes ? lanes[laneOf(cell, lanes.length)]! : null;
    // A building the player cut open goes first: what the click asked for (`layer.ts` `entryFor`).
    const rank = entries.some((e) => e.key.includes('|')) ? -1 : PRIORITY[kind];
    const running: Running = { job, env, done, lane, rank };
    if (!lane) { this.onPage(running); return job.id; }
    lane.queue.push(running);
    this.pump(lane);
    return job.id;
  }

  /**
   * The lane's next jobs begun while it has room: a cell's detail first, then masses, then the far
   * flags (`PRIORITY`), each kind in the order asked. DO NOT take them only in the order asked: the
   * masses of a whole town asked at its opening kept the near cells' detail waiting behind them.
   */
  private pump(lane: Lane): void {
    while (lane.jobs.size < ACTIVE_PER_LANE && lane.queue.length) {
      let at = 0;
      for (let i = 1; i < lane.queue.length && lane.queue[at]!.rank > -1; i++) if (lane.queue[i]!.rank < lane.queue[at]!.rank) at = i;
      const next = lane.queue.splice(at, 1)[0]!;
      lane.jobs.set(next.job.id, next);
      lane.worker.postMessage({ type: 'start', job: next.job });
    }
  }

  /**
   * The workers made now, ahead of the first job: each loads its code while the
   * town is being laid out, not when the first cell is asked for.
   */
  warm(): void {
    this.start();
  }

  /**
   * A job whose result is no longer wanted (a newer one for its cell, the layer gone): out of its
   * lane's queue, or, begun, dropped by its worker, which takes the next. DO NOT only mark it: the
   * worker went through every round of a cell nobody wanted, and the cells behind it waited.
   */
  cancel(id: number): void {
    for (const lane of this.lanes ?? []) {
      const waiting = lane.queue.findIndex((r) => r.job.id === id);
      if (waiting >= 0) { lane.queue.splice(waiting, 1); return; }
      if (lane.jobs.delete(id)) {
        this.abandoned.delete(id);
        lane.worker.postMessage({ type: 'cancel', job: id });
        this.pump(lane);
        return;
      }
    }
  }

  /**
   * A job a newer one for its cell replaces: dropped, waiting or begun (`cancel`). The worker keeps
   * nothing of a job (`cellWork.ts`), so one finished for nobody would only keep the newer one waiting.
   */
  supersede(id: number): void {
    this.cancel(id);
  }

  /** Whether a job is still waiting or being worked on (one done on the page never is). */
  isRunning(id: number): boolean {
    return (this.lanes ?? []).some((lane) => lane.jobs.has(id) || lane.queue.some((r) => r.job.id === id));
  }

  dispose(): void {
    for (const lane of this.lanes ?? []) lane.worker.terminate();
    this.lanes = null;
    this.local = null;
  }

  /** The job done here, every round answered at once. */
  private onPage(running: Running): void {
    this.local ??= new CellWork(this.boxes(), this.tone);
    const work = this.local;
    let reply = work.start(running.job);
    while (reply.kind !== 'done') reply = work.readings(reply.job, readingsOf(reply.points, running.env));
    this.finish(running, reply.result);
  }

  private finish(running: Running, result: CellResult): void {
    running.done(result);
  }

  private start(): Lane[] | null {
    if (this.lanes || this.broken || !this.workers) return this.lanes;
    if (typeof Worker === 'undefined') { this.broken = true; return null; }
    const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
    const count = Math.max(1, Math.min(MOST_LANES, cores - 1));
    try {
      const boxes = this.boxes();
      const lanes: Lane[] = [];
      for (let k = 0; k < count; k++) {
        const worker = new Worker(new URL('./cell.worker.ts', import.meta.url), { type: 'module' });
        const lane: Lane = { worker, jobs: new Map(), queue: [] };
        worker.onmessage = (event: MessageEvent<WorkReply | { kind: 'error'; job: number; message: string }>) => this.answer(lane, event.data);
        worker.onerror = (event) => {
          // A worker that cannot run: its jobs, and every one from now on, are done on the page.
          console.warn('[buildings] the cell workers failed; cells are put together on the page', event.message);
          this.giveUp();
        };
        worker.postMessage({ type: 'init', boxes, tone: this.tone });
        lanes.push(lane);
      }
      this.lanes = lanes;
    } catch (error) {
      console.warn('[buildings] no cell workers; cells are put together on the page', error);
      this.broken = true;
    }
    return this.lanes;
  }

  /** A worker's reply: the readings or slots it asks answered, or its result handed on. */
  private answer(lane: Lane, reply: WorkReply | { kind: 'error'; job: number; message: string }): void {
    const running = lane.jobs.get(reply.job);
    if (!running) return;
    if (this.abandoned.has(reply.job) && (reply.kind === 'error' || reply.kind === 'done')) {
      this.abandoned.delete(reply.job);
      lane.jobs.delete(reply.job);
      this.pump(lane);
      return;
    }
    if (reply.kind === 'error') {
      console.warn('[buildings] a cell worker failed on a cell; put together on the page', reply.message);
      lane.jobs.delete(reply.job);
      this.onPage({ ...running, lane: null });
      this.pump(lane);
      return;
    }
    if (reply.kind === 'done') {
      lane.jobs.delete(reply.job);
      this.finish(running, reply.result);
      this.pump(lane);
      return;
    }
    // The readings answered on the page, the buffer handed back (MDN, transfer).
    const values = readingsOf(reply.points, running.env);
    lane.worker.postMessage({ type: 'readings', job: reply.job, values }, [values.buffer]);
  }

  private giveUp(): void {
    const waiting = (this.lanes ?? []).flatMap((lane) => [...lane.jobs.values(), ...lane.queue]);
    this.broken = true;
    this.dispose();
    for (const running of waiting) this.onPage({ ...running, lane: null });
  }
}

/** A cell's worker: the same one each time, by a hash of its key. */
function laneOf(cell: string, lanes: number): number {
  let h = 0;
  for (let i = 0; i < cell.length; i++) h = (h * 31 + cell.charCodeAt(i)) | 0;
  return Math.abs(h) % lanes;
}

/** The page's readings of kind, x, y threes. */
function readingsOf(points: Float64Array, env: CellEnv): Float64Array {
  const out = new Float64Array(points.length / 3);
  for (let i = 0, at = 0; i < points.length; i += 3, at++) {
    const kind = points[i]!, x = points[i + 1]!, y = points[i + 2]!;
    out[at] = kind === GROUND ? env.groundAt(x, y) : kind === NATURAL ? env.naturalAt(x, y) : kind === PAVED ? env.pavedAt!(x, y) : NaN;
  }
  return out;
}
