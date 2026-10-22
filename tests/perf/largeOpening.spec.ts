import { Box3, type Mesh, type Object3D } from 'three';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLargeCityMap } from '@editor/smallCityMap';
import { prepareCity } from '@editor/preparedCity';
import type { QualityLevel } from '@render/quality';
import { m } from '@world/units';
import { installNullPage, primeCookedSurfaces } from '../support/nullGpu';
import { DISTRICT, HEIGHT, WIDTH, openCityMap, setView, type City, type View } from '../support/sceneHarness';

/**
 * A LARGER CITY OPENS AS THE LARGE ONE DOES (the scale step of 25,000 buildings, `scripts/look/step-25k.json`): the large city of seed 7
 * and the same city over a radius of 2,800 m, each opened on the null GPU as the menu opens it (`tests/support/sceneHarness.ts`
 * openCityMap: its buildings' table, the opening scoped to its view). The larger one's opening takes as many frames as the large one's,
 * every road of its map is drawn from the first frame after the curtain (the network's far level, `render/networkFarRoads.ts`) at
 * the map, mid-distance, corner and edge views, and its district view settles with as many cells in detail as the large city's: the
 * view is the same, so its detail must not scale with the city (the GPU book's room for detail, `render/gpuLedger.ts`).
 *
 * ON EVERY TIER: the weak machine starts on low (`core/weakMachine.ts`), whose budgets are the tightest (`quality.ts`
 * GEOMETRY_BUDGETS); the opening must never wait on a level its budget lets go. `LARGE_OPENING_TIERS` (comma-separated) runs a few.
 */

/** The opening's view of a large city (`main.ts` fitOpeningView: a district from nearly overhead). */
const OPEN: View = [0, 0, 1.8, 45, 79];
/** The side of the cells the roads are counted in (the road blocks', `roadSurfaces.ts`). */
const CELL = m(614.4);

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
async function frames(city: City, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    if (city.net.revision !== city.doc.revision) city.net.rebuild();
    city.scene.draw(city.net, city.sim, 1, 1 / 60);
    await turn();
  }
}

const cellOf = (x: number, y: number): string => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

/** The cells a road of the network passes through (its centreline sampled every 20 m). */
function roadCells(city: City): Set<string> {
  const cells = new Set<string>();
  for (const ribbon of city.net.ribbons.values()) {
    const line = ribbon.full;
    for (let s = 0; s <= line.length; s += m(20)) { const f = line.sampleAt(Math.min(s, line.length)); cells.add(cellOf(f.p.x, f.p.y)); }
  }
  return cells;
}

/** The cells the visible road surfaces' meshes reach (the carriageway's blocks, near or far, and the network's far level), with their triangles. */
function drawnRoadCells(city: City): Map<string, number> {
  const out = new Map<string, number>();
  const box = new Box3();
  city.scene.scene.traverseVisible((o: Object3D) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh || !(mesh.name.startsWith('asphalt') || mesh.name === 'road-far-network')) return;
    const g = mesh.geometry;
    const n = Math.floor((g.index ? g.index.count : g.getAttribute('position').count) / 3);
    if (!n) return;
    if (!g.boundingBox) g.computeBoundingBox();
    mesh.updateWorldMatrix(true, false);
    box.copy(g.boundingBox!).applyMatrix4(mesh.matrixWorld);
    // The scene's z is the plan's -y.
    for (let i = Math.floor(box.min.x / CELL); i <= Math.floor(box.max.x / CELL); i++) {
      for (let j = Math.floor(-box.max.z / CELL); j <= Math.floor(-box.min.z / CELL); j++) out.set(`${i},${j}`, (out.get(`${i},${j}`) ?? 0) + n);
    }
  });
  return out;
}

/** The cells with roads and no road drawn. */
function missingRoads(city: City, wanted: ReadonlySet<string>): string[] {
  const drawn = drawnRoadCells(city);
  return [...wanted].filter((key) => !(drawn.get(key)! > 0));
}

interface Opened { readonly frames: number; readonly districtDetail: number; readonly districtShown: number; readonly room: number; readonly missing: Record<string, string[]>; readonly cells: number }

async function open(quality: QualityLevel, radius?: number): Promise<Opened> {
  // The baked textures again: the scene before let them go with it (`SceneHandle.dispose`).
  primeCookedSurfaces(process.cwd());
  const { data, buildings } = prepareCity(buildLargeCityMap(7, radius));
  const { city, frames: opened } = await openCityMap(data, buildings, { large: true, view: OPEN, quality });
  try {
    const wanted = roadCells(city);
    const missing: Record<string, string[]> = {};
    // Right after the curtain, and at the views the photographs are taken from: the map, mid-distance, the corners and edges.
    missing['opening'] = missingRoads(city, wanted);
    const reach = Math.max(...[...wanted].map((key) => Math.max(...key.split(',').map((v) => Math.abs(Number(v)))))) * CELL;
    const views: [string, View][] = [['map', [0, 0, 0.12, 45, 48]], ['mid05', [0, 0, 0.5, 45, 48]], ['mid12', [0, 0, 1.2, 45, 48]]];
    for (const [name, x, y] of [['ne', 0.7, 0.7], ['sw', -0.7, -0.7], ['e', 0.8, 0], ['n', 0, 0.8]] as const) views.push([`${name}-mid12`, [x * reach, y * reach, 1.2, 45, 48]]);
    for (const [name, view] of views) {
      setView(city.scene, view);
      await frames(city, 3);
      missing[name] = missingRoads(city, wanted);
    }
    // The district over the middle: frames until its cells' levels stand (at least 60: the masses the view refines to come first), or 300.
    setView(city.scene, DISTRICT);
    let last = '', still = 0;
    for (let i = 0; i < 300 && (i < 60 || still < 12); i++) {
      await frames(city, 1);
      const levels = city.scene.buildingLevels();
      const key = `${levels['shownDetail']}|${levels['shownFacade']}|${levels['chosenDetail']}|${levels['chosenFacade']}`;
      still = key === last && !(levels['notLanded']! > 0) ? still + 1 : 0;
      last = key;
    }
    const levels = city.scene.buildingLevels();
    return { frames: opened, districtDetail: levels['shownDetail']!, districtShown: levels['shownDetail']! + levels['shownFacade']!, room: levels['roomBytes']!, missing, cells: wanted.size };
  } finally {
    city.scene.dispose();
  }
}

const TIERS = (process.env['LARGE_OPENING_TIERS'] ?? 'ultra,medium,low').split(',') as QualityLevel[];

describe.each(TIERS)('a larger city opens as the large one does (%s)', (quality) => {
  let page: { restore(): void };
  let large: Opened, larger: Opened;
  beforeAll(async () => {
    page = installNullPage(WIDTH, HEIGHT, process.cwd());
    large = await open(quality);
    if (process.env['LARGE_OPENING_OUT']) writeFileSync(`${process.env['LARGE_OPENING_OUT']}.${quality}.json`, JSON.stringify({ large }, null, 1));
    larger = await open(quality, m(2800));
    if (process.env['LARGE_OPENING_OUT']) writeFileSync(`${process.env['LARGE_OPENING_OUT']}.${quality}.json`, JSON.stringify({ large, larger }, null, 1));
  }, 1_500_000);
  afterAll(() => page.restore());

  it('opens in as many frames as the large city', () => {
    // The frames an opening takes move a little with its jobs' timing (70 to 97 for the large city): the larger one took 168 when it refined the whole map's masses.
    expect(larger.frames, `25k ${larger.frames} frames, 8k ${large.frames}`).toBeLessThanOrEqual(Math.ceil(large.frames * 1.5) + 10);
  });

  it('draws every road of the map from the first frame after the curtain, at every view', () => {
    expect(larger.cells).toBeGreaterThan(large.cells);
    for (const city of [large, larger]) for (const [view, cells] of Object.entries(city.missing)) expect(cells, `${view}: cells with roads and none drawn`).toEqual([]);
  });

  it('settles the district in as much detail as the large city', () => {
    expect(larger.room, 'the room left for detail').toBeGreaterThan(0);
    expect(large.districtShown).toBeGreaterThan(0);
    // Not the same cells (the larger city is laid out over another plan), as many of them: it showed none before.
    expect(larger.districtShown, `25k ${larger.districtShown} cells shown in detail or facade, 8k ${large.districtShown}`).toBeGreaterThanOrEqual(Math.floor(large.districtShown * 0.8));
    expect(larger.districtDetail).toBeGreaterThanOrEqual(Math.floor(large.districtDetail * 0.8));
  });
});
