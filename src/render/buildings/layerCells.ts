import { Group } from 'three';
import { Digest } from '@core/digest';
import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { footprintRects, solidFootprints, storedBounds } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { m } from '@world/units';
import type { BuildingMeshes } from './buildingMesh';
import type { CellEntry } from './chunk';
import { PART_KINDS, type PartKind } from './kit';

/** THE CELLS OF THE BUILDINGS LAYER (`layer.ts`) */

/** DO NOT work it out again here: every building the ground moved near turned its corners into the world again, 3 s of a 2 */
export function groundDigest(b: Building, groundAt: GroundAt, pavedAt?: PavedAt): number {
  const box = storedBounds(b, b.module * 2);
  // To the centimetre, as the text it replaced was; a number, never a string kept per building.
  const out = new Digest();
  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const x = box.minX + ((box.maxX - box.minX) * i) / 5;
      const y = box.minY + ((box.maxY - box.minY) * j) / 5;
      out.add(Math.round(groundAt(x, y) * 100));
      if (pavedAt) { const p = pavedAt(x, y); out.add(Number.isFinite(p) ? Math.round(p * 100) : NaN); }
    }
  }
  return out.value();
}
/** Cells asked of the workers at once while the eye streams the town in (`landCells`, `layer.ts`), nearest first. */
export const STREAM_AHEAD = 8;
/** Side of the cells the buildings are batched in, world units. */
export const BATCH_CELL = m(240);
export const DETAIL_CELL = m(120);
/** A window frame's side, m (`buildingMesh.ts`, the frames' depth). */
const FRAME_SIDE = m(0.06);
/** A detail cell's frames and railings are drawn whole while a frame's side spans this many pixels (`cullDetails`). */
const FULL_DETAIL_PIXELS = 0.4;
const DETAIL_HYSTERESIS = 0.1;
// Frozen tables, not state (`eslint-rules/no-module-state.js`).
export const DETAIL_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['frame', 'railing', 'roofRailing', 'louvre']));
export const COARSE_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set(PART_KINDS.filter((kind) => !DETAIL_PARTS.has(kind))));

/** The buildings batched cell by cell, each cell its own meshes: a cell out of the view */
/** A cell's batch and the entries it was made of (its coarse cell's: `cellRequests.ts`), by cell key. */
export type CellCache = Map<string, CellBatch>;
/** `bytes`: what a coarse cell and its detail cells send to the GPU, on the coarse cell's entry (0 on the detail cells'). */
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
/** Side of the footprint index's buckets, world units. */
const COVER_CELL = m(25.6);

/** Where the buildings stand, for the scenery's plant cull */
export interface CoverIndex {
  /** The whole town filed again (the opening, a map opened). */
  index(buildings: Iterable<Building>): void;
  /** One building filed again (added or changed): an edit pays for it, not for the town. */
  set(b: Building): void;
  remove(id: BuildingId): void;
  covers(x: number, y: number): boolean;
  readonly version: number;
}

export function createCoverIndex(): CoverIndex {
  const footprints = new WeakMap<Building, Vec2[][]>();
  /** Each building's rectangles, the buckets they are filed in and their digest: taken out and filed again by id */
  const filed = new Map<BuildingId, { digest: number; at: [number, Vec2[]][] }>();
  const buckets = new Map<number, Set<Vec2[]>>();
  const bucketKey = (i: number, j: number): number => i * 100_003 + j;
  let digestWas = -1;
  let version = 0;
  const unfile = (id: BuildingId): number | undefined => {
    const known = filed.get(id);
    if (!known) return undefined;
    for (const [key, rect] of known.at) {
      const set = buckets.get(key)!;
      set.delete(rect);
      if (set.size === 0) buckets.delete(key);
    }
    filed.delete(id);
    return known.digest;
  };
  const file = (b: Building): number => {
    let rects = footprints.get(b);
    if (!rects) {
      rects = [...solidFootprints(b, PLANT_MARGIN), ...footprintRects(b)];
      footprints.set(b, rects);
    }
    const digest = new Digest();
    const at: [number, Vec2[]][] = [];
    for (const rect of rects) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of rect) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
        digest.add(p.x).add(p.y);
      }
      digest.add(rect.length);
      for (let i = Math.floor(minX / COVER_CELL); i <= Math.floor(maxX / COVER_CELL); i++) {
        for (let j = Math.floor(minY / COVER_CELL); j <= Math.floor(maxY / COVER_CELL); j++) {
          const key = bucketKey(i, j);
          const set = buckets.get(key);
          if (set) set.add(rect);
          else buckets.set(key, new Set([rect]));
          at.push([key, rect]);
        }
      }
    }
    const value = digest.value();
    filed.set(b.id, { digest: value, at });
    return value;
  };
  return {
    index(buildings) {
      filed.clear();
      buckets.clear();
      const digest = new Digest();
      for (const b of buildings) digest.add(file(b));
      const value = digest.value();
      if (value !== digestWas) {
        digestWas = value;
        version++;
      }
    },
    set(b) {
      const was = unfile(b.id);
      if (file(b) !== was) version++;
    },
    remove(id) {
      if (unfile(id) !== undefined) version++;
    },
    covers(x, y) {
      const list = buckets.get(bucketKey(Math.floor(x / COVER_CELL), Math.floor(y / COVER_CELL)));
      if (!list) return false;
      const p = { x, y };
      for (const rect of list) if (pointInPolygon(p, rect)) return true;
      return false;
    },
    get version() {
      return version;
    },
  };
}


/** A detail cell's centre (map x/y), whether it is drawn by the far versions of its parts, and its coarse cell. */
export interface DetailState { x: number; y: number; far: boolean; parent: string }

/** Each detail cell shown with its coarse cell, and its frames and railings whole or by their street faces */
export function cullDetailCells(detailCells: CellCache, states: WeakMap<BuildingMeshes, DetailState>, coarseNear: (key: string) => boolean,
  eyeX: number, eyeY: number, eyeZ: number, pxAtMetre: number, orthoPx: number | null, applyFar: (part: BuildingMeshes, far: boolean) => void): void {
  for (const [key, cell] of detailCells) {
    let state = states.get(cell.part);
    // A cell new since the last frame is put to its detail whatever it is.
    const fresh = !state;
    if (!state) {
      const comma = key.indexOf(',');
      const i = Number(key.slice(0, comma)), j = Number(key.slice(comma + 1));
      // Its cell of the coarse grid (two of these a side), read once.
      const parent = `${Math.floor((i * DETAIL_CELL) / BATCH_CELL)},${Math.floor((j * DETAIL_CELL) / BATCH_CELL)}`;
      state = { x: (i + 0.5) * DETAIL_CELL, y: (j + 0.5) * DETAIL_CELL, far: false, parent };
      states.set(cell.part, state);
    }
    const cx = state.x - eyeX, cy = state.y - eyeY;
    // Drawn while its coarse cell is drawn in detail: the far level takes over by the error on the screen (`massCells.ts`).
    cell.part.group.visible = coarseNear(state.parent);
    // Its frames and railings whole while a frame's side spans `FULL_DETAIL_PIXELS` or more, by their street faces
    const nx = Math.max(Math.abs(cx) - DETAIL_CELL / 2, 0), ny = Math.max(Math.abs(cy) - DETAIL_CELL / 2, 0);
    const near = Math.max(Math.hypot(nx, ny, eyeZ), 1);
    const pixels = orthoPx !== null ? FRAME_SIDE * orthoPx : (FRAME_SIDE * pxAtMetre) / near;
    const nextFar = pixels < FULL_DETAIL_PIXELS * (state.far ? 1 : 1 - DETAIL_HYSTERESIS);
    if (fresh || nextFar !== state.far) {
      state.far = nextFar;
      applyFar(cell.part, nextFar);
    }
  }
}

/** The detail cells (`DETAIL_CELL`) inside a coarse cell (`BATCH_CELL`), by key. */
export function detailKeysOf(coarseKey: string): string[] {
  const comma = coarseKey.indexOf(',');
  const i = Number(coarseKey.slice(0, comma)), j = Number(coarseKey.slice(comma + 1));
  const per = Math.round(BATCH_CELL / DETAIL_CELL);
  const out: string[] = [];
  for (let di = 0; di < per; di++) for (let dj = 0; dj < per; dj++) out.push(`${i * per + di},${j * per + dj}`);
  return out;
}

/** A cell's batch out of its cache and its group, disposed. */
export function dropCell(cache: CellCache, key: string, owner: BuildingMeshes | null): void {
  const known = cache.get(key);
  if (!known) return;
  owner?.group.remove(known.part.group);
  known.part.dispose();
  cache.delete(key);
}
