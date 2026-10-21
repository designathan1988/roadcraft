import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BatchedMesh, InstancedMesh, Object3D } from 'three';

import { Engine } from '@core/engine';
import { restoreInto } from '@editor/history';
import { buildSmallCityMap } from '@editor/smallCityMap';
import { createSceneRenderer, type SceneHandle } from '@render/renderer';
import { SimClient } from '@sim/host/simClient';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { RELIEF_FLAT } from '@world/terrain';
import { NullCanvas, installNullPage, nullRenderer, primeCookedSurfaces } from '../support/nullGpu';

/**
 * THE SCENE AS THE GAME WOULD DRAW IT, WITHOUT OPENING THE GAME: the real scene renderer (`createSceneRenderer`) on a GPU that draws
 * nothing (`tests/support/nullGpu.ts`: three's own WebGLRenderer on a null WebGL2 context), the small city of seed 7 opened as the menu
 * opens it (`main.ts` openCity: `restoreInto`, `beginLoad`, frames until the curtain comes down, `opening:shown`), then the two views
 * the game's photographs are taken from (`scripts/look/verify.json`: the district over the centre, the street) settled, and what each
 * would draw counted: every visible mesh, instanced mesh (its count), batched mesh (its visible instances), points and line, by name
 * with its digits taken out, and the draws and triangles three issued for the frame (`renderer.info.render`: the colour pass, the
 * shadows and the post chain, after three's own frustum culling). No GPU, no browser, no worker (their jobs run on the page's thread).
 * A layer that stops drawing shows here as a count that fell; a change made on purpose updates the numbers in the same commit, and says why.
 */

const WIDTH = 1280;
const HEIGHT = 720;
/** Frames the opening, or a view, may take before the census gives up on it. */
const MOST_FRAMES = 600;
/** Frames in a row with the same count for a view to be taken as settled. */
const STILL_FRAMES = 8;
/** The views of the game's photographs (`scripts/look/verify.json` setView): x, y, zoom, azimuth and elevation in degrees. */
const DISTRICT = [0, 0, 2.5, 45, 48] as const;
const STREET = [60, 0, 5, 20, 35] as const;

let page: { restore(): void };
beforeAll(() => {
  page = installNullPage(WIDTH, HEIGHT, process.cwd());
  primeCookedSurfaces(process.cwd());
});
afterAll(() => page.restore());

/** A turn of the event loop: what the frame left to promises, imports and timers runs, as between two animation frames. */
const turn = (): Promise<void> => new Promise((done) => setImmediate(done));

interface City { readonly scene: SceneHandle; readonly doc: RoadDoc; readonly net: Network; readonly sim: SimClient }

/** One frame as `main.ts` draws it: the network caught up, the scene drawn, the page's loop turned. */
async function frame(city: City): Promise<void> {
  if (city.net.revision !== city.doc.revision) city.net.rebuild();
  city.scene.draw(city.net, city.sim, 1, 1 / 60);
  await turn();
}

/** The camera where `window.__roadcraft.setView` puts it (`main.ts`). */
function setView(scene: SceneHandle, [x, y, zoom, azimuth, elevation]: readonly number[]): void {
  const view = scene.viewport;
  view.moveTo({ x: x!, y: y! });
  view.zoomAt(WIDTH / 2, HEIGHT / 2, zoom! / Math.max(0.001, view.zoom), WIDTH, HEIGHT);
  view.setOrbit((azimuth! * Math.PI) / 180, (elevation! * Math.PI) / 180);
  view.moveTo({ x: x!, y: y! });
}

interface Counted { objects: number; drawn: number }
interface Census { byName: Record<string, Counted>; objects: number; drawn: number; draws: number; triangles: number; points: number; lines: number }

/** Every visible drawable under the scene, by name without digits (how many objects, how many things drawn), and three's last frame. */
function census(scene: SceneHandle): Census {
  const byName = new Map<string, Counted>();
  let objects = 0, drawn = 0;
  scene.scene.traverseVisible((o: Object3D) => {
    const kind = o as Object3D & { isMesh?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; isPoints?: boolean; isLine?: boolean };
    if (!kind.isMesh && !kind.isPoints && !kind.isLine) return;
    let things = 1;
    if (kind.isInstancedMesh) things = (o as InstancedMesh).count;
    else if (kind.isBatchedMesh) {
      // Its visible instances (three r186 keeps them in `_instanceInfo`; `instanceCount` counts the hidden too).
      const info = (o as BatchedMesh & { _instanceInfo: readonly { active: boolean; visible: boolean }[] })._instanceInfo;
      things = info.reduce((n, i) => n + (i.active && i.visible ? 1 : 0), 0);
    }
    const name = (o.name || o.type).replace(/\d+/g, '');
    const row = byName.get(name) ?? { objects: 0, drawn: 0 };
    row.objects++;
    row.drawn += things;
    byName.set(name, row);
    objects++;
    drawn += things;
  });
  const sorted: Record<string, Counted> = {};
  for (const key of [...byName.keys()].sort()) sorted[key] = byName.get(key)!;
  const render = scene.gl.info.render;
  return { byName: sorted, objects, drawn, draws: render.calls, triangles: render.triangles, points: render.points, lines: render.lines };
}

/** Frames until the view stands: the same census `STILL_FRAMES` frames in a row, and the world's work done. */
async function settle(city: City): Promise<Census> {
  let last = '', still = 0;
  for (let frames = 0; frames < MOST_FRAMES; frames++) {
    await frame(city);
    const now = census(city.scene);
    const key = JSON.stringify(now);
    still = key === last && !city.scene.worldBusy ? still + 1 : 0;
    last = key;
    if (still >= STILL_FRAMES) return now;
  }
  throw new Error(`the view did not settle in ${MOST_FRAMES} frames`);
}

/** The small city of seed 7 opened as the menu opens it, the camera at the district view, frames until the curtain comes down. */
async function openSmallCity(): Promise<City> {
  const doc = new RoadDoc();
  doc.terrainRelief = RELIEF_FLAT;
  const net = new Network(doc);
  const sim = new SimClient(doc, net);
  const canvas = new NullCanvas(WIDTH, HEIGHT);
  const scene = createSceneRenderer(canvas as unknown as HTMLCanvasElement, { x: 0, y: 0 }, DISTRICT[2], 'ultra', () => {}, new Engine(), undefined, nullRenderer);
  scene.setSkyMode('day');
  const city = { scene, doc, net, sim };
  // The empty map the game starts on, drawn once.
  await frame(city);
  restoreInto(doc, { ...buildSmallCityMap(7), relief: RELIEF_FLAT, markingStyle: 'br' }, net);
  sim.load();
  scene.beginLoad();
  setView(scene, DISTRICT);
  for (let frames = 0; scene.opening; frames++) {
    if (frames >= MOST_FRAMES) throw new Error(`the opening was not shown in ${MOST_FRAMES} frames`);
    await frame(city);
  }
  return city;
}

describe('scene census', () => {
  it('the small city of seed 7 draws what it drew before, district and street', async () => {
    const city = await openSmallCity();
    expect(performance.getEntriesByName('opening:shown').length).toBeGreaterThan(0);
    const district = await settle(city);
    setView(city.scene, STREET);
    const street = await settle(city);
    city.scene.dispose();
    expect({ district, street }).toMatchInlineSnapshot(`
      {
        "district": {
          "byName": {
            "asphalt-far": {
              "drawn": 4,
              "objects": 4,
            },
            "benches-far-cells": {
              "drawn": 876,
              "objects": 4,
            },
            "building-acUnit": {
              "drawn": 3588,
              "objects": 1,
            },
            "building-airer": {
              "drawn": 132,
              "objects": 1,
            },
            "building-awning": {
              "drawn": 5132,
              "objects": 1,
            },
            "building-bike": {
              "drawn": 36,
              "objects": 1,
            },
            "building-brise": {
              "drawn": 10278,
              "objects": 1,
            },
            "building-bush": {
              "drawn": 749,
              "objects": 1,
            },
            "building-chair": {
              "drawn": 1257,
              "objects": 1,
            },
            "building-concrete": {
              "drawn": 83539,
              "objects": 1,
            },
            "building-dish": {
              "drawn": 1376,
              "objects": 1,
            },
            "building-fin": {
              "drawn": 34623,
              "objects": 1,
            },
            "building-foliage": {
              "drawn": 801,
              "objects": 1,
            },
            "building-frame": {
              "drawn": 7207,
              "objects": 1,
            },
            "building-glass": {
              "drawn": 1141,
              "objects": 18,
            },
            "building-glassDark": {
              "drawn": 354,
              "objects": 14,
            },
            "building-glassRail": {
              "drawn": 7214,
              "objects": 1,
            },
            "building-lamp": {
              "drawn": 4894,
              "objects": 1,
            },
            "building-lotBox": {
              "drawn": 216296,
              "objects": 64,
            },
            "building-lotRail": {
              "drawn": 23714,
              "objects": 19,
            },
            "building-lotSlab": {
              "drawn": 7102,
              "objects": 19,
            },
            "building-lounger": {
              "drawn": 346,
              "objects": 1,
            },
            "building-louvre": {
              "drawn": 6214,
              "objects": 1,
            },
            "building-massing": {
              "drawn": 17,
              "objects": 17,
            },
            "building-pot": {
              "drawn": 1550,
              "objects": 1,
            },
            "building-roofRailing": {
              "drawn": 10359,
              "objects": 1,
            },
            "building-shell-batch-detail": {
              "drawn": 0,
              "objects": 1,
            },
            "building-shell-batch-facade": {
              "drawn": 69,
              "objects": 1,
            },
            "building-shell-batch-runs": {
              "drawn": 68,
              "objects": 1,
            },
            "building-table": {
              "drawn": 291,
              "objects": 1,
            },
            "building-wash": {
              "drawn": 1636,
              "objects": 1,
            },
            "building-water": {
              "drawn": 138,
              "objects": 13,
            },
            "exhaust": {
              "drawn": 1,
              "objects": 1,
            },
            "flat-world-far": {
              "drawn": 1,
              "objects": 1,
            },
            "flat-world-slab": {
              "drawn": 1,
              "objects": 1,
            },
            "footway+curb-ramp+median-paved-far": {
              "drawn": 4,
              "objects": 4,
            },
            "gardens-far-cells": {
              "drawn": 34274,
              "objects": 4,
            },
            "hydrants-far-cells": {
              "drawn": 294,
              "objects": 4,
            },
            "kerb+median-kerb-far": {
              "drawn": 4,
              "objects": 4,
            },
            "markings-eca-far": {
              "drawn": 4,
              "objects": 4,
            },
            "markings-eced-far": {
              "drawn": 4,
              "objects": 4,
            },
            "markings-eeed-far": {
              "drawn": 4,
              "objects": 4,
            },
            "markings-ffe-far": {
              "drawn": 4,
              "objects": 4,
            },
            "median-planting-far": {
              "drawn": 4,
              "objects": 4,
            },
            "nature-tree-cypress-": {
              "drawn": 7,
              "objects": 2,
            },
            "nature-tree-cypress--cards": {
              "drawn": 7,
              "objects": 2,
            },
            "nature-tree-oak-": {
              "drawn": 6,
              "objects": 2,
            },
            "nature-tree-oak--cards": {
              "drawn": 6,
              "objects": 2,
            },
            "nature-tree-palm-": {
              "drawn": 6,
              "objects": 2,
            },
            "nature-tree-palm--cards": {
              "drawn": 6,
              "objects": 2,
            },
            "nature-tree-palm--far": {
              "drawn": 1,
              "objects": 1,
            },
            "sign-plates": {
              "drawn": 2,
              "objects": 2,
            },
            "sign-posts": {
              "drawn": 190,
              "objects": 1,
            },
            "sky": {
              "drawn": 1,
              "objects": 1,
            },
            "street-bins-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-beams-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-lamps-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-pools-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-lights-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "terrain-ground": {
              "drawn": 1,
              "objects": 1,
            },
            "terrain-rim": {
              "drawn": 1,
              "objects": 1,
            },
            "utility-arms": {
              "drawn": 797,
              "objects": 4,
            },
            "utility-lamp-beams": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-pools": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-poles": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-transformers": {
              "drawn": 159,
              "objects": 4,
            },
            "utility-wires": {
              "drawn": 4,
              "objects": 4,
            },
            "verge-far": {
              "drawn": 4,
              "objects": 4,
            },
          },
          "drawn": 473386,
          "draws": 259,
          "lines": 0,
          "objects": 301,
          "points": 4000,
          "triangles": 5131008,
        },
        "street": {
          "byName": {
            "asphalt-far": {
              "drawn": 4,
              "objects": 4,
            },
            "benches": {
              "drawn": 60,
              "objects": 1,
            },
            "benches-far-cells": {
              "drawn": 876,
              "objects": 4,
            },
            "building-acUnit": {
              "drawn": 2953,
              "objects": 11,
            },
            "building-airer": {
              "drawn": 100,
              "objects": 10,
            },
            "building-awning": {
              "drawn": 4038,
              "objects": 11,
            },
            "building-bike": {
              "drawn": 31,
              "objects": 8,
            },
            "building-brise": {
              "drawn": 9064,
              "objects": 11,
            },
            "building-bush": {
              "drawn": 553,
              "objects": 11,
            },
            "building-chair": {
              "drawn": 924,
              "objects": 11,
            },
            "building-concrete": {
              "drawn": 67714,
              "objects": 21,
            },
            "building-dish": {
              "drawn": 1258,
              "objects": 11,
            },
            "building-door": {
              "drawn": 2133,
              "objects": 11,
            },
            "building-fin": {
              "drawn": 22821,
              "objects": 14,
            },
            "building-foliage": {
              "drawn": 597,
              "objects": 13,
            },
            "building-frame": {
              "drawn": 116535,
              "objects": 22,
            },
            "building-glass": {
              "drawn": 91997,
              "objects": 11,
            },
            "building-glassDark": {
              "drawn": 14447,
              "objects": 11,
            },
            "building-glassRail": {
              "drawn": 4324,
              "objects": 11,
            },
            "building-lamp": {
              "drawn": 3453,
              "objects": 11,
            },
            "building-lotBox": {
              "drawn": 169608,
              "objects": 44,
            },
            "building-lotRail": {
              "drawn": 18080,
              "objects": 11,
            },
            "building-lotSlab": {
              "drawn": 4668,
              "objects": 11,
            },
            "building-lounger": {
              "drawn": 237,
              "objects": 11,
            },
            "building-louvre": {
              "drawn": 4486,
              "objects": 11,
            },
            "building-massing": {
              "drawn": 25,
              "objects": 25,
            },
            "building-pot": {
              "drawn": 1150,
              "objects": 15,
            },
            "building-railing": {
              "drawn": 1292,
              "objects": 14,
            },
            "building-roofRailing": {
              "drawn": 1365,
              "objects": 8,
            },
            "building-shell-batch-detail": {
              "drawn": 86,
              "objects": 1,
            },
            "building-shell-batch-facade": {
              "drawn": 0,
              "objects": 1,
            },
            "building-shell-batch-runs": {
              "drawn": 0,
              "objects": 1,
            },
            "building-shutter": {
              "drawn": 4830,
              "objects": 11,
            },
            "building-table": {
              "drawn": 221,
              "objects": 11,
            },
            "building-wash": {
              "drawn": 1098,
              "objects": 11,
            },
            "building-water": {
              "drawn": 70,
              "objects": 7,
            },
            "exhaust": {
              "drawn": 1,
              "objects": 1,
            },
            "flat-world-far": {
              "drawn": 1,
              "objects": 1,
            },
            "flat-world-slab": {
              "drawn": 1,
              "objects": 1,
            },
            "footway+curb-ramp+median-paved-far": {
              "drawn": 4,
              "objects": 4,
            },
            "garden-bushes-bush-far": {
              "drawn": 2,
              "objects": 1,
            },
            "garden-bushes-bushFlowering-far": {
              "drawn": 28,
              "objects": 1,
            },
            "garden-trees-broadleaf": {
              "drawn": 121,
              "objects": 1,
            },
            "garden-trees-broadleaf-cards": {
              "drawn": 121,
              "objects": 1,
            },
            "garden-trees-broadleafTall": {
              "drawn": 3,
              "objects": 1,
            },
            "garden-trees-broadleafTall-cards": {
              "drawn": 3,
              "objects": 1,
            },
            "garden-trees-broadleafTall-far": {
              "drawn": 48,
              "objects": 1,
            },
            "garden-trees-conifer": {
              "drawn": 13,
              "objects": 1,
            },
            "garden-trees-conifer-cards": {
              "drawn": 13,
              "objects": 1,
            },
            "garden-trees-conifer-far": {
              "drawn": 29,
              "objects": 1,
            },
            "garden-trees-ipePink": {
              "drawn": 24,
              "objects": 1,
            },
            "garden-trees-ipePink-cards": {
              "drawn": 24,
              "objects": 1,
            },
            "garden-trees-ipeYellow": {
              "drawn": 33,
              "objects": 1,
            },
            "garden-trees-ipeYellow-cards": {
              "drawn": 33,
              "objects": 1,
            },
            "gardens-far-cells": {
              "drawn": 34274,
              "objects": 4,
            },
            "hydrants": {
              "drawn": 21,
              "objects": 1,
            },
            "hydrants-far-cells": {
              "drawn": 294,
              "objects": 4,
            },
            "kerb+median-kerb-far": {
              "drawn": 4,
              "objects": 4,
            },
            "markings-eca-far": {
              "drawn": 4,
              "objects": 4,
            },
            "markings-eced-far": {
              "drawn": 4,
              "objects": 4,
            },
            "markings-eeed-far": {
              "drawn": 4,
              "objects": 4,
            },
            "markings-ffe-far": {
              "drawn": 4,
              "objects": 4,
            },
            "median-planting-far": {
              "drawn": 4,
              "objects": 4,
            },
            "sign-plates": {
              "drawn": 2,
              "objects": 2,
            },
            "sign-posts": {
              "drawn": 64,
              "objects": 1,
            },
            "sky": {
              "drawn": 1,
              "objects": 1,
            },
            "street-bins": {
              "drawn": 59,
              "objects": 1,
            },
            "street-bins-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-beams": {
              "drawn": 71,
              "objects": 1,
            },
            "street-light-beams-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-lamps": {
              "drawn": 58,
              "objects": 1,
            },
            "street-light-lamps-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-light-pools": {
              "drawn": 76,
              "objects": 1,
            },
            "street-light-pools-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "street-lights": {
              "drawn": 64,
              "objects": 1,
            },
            "street-lights-far-cells": {
              "drawn": 840,
              "objects": 4,
            },
            "terrain-ground": {
              "drawn": 1,
              "objects": 1,
            },
            "terrain-rim": {
              "drawn": 1,
              "objects": 1,
            },
            "utility-arms": {
              "drawn": 797,
              "objects": 4,
            },
            "utility-caps": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-arms": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-beams": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-heads": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-lenses": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-lamp-pools": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-poles": {
              "drawn": 796,
              "objects": 4,
            },
            "utility-transformers": {
              "drawn": 159,
              "objects": 4,
            },
            "utility-wires": {
              "drawn": 4,
              "objects": 4,
            },
            "verge-far": {
              "drawn": 4,
              "objects": 4,
            },
          },
          "drawn": 597346,
          "draws": 384,
          "lines": 0,
          "objects": 540,
          "points": 4000,
          "triangles": 5347572,
        },
      }
    `);
  }, 60_000);
});
