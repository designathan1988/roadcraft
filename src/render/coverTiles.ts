import { Digest } from '@core/digest';
import { PLATE_SIZE, plateOf } from '@world/bounds';
import { onCarriageway } from '@world/carriageway';
import { type CoverKind, type PaintDab, isCoverKind } from '@world/terrainPaint';
import { TILE, tileOfKey } from '@world/tiles';
import type { TreeClearing } from '@world/trees';
import { m } from '@world/units';
import { stagesCover } from './nearBuildings';
import { KEEP_CELL, keepCellKey, keepCellOf } from './candidateKeep';
import { ClearingCells } from './clearingCells';
import { COVER_SWEEP_PAD, type Candidate, type CoverField, forestIn, rocksIn, scrubIn } from './coverSweep';
import { COVER_POSE, FOREST_SPECIES, type ForestSpecies, type GroundCoverKit, type TreePlacement } from './groundCover';
import { type Run, RunBuilder } from './instanceRuns';
import { TREE_POSE } from './natureTrees';
import type { NearBaker, NearProduct } from './nearTileBake';
import { type PlantCells, coverInto, coverLayout, treesInto } from './plantCells';
import { runBuffers } from './streetFurnitureLayer';
import { type PlateCover, coverOf, geologyOf, layCover, plateCover } from './coverRaster';
import { TERRAIN_HALF } from './terrainGrid';

/** A TILE'S PAINTED COVER AS A NEAR PRODUCT (`nearTiles.ts`): the stones, the scrub and the painted woods the player's cover brush laid, swept a keep cell at a time as the page sweeps them (`coverSweep.ts`) from the plates' cover densities laid from the dabs as the plate lays them (`terrain.ts` layCover), standing where the page's keeps let them (off the carriageway, out of the buildings, the woods out of the clearings), baked in a worker; the rivers' stones stay the plates' (`ShorePlates`) */

/** What a cover bake reads from the page: the cover kit's models (`createCoverCells`'s stores), the woods' kit (none yet: 0), whether the card trees stand in for its trees, the clearings reaching the tile. */
export interface CoverExtra {
  readonly models: { readonly rocks: number; readonly scrub: number; readonly trees: Readonly<Record<ForestSpecies, number>> };
  readonly variants: number;
  readonly standIns: boolean;
  readonly clearings: readonly TreeClearing[];
}

/** A tile's painted cover as a bake hands it: its stones, scrub (and card trees) in the cover layer's stores, its woods' trees in the painted forest's. */
export interface CoverBake {
  readonly cover: Run | null;
  readonly forest: Run | null;
}

/** How far round the tile its cells' neighbours are swept: a wood's tree is shaped by the trees of the cells round its own (`standsAmong`). */
const AROUND = KEEP_CELL;

/** The cover densities and rock of the plates over a box, laid from the dabs in their order as each plate lays its own. */
function platesOver(box: readonly [number, number, number, number], dabs: readonly PaintDab[]): Map<number, PlateCover & { readonly cx: number; readonly cy: number }> {
  const out = new Map<number, PlateCover & { readonly cx: number; readonly cy: number }>();
  const pi0 = Math.floor(box[0] / PLATE_SIZE + 0.5), pi1 = Math.floor(box[2] / PLATE_SIZE + 0.5);
  const pj0 = Math.floor(box[1] / PLATE_SIZE + 0.5), pj1 = Math.floor(box[3] / PLATE_SIZE + 0.5);
  for (let pi = pi0; pi <= pi1; pi++) {
    for (let pj = pj0; pj <= pj1; pj++) {
      const cx = pi * PLATE_SIZE, cy = pj * PLATE_SIZE;
      const plate = { ...plateCover(), cx, cy };
      // A dab reaching the plate, moved to its frame (`flatAtlas.ts` copyOn).
      for (const d of dabs) {
        if (Math.abs(d.x - cx) > TERRAIN_HALF + d.radius || Math.abs(d.y - cy) > TERRAIN_HALF + d.radius) continue;
        layCover(plate, { ...d, x: d.x - cx, y: d.y - cy });
      }
      out.set(plateOf(cx, cy), plate);
    }
  }
  return out;
}

/** THE TILE'S OWN KEEP CELLS' COVER (the cells of 64 m fall whole in a tile), swept from the dabs of the 3 x 3 read: its neighbours' dabs reaching over its edge laid too */
export const coverBaker: NearBaker<CoverBake | null, CoverExtra> = {
  parts: ['rest'],
  // The roads of a tile with cover only; the buildings read off each tile's kept stage (`nearBuildings.ts`), never made again from their rows here.
  more: ['roads'],
  buildings: 'around',
  around: true,
  // A stone or a tree stands on the ground as drawn.
  groundReach: AROUND + COVER_SWEEP_PAD,
  // The clearings the woods keep out of.
  readKey: (extra) => new Digest().addPlain(extra.clearings).value(),
  has(tiles) {
    const { i, j } = tileOfKey(tiles[0]!.key);
    const x0 = i * TILE - AROUND - COVER_SWEEP_PAD, y0 = j * TILE - AROUND - COVER_SWEEP_PAD, x1 = (i + 1) * TILE + AROUND + COVER_SWEEP_PAD, y1 = (j + 1) * TILE + AROUND + COVER_SWEEP_PAD;
    return tiles.some((t) => (t.paint as readonly PaintDab[]).some((d) => isCoverKind(d.kind) && d.x + d.radius >= x0 && d.x - d.radius <= x1 && d.y + d.radius >= y0 && d.y - d.radius <= y1));
  },
  bake(area, extra) {
    const { i, j } = tileOfKey(area.key);
    const x0 = i * TILE, y0 = j * TILE;
    const reach = AROUND + COVER_SWEEP_PAD;
    // DO NOT lay the dabs in the order the tiles were read: a dab moves the density towards its own, so two overlapping ones of two tiles give another density in the other order, and two bakes side by side would sweep their shared edge differently. Every bake lays them by tile key, each tile's in its own order (the page laid them in the order its tiles came in, no fixed one).
    const plates = platesOver([x0 - reach, y0 - reach, x0 + TILE + reach, y0 + TILE + reach], [...area.tiles].sort((a, b) => a.key - b.key).flatMap((t) => t.paint as readonly PaintDab[]));
    const plateAt = (x: number, y: number): (PlateCover & { readonly cx: number; readonly cy: number }) | undefined => plates.get(plateOf(x, y));
    const field: CoverField = {
      forestAt: (x, y) => { const p = plateAt(x, y); return p ? coverOf(p.covers, 'forest', x - p.cx, y - p.cy) : 0; },
      coverAt: (kind: CoverKind, x, y) => { const p = plateAt(x, y); return p ? coverOf(p.covers, kind, x - p.cx, y - p.cy) : 0; },
      shoreLevelAt: () => null,
    };
    const net = area.net();
    const covers = stagesCover(area.tiles.map((_, n) => area.buildings(n)));
    const clearings = new ClearingCells();
    clearings.follow(extra, extra.clearings);
    // As the page's keeps test them (`renderer.ts` coverKeeps).
    const free = (x: number, y: number): boolean => !onCarriageway(net, { x, y }) && !covers(x, y);
    const placed = (c: Candidate): Candidate & { readonly z: number } => ({ ...c, z: area.groundAt(c.x, c.y) });
    const ci0 = Math.floor(x0 / KEEP_CELL), cj0 = Math.floor(y0 / KEEP_CELL), cells = TILE / KEEP_CELL;
    /** Each cell's standing woods, the tile's and the ring round it. */
    const woods = new Map<number, TreePlacement[]>();
    for (let ci = ci0 - 1; ci <= ci0 + cells; ci++) {
      for (let cj = cj0 - 1; cj <= cj0 + cells; cj++) {
        const key = keepCellKey(ci, cj);
        const standing = forestIn(key, field).filter((c) => free(c.x, c.y) && !clearings.has(c.x, c.y)).map((c) => placed(c) as TreePlacement);
        if (standing.length) woods.set(key, standing);
      }
    }
    const { layout, stores } = coverLayout(extra.models.rocks, extra.models.scrub, extra.models.trees);
    const coverRun = new RunBuilder(Array.from({ length: stores }, () => ({ tinted: true })), COVER_POSE);
    const forestRun = !extra.standIns && extra.variants > 0 ? new RunBuilder(Array.from({ length: extra.variants }, () => ({ tinted: true })), TREE_POSE) : null;
    for (let ci = ci0; ci < ci0 + cells; ci++) {
      for (let cj = cj0; cj < cj0 + cells; cj++) {
        const key = keepCellKey(ci, cj);
        const rocks = rocksIn(key, field).filter((c) => free(c.x, c.y)).map((c) => {
          const p = plateAt(c.x, c.y);
          return { ...placed(c), rock: p ? geologyOf(p.sand, p.basalt, c.x - p.cx, c.y - p.cy) : 'granite' as const };
        });
        const scrub = scrubIn(key, field).filter((c) => free(c.x, c.y)).map((c) => ({ x: c.x, y: c.y, z: area.groundAt(c.x, c.y), size: c.size, yaw: c.yaw, seed: c.seed }));
        const own = woods.get(key) ?? [];
        coverInto(coverRun, layout, rocks, scrub, extra.standIns ? own : []);
        if (forestRun && own.length) {
          const [ki, kj] = keepCellOf(key);
          const among: TreePlacement[] = [];
          for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) among.push(...(woods.get(keepCellKey(ki + di, kj + dj)) ?? []));
          treesInto(forestRun, own, among, extra.variants);
        }
      }
    }
    const c = coverRun.build(), f = forestRun?.build() ?? null;
    const bake = { cover: c.size ? c : null, forest: f && f.size ? f : null };
    return bake.cover || bake.forest ? bake : null;
  },
  buffers: (bake) => (bake ? [...runBuffers(bake.cover), ...runBuffers(bake.forest)] : []),
};

/** What a tile's cover bake reads from the page (`CoverExtra`): the cover kit's models, the woods' kit's, the stand-ins' flag, and the clearings reaching the tile's cells and the ring round them. */
export function coverExtraFor(tile: number, kit: GroundCoverKit, variants: number, standIns: boolean, clearings: readonly TreeClearing[]): CoverExtra {
  const { i, j } = tileOfKey(tile);
  const pad = AROUND + COVER_SWEEP_PAD;
  const x0 = i * TILE - pad, y0 = j * TILE - pad, x1 = (i + 1) * TILE + pad, y1 = (j + 1) * TILE + pad;
  const trees = Object.fromEntries(FOREST_SPECIES.map((species) => [species, kit.trees[species].length])) as unknown as Record<ForestSpecies, number>;
  return {
    models: { rocks: kit.rocks.length, scrub: kit.scrub.length, trees }, variants, standIns,
    clearings: clearings.filter((c) => c.x + c.radius >= x0 && c.x - c.radius <= x1 && c.y + c.radius >= y0 && c.y - c.radius <= y1),
  };
}

/** A tile's painted cover as the page draws it: its stones and scrub in the cover layer's cells, its woods in the painted forest's (each made once, `coverCells`, `forest`). */
export function coverProduct(page: {
  readonly coverCells: () => PlantCells;
  readonly forest: () => PlantCells | null;
  readonly extra: (tile: number) => CoverExtra;
  readonly version: () => string;
}): NearProduct<CoverBake> {
  return {
    kind: 'covers',
    // A wood's tree, ten metres and more, seen as its picture from afar; a stone a pixel across far nearer (`cellInstances.ts` levels).
    // Out to where a tree or a pier is a couple of pixels tall (DO NOT reach out to 6 km: dozens of tiles of roads solved, behind the street's cells).
    cover: m(3) * m(3),
    top: m(20),
    version: page.version,
    extra: page.extra,
    land(bake) {
      const cells = bake.cover ? page.coverCells() : null, forest = bake.forest ? page.forest() : null;
      return {
        put: () => { if (bake.cover) cells!.put(bake.cover); if (bake.forest) forest?.put(bake.forest); },
        remove: () => { if (bake.cover) cells!.take(bake.cover); if (bake.forest) forest?.take(bake.forest); },
      };
    },
  };
}
