import { pointInPolygon } from '@core/polygon';
import type { Vec2 } from '@core/vec2';
import { migrateBuilding } from '@world/buildings/serialize';
import type { Building } from '@world/buildings/types';
import type { TileRecords } from '@world/doc';
import { tileBuildingsOf } from '@world/growth/grownRows';
import { m } from '@world/units';
import { coverPolygons } from './buildings/layerCells';
import { type GardenPlant, gardenPlants } from './gardens';
import { partsDigest } from './nearContent';
import { TREE_SPECIES } from './propGeometry';

/** WHAT THE NEAR PRODUCTS READ OF A TILE'S BUILDINGS, MADE ONCE A VERSION OF THE TILE (`nearTileBake.ts` NearBaker.buildings): where no plant stands (the cover index's polygons, `layerCells.ts` coverPolygons), the gardens' plants on no ground, and the content they were made of */
/** DO NOT make a tile's buildings again from their rows in every bake that reads them: ~1,500 of a dense tile, two seconds of a worker, for each of the 9 tiles a park's trees read; the woods and the parks' trees never landed (conf25 27-jump-later, 2026-10-17). Kept here where the tile is made (`cityTile.worker.ts`), and by any bake that had to make it, under the tile's version. */

/** The stage's shape (`STAGE_PLANT`): one kept in another is made again, never read. */
export const STAGE_FORMAT = 2;

/** A tile's buildings as the near bakes read them. */
export interface BuildingStage {
  readonly format: number;
  /** The tile's version it was made at (null: from the page's records of a tile it holds edited, never kept). */
  readonly version: number | null;
  /** The digest of the buildings part it was made of (`partsDigest`). */
  readonly content: string;
  /** Each polygon no plant stands in, as its corners' count then its corners (x, y). */
  readonly covers: Float64Array<ArrayBuffer>;
  /** Its gardens' plants, each at height 0 (the bake puts it on the ground), `STAGE_PLANT` numbers each (`stagePlants` reads them back). DO NOT keep them as objects: the store's clone of a dense tile's thousands, their keys with each, is held until the write commits, and the write budget counts the numbers alone (`derivedCache.ts` bytesOf). */
  readonly plants: Float64Array<ArrayBuffer>;
}

/** A plant's numbers in a stage: what it is (`plantCode`), x, y, w, d, h, yaw, seed; its z is 0 in every stage (`stageOf`). */
const STAGE_PLANT = 8;
const PLANT_KINDS: readonly GardenPlant['kind'][] = ['tree', 'shrub', 'hedge', 'flowers'];
/** A plant's kind, species (0: none, else 1 + its place in `TREE_SPECIES`) and plainness (0: unsaid, 1: false, 2: true) as one number. */
const SPECIES_STEP = PLANT_KINDS.length, PLAIN_STEP = SPECIES_STEP * (TREE_SPECIES.length + 1);
const plantCode = (p: GardenPlant): number => PLANT_KINDS.indexOf(p.kind)
  + SPECIES_STEP * (p.species === undefined ? 0 : TREE_SPECIES.indexOf(p.species) + 1) + PLAIN_STEP * (p.plain === undefined ? 0 : p.plain ? 2 : 1);

/** Plants as a stage keeps them (`BuildingStage.plants`). */
function packPlants(plants: readonly GardenPlant[]): Float64Array<ArrayBuffer> {
  const out = new Float64Array(plants.length * STAGE_PLANT);
  plants.forEach((p, i) => out.set([plantCode(p), p.x, p.y, p.w, p.d, p.h, p.yaw, p.seed], i * STAGE_PLANT));
  return out;
}

/** A stage's plants read back as the gardens make them (`gardenPlants`). */
export function stagePlants(stage: BuildingStage): GardenPlant[] {
  const c = stage.plants;
  const out: GardenPlant[] = [];
  for (let k = 0; k + STAGE_PLANT <= c.length; k += STAGE_PLANT) {
    const code = c[k]!;
    const species = Math.floor(code / SPECIES_STEP) % (TREE_SPECIES.length + 1), plain = Math.floor(code / PLAIN_STEP);
    out.push({
      kind: PLANT_KINDS[code % SPECIES_STEP]!, x: c[k + 1]!, y: c[k + 2]!, z: 0, w: c[k + 3]!, d: c[k + 4]!, h: c[k + 5]!, yaw: c[k + 6]!, seed: c[k + 7]!,
      ...(species ? { species: TREE_SPECIES[species - 1]! } : {}), ...(plain ? { plain: plain === 2 } : {}),
    });
  }
  return out;
}

/** Where a tile's stage is kept, under the near bakes' prefix. */
export const stageKey = (prefix: string, tile: number): string => `${prefix}build:${tile}`;

/** A tile's stage from its buildings made (`buildings`) and the records' buildings part they were made from (`records`, for the content). */
function stageOf(records: Partial<TileRecords>, buildings: readonly Building[], version: number | null): BuildingStage {
  const flat: number[] = [];
  for (const b of buildings) {
    for (const ring of coverPolygons(b)) {
      flat.push(ring.length);
      for (const p of ring) flat.push(p.x, p.y);
    }
  }
  return { format: STAGE_FORMAT, version, content: partsDigest(records, ['buildings']), covers: Float64Array.from(flat), plants: packPlants(gardenPlants(buildings, () => 0)) };
}

/** THE STAGE OF A TILE READ FROM ITS RECORDS: its buildings made again from their rows (`tileBuildingsOf`) — the cost this stage is kept to pay once */
export function buildingStage(records: Partial<TileRecords> & Pick<TileRecords, 'buildings'>, version: number | null): BuildingStage {
  const buildings: Building[] = [];
  for (const raw of tileBuildingsOf(records as TileRecords)) { const b = migrateBuilding(raw); if (b) buildings.push(b); }
  return stageOf(records, buildings, version);
}

/** A TILE'S STAGE KEPT WHERE THE TILE WAS JUST MADE (`cityTile.worker.ts`), from its buildings as just grown (`full`: never made again), under the version written: no bake makes them again */
export async function keepTileNearBuildings(records: TileRecords, full: TileRecords, version: number, prefix: string | null,
  cache: { ready(): Promise<boolean>; put(key: string, value: unknown): Promise<void> }): Promise<boolean> {
  if (prefix === null || !(await cache.ready())) return false;
  // Migrated once where the tile was made (`cityTile.worker.ts` migratedOnce): each comes back as it is.
  const buildings: Building[] = [];
  for (const raw of full.buildings) { const b = migrateBuilding(raw); if (b) buildings.push(b); }
  await cache.put(stageKey(prefix, records.key), stageOf(records, buildings, version));
  return true;
}

/** Side of a cover filing's buckets. */
const BUCKET = m(25.6);

/** Whether a point lies in any polygon of some stages (as `layerCells.ts` createCoverIndex answers `covers`). */
export function stagesCover(stages: readonly BuildingStage[]): (x: number, y: number) => boolean {
  const buckets = new Map<number, Vec2[][]>();
  const key = (i: number, j: number): number => i * 100_003 + j;
  for (const stage of stages) {
    const c = stage.covers;
    for (let k = 0; k < c.length;) {
      const n = c[k++]!;
      const ring: Vec2[] = [];
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let q = 0; q < n; q++, k += 2) {
        const p = { x: c[k]!, y: c[k + 1]! };
        ring.push(p);
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
      }
      for (let i = Math.floor(x0 / BUCKET); i <= Math.floor(x1 / BUCKET); i++) {
        for (let j = Math.floor(y0 / BUCKET); j <= Math.floor(y1 / BUCKET); j++) {
          const list = buckets.get(key(i, j));
          if (list) list.push(ring); else buckets.set(key(i, j), [ring]);
        }
      }
    }
  }
  return (x, y) => {
    const list = buckets.get(key(Math.floor(x / BUCKET), Math.floor(y / BUCKET)));
    if (!list) return false;
    const p = { x, y };
    for (const ring of list) if (pointInPolygon(p, ring)) return true;
    return false;
  };
}
