import type { Finish } from '@world/buildings/materials';
import type { Building } from '@world/buildings/types';
import { emitChunk } from './buildingMesh';
import { type CellArrays, type CellMass, type CellSelection, type KitBoxes, cellArrays, cellBuffers, cellMass, cellMassBuffers, massBytes } from './cellArrays';
import type { BuildingChunk, CellEntry, LotGroundRecipe } from './chunk';
import type { FlagInstance } from './flagLayer';
import { PART_KINDS } from './kit';
import { COARSE_PARTS, DETAIL_CELL, DETAIL_PARTS } from './layerCells';
import { emitMassing, type MassingChunk } from './massing';
import { drawsSignature } from './signature';

/**
 * THE BUILDINGS' CELLS PUT TOGETHER AWAY FROM THE PAGE (`cell.worker.ts`; on
 * the page itself where no worker runs, the tests). A worker keeps the chunks
 * and the masses of the cells sent to it, emits the buildings it lacks and
 * hands back each cell's batches - or its masses from afar - as arrays
 * (`cellArrays.ts`), ready to be wrapped in meshes: Cesium's `combineGeometry`
 * worker, which combines a primitive's geometries and transfers the packed
 * result. What an emission reads that lives on the page - the ground as drawn
 * and as it was, the footways' paving - is asked of the page: emitted once with
 * the readings unknown, a building says which points it read, the page reads
 * them, and the next emission, with them all known, reads nothing else (a point
 * that depends on an answer is asked in the next round). A window's light
 * needs nothing of the page: its space's seed is a hash (`lightSlots.ts`).
 *
 * DO NOT send the page a chunk per building: rebuilding each one's dozens of
 * arrays on the page cost as much as emitting it there (2026-10-14,
 * OTIMIZACAO pendente 16). The page gets one message a cell. DO NOT make the
 * masses on the page either: every building of the town was massed there, a
 * slice a frame, and each one's mass kept there for good (`layer.ts` before).
 */

/** Which reading a point asks for. */
export const GROUND = 0;
export const NATURAL = 1;
export const PAVED = 2;

export type { CellEntry } from './chunk';

/**
 * What a job makes: a cell's detail (its coarse batch and its detail cells'),
 * a cell's buildings faded (the editor's "hide the others"), a cell's
 * buildings from afar (their masses, `massing.ts`), or only what the page reads
 * of far buildings (their flags, lots' ground, signature floor).
 */
export type JobKind = 'cell' | 'faded' | 'mass' | 'summary';

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
  /** The coarse batch ('cell'), the faded one ('faded'); none for a summary or masses. */
  readonly batch: CellArrays | null;
  /** Each detail cell's batch, by its key ('cell'). */
  readonly details: readonly (readonly [string, CellArrays])[];
  /** The buildings this job emitted whole. */
  readonly summaries: readonly ChunkSummary[];
  /** The cell's masses ('mass'): null when none of its buildings has any. */
  readonly mass?: CellMass | null;
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
  if (reply.result.mass) out.push(...cellMassBuffers(reply.result.mass));
  return out;
}

/** A reading's key: the exact numbers (a double's shortest text round-trips it). */
const readingKey = (kind: number, x: number, y: number): string => `${kind} ${x} ${y}`;

/** Rounds of readings before a building is given up as never settling (none has needed more than two). */
const MOST_ROUNDS = 16;

/** A building of a job being emitted: its record, the readings known, those asked last round, and what it made once made. */
interface Emitting {
  readonly entry: CellEntry;
  readonly building: Building;
  readonly known: Map<string, number>;
  asked: number[];
  done: boolean;
  chunk: BuildingChunk | null;
  mass: MassingChunk | null;
}

interface JobState {
  readonly job: CellJob;
  /** Per entry: what was kept for it ('mass' jobs: its mass, or null for none), undefined while it is being made. */
  readonly kept: (BuildingChunk | MassingChunk | null | undefined)[];
  readonly emitting: Emitting[];
  rounds: number;
}

/** A building as kept: its record and ground, what was made of them, and its bytes. */
interface Kept<T> { readonly record: string; readonly digest: string; readonly building: Building; readonly made: T; readonly bytes: number }

/**
 * What a worker keeps of one product (the chunks, or the masses), by key, and
 * which cells hold each key: a key is let go when no cell of its kind holds it.
 * The two products are kept apart, so a cell letting its chunks go frees them
 * even while its masses stay.
 */
class Store<T> {
  readonly kept = new Map<string, Kept<T>>();
  /** Each cell's and job kind's keys, as last sent, and how many of these groups hold each key. */
  private readonly members = new Map<string, Set<string>>();
  private readonly groupsOf = new Map<string, number>();
  bytes = 0;

  constructor(private readonly sizeOf: (made: T) => number) {}

  /** What was made for this record on this ground, if kept. */
  get(entry: CellEntry): T | undefined {
    const known = this.kept.get(entry.key);
    return known && known.record === entry.record && known.digest === entry.digest ? known.made : undefined;
  }

  /** The building as last parsed for this record, if any. */
  building(entry: CellEntry): Building | undefined {
    const known = this.kept.get(entry.key);
    return known && known.record === entry.record ? known.building : undefined;
  }

  /** The cell's group made of these entries now: what was made kept, the keys gone from it let go. */
  keep(group: string, entries: readonly CellEntry[], made: readonly { entry: CellEntry; building: Building; made: T }[]): void {
    for (const m of made) {
      this.forget(m.entry.key);
      const bytes = this.sizeOf(m.made);
      this.kept.set(m.entry.key, { record: m.entry.record, digest: m.entry.digest, building: m.building, made: m.made, bytes });
      this.bytes += bytes;
    }
    const was = this.members.get(group) ?? new Set<string>();
    const now = new Set(entries.map((e) => e.key));
    for (const key of now) if (!was.has(key)) this.groupsOf.set(key, (this.groupsOf.get(key) ?? 0) + 1);
    for (const key of was) if (!now.has(key)) this.leave(key);
    this.members.set(group, now);
  }

  /** A group let go: its keys too, where no other group holds them. */
  drop(group: string): void {
    for (const key of this.members.get(group) ?? []) this.leave(key);
    this.members.delete(group);
  }

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
}

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
 * One worker's cells: the chunks and masses it keeps, by cell, within its
 * share of the cache's budget - the cells the page let go (`release`) give
 * their chunks up first, least recently let go first, then the masses of the
 * cells asked longest ago. A cell sent again keeps what was made of the
 * buildings still in it (by record and ground) and emits only the rest.
 */
export class CellWork {
  private readonly chunks = new Store<BuildingChunk>(chunkBytes);
  private readonly masses = new Store<MassingChunk | null>((m) => (m ? massBytes(m) : 0));
  /** The cells let go, in the order they were (oldest first). */
  private readonly released = new Map<string, true>();
  /** The cells whose masses were asked, in the order last asked (oldest first). */
  private readonly massed = new Map<string, true>();
  private readonly jobs = new Map<number, JobState>();

  /** `tone`: each finish's colour from afar (`kit.ts` `finishTone`), for the masses. */
  constructor(private readonly boxes: KitBoxes, private readonly budget: number,
    private readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>) {}

  /**
   * A job begun: done at once if everything is kept, else what the page must answer first.
   * @rebuild Asked only for a cell whose entries changed (`cellRequests.ts`); a record is parsed only when it is new.
   */
  start(job: CellJob): WorkReply {
    const kept: (BuildingChunk | MassingChunk | null | undefined)[] = [];
    const emitting: Emitting[] = [];
    const masses = job.kind === 'mass';
    for (const entry of job.entries) {
      const made = masses ? this.masses.get(entry) : this.chunks.get(entry);
      if (made !== undefined) { kept.push(made); continue; }
      kept.push(undefined);
      // The record parsed once a record: the same text, the same building.
      const building = this.chunks.building(entry) ?? this.masses.building(entry) ?? JSON.parse(entry.record) as Building;
      emitting.push({ entry, building, known: new Map(), asked: [], done: false, chunk: null, mass: null });
    }
    const state: JobState = { job, kept, emitting, rounds: 0 };
    this.jobs.set(job.id, state);
    // Only the cell's own batches bring it near again: a summary of its far buildings' flags, or its masses, do not.
    if (job.kind === 'cell' || job.kind === 'faded') this.released.delete(job.cell);
    if (masses) { this.massed.delete(job.cell); this.massed.set(job.cell, true); }
    return this.emitRound(state);
  }

  /** The page's readings of the points last asked, in their order. */
  readings(id: number, values: Float64Array): WorkReply {
    const state = this.jobs.get(id)!;
    let at = 0;
    for (const e of state.emitting) {
      if (e.done) continue;
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
    const { job } = state;
    for (const e of state.emitting) {
      if (e.done) continue;
      const asked = new Set<string>();
      const points: number[] = [];
      const reading = (kind: number) => (x: number, y: number): number => {
        const k = readingKey(kind, x, y);
        const value = e.known.get(k);
        if (value !== undefined) return value;
        if (!asked.has(k)) { asked.add(k); points.push(kind, x, y); }
        return kind === PAVED ? NaN : 0;
      };
      const paved = job.paved ? reading(PAVED) : undefined;
      if (job.kind === 'mass') e.mass = emitMassing(e.building, reading(GROUND), paved, reading(NATURAL), drawsSignature(e.building), this.tone);
      else e.chunk = emitChunk(e.building, reading(GROUND), paved, reading(NATURAL));
      e.asked = points;
      if (points.length) { need.push(...points); continue; }
      e.done = true;
    }
    if (need.length) {
      if (++state.rounds > MOST_ROUNDS) throw new Error(`[buildings] a cell's readings never settled (${job.cell})`);
      return { kind: 'need', job: job.id, points: Float64Array.from(need) };
    }
    return this.finish(state);
  }

  /** Everything made: the new ones kept (a summary job keeps none), the batches or the masses put together. */
  private finish(state: JobState): WorkReply {
    const { job } = state;
    this.jobs.delete(job.id);
    const group = `${job.kind}|${job.cell}`;
    let next = 0;
    const made = state.kept.map((k) => {
      if (k !== undefined) return k;
      const e = state.emitting[next++]!;
      return job.kind === 'mass' ? e.mass : e.chunk!;
    });
    if (job.kind === 'mass') {
      this.masses.keep(group, job.entries, state.emitting.map((e) => ({ entry: e.entry, building: e.building, made: e.mass })));
      this.trim();
      const masses = made.filter((x): x is MassingChunk => x !== null);
      return { kind: 'done', job: job.id, result: { batch: null, details: [], summaries: [], mass: cellMass(masses) } };
    }
    const chunks = made as BuildingChunk[];
    const summaries: ChunkSummary[] = state.emitting.map((e) => {
      const { flags, lotGround, signatureFloor } = e.chunk!;
      return { key: e.entry.key, ...(flags ? { flags } : {}), lot: lotGround?.recipe ?? null, ...(signatureFloor !== undefined ? { signatureFloor } : {}) };
    });
    if (job.kind === 'summary') return { kind: 'done', job: job.id, result: { batch: null, details: [], summaries } };
    this.chunks.keep(group, job.entries, state.emitting.map((e) => ({ entry: e.entry, building: e.building, made: e.chunk! })));
    this.trim();
    if (job.kind === 'faded') {
      return { kind: 'done', job: job.id, result: { batch: cellArrays(chunks, { ...WHOLE, ghost: false, dim: true }, this.boxes), details: [], summaries } };
    }
    const batch = cellArrays(chunks, { ...COARSE, ghost: false, dim: false }, this.boxes);
    // The detail cells inside, each its buildings in the cell's order (`layerCells.ts` `chunksByCell`).
    const byDetail = new Map<string, BuildingChunk[]>();
    job.entries.forEach((entry, i) => {
      const b = this.chunks.kept.get(entry.key)!.building;
      const key = `${Math.floor(b.x / DETAIL_CELL)},${Math.floor(b.y / DETAIL_CELL)}`;
      const list = byDetail.get(key);
      if (list) list.push(chunks[i]!); else byDetail.set(key, [chunks[i]!]);
    });
    const details = [...byDetail].map(([key, list]) => [key, cellArrays(list, { ...DETAIL, ghost: false, dim: false }, this.boxes)] as const);
    return { kind: 'done', job: job.id, result: { batch, details, summaries } };
  }

  /** Over its share of the budget: the cells let go give their chunks up, oldest first; then the masses asked longest ago. */
  private trim(): void {
    const over = (): boolean => this.chunks.bytes + this.masses.bytes > this.budget;
    for (const cell of this.released.keys()) {
      if (!over()) return;
      this.chunks.drop(`cell|${cell}`);
      this.chunks.drop(`faded|${cell}`);
      this.released.delete(cell);
    }
    for (const cell of this.massed.keys()) {
      if (!over()) return;
      this.masses.drop(`mass|${cell}`);
      this.massed.delete(cell);
    }
  }
}
