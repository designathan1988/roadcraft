import type { Finish } from '@world/buildings/materials';
import type { Building } from '@world/buildings/types';
import { type PavingData, pavingReader } from '@world/paving';
import { emitChunk } from './buildingMesh';
import { type CellArrays, type CellMass, type CellSelection, type KitBoxes, cellArrays, cellBuffers, cellMass, cellMassBuffers } from './cellArrays';
import type { BuildingChunk, CellJobEntry, LotGroundRecipe } from './chunk';
import type { FlagInstance } from './flagLayer';
import { PART_KINDS } from './kit';
import { COARSE_PARTS, DETAIL_CELL, DETAIL_PARTS } from './layerCells';
import { emitMassing, type MassingChunk } from './massing';
import { drawsSignature } from './signature';

/**
 * THE BUILDINGS' CELLS PUT TOGETHER AWAY FROM THE PAGE (`cell.worker.ts`; on
 * the page itself where no worker runs, the tests). A worker emits the
 * buildings of a cell sent to it and hands back the cell's batches - or its
 * masses from afar - as arrays
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
 * DO NOT keep the chunks or the masses in the worker between jobs: a cache of
 * every building's arrays under a byte budget (128 MB a pool) held on the CPU
 * what was already on the GPU, and expelled and made again what went past it.
 * A cell asked again is emitted again, that cell alone.
 */

/** Which reading a point asks for. */
export const GROUND = 0;
export const NATURAL = 1;
export const PAVED = 2;

export type { CellEntry, CellJobEntry } from './chunk';

/**
 * What a job makes: a cell's detail (its coarse batch and its detail cells'),
 * a cell's buildings faded (the editor's "hide the others"), a cell's
 * buildings from afar (their masses, `massing.ts`), or only what the page reads
 * of far buildings (their flags, lots' ground, signature floor).
 */
export type JobKind = 'cell' | 'mass' | 'summary';

export interface CellJob {
  readonly id: number;
  readonly kind: JobKind;
  /** The coarse cell the entries stand in (`BATCH_CELL`). */
  readonly cell: string;
  readonly entries: readonly CellJobEntry[];
  /** Whether the page has paving to read. */
  readonly paved: boolean;
  /** The roads near the cell, to read the paving here instead of asking the page (`world/paving.ts`). */
  readonly paving?: PavingData;
}

/** What the page keeps of a building emitted: its flags, how its lots' ground is made again, its signature floor. */
export interface ChunkSummary {
  readonly key: string;
  readonly flags?: readonly FlagInstance[];
  readonly lot: LotGroundRecipe | null;
  readonly signatureFloor?: number;
}

export interface CellResult {
  /** The coarse batch ('cell'); none for a summary or masses. */
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
  readonly entry: CellJobEntry;
  readonly building: Building;
  readonly known: Map<string, number>;
  asked: number[];
  done: boolean;
  chunk: BuildingChunk | null;
  mass: MassingChunk | null;
}

interface JobState {
  readonly job: CellJob;
  /** The paving read here (`pavingReader`): undefined where the page is asked. */
  readonly pavedHere: ((x: number, y: number) => number | undefined) | null;
  /** One per entry, in the job's order. */
  readonly emitting: Emitting[];
  rounds: number;
}

const COARSE: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS.filter((k) => COARSE_PARTS.has(k)), shells: true, furniture: true };
const DETAIL: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS.filter((k) => DETAIL_PARTS.has(k)), shells: false, furniture: false };

/** One worker's cells: each job emitted from the records it brings, nothing kept once it is done. */
export class CellWork {
  private readonly jobs = new Map<number, JobState>();

  /** `tone`: each finish's colour from afar (`kit.ts` `finishTone`), for the masses. */
  constructor(private readonly boxes: KitBoxes, private readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>) {}

  /**
   * A job begun: what the page must answer first, or done at once.
   * @rebuild Asked only for a cell whose entries changed (`cellRequests.ts`).
   */
  start(job: CellJob): WorkReply {
    const emitting: Emitting[] = job.entries.map((entry) => ({
      entry, building: JSON.parse(entry.record) as Building, known: new Map(), asked: [], done: false, chunk: null, mass: null,
    }));
    const state: JobState = { job, pavedHere: job.paving ? pavingReader(job.paving) : null, emitting, rounds: 0 };
    this.jobs.set(job.id, state);
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
        if (kind === PAVED && state.pavedHere) {
          const here = state.pavedHere(x, y);
          if (here !== undefined) return here;
        }
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

  /** Everything made: the batches or the masses put together, the summaries of what the page keeps. */
  private finish(state: JobState): WorkReply {
    const { job } = state;
    this.jobs.delete(job.id);
    if (job.kind === 'mass') {
      const masses = state.emitting.map((e) => e.mass).filter((x): x is MassingChunk => x !== null);
      return { kind: 'done', job: job.id, result: { batch: null, details: [], summaries: [], mass: cellMass(masses) } };
    }
    const chunks = state.emitting.map((e) => e.chunk!);
    const summaries: ChunkSummary[] = state.emitting.map((e) => {
      const { flags, lotGround, signatureFloor } = e.chunk!;
      return { key: e.entry.key, ...(flags ? { flags } : {}), lot: lotGround?.recipe ?? null, ...(signatureFloor !== undefined ? { signatureFloor } : {}) };
    });
    if (job.kind === 'summary') return { kind: 'done', job: job.id, result: { batch: null, details: [], summaries } };
    const batch = cellArrays(chunks, { ...COARSE, ghost: false, dim: false }, this.boxes);
    // The detail cells inside, each its buildings in the cell's order (`layerCells.ts` `chunksByCell`).
    const byDetail = new Map<string, BuildingChunk[]>();
    state.emitting.forEach((e, i) => {
      const key = `${Math.floor(e.building.x / DETAIL_CELL)},${Math.floor(e.building.y / DETAIL_CELL)}`;
      const list = byDetail.get(key);
      if (list) list.push(chunks[i]!); else byDetail.set(key, [chunks[i]!]);
    });
    const details = [...byDetail].map(([key, list]) => [key, cellArrays(list, { ...DETAIL, ghost: false, dim: false }, this.boxes)] as const);
    return { kind: 'done', job: job.id, result: { batch, details, summaries } };
  }
}
