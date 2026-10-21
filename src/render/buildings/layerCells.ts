import { Group } from 'three';
import { Digest } from '@core/digest';
import type { Vec2 } from '@core/vec2';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { footprintRects, solidFootprints, storedBounds } from '@world/buildings/geometry';
import { cutOpen } from '@world/buildings/interior';
import { type RecordRef, refOf } from '@world/buildings/recordTable';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { CELL } from '@world/cells';
import type { ChangeJournal, ChangeRect } from '@world/changes';
import type { BuildingStore } from '@world/buildings/store';
import { ViewCells } from '@world/viewCells';
import type { BuildingMeshes } from './buildingMesh';
import type { CellEntry } from './chunk';
import { PART_KINDS, type PartKind } from './kit';

/** THE CELLS OF THE BUILDINGS LAYER (`layer.ts`) */

/** DO NOT work it out again here: every building the ground moved near turned its corners into the world again, 3 s of a 2 */
export function groundDigest(b: Building, groundAt: GroundAt, pavedAt?: PavedAt): number {
  const box = storedBounds(b, b.module * 2);
  return boxGroundDigest(box.minX, box.minY, box.maxX, box.maxY, groundAt, pavedAt);
}

/** The ground of a box sampled as `groundDigest` samples a building's (6 by 6 points): the layer's, from the box its columns keep (`townColumns.ts`). */
export function boxGroundDigest(minX: number, minY: number, maxX: number, maxY: number, groundAt: GroundAt, pavedAt?: PavedAt): number {
  // To the centimetre, as the text it replaced was; a number, never a string kept per building.
  const out = new Digest();
  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const x = minX + ((maxX - minX) * i) / 5;
      const y = minY + ((maxY - minY) * j) / 5;
      out.add(Math.round(groundAt(x, y) * 100));
      if (pavedAt) { const p = pavedAt(x, y); out.add(Number.isFinite(p) ? Math.round(p * 100) : NaN); }
    }
  }
  return out.value();
}
/** Cells asked of the workers at once while the eye streams the town in (`landCells`, `layer.ts`), nearest first. */
export const STREAM_AHEAD = 8;
/** Side of the cells the buildings are batched in: the world's one grid (`world/cells.ts`). */
export const BATCH_CELL = CELL;
/** Side of the sub-cells a cell's parts are filed by (`partFiling.ts`). */
export { DETAIL_CELL } from './partFiling';
// Frozen tables, not state (`eslint-rules/no-module-state.js`).
/** The parts drawn with the cell's shells, one batch a cell: window panes (each with its room's light) and pool water, their single level two triangles. */
export const COARSE_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['glass', 'glassDark', 'water']));
/** Every other part, filed by sub-cell and drawn by the error on the screen (`partCells.ts`). */
export const DETAIL_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set(PART_KINDS.filter((kind) => !COARSE_PARTS.has(kind))));

/** The buildings batched cell by cell, each cell its own meshes: a cell out of the view */
/** A cell's batch and the entries it was made of (its coarse cell's: `cellRequests.ts`), by cell key. */
export type CellCache = Map<string, CellBatch>;
/** `bytes`: what a cell's batch and its parts (`partCells.ts`) send to the GPU. */
interface CellBatch { entries: readonly CellEntry[]; part: BuildingMeshes; bytes: number }

/** A cell cache that tells `told` each key that comes in (true) or goes (false). */
export function watchedCells(told: (key: string, has: boolean) => void): CellCache {
  return new (class extends Map<string, CellBatch> {
    override set(key: string, value: CellBatch): this {
      super.set(key, value);
      told(key, true);
      return this;
    }
    override delete(key: string): boolean {
      const had = super.delete(key);
      if (had) told(key, false);
      return had;
    }
    override clear(): void {
      for (const key of this.keys()) told(key, false);
      super.clear();
    }
  })();
}

/** A group of the cells in `cache` (the coarse batches, or the detail ones): its triangles theirs, disposing it lets go of the group only. */
export function cellGroup(cache: CellCache): BuildingMeshes {
  const group = new Group();
  group.name = 'buildings';
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  for (const { part } of cache.values()) group.add(part.group);
  return {
    group,
    // The cells in the cache are the ones in this group: streamed in and out after this (`landCells`, `layer.ts`).
    get triangles() {
      let sum = 0;
      for (const { part } of cache.values()) sum += part.triangles;
      return sum;
    },
    setVisible(visible) {
      group.visible = visible;
    },
    // The cells' batches belong to the cache: only this group is let go.
    dispose() {
      group.clear();
    },
  };
}

/** How far past a wall a plant is still considered under the building. */
const PLANT_MARGIN = m(1);
/** Side of the footprint index's buckets, world units (ten to a world cell, `CELL`). */
const COVER_CELL = m(25.6);
/** How far past a building's stored box its cover reaches (its footprints grown by `PLANT_MARGIN`), with a margin. */
const COVER_PAD = m(3);
/** The most the cover cells hold on the CPU (`ViewCells`): a few hundred cells of a dense town. */
const COVER_CPU_BUDGET = 16 * 1048576;
/** How far round the eye the cover cells are derived ahead of the plants' questions. */
const COVER_REACH = m(600);
/** The cover's generator: moves when what a cell holds is worked out otherwise. */
const COVER_VERSION = 1;

/** A building's ground no plant stands on: its solid footprints grown by `PLANT_MARGIN`, and its footprint's rectangles (the cover index's and a tile's near bake's, `nearBuildings.ts`). */
export const coverPolygons = (b: Building): Vec2[][] => [...solidFootprints(b, PLANT_MARGIN), ...footprintRects(b)];

/** One cell of the cover: the polygons reaching it, flat (x, y pairs; polygon k's points from `starts[k]` to `starts[k + 1]`), filed by bucket. */
export interface CoverCell {
  readonly xy: Float64Array;
  readonly starts: Uint32Array;
  readonly buckets: ReadonlyMap<number, Uint32Array>;
}

/** What the cover index reads: the document's buildings and its diary. */
export interface CoverSource {
  readonly buildings: BuildingStore;
  readonly changes: ChangeJournal;
}

/** Where the buildings stand, for the scenery's plant cull: derived cell by cell round the questions asked (`viewCells.ts`), never for the whole town */
export interface CoverIndex {
  /** Brought up to the document: the cells its buildings' changes reached dropped (made again when asked), the rest kept. */
  follow(source: CoverSource): void;
  /** The eye: the cells round it derived ahead of the plants' questions, `most` a call. */
  look(x: number, y: number, most?: number): void;
  covers(x: number, y: number): boolean;
  /** Moves when what `covers` answers may have changed (a building came, went or changed). */
  readonly version: number;
  /** The cells held, their bytes and work (the bound's tests). */
  readonly cells: ViewCells<CoverCell>;
}

const bucketKey = (i: number, j: number): number => i * 100_003 + j;
const EMPTY_COVER: CoverCell = Object.freeze({ xy: new Float64Array(0), starts: new Uint32Array(1), buckets: Object.freeze(new Map<number, Uint32Array>()) });

/** A cell's cover from the buildings reaching it: a pure function of the cell and the document. */
export function coverCell(buildings: BuildingStore | null, rect: ChangeRect): CoverCell {
  if (!buildings) return EMPTY_COVER;
  const near = buildings.near(rect[0] - COVER_PAD, rect[1] - COVER_PAD, rect[2] + COVER_PAD, rect[3] + COVER_PAD);
  if (near.length === 0) return EMPTY_COVER;
  const points: number[] = [];
  const starts: number[] = [0];
  const filed = new Map<number, number[]>();
  // The cell's buckets: the world's (`COVER_CELL`), those of the cell and one more each side (a point on the cell's edge may round into its neighbour's bucket).
  const i0 = Math.floor(rect[0] / COVER_CELL) - 1, i1 = Math.floor(rect[2] / COVER_CELL);
  const j0 = Math.floor(rect[1] / COVER_CELL) - 1, j1 = Math.floor(rect[3] / COVER_CELL);
  for (const b of near) {
    for (const poly of coverPolygons(b)) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of poly) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
      const bi0 = Math.max(i0, Math.floor(minX / COVER_CELL)), bi1 = Math.min(i1, Math.floor(maxX / COVER_CELL));
      const bj0 = Math.max(j0, Math.floor(minY / COVER_CELL)), bj1 = Math.min(j1, Math.floor(maxY / COVER_CELL));
      if (bi0 > bi1 || bj0 > bj1) continue;
      const k = starts.length - 1;
      for (const p of poly) points.push(p.x, p.y);
      starts.push(points.length / 2);
      for (let i = bi0; i <= bi1; i++) {
        for (let j = bj0; j <= bj1; j++) {
          const key = bucketKey(i, j);
          const list = filed.get(key);
          if (list) list.push(k); else filed.set(key, [k]);
        }
      }
    }
  }
  if (starts.length === 1) return EMPTY_COVER;
  const buckets = new Map<number, Uint32Array>();
  for (const [key, list] of filed) buckets.set(key, Uint32Array.from(list));
  return { xy: Float64Array.from(points), starts: Uint32Array.from(starts), buckets };
}

/** The bytes a cover cell holds: its arrays, and each bucket's entry. */
const coverBytes = (cell: CoverCell): number => {
  let n = cell.xy.byteLength + cell.starts.byteLength;
  for (const list of cell.buckets.values()) n += list.byteLength + 64;
  return n;
};

/** Whether (x, y) is in polygon `k` of a cell (`pointInPolygon` on the flat points, the same arithmetic). */
function inCoverPolygon(cell: CoverCell, k: number, x: number, y: number): boolean {
  const from = cell.starts[k]!, to = cell.starts[k + 1]!, xy = cell.xy;
  let inside = false;
  for (let i = from, j = to - 1; i < to; j = i++) {
    const xi = xy[i * 2]!, yi = xy[i * 2 + 1]!, xj = xy[j * 2]!, yj = xy[j * 2 + 1]!;
    if (yi > y === yj > y) continue;
    if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function createCoverIndex(): CoverIndex {
  let source: CoverSource | null = null;
  const cells = new ViewCells<CoverCell>({
    name: 'building cover',
    version: COVER_VERSION,
    side: CELL,
    reach: COVER_REACH,
    cpuBudget: COVER_CPU_BUDGET,
    kinds: ['buildings'],
    pad: COVER_PAD,
    derive: (_key, rect) => {
      const cell = coverCell(source?.buildings ?? null, rect);
      return { value: cell, cpuBytes: coverBytes(cell) };
    },
  });
  let version = 0;
  /** The cell the eye was last in (`look`), and whether some cell it wants is not derived yet. */
  let lookedFrom = Number.NaN, missing = false;
  return {
    follow(next) {
      // Another document: nothing held of the last one stands.
      if (next.buildings !== source?.buildings || next.changes !== source.changes) {
        source = next;
        cells.clear();
        cells.follow(next.changes);
        version++;
        missing = true;
        return;
      }
      if (cells.follow(next.changes) > 0) { version++; missing = true; }
    },
    look(x, y, most = 1) {
      if (!source) return;
      // The wanted cells chosen again only when the eye crossed into another cell, and derived only while some are missing.
      const at = cells.cellAt(x, y);
      if (at !== lookedFrom) { lookedFrom = at; cells.look({ x, y }); missing = true; }
      if (missing) missing = cells.pump(most) > 0 || cells.wantedKeys.some((key) => !cells.has(key));
    },
    covers(x, y) {
      if (!source) return false;
      const cell = cells.ensure(cells.cellAt(x, y));
      const list = cell.buckets.get(bucketKey(Math.floor(x / COVER_CELL), Math.floor(y / COVER_CELL)));
      if (!list) return false;
      for (let i = 0; i < list.length; i++) if (inCoverPolygon(cell, list[i]!, x, y)) return true;
      return false;
    },
    get version() {
      return version;
    },
    cells,
  };
}


/** A cell's batch out of its cache and its group, disposed. */
/** Where the workers read a building's record (`layer.ts` `refOf`): its tile's shared table and row, or a table of its own made once per record (a record is replaced, never edited); cut open (a key with a level and a direction), the opened record in a table of its own, never kept (DO NOT keep them in a map with a cap: a cache that drops and remakes). */
export function recordRef(b: Building, key: string): RecordRef {
  if (!key.includes('|')) return refOf(b);
  const [, level, dir] = key.split('|').map(Number) as [number, number, number];
  const turn = dir * (Math.PI / 4);
  // Opened, a signature building is drawn by the shared kit with its rooms and furniture.
  const { blueprint: _sig, ...plain } = cutOpen(b, level, { x: Math.cos(turn), y: Math.sin(turn) });
  return refOf(plain as Building, false);
}

/** A cell's level: its detail or its facade level (`cellRequests.ts` `BatchKind`, named here so the cells' module imports nothing of the requests). */
type LevelKind = 'cell' | 'facade';

/** THE BYTES THE CELLS' LEVELS HOLD ON THE GPU (`layer.ts` `counted`, `keepToBudget`), by level, and what each level measured when it last landed, kept or not: the cap reckons with it before asking again (no level refused and asked again for ever). */
export class ResidentBytes {
  /** What the levels hold now, bytes. */
  total = 0;
  private readonly resident = new Map<string, number>();
  private readonly measured = new Map<string, number>();
  /** Called whenever what it answers may change (`layer.ts` levelOfDetail chooses the levels again then). */
  changed: () => void = () => {};
  /** A level come (`bytes` over 0) or gone (0). */
  count(kind: LevelKind, key: string, bytes: number): void {
    const at = `${kind}|${key}`;
    this.changed();
    this.total += bytes - (this.resident.get(at) ?? 0);
    if (bytes) this.resident.set(at, bytes); else this.resident.delete(at);
  }
  /** A level landed, uploaded or not: what it measured. */
  landed(kind: LevelKind, key: string, bytes: number): void {
    this.measured.set(`${kind}|${key}`, bytes);
    this.changed();
  }
  /** A cell's buildings changed: what its levels measured no longer holds. */
  forget(key: string): void {
    this.changed();
    this.measured.delete(`cell|${key}`);
    this.measured.delete(`facade|${key}`);
  }
  /** What a level holds or would hold, bytes: resident, else as measured when it last landed, else `typical`. */
  of(kind: LevelKind, key: string, typical: number): number {
    const at = `${kind}|${key}`;
    return this.resident.get(at) ?? this.measured.get(at) ?? typical;
  }
}

export function dropCell(cache: CellCache, key: string, owner: BuildingMeshes | null): void {
  const known = cache.get(key);
  if (!known) return;
  owner?.group.remove(known.part.group);
  known.part.dispose();
  cache.delete(key);
}
