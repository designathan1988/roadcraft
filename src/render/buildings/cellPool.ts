import { canQueueJobs, focusDistance, type JobTicket, submitJob, warmJobWorkers } from '../../jobs/jobPool';
import type { GroundAt } from '@world/buildings/foundation';
import type { Finish } from '@world/buildings/materials';
import type { PavingSource } from '@world/paving';
import { m } from '@world/units';
import type { SharedGroundAt } from '../sharedGround';
import { BATCH_CELL } from './layerCells';
import type { KitBoxes } from './cellArrays';
import { type CellEntry, type CellJob, type CellResult, type JobKind, type WorkReply, runCellJob } from './cellWork';
import { levelCells } from './massLevels';

/** THE PAGE'S SIDE OF THE CELLS PUT TOGETHER IN WORKERS (`cellWork.ts`, `cell.worker.ts`), through the job system's one queue (`jobPool.ts` `submitJob`) */

/** What a job reads on the page: the ground as drawn and as it was, and the paving (with `pack`: read by the worker itself). */
export interface CellEnv {
  readonly groundAt: GroundAt;
  readonly naturalAt: GroundAt;
  readonly pavedAt?: PavingSource;
}

/** How far past its cell a job's buildings read the paving off the roads handed to its worker (`PavingData`) */
const PAVING_REACH = m(64);
/** Which jobs go first, a band each, nearest the eye first within a band: the detail, its far level, the masses, the summaries. */
const TIER: Readonly<Record<JobKind, number>> = { cell: 0, facade: 1, mass: 2, massTile: 2.5, massPlate: 2.75, summary: 3 };
/** A band: farther than any cell of any map is from the eye. */
const TIER_SPAN = m(10_000_000);
/** Times a job is asked again over wider roads (`wider`) before the page puts it together. */
const MOST_WIDER = 2;

/** A job's square in `BATCH_CELL`s from its key: a cell ("x,y") or a tile or plate of masses ("t:i,j", "p:i,j", `massLevels.ts`); null when it is none. */
function squareOf(cell: string): { readonly i0: number; readonly j0: number; readonly n: number } | null {
  if (cell[1] === ':') { const { i0, j0, n } = levelCells(cell); return { i0, j0, n }; }
  const [cx, cy] = cell.split(',').map(Number) as [number, number];
  return Number.isFinite(cx) && Number.isFinite(cy) ? { i0: cx, j0: cy, n: 1 } : null;
}

/** The rectangle a job's worker reads the paving in: its square and `PAVING_REACH` round it. */
function pavingRect(cell: string): [number, number, number, number] | null {
  const at = squareOf(cell);
  if (!at) return null;
  const { i0, j0, n } = at;
  return [i0 * BATCH_CELL - PAVING_REACH, j0 * BATCH_CELL - PAVING_REACH, (i0 + n) * BATCH_CELL + PAVING_REACH, (j0 + n) * BATCH_CELL + PAVING_REACH];
}

/** A job asked: what it is written from when a worker takes it (`write`), and where it stands. */
interface Asked {
  readonly id: number;
  readonly kind: JobKind;
  readonly cell: string;
  readonly entries: readonly CellEntry[];
  /** Each record taken when asked, written as text only for the message (the page keeps none: `CellJobEntry`). */
  readonly writers: readonly (() => string)[];
  readonly env: CellEnv;
  readonly done: (result: CellResult) => void;
  readonly key: string | null;
  readonly priority: number;
  /** The roads handed with it: the cell and its reach, wider once the worker said so. */
  rect: [number, number, number, number] | null;
  widened: number;
  ticket: JobTicket | null;
}

export class CellPool {
  private readonly asked = new Map<number, Asked>();
  /** Each key's job asked: a newer one replaces it (the queue drops it too). */
  private readonly byKey = new Map<string, Asked>();
  private nextId = 1;
  private warned = false;

  /** `workers`: false does every job on the page (tests). `tone`: each finish's colour from afar, for the masses (`kit.ts`). */
  /** `text`: an entry's record, taken when asked, written as text for the job's message when it is sent (the page keeps none). */
  constructor(private readonly boxes: () => KitBoxes, private readonly text: (entry: CellEntry) => () => string, private readonly workers = true,
    private readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>) {}

  /** Jobs asked and not answered. */
  get running(): number {
    return this.asked.size;
  }

  /** A cell's job: its batches ('cell'), its far level ('facade'), its masses ('mass') or its buildings' summaries; `key`, what a newer job replaces */
  run(kind: JobKind, cell: string, entries: readonly CellEntry[], env: CellEnv, done: (result: CellResult) => void, key: string | null = null): number {
    if (key !== null) { const older = this.byKey.get(key); if (older) this.cancel(older.id); }
    const at = squareOf(cell);
    const away = at ? focusDistance((at.i0 + at.n / 2) * BATCH_CELL, (at.j0 + at.n / 2) * BATCH_CELL) : 0;
    // A building the player cut open goes first: what the click asked for (`layer.ts` `entryFor`).
    const priority = entries.some((e) => e.key.includes('|')) ? -TIER_SPAN : TIER[kind] * TIER_SPAN + away;
    const asked: Asked = {
      id: this.nextId++, kind, cell, entries, writers: entries.map((e) => this.text(e)), env, done, key, priority,
      rect: env.pavedAt ? pavingRect(cell) : null, widened: 0, ticket: null,
    };
    if (!this.offPage(env)) { this.onPage(asked); return asked.id; }
    this.asked.set(asked.id, asked);
    if (key !== null) this.byKey.set(key, asked);
    this.submit(asked);
    return asked.id;
  }

  /** The job system's workers made now, ahead of the first job. */
  warm(): void {
    if (this.workers && canQueueJobs()) warmJobWorkers();
  }

  /** A job no longer wanted: never sent if waiting, its answer dropped if begun (a worker runs a job through, one message). */
  cancel(id: number): void {
    const asked = this.asked.get(id);
    if (!asked) return;
    this.forget(asked);
    asked.ticket?.cancel();
  }

  /** A job a newer one for its cell replaces (`cancel`). */
  supersede(id: number): void {
    this.cancel(id);
  }

  /** Whether a job is still waiting or being worked on (one done on the page never is). */
  isRunning(id: number): boolean {
    return this.asked.has(id);
  }

  dispose(): void {
    for (const id of [...this.asked.keys()]) this.cancel(id);
  }

  /** DO NOT hand a worker a job it would have to ask the page about: only with the ground shared and the paving packable (`sharedGround.ts`, `PavingSource.pack`) */
  private offPage(env: CellEnv): boolean {
    if (!this.workers || !canQueueJobs()) return false;
    if (!(env.groundAt as SharedGroundAt).share?.current) return false;
    return env.pavedAt === undefined || env.pavedAt.pack !== undefined;
  }

  private submit(asked: Asked): void {
    asked.ticket = submitJob({
      service: 'cells',
      key: asked.key === null ? null : `cells:${asked.key}`,
      priority: asked.priority,
      write: () => this.write(asked),
      done: (answer) => this.answer(asked, answer as WorkReply),
      failed: (message) => this.failed(asked, message),
    });
  }

  /** The job as its worker reads it: the records written now, the plates' shared buffers, the roads near the cell (MDN, transfer). */
  private write(asked: Asked): { data: CellJob; transfer: ArrayBuffer[] } {
    const ground = (asked.env.groundAt as SharedGroundAt).share?.current;
    if (!ground) throw new Error('[buildings] the ground is not shared any more');
    const packed = asked.env.pavedAt && asked.rect ? asked.env.pavedAt.pack!(asked.rect) : null;
    if (asked.env.pavedAt && asked.rect && !packed) throw new Error('[buildings] the paving cannot be handed to a worker');
    const job: CellJob = {
      ...this.base(asked), ground,
      ...(asked.env.naturalAt === asked.env.groundAt ? { naturalIsGround: true } : {}),
      ...(packed ? { paving: packed.data } : {}),
    };
    return { data: job, transfer: packed?.transfer ?? [] };
  }

  /** What every job carries, on the page or off it. */
  private base(asked: Asked): CellJob {
    return {
      id: asked.id, kind: asked.kind, cell: asked.cell, paved: asked.env.pavedAt !== undefined, boxes: this.boxes(),
      entries: asked.entries.map((e, i) => ({ ...e, record: asked.writers[i]!() })),
      ...(this.tone ? { tone: this.tone } : {}),
    };
  }

  /** A worker's answer: the result handed on, the job asked again over wider roads, or put together here. */
  private answer(asked: Asked, reply: WorkReply): void {
    if (this.asked.get(asked.id) !== asked) return;
    if (reply.kind === 'wider' && asked.widened < MOST_WIDER) {
      asked.widened++;
      asked.rect = [reply.rect[0], reply.rect[1], reply.rect[2], reply.rect[3]];
      this.submit(asked);
      return;
    }
    this.forget(asked);
    if (reply.kind === 'done') { asked.done(reply.result); return; }
    if (reply.kind === 'error') console.warn('[buildings] a cell worker failed on a cell; put together on the page', reply.message);
    this.onPage(asked);
  }

  /** The worker failed, or none runs: put together here. */
  private failed(asked: Asked, message: string): void {
    if (this.asked.get(asked.id) !== asked) return;
    if (!this.warned) { this.warned = true; console.warn('[buildings] a cell job could not run in a worker; put together on the page', message); }
    this.forget(asked);
    this.onPage(asked);
  }

  private forget(asked: Asked): void {
    this.asked.delete(asked.id);
    if (asked.key !== null && this.byKey.get(asked.key) === asked) this.byKey.delete(asked.key);
  }

  /** The job done here, every height read off the page's own ground. */
  private onPage(asked: Asked): void {
    const { groundAt, naturalAt, pavedAt } = asked.env;
    const reply = runCellJob(this.base(asked), { groundAt, naturalAt, ...(pavedAt ? { pavedAt } : {}) });
    if (reply.kind !== 'done') throw new Error(`[buildings] a cell put together on the page did not finish (${asked.cell})`);
    asked.done(reply.result);
  }
}
