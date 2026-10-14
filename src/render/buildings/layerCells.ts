import { Group } from 'three';
import { Digest } from '@core/digest';
import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import type { GroundAt, PavedAt } from '@world/buildings/foundation';
import { buildingBounds, footprintRects, solidFootprints } from '@world/buildings/geometry';
import type { Building } from '@world/buildings/types';
import { m } from '@world/units';
import { type BuildingChunk, type BuildingMeshes, type PartBatch, assembleBuildingMeshes } from './buildingMesh';
import { type BuildingKit, PART_KINDS, type PartKind } from './kit';
import type { ShellBatches } from './shellBatches';

/**
 * THE CELLS OF THE BUILDINGS LAYER (`layer.ts`): the constants of the grid and
 * of its slices, the ground fingerprint, the plant cull's footprint index and the batching
 * of a list of buildings by cell. Pure helpers, no state of the layer.
 */

/**
 * A fingerprint of the ground under and around a building: a 6 x 6 grid over
 * its bounds grown by two modules (the entrance steps land out there), of the
 * land and of the paving. Any change the foundation could see changes this.
 */
export function groundDigest(b: Building, groundAt: GroundAt, pavedAt?: PavedAt): string {
  const box = buildingBounds(b, b.module * 2);
  let out = '';
  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const x = box.minX + ((box.maxX - box.minX) * i) / 5;
      const y = box.minY + ((box.maxY - box.minY) * j) / 5;
      out += `${groundAt(x, y).toFixed(2)}${pavedAt ? `/${pavedAt(x, y).toFixed(2)}` : ''},`;
    }
  }
  return out;
}
/** Milliseconds a frame spent emitting the buildings of a change (`update`). */
export const WARM_SLICE_MS = 6;
/** Milliseconds a frame while a whole town is loaded (Unity, backgroundLoadingPriority High). */
export const LOADING_SLICE_MS = 50;
/**
 * Milliseconds a frame while a town loads behind the loading curtain: nothing
 * is presented, so the frame is the load's (Unity's
 * `allowSceneActivation = false`: loaded whole in the background, then shown).
 */
export const HIDDEN_SLICE_MS = 250;
/** More buildings than this not made yet: a load, not an edit. */
export const LOADING_COUNT = 100;
/**
 * Frames a cell stays made after it went far (ten seconds at sixty), for the
 * camera that comes back: made again at once it would thrash at the edge.
 */
export const RELEASE_FRAMES = 600;
/**
 * Bytes of buildings' full chunks kept for the cells not drawn in detail
 * (`layer.ts` `trimChunkCache`), so a camera coming back finds them made: a
 * cache budget with the cells in view allowed over it, as Cesium's
 * `cacheBytes` / `maximumCacheOverflowBytes`; past it the cells least
 * recently near are slimmed first (LRU). Far cells slimmed at once were
 * emitted again at every return of the camera - seconds of empty lots.
 */
export const CHUNK_CACHE_BYTES = 768 * 1024 * 1024;
/** Cells streamed in at most in one frame (`streamCells`), each within the frame's slice. */
export const STREAM_CELLS_PER_FRAME = 4;
/** The bytes of a building's full chunk: its shells' and parts' arrays (what `slim` lets go). */
export function chunkBytes(chunk: BuildingChunk): number {
  let n = 0;
  for (const shell of Object.values(chunk.shells)) if (shell) n += shell.position.byteLength + shell.normal.byteLength + shell.colour.byteLength + shell.uv.byteLength + shell.index.byteLength + shell.decay.byteLength;
  for (const batch of Object.values(chunk.parts)) n += batch.matrices.byteLength + (batch.colours?.byteLength ?? 0) + (batch.slots?.byteLength ?? 0) + (batch.rooms?.byteLength ?? 0);
  return n;
}
/** A slimmed building's parts: none (`layer.ts` `slim`). */
export const EMPTY_PARTS: Readonly<Record<PartKind, PartBatch>> = Object.fromEntries(
  PART_KINDS.map((kind) => [kind, { matrices: new Float32Array(0), colours: null, count: 0 }]),
) as Record<PartKind, PartBatch>;
/** Side of the cells the buildings are batched in, world units. */
export const BATCH_CELL = m(240);
export const DETAIL_CELL = m(120);
/** A window frame's side, m (`buildingMesh.ts`, the frames' depth). */
export const FRAME_SIDE = m(0.06);
/** A detail cell's frames and railings are drawn whole while a frame's side spans this many pixels (`cullDetails`). */
export const FULL_DETAIL_PIXELS = 0.4;
export const DETAIL_HYSTERESIS = 0.1;
// Frozen tables, not state (`eslint-rules/no-module-state.js`).
export const DETAIL_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(['frame', 'railing', 'roofRailing', 'louvre']));
export const COARSE_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set(PART_KINDS.filter((kind) => !DETAIL_PARTS.has(kind))));

/**
 * The buildings batched cell by cell, each cell its own meshes: a cell out of
 * the view (and out of the shadow's) is not drawn at all. One batch for the
 * whole town sent every window frame and railing in it to the GPU, twice a
 * frame (picture and shadow), wherever the camera looked.
 */
/** A cell's batch and the buildings' meshes it was assembled from. */
export type CellCache = Map<string, { chunks: readonly BuildingChunk[]; part: BuildingMeshes }>;

/**
 * The buildings batched by cell of the map. A cell whose buildings' meshes
 * are the very ones it was assembled from (each building's are kept while it
 * is unchanged, `chunkFor`) keeps its batch; only the cells an edit touched
 * are assembled and sent to the GPU again. Every cell of the town was, for a
 * storey added to one building - as voxel and tile engines rebuild only the
 * chunks an edit made dirty.
 */
/** The buildings' chunks by cell, in list order. */
export function chunksByCell(buildings: readonly Building[], chunkOf: (b: Building) => BuildingChunk, cellSize: number): Map<string, BuildingChunk[]> {
  const byCell = new Map<string, BuildingChunk[]>();
  for (const b of buildings) {
    const key = `${Math.floor(b.x / cellSize)},${Math.floor(b.y / cellSize)}`;
    const list = byCell.get(key);
    if (list) list.push(chunkOf(b));
    else byCell.set(key, [chunkOf(b)]);
  }
  return byCell;
}

export const sameChunks = (a: readonly BuildingChunk[], b: readonly BuildingChunk[]): boolean =>
  a.length === b.length && a.every((c, i) => c === b[i]);

export function assembleByCell(buildings: readonly Building[], chunkOf: (b: Building) => BuildingChunk,
  kit: BuildingKit, cache: CellCache, cellSize: number, partKinds: ReadonlySet<PartKind>, staged?: CellCache, batches?: ShellBatches): BuildingMeshes {
  const byCell = chunksByCell(buildings, chunkOf, cellSize);
  const group = new Group();
  group.name = 'buildings';
  group.matrixAutoUpdate = false;
  group.updateMatrix();
  for (const [key, chunks] of byCell) {
    const known = cache.get(key);
    let part: BuildingMeshes;
    const ready = staged?.get(key);
    if (known && sameChunks(known.chunks, chunks)) {
      part = known.part;
    } else if (ready && sameChunks(ready.chunks, chunks)) {
      // Put together ahead, a cell a frame (`update`).
      known?.part.dispose();
      part = ready.part;
      staged!.delete(key);
      cache.set(key, { chunks, part });
    } else {
      known?.part.dispose();
      part = assembleBuildingMeshes(chunks, kit, false, false,
        { parts: partKinds, shells: partKinds === COARSE_PARTS, furniture: partKinds === COARSE_PARTS, ...(batches ? { batches } : {}) });
      cache.set(key, { chunks, part });
    }
    group.add(part.group);
  }
  // Cells left with no building, or drawn far (their detail is not made).
  for (const [key, known] of cache) {
    if (byCell.has(key)) continue;
    known.part.dispose();
    cache.delete(key);
  }
  return {
    group,
    // The cells in the cache are the ones in this group: streamed in and out after this (`streamCells`).
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

/**
 * Where the buildings stand, for the scenery's plant cull: the built parts
 * with a margin for the crowns and the open lots as they are (grown round the
 * lots too, every street tree on a pavement a facade stands on was taken away
 * and left its pit empty), bucketed on a coarse grid (a cell as one number: a
 * string per query was most of a plant pass). Each record's footprints are
 * worked out once per record object, not for the whole town at every change of
 * one building. `version` moves only when what `covers` answers changes: a
 * building drawn again for its paint or its age leaves the plants round it alone.
 */
export function createCoverIndex(): { index(buildings: Iterable<Building>): void; covers(x: number, y: number): boolean; readonly version: number } {
  const footprints = new WeakMap<Building, Vec2[][]>();
  let buckets = new Map<number, Vec2[][]>();
  const bucketKey = (i: number, j: number): number => i * 100_003 + j;
  let digestWas = -1;
  let version = 0;
  return {
    index(buildings) {
      buckets = new Map();
      const digest = new Digest();
      for (const b of buildings) {
        let rects = footprints.get(b);
        if (!rects) {
          rects = [...solidFootprints(b, PLANT_MARGIN), ...footprintRects(b)];
          footprints.set(b, rects);
        }
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
              const list = buckets.get(key);
              if (list) list.push(rect);
              else buckets.set(key, [rect]);
            }
          }
        }
      }
      const value = digest.value();
      if (value !== digestWas) {
        digestWas = value;
        version++;
      }
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
