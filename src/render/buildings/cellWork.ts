import type { Building } from '@world/buildings/types';
import { emitChunk } from './buildingMesh';
import { type CellArrays, type CellSelection, type KitBoxes, cellArrays, cellBuffers } from './cellArrays';
import type { BuildingChunk, CellEntry, LotGroundRecipe } from './chunk';
import type { FlagInstance } from './flagLayer';
import { PART_KINDS } from './kit';
import { COARSE_PARTS, DETAIL_CELL, DETAIL_PARTS } from './layerCells';

/**
 * THE BUILDINGS' CELLS PUT TOGETHER AWAY FROM THE PAGE (`cell.worker.ts`; on
 * the page itself where no worker runs, the tests). A worker keeps the chunks
 * of the cells sent to it, emits the buildings it lacks and hands back each
 * cell's batches as arrays (`cellArrays.ts`), ready to be wrapped in meshes:
 * Cesium's `combineGeometry` worker, which combines a primitive's geometries
 * and transfers the packed result. What an emission reads that lives on the
 * page - the ground as drawn and as it was, the footways' paving, the light
 * slots' table - is asked of the page: emitted once with the readings unknown,
 * a building says which points it read, the page reads them, and the next
 * emission, with them all known, reads nothing else (a point that depends on an
 * answer is asked in the next round). A window's light needs nothing of the
 * page: its space's seed is a hash (`lightSlots.ts`).
 *
 * DO NOT send the page a chunk per building: rebuilding each one's dozens of
 * arrays on the page cost as much as emitting it there (2026-10-14,
 * OTIMIZACAO pendente 16). The page gets one message a cell.
 */

/** Which reading a point asks for. */
export const GROUND = 0;
export const NATURAL = 1;
export const PAVED = 2;

export type { CellEntry } from './chunk';

/**
 * What a job makes: a cell's detail (its coarse batch and its detail cells'),
 * a cell's buildings faded (the editor's "hide the others"), or only what the
 * page reads of far buildings (their flags, lots' ground, signature floor).
 */
export type JobKind = 'cell' | 'faded' | 'summary';

export interface CellJob {
  readonly id: number;
  readonly kind: JobKind;
  /** The coarse cell the entries stand in (`BATCH_CELL`). */
  readonly cell: string;
  readonly entries: readonly CellEntry[];
  /** Whether the page has paving to read. */
  readonly paved: boolean;
}

/** What the page keeps of a building emitted: its flags, how its lots' ground is made again, its signature floor. */
export interface ChunkSummary {
  readonly key: string;
  readonly flags?: readonly FlagInstance[];
  readonly lot: LotGroundRecipe | null;
  readonly signatureFloor?: number;
}

export interface CellResult {
  /** The coarse batch ('cell'), the faded one ('faded'); none for a summary. */
  readonly batch: CellArrays | null;
  /** Each detail cell's batch, by its key ('cell'). */
  readonly details: readonly (readonly [string, CellArrays])[];
  /** The buildings this job emitted. */
  readonly summaries: readonly ChunkSummary[];
}

export type WorkReply =
  /** The readings still unknown: kind, x, y threes. */
  | { readonly kind: 'need'; readonly job: number; readonly points: Float64Array }
  | { readonly kind: 'done'; readonly job: number; readonly result: CellResult };

/** Every buffer of a reply: handed over, not copied (MDN, `postMessage` transfer). */
export function replyBuffers(reply: WorkReply): ArrayBuffer[] {
  if (reply.kind === 'need') return [reply.points.buffer as ArrayBuffer];
  const out = reply.result.batch ? cellBuffers(reply.result.batch) : [];
  for (const [, arrays] of reply.result.details) out.push(...cellBuffers(arrays));
  return out;
}

/** A reading's key: the exact numbers (a double's shortest text round-trips it). */
const readingKey = (kind: number, x: number, y: number): string => `${kind} ${x} ${y}`;

/** Rounds of readings before a building is given up as never settling (none has needed more than two). */
const MOST_ROUNDS = 16;

/** A building of a job being emitted: its record, the readings known, those asked last round, and its chunk once made. */
interface Emitting {
  readonly entry: CellEntry;
  readonly building: Building;
  readonly known: Map<string, number>;
  asked: number[];
  chunk: BuildingChunk | null;
}

interface JobState {
  readonly job: CellJob;
  readonly chunks: (BuildingChunk | null)[];
  readonly emitting: Emitting[];
  rounds: number;
}

interface Kept { readonly record: string; readonly digest: string; readonly building: Building; readonly chunk: BuildingChunk; readonly bytes: number }

/** The bytes of a chunk's arrays (what the cache counts). */
function chunkBytes(chunk: BuildingChunk): number {
  let n = 0;
  for (const s of Object.values(chunk.shells)) if (s) n += s.position.byteLength + s.normal.byteLength + s.colour.byteLength + s.uv.byteLength + s.index.byteLength + s.decay.byteLength;
  for (const p of Object.values(chunk.parts)) n += p.matrices.byteLength + (p.colours?.byteLength ?? 0) + (p.slots?.byteLength ?? 0) + (p.rooms?.byteLength ?? 0);
  for (const p of Object.values(chunk.furniture ?? {})) if (p) n += p.matrices.byteLength;
  return n;
}

const COARSE: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS.filter((k) => COARSE_PARTS.has(k)), shells: true, furniture: true };
const DETAIL: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS.filter((k) => DETAIL_PARTS.has(k)), shells: false, furniture: false };
const WHOLE: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS, shells: true, furniture: true };

/**
 * One worker's cells: the chunks it keeps, by cell, within its share of the
 * cache's budget - the cells the page let go (`release`) give theirs up first,
 * least recently let go first, as `layer.ts` slimmed far buildings. A cell
 * sent again keeps the chunks of the buildings still in it (by record and
 * ground) and emits only the rest.
 */
export class CellWork {
  private readonly kept = new Map<string, Kept>();
  /** Each cell's and job kind's chunk keys, as last sent, and how many of these groups hold each key. */
  private readonly members = new Map<string, Set<string>>();
  private readonly groupsOf = new Map<string, number>();
  /** The cells let go, in the order they were (oldest first). */
  private readonly released = new Map<string, true>();
  private readonly jobs = new Map<number, JobState>();
  private bytes = 0;

  constructor(private readonly boxes: KitBoxes, private readonly budget: number) {}

  /**
   * A job begun: done at once if every chunk is kept, else what the page must answer first.
   * @rebuild Asked only for a cell whose entries changed (`cellRequests.ts` `want`); a record is parsed only when it is new.
   */
  start(job: CellJob): WorkReply {
    const chunks: (BuildingChunk | null)[] = [];
    const emitting: Emitting[] = [];
    for (const entry of job.entries) {
      const known = this.kept.get(entry.key);
      if (known && known.record === entry.record && known.digest === entry.digest) { chunks.push(known.chunk); continue; }
      chunks.push(null);
      // The record parsed once a record: the same text, the same building.
      const building = known && known.record === entry.record ? known.building : JSON.parse(entry.record) as Building;
      emitting.push({ entry, building, known: new Map(), asked: [], chunk: null });
    }
    const state: JobState = { job, chunks, emitting, rounds: 0 };
    this.jobs.set(job.id, state);
    // Only the cell's own batches bring it near again: a summary of its far buildings' flags does not.
    if (job.kind !== 'summary') this.released.delete(job.cell);
    return this.emitRound(state);
  }

  /** The page's readings of the points last asked, in their order. */
  readings(id: number, values: Float64Array): WorkReply {
    const state = this.jobs.get(id)!;
    let at = 0;
    for (const e of state.emitting) {
      if (e.chunk) continue;
      for (let i = 0; i < e.asked.length; i += 3) e.known.set(readingKey(e.asked[i]!, e.asked[i + 1]!, e.asked[i + 2]!), values[at++]!);
    }
    return this.emitRound(state);
  }

  /** A job no longer wanted: its state let go; a reading for it that comes later is not asked for. */
  cancel(id: number): void {
    this.jobs.delete(id);
  }

  /** A cell the page drew far: its chunks given up first when the cache is over its share. */
  release(cell: string): void {
    this.released.delete(cell);
    this.released.set(cell, true);
    this.trim();
  }

  /** Emits every building of the job not made yet with the readings it has; asks what is still unknown. */
  private emitRound(state: JobState): WorkReply {
    const need: number[] = [];
    for (const e of state.emitting) {
      if (e.chunk) continue;
      const asked = new Set<string>();
      const points: number[] = [];
      const reading = (kind: number) => (x: number, y: number): number => {
        const k = readingKey(kind, x, y);
        const value = e.known.get(k);
        if (value !== undefined) return value;
        if (!asked.has(k)) { asked.add(k); points.push(kind, x, y); }
        return kind === PAVED ? NaN : 0;
      };
      const chunk = emitChunk(e.building, reading(GROUND), state.job.paved ? reading(PAVED) : undefined, reading(NATURAL));
      e.asked = points;
      if (points.length) { need.push(...points); continue; }
      e.chunk = chunk;
    }
    if (need.length) {
      if (++state.rounds > MOST_ROUNDS) throw new Error(`[buildings] a cell's readings never settled (${state.job.cell})`);
      return { kind: 'need', job: state.job.id, points: Float64Array.from(need) };
    }
    return this.finish(state);
  }

  /** Every chunk made: the new ones kept (a summary job keeps none), the batches put together. */
  private finish(state: JobState): WorkReply {
    const { job } = state;
    this.jobs.delete(job.id);
    let next = 0;
    const chunks = state.chunks.map((c) => c ?? state.emitting[next++]!.chunk!);
    const summaries: ChunkSummary[] = state.emitting.map((e) => {
      const { flags, lotGround, signatureFloor } = e.chunk!;
      return { key: e.entry.key, ...(flags ? { flags } : {}), lot: lotGround?.recipe ?? null, ...(signatureFloor !== undefined ? { signatureFloor } : {}) };
    });
    if (job.kind === 'summary') return { kind: 'done', job: job.id, result: { batch: null, details: [], summaries } };
    this.keep(job, state.emitting);
    if (job.kind === 'faded') {
      return { kind: 'done', job: job.id, result: { batch: cellArrays(chunks, { ...WHOLE, ghost: false, dim: true }, this.boxes), details: [], summaries } };
    }
    const batch = cellArrays(chunks, { ...COARSE, ghost: false, dim: false }, this.boxes);
    // The detail cells inside, each its buildings in the cell's order (`layerCells.ts` `chunksByCell`).
    const byDetail = new Map<string, BuildingChunk[]>();
    job.entries.forEach((entry, i) => {
      const b = this.kept.get(entry.key)!.building;
      const key = `${Math.floor(b.x / DETAIL_CELL)},${Math.floor(b.y / DETAIL_CELL)}`;
      const list = byDetail.get(key);
      if (list) list.push(chunks[i]!); else byDetail.set(key, [chunks[i]!]);
    });
    const details = [...byDetail].map(([key, list]) => [key, cellArrays(list, { ...DETAIL, ghost: false, dim: false }, this.boxes)] as const);
    return { kind: 'done', job: job.id, result: { batch, details, summaries } };
  }

  /** The job's cell made of its entries now: the chunks made kept, those of buildings gone from it let go. */
  private keep(job: CellJob, made: readonly Emitting[]): void {
    for (const e of made) {
      this.forget(e.entry.key);
      const bytes = chunkBytes(e.chunk!);
      this.kept.set(e.entry.key, { record: e.entry.record, digest: e.entry.digest, building: e.building, chunk: e.chunk!, bytes });
      this.bytes += bytes;
    }
    const group = `${job.kind}|${job.cell}`;
    const was = this.members.get(group) ?? new Set<string>();
    const now = new Set(job.entries.map((e) => e.key));
    for (const key of now) if (!was.has(key)) this.groupsOf.set(key, (this.groupsOf.get(key) ?? 0) + 1);
    for (const key of was) if (!now.has(key)) this.leave(key);
    this.members.set(group, now);
    this.trim();
  }

  /** A key out of one group: its chunk let go when no group holds it. */
  private leave(key: string): void {
    const left = (this.groupsOf.get(key) ?? 1) - 1;
    if (left > 0) { this.groupsOf.set(key, left); return; }
    this.groupsOf.delete(key);
    this.forget(key);
  }

  private forget(key: string): void {
    const known = this.kept.get(key);
    if (!known) return;
    this.bytes -= known.bytes;
    this.kept.delete(key);
  }

  /** Over its share of the budget: the cells let go give their chunks up, oldest first. */
  private trim(): void {
    for (const cell of this.released.keys()) {
      if (this.bytes <= this.budget) return;
      for (const kind of ['cell', 'faded'] as const) {
        const group = `${kind}|${cell}`;
        for (const key of this.members.get(group) ?? []) this.leave(key);
        this.members.delete(group);
      }
      this.released.delete(cell);
    }
  }
}
