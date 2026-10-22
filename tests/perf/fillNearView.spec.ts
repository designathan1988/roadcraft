import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLargeCityMap } from '@editor/smallCityMap';
import { prepareCity } from '@editor/preparedCity';
import { TILE, TILE_ORIGIN } from '@render/roadSurfaceInputs';
import { m } from '@world/units';
import { installNullPage, primeCookedSurfaces } from '../support/nullGpu';
import { HEIGHT, WIDTH, drawnPieces, openCityMap, setView, type City, type View } from '../support/sceneHarness';

/**
 * THE OPENING'S FILL BUILDS THE VIEW'S ROADS FIRST, WHEREVER THE CAMERA GOES (`renderer.ts` fillStep): the city of the 25,000-building
 * step (`scripts/look/step-25k.json`: seed 7 over 2,800 m) opened on the null GPU, the camera taken to each corner in turn once the
 * fill is under way; within a few steps the road block under it is drawn by its detailed blocks (markings, crossings, kerbs), and the
 * network's far level (`networkFarRoads.ts`) no longer draws there.
 */

/** A road block's side, the far level's cells (`renderer.ts` FAR_ROAD_CELL). */
const CELL = 8 * TILE;
/** The frames the corner's block may take to be drawn in detail: the fill's step under way when the camera moved, and the corner's own
 *  (on the null GPU no road tile worker is made: each tile is built on the page, a frame each, ~600 frames a step of four cells). The
 *  whole map's fill in one build, as it was, came in at its end only (step-25k 89-ne-district, a minute after the curtain). */
const MOST_FRAMES = 1500;

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
async function frame(city: City): Promise<void> {
  if (city.net.revision !== city.doc.revision) city.net.rebuild();
  city.scene.draw(city.net, city.sim, 1, 1 / 60);
  await turn();
}

const cellOf = (x: number, y: number): string => `${Math.floor((x - TILE_ORIGIN) / CELL)},${Math.floor((y - TILE_ORIGIN) / CELL)}`;

/** The triangles each kind of road mesh draws in a cell: the detailed blocks' carriageway (`asphalt...`), and the network's far level. */
function drawnIn(city: City, key: string): { detailed: number; network: number } {
  const out = { detailed: 0, network: 0 };
  for (const network of [true, false]) {
    for (const { box, triangles } of drawnPieces(city.scene.scene, (name) => (network ? name === 'road-far-network' : name.startsWith('asphalt')))) {
      // The scene's z is the plan's -y; a block (a cell of the far level) lies in one cell: its middle tells which.
      if (cellOf((box.min.x + box.max.x) / 2, -(box.min.z + box.max.z) / 2) !== key) continue;
      if (network) out.network += triangles; else out.detailed += triangles;
    }
  }
  return out;
}

interface Corner { readonly name: string; readonly frames: number; readonly ms: number; readonly cellsLeft: number; readonly detailed: number; readonly network: number }

describe('the opening fill builds the view first', () => {
  let page: { restore(): void };
  const corners: Corner[] = [];
  beforeAll(async () => {
    page = installNullPage(WIDTH, HEIGHT, process.cwd());
    primeCookedSurfaces(process.cwd());
    const { data, buildings } = prepareCity(buildLargeCityMap(7, m(2800)));
    const { city } = await openCityMap(data, buildings, { large: true, view: [0, 0, 1.8, 45, 79] });
    try {
      // The fill begins once the roads past the opening are solved (`completeSolve`).
      for (let i = 0; i < 600 && city.scene.openingState().fillCellsLeft === 0; i++) await frame(city);
      process.stderr.write(`[fill] started, ${city.scene.openingState().fillCellsLeft} cells left
`);
      const reach = m(2400);
      for (const [name, x, y] of [['ne', 0.7, 0.7], ['sw', -0.7, -0.7], ['nw', -0.7, 0.7], ['se', 0.7, -0.7]] as const) {
        const view: View = [x * reach, y * reach, 2.5, 45, 48];
        setView(city.scene, view);
        const key = cellOf(view[0], view[1]);
        const since = performance.now();
        let frames = 0, drawn = drawnIn(city, key);
        for (; frames < MOST_FRAMES && !(drawn.detailed > 0 && drawn.network === 0); frames++) {
          await frame(city);
          drawn = drawnIn(city, key);
        }
        corners.push({ name, frames, ms: Math.round(performance.now() - since), cellsLeft: city.scene.openingState().fillCellsLeft, ...drawn });
        process.stderr.write(`[fill] ${JSON.stringify(corners[corners.length - 1])}
`);
      }
    } finally {
      city.scene.dispose();
    }
  }, 1_500_000);
  afterAll(() => page.restore());

  it('draws the block under the camera in detail within a few steps at each corner', () => {
    expect(corners.length).toBe(4);
    for (const c of corners) {
      expect(c.detailed, `${c.name}: detailed road triangles under the camera`).toBeGreaterThan(0);
      expect(c.network, `${c.name}: far network triangles under the camera`).toBe(0);
      expect(c.frames, `${c.name}: frames to the detailed roads`).toBeLessThan(MOST_FRAMES);
    }
  });
});
