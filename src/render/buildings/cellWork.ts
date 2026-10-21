import type { Finish } from '@world/buildings/materials';
import { eachRecord, readRecords } from '@world/buildings/recordTable';
import { type PavingData, pavingReader } from '@world/paving';
import { type GroundReaders, type SharedGroundData, sharedGroundReaders } from '../sharedGround';
import { ShellWriter, chunkSummary, emitChunk, letGoEmitted } from './buildingMesh';
export { ShellWriter } from './buildingMesh';
import { type CellArrays, type CellMass, type CellSelection, type KitBoxes, cellArrays, cellBuffers, cellMass, cellMassBuffers } from './cellArrays';
import type { BuildingChunk, CellJobEntry, LotGroundRecipe } from './chunk';
import type { FlagInstance } from './flagLayer';
import { PART_KINDS } from './kit';
import { COARSE_PARTS, DETAIL_CELL, DETAIL_PARTS } from './layerCells';
import { CELL_DETAIL, type MassDetail, PLATE_DETAIL, TILE_DETAIL, emitMassing, massFloor, type MassingChunk } from './massing';
import { type PartFiling, fileParts, filingBuffers } from './partFiling';
import { levelCells } from './levelKeys';
import { PartyWalls } from './partyWalls';
import { drawsSignature } from './signature';

/** DO NOT send the page a chunk per building */

export type { CellEntry } from './chunk';

/** What a job makes: a cell's detail (its coarse batch and its detail cells'), the same at the far level (`facade`: L1, `emitChunk` `far`), a cell's buildings faded */
/** 'massTile' and 'massPlate': the masses of a 1,024 m tile (L2) and a 2,048 m plate (L3) merged, simplified to their level (`massLevels.ts`). */
export type JobKind = 'cell' | 'mass' | 'summary' | 'facade' | 'massTile' | 'massPlate';

/** What each kind of masses leaves out (`massing.ts` `MassDetail`). */
const MASS_DETAIL: Partial<Readonly<Record<JobKind, MassDetail>>> = { mass: CELL_DETAIL, massTile: TILE_DETAIL, massPlate: PLATE_DETAIL };

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
  /** The ground in shared memory, read here as the page reads it (`sharedGround.ts`); none when the job is done on the page. */
  readonly ground?: SharedGroundData;
  /** Where the ground was cut to its plates around the job (`groundAround`: a job for another process); a read past them asks the job again (`wider`). */
  readonly around?: readonly [number, number, number, number];
  /** The page reads the natural ground as the drawn one (`layer.ts` `update`, `naturalAt` left out). */
  readonly naturalIsGround?: boolean;
  /** The kit's part boxes and each finish's colour from afar (`kit.ts` `finishTone`): the job carries all it reads. */
  readonly boxes: KitBoxes;
  readonly tone?: Readonly<Record<Finish, readonly [number, number, number]>>;
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
  /** The cell's parts by band and detail cell, filed here (`partFiling.ts`): null for a summary or masses, or none. */
  readonly parts: PartFiling | null;
  /** The buildings this job emitted whole. */
  readonly summaries: readonly ChunkSummary[];
  /** The cell's masses ('mass'): null when none of its buildings has any. */
  readonly mass?: CellMass | null;
  /** Each entry's ground floor as the job stood it (`CellEntry.floor`): null with no closed block, undefined where it read none; kept by the page for the next jobs of the same buildings (`cellPool.ts`). */
  readonly floors?: readonly (number | null | undefined)[];
}

export type WorkReply =
  /** The paving was read past the roads handed over, or the ground past the plates (`CellJob.around`): the job is asked again with them over `rect` (rare: a building reaching far out of its cell). */
  | { readonly kind: 'wider'; readonly job: number; readonly rect: readonly [number, number, number, number] }
  | { readonly kind: 'done'; readonly job: number; readonly result: CellResult }
  | { readonly kind: 'error'; readonly job: number; readonly message: string };

/** Every buffer of a reply: handed over, not copied (MDN, `postMessage` transfer). */
export function replyBuffers(reply: WorkReply): ArrayBuffer[] {
  if (reply.kind !== 'done') return [];
  const out = reply.result.batch ? cellBuffers(reply.result.batch) : [];
  if (reply.result.parts) out.push(...filingBuffers(reply.result.parts));
  if (reply.result.mass) out.push(...cellMassBuffers(reply.result.mass));
  return out;
}

/** What a job reads: the ground (shared, or the page's own), and the paving, undefined where it cannot be read here. */
interface CellReads extends GroundReaders {
  readonly pavedAt?: (x: number, y: number) => number | undefined;
  /** The worker's own shell and rows (`ShellWriter`): DO NOT make them for each job, their arrays grown again from nothing. */
  readonly writer?: ShellWriter;
  /** The box of the reads on plates the job was not handed (`CellJob.around`); null when none. */
  readonly groundMissed?: () => readonly [number, number, number, number] | null;
}

/** A job's reads in a worker: the shared ground, the paving off the roads it was handed (reading the shared natural ground where they need it). */
export function workerReads(job: CellJob, writer?: ShellWriter): CellReads {
  if (!job.ground) throw new Error(`[buildings] a cell job with no shared ground (${job.cell})`);
  const miss: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  const shared = sharedGroundReaders(job.ground, (x, y) => {
    if (x < miss[0]) miss[0] = x;
    if (y < miss[1]) miss[1] = y;
    if (x > miss[2]) miss[2] = x;
    if (y > miss[3]) miss[3] = y;
  });
  const naturalAt = job.naturalIsGround ? shared.groundAt : shared.naturalAt;
  const pavedAt = job.paving ? pavingReader(job.paving, naturalAt) : undefined;
  const groundMissed = (): readonly [number, number, number, number] | null => (miss[0] <= miss[2] ? miss : null);
  return { groundAt: shared.groundAt, naturalAt, groundMissed, ...(pavedAt ? { pavedAt } : {}), ...(writer ? { writer } : {}) };
}

const COARSE: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS.filter((k) => COARSE_PARTS.has(k)), shells: true, furniture: true };
const DETAIL: Omit<CellSelection, 'ghost' | 'dim'> = { parts: PART_KINDS.filter((k) => DETAIL_PARTS.has(k)), shells: false, furniture: false };

/** DO NOT ask the page for the ground in rounds: a cell's job reads every height itself (`sharedGround.ts`), in one pass, nothing kept once it is done */
export function runCellJob(job: CellJob, reads: CellReads): WorkReply {
  // A paving point past the roads handed over: the box of them, to ask the job again over it (`wider`).
  let missX0 = Infinity, missY0 = Infinity, missX1 = -Infinity, missY1 = -Infinity;
  const pavedHere = reads.pavedAt;
  const paved = job.paved
    ? (x: number, y: number): number => {
      const value = pavedHere?.(x, y);
      if (value !== undefined) return value;
      if (x < missX0) missX0 = x;
      if (y < missY0) missY0 = y;
      if (x > missX1) missX1 = x;
      if (y > missY1) missY1 = y;
      return NaN;
    }
    : undefined;
  /** Whether anything was read past what the job was handed: the paving's misses, and the ground's put with them. */
  const missed = (): boolean => {
    const ground = reads.groundMissed?.();
    if (ground) {
      missX0 = Math.min(missX0, ground[0]); missY0 = Math.min(missY0, ground[1]);
      missX1 = Math.max(missX1, ground[2]); missY1 = Math.max(missY1, ground[3]);
    }
    return missX0 <= missX1;
  };
  const { groundAt, naturalAt } = reads;
  const detail = MASS_DETAIL[job.kind];
  if (detail) {
    const masses: MassingChunk[] = [];
    const floors: (number | null)[] = [];
    // One record at a time, let go once its masses are made: a plate's job is four tiles of buildings (`eachRecord`).
    let n = 0;
    for (const b of eachRecord(job.entries.map((entry) => entry.record))) {
      // DO NOT measure a floor an earlier job of the same building on the same ground measured (`CellEntry.floor`).
      const given = job.entries[n]!.floor;
      const floor = given !== undefined ? given ?? undefined : massFloor(b, naturalAt, paved);
      floors.push(floor ?? null);
      n++;
      const mass = emitMassing(b, groundAt, paved, naturalAt, drawsSignature(b), job.tone, detail, { floor });
      if (mass) masses.push(mass);
    }
    // On the square's grid (`cellArrays.ts` `massGrid`): a cell's, a tile's or a plate's.
    const at = job.cell[1] === ':' ? levelCells(job.cell) : { i0: Number(job.cell.slice(0, job.cell.indexOf(','))), j0: Number(job.cell.slice(job.cell.indexOf(',') + 1)), n: 1 };
    return missed() ? wider(job, missX0, missY0, missX1, missY1) : { kind: 'done', job: job.id, result: { batch: null, parts: null, summaries: [], mass: cellMass(masses, at), floors } };
  }
  // DO NOT parse a text per building: each record decoded from its tile's shared table, a tile's shared members once for the job.
  const buildings = readRecords(job.entries.map((entry) => entry.record));
  /** What the page keeps of a building, from its chunk or its summary alone. */
  const summaryOf = (chunk: Pick<BuildingChunk, 'flags' | 'lotGround' | 'signatureFloor'>, i: number): ChunkSummary => {
    const { flags, lotGround, signatureFloor } = chunk;
    return { key: job.entries[i]!.key, ...(flags ? { flags } : {}), lot: lotGround?.recipe ?? null, ...(signatureFloor !== undefined ? { signatureFloor } : {}) };
  };
  // DO NOT lay a building for its summary: its lots' recipe and its floor alone (`chunkSummary`).
  // Each floor once for the job, those an earlier job measured not again (`CellEntry.floor`).
  const known = job.entries.map((entry) => entry.floor);
  if (job.kind === 'summary') {
    const floorsOf = new PartyWalls(buildings, naturalAt, paved, known);
    const summaries = buildings.map((b, i) => summaryOf(chunkSummary(b, groundAt, paved, naturalAt, floorsOf), i));
    return missed() ? wider(job, missX0, missY0, missX1, missY1) : { kind: 'done', job: job.id, result: { batch: null, parts: null, summaries, floors: floorsOf.floorsKnown() } };
  }
  // The detail and its far level: the buildings of the cell as one another's neighbours, a party wall's covered bays not laid (`partyWalls.ts`).
  const party = new PartyWalls(buildings, naturalAt, paved, known);
  // One shell and one set of rows written again for each building of the job, and of every job the worker runs (`CellReads.writer`).
  const writer = reads.writer ?? new ShellWriter();
  const chunks = buildings.map((b) => {
    const chunk = emitChunk(b, groundAt, paved, naturalAt, undefined, job.kind === 'facade', true, party, writer);
    // Its furniture and bays let go now: the job reads them no more (`letGoEmitted`).
    letGoEmitted(b);
    return chunk;
  });
  if (missed()) return wider(job, missX0, missY0, missX1, missY1);
  const summaries = chunks.map(summaryOf);
  // The far level's shells on the cell's grid (`cellArrays.ts` `ShellGrid`); the detail's in floats (its millimetre steps).
  const comma = job.cell.indexOf(',');
  const grid = job.kind === 'facade' ? [Number(job.cell.slice(0, comma)), Number(job.cell.slice(comma + 1))] as const : undefined;
  // The detail cells inside, each its buildings in the cell's order (`layerCells.ts` `chunksByCell`).
  const detailOf = buildings.map((b) => `${Math.floor(b.x / DETAIL_CELL)},${Math.floor(b.y / DETAIL_CELL)}`);
  // The shells pieced by quadrant (two detail cells a side): each piece culled by its own box (`cellArrays` groups), and a cell
  // at the district's scale drawing four pieces rather than sixteen. The parts keep the detail cell's finer levels (`partFiling.ts`).
  const shellOf = buildings.map((b) => `${Math.floor(b.x / (2 * DETAIL_CELL))},${Math.floor(b.y / (2 * DETAIL_CELL))}`);
  const batch = cellArrays(chunks, { ...COARSE, ghost: false, dim: false, ...(grid ? { grid } : {}) }, job.boxes, shellOf);
  const byDetail = new Map<string, BuildingChunk[]>();
  buildings.forEach((_b, i) => {
    const key = detailOf[i]!;
    const list = byDetail.get(key);
    if (list) list.push(chunks[i]!); else byDetail.set(key, [chunks[i]!]);
  });
  const details = [...byDetail].map(([key, list]) => [key, cellArrays(list, { ...DETAIL, ghost: false, dim: false }, job.boxes)] as const);
  // DO NOT hand the page the instances to band: the parts filed here, by band and detail cell, their buffers ready (`partFiling.ts`).
  if (!job.boxes.bandings) throw new Error('[buildings] a cell job with no part bandings (`kitBoxes`)');
  const parts = details.length ? fileParts(job.cell, details, job.boxes.bandings) : null;
  return { kind: 'done', job: job.id, result: { batch, parts, summaries, floors: party.floorsKnown() } };
}

/** The roads and the ground to hand the job again: those it was handed and every point it read past them, a metre round. */
function wider(job: CellJob, x0: number, y0: number, x1: number, y1: number): WorkReply {
  const rect: [number, number, number, number] = [x0 - 1, y0 - 1, x1 + 1, y1 + 1];
  for (const was of [job.paving?.rect, job.around]) {
    if (was) { rect[0] = Math.min(rect[0], was[0]); rect[1] = Math.min(rect[1], was[1]); rect[2] = Math.max(rect[2], was[2]); rect[3] = Math.max(rect[3], was[3]); }
  }
  return { kind: 'wider', job: job.id, rect };
}
