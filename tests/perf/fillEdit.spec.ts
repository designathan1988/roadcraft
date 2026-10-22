import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLargeCityMap } from '@editor/smallCityMap';
import { prepareCity } from '@editor/preparedCity';
import { TILE, TILE_ORIGIN } from '@render/roadSurfaceEntries';
import { ROAD_TYPES } from '@world/roadTypes';
import type { SegmentId } from '@world/ids';
import { installNullPage, primeCookedSurfaces } from '../support/nullGpu';
import { HEIGHT, WIDTH, drawnPieces, openCityMap, type City, type View } from '../support/sceneHarness';

/**
 * A ROAD EDITED DURING THE OPENING'S FILL IS BUILT AT ONCE (`renderer.ts` takeEditedCells): the large city opened on the null GPU as
 * the menu opens it (its view built in detail, every other road at the network's far level, the rest filled a few cells a step after
 * the curtain), and while the fill is still under way the road farthest from the view - the last the fill would come to - changed to
 * another class. The edit's own build makes that road's cell in detail and lets the far level's old outline of it go, the fill still
 * far from done.
 */

const OPEN: View = [0, 0, 1.8, 45, 79];
/** The far level's cells (`renderer.ts` FAR_ROAD_CELL): eight road tiles. */
const FAR_CELL = 8 * TILE;

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
async function frame(city: City): Promise<void> {
  if (city.net.revision !== city.doc.revision) city.net.rebuild();
  city.scene.draw(city.net, city.sim, 1, 1 / 60);
  await turn();
}

/** The world boxes (plan x0, y0, x1, y1) of the visible meshes whose name passes `named`. */
function boxes(city: City, named: (name: string) => boolean): [number, number, number, number][] {
  // The scene's z is the plan's -y.
  return drawnPieces(city.scene.scene, named).map(({ box }) => [box.min.x, -box.max.z, box.max.x, -box.min.z]);
}

const covers = (list: readonly (readonly [number, number, number, number])[], x: number, y: number): boolean =>
  list.some(([x0, y0, x1, y1]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);

describe('a road edited during the opening\'s fill', () => {
  let page: { restore(): void };
  let result: { fillLeftAtEdit: number; fillLeftAfter: number; frames: number; farBefore: boolean; farAfter: boolean; detailAfter: boolean };
  beforeAll(async () => {
    page = installNullPage(WIDTH, HEIGHT, process.cwd());
    primeCookedSurfaces(process.cwd());
    const { data, buildings } = prepareCity(buildLargeCityMap(7));
    const { city } = await openCityMap(data, buildings, { large: true, view: OPEN });
    try {
      // The fill under way: its first cells taken.
      for (let i = 0; i < 400 && city.scene.openingState().fillCellsLeft === 0; i++) await frame(city);
      // The road farthest from the view, in a cell of the far level the fill has not come to.
      let far: { id: SegmentId; x: number; y: number; d: number } | null = null;
      for (const [id, ribbon] of city.net.ribbons) {
        const p = ribbon.full.sampleAt(ribbon.full.length / 2).p;
        const d = Math.hypot(p.x, p.y);
        if (!far || d > far.d) far = { id: id as SegmentId, x: p.x, y: p.y, d };
      }
      const cellOf = (v: number): number => Math.floor((v - TILE_ORIGIN) / FAR_CELL);
      const [i, j] = [cellOf(far!.x), cellOf(far!.y)];
      const centre = { x: TILE_ORIGIN + (i + 0.5) * FAR_CELL, y: TILE_ORIGIN + (j + 0.5) * FAR_CELL };
      const farOf = (): [number, number, number, number][] => boxes(city, (name) => name === 'road-far-network')
        .filter(([x0, y0, x1, y1]) => (x0 + x1) / 2 >= centre.x - FAR_CELL / 2 && (x0 + x1) / 2 <= centre.x + FAR_CELL / 2 && (y0 + y1) / 2 >= centre.y - FAR_CELL / 2 && (y0 + y1) / 2 <= centre.y + FAR_CELL / 2);
      const farBefore = farOf().length > 0;
      const fillLeftAtEdit = city.scene.openingState().fillCellsLeft;
      const segment = city.doc.segments.get(far!.id)!;
      city.doc.setSegmentType(far!.id, (segment.type + 1) % ROAD_TYPES.length);
      // Frames till the cell's far level goes (the edit's build landed: one build, a step of it a frame), or they run out.
      let frames = 0;
      for (; frames < 1500 && farOf().length > 0; frames++) await frame(city);
      for (let k = 0; k < 3; k++) await frame(city);
      result = {
        fillLeftAtEdit, fillLeftAfter: city.scene.openingState().fillCellsLeft, frames, farBefore, farAfter: farOf().length > 0,
        detailAfter: covers(boxes(city, (name) => name.startsWith('asphalt')), far!.x, far!.y),
      };
      if (process.env['FILL_EDIT_OUT']) writeFileSync(process.env['FILL_EDIT_OUT'], JSON.stringify(result));
    } finally {
      city.scene.dispose();
    }
  }, 1_500_000);
  afterAll(() => page.restore());

  it('builds the edited road\'s cell in detail and lets its old far outline go before the fill comes to it', () => {
    expect(result.farBefore, 'the cell stood in the far level before the edit').toBe(true);
    expect(result.fillLeftAtEdit).toBeGreaterThan(1);
    expect(result.detailAfter, `the edited road drawn in detail (${result.frames} frames)`).toBe(true);
    expect(result.farAfter, 'the far level\'s old outline of the cell gone').toBe(false);
    expect(result.fillLeftAfter, 'the fill still under way').toBeGreaterThan(0);
  });
});
