import { flatGroundFor } from '@world/flatEarth';
import { tileGround } from '@world/planet/relief';
import type { ReliefVersion } from '@world/terrain';
import { buildPlateMesh } from './plateMesh';
import { cornerLand, woodsBase } from './woodsBase';
import { tileCentre } from '@world/planet/atlas';

/**
 * A plate of the whole flat Earth's land off the page's thread
 * (`flatGroundPool.ts`): the land's height at each of the plate's grid
 * corners (rows from its north edge down, as the terrain's grid), sent back
 * as a transferred buffer with the job's id. Reading the Earth's field at the
 * 90 601 corners of a plate took the page a few hundred milliseconds - a
 * hitch at every plate a zoom or a drag brought in (profiled 2026-10-11).
 * And the plate's first build from them (`plateMesh.ts`): its normals and
 * steepness, which were the rest of a plate's frame.
 */
/** `tile` >= 0: a planet's piece, its land on its own map (`planet/relief.ts` tileGround), `cx`, `cy` 0; else the flat Earth's, world coordinates. */
interface Ask { readonly id: number; readonly relief: ReliefVersion; readonly tile: number; readonly cx: number; readonly cy: number; readonly half: number; readonly cell: number; readonly side: number; readonly base: number }

let relief: ReliefVersion | null = null;
let flatLand: (x: number, y: number) => number = () => 0;

self.onmessage = (event: MessageEvent<Ask>) => {
  const { id, tile, cx, cy, half, cell, side, base } = event.data;
  try {
    if (event.data.relief !== relief) { relief = event.data.relief; flatLand = flatGroundFor(relief); }
    const land = tile >= 0 ? tileGround(tile, event.data.relief) : flatLand;
    const heights = new Float64Array(side * side);
    for (let j = 0; j < side; j++) {
      const y = cy + half - j * cell;
      for (let i = 0; i < side; i++) heights[j * side + i] = land(cx - half + i * cell, y);
    }
    const mesh = buildPlateMesh(heights, side, half, cell, base);
    // The woods' density but the ecosystem's share, on the same natural land (`woodsBase.ts`).
    const centre = tile >= 0 ? tileCentre(tile) : { x: cx, y: cy };
    const natural = cornerLand(mesh.heights, mesh.flip, side, half, cell, (x, y) => base + land(cx + x, cy + y));
    mesh.woods = woodsBase(natural, half, centre.x, centre.y, tile >= 0);
    (self as unknown as { postMessage(message: unknown, transfer: Transferable[]): void }).postMessage({ id, mesh },
      [mesh.heights.buffer, mesh.flip.buffer, mesh.normals.buffer, mesh.steep.buffer, mesh.woods.buffer]);
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
