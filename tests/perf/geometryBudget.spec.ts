import { Frustum, Matrix4, Sphere, type BatchedMesh, type InstancedMesh, type Mesh, type Object3D } from 'three';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildLargeCityMap } from '@editor/smallCityMap';
import { prepareCity } from '@editor/preparedCity';
import { countMemory } from '@render/memoryCounters';
import { GEOMETRY_BUDGETS, type QualityLevel } from '@render/quality';
import { m } from '@world/units';
import { installNullPage, primeCookedSurfaces } from '../support/nullGpu';
import { HEIGHT, WIDTH, openCityMap, setView, type City, type View } from '../support/sceneHarness';

/**
 * THE GEOMETRY OF A TOUR STAYS UNDER ITS TIER'S BUDGET (`quality.ts` GEOMETRY_BUDGETS) WITH NOTHING MISSING IN THE VIEW: the city of
 * 25,000 buildings (`scripts/look/step-25k.json`) opened on the null GPU as the menu opens it, the camera taken over the photographs'
 * views (the map, the district and the street over the middle, the corners and edges), each view's frames drawn till it stands. With
 * the tier's budget, the scene's geometry (`countMemory`, what `__roadcraft.memory()` reports) is under the budget at every view, and
 * what is drawn in the view (every visible object meeting the camera's frustum, by name, and the instances it draws) is what the same
 * tour draws without any budget: only what is out of the view went.
 */

const OPEN: View = [0, 0, 1.8, 45, 79];
/** The tier toured: medium, where the masses out of the view go for the budget (160 MB) on this city's tour; ultra holds it whole under its own. */
const TIER = (process.env['BUDGET_TIER'] ?? 'medium') as QualityLevel;
const UNBOUNDED = { totalMB: Infinity, massesMB: Infinity, viewCellsShare: 1, roadsNearMB: Infinity } as const;
/** Frames a view may take to stand; it stands once what is drawn in it is the same `STILL` frames in a row and the world's job is done. */
const MOST = 240;
const STILL = 8;
const MIB = 1048576;

const VIEWS: readonly (readonly [string, View])[] = [
  ['map', [0, 0, 0.12, 45, 48]], ['district', [0, 0, 2.5, 45, 48]], ['street', [150, 0, 5, 20, 35]],
  ['ne-district', [1960, 1960, 2.5, 45, 48]], ['sw-district', [-1960, -1960, 2.5, 45, 48]], ['e-mid12', [2240, 0, 1.2, 45, 48]],
  ['n-district', [0, 2240, 2.5, 45, 48]], ['back-district', [0, 0, 2.5, 45, 48]],
];

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));
async function frame(city: City): Promise<void> {
  if (city.net.revision !== city.doc.revision) city.net.rebuild();
  city.scene.draw(city.net, city.sim, 1, 1 / 60);
  await turn();
}

/** What is drawn in the camera's view: every visible drawable whose world bounds meet its frustum, by name without digits (objects, things drawn). */
function inView(city: City): Record<string, string> {
  const camera = city.scene.viewCamera();
  camera.updateMatrixWorld();
  const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const rows = new Map<string, { objects: number; drawn: number }>();
  const sphere = new Sphere();
  city.scene.scene.traverseVisible((o: Object3D) => {
    const kind = o as Mesh & { isInstancedMesh?: boolean; isBatchedMesh?: boolean; isPoints?: boolean; isLine?: boolean };
    if (!kind.isMesh && !kind.isPoints && !kind.isLine) return;
    const g = kind.geometry;
    if (!kind.isBatchedMesh && !kind.isInstancedMesh && o.frustumCulled) {
      if (!g.boundingSphere) g.computeBoundingSphere();
      if (g.boundingSphere && !frustum.intersectsSphere(sphere.copy(g.boundingSphere).applyMatrix4(o.matrixWorld))) return;
    }
    let things = 1;
    if (kind.isInstancedMesh) things = (o as InstancedMesh).count;
    else if (kind.isBatchedMesh) {
      const info = (o as BatchedMesh & { _instanceInfo: readonly { active: boolean; visible: boolean }[] })._instanceInfo;
      things = info.reduce((n, i) => n + (i.active && i.visible ? 1 : 0), 0);
    }
    const name = (o.name || o.type).replace(/\d+/g, '');
    const row = rows.get(name) ?? { objects: 0, drawn: 0 };
    row.objects++;
    row.drawn += things;
    rows.set(name, row);
  });
  const out: Record<string, string> = {};
  for (const key of [...rows.keys()].sort()) out[key] = `${rows.get(key)!.objects}/${rows.get(key)!.drawn}`;
  return out;
}

interface Stop { readonly name: string; readonly geometryMB: number; readonly view: Record<string, string>; readonly frames: number; readonly top: readonly string[] }

async function tour(budgeted: boolean): Promise<Stop[]> {
  primeCookedSurfaces(process.cwd());
  const { data, buildings } = prepareCity(buildLargeCityMap(7, m(2800)));
  const { city } = await openCityMap(data, buildings, { large: true, view: OPEN, quality: TIER });
  try {
    city.scene.setGeometryBudget(budgeted ? null : UNBOUNDED);
    const stops: Stop[] = [];
    for (const [name, view] of VIEWS) {
      setView(city.scene, view);
      let last = '', still = 0, frames = 0;
      for (; frames < MOST && still < STILL; frames++) {
        await frame(city);
        // The governor's read every frame here (the game's every `GOVERN_FRAMES`): the view stands under the budget it keeps.
        city.scene.governGeometry();
        const key = JSON.stringify(inView(city));
        still = key === last && !city.scene.worldBusy ? still + 1 : 0;
        last = key;
      }
      const counted = countMemory(city.scene.scene);
      const byName = new Map<string, number>();
      for (const [holder, bytes] of counted.bytesByName) { const key = holder.replace(/\d+/g, '#'); byName.set(key, (byName.get(key) ?? 0) + bytes); }
      const top = [...byName].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([holder, bytes]) => `${holder} ${(bytes / MIB).toFixed(1)}`);
      stops.push({ name, geometryMB: counted.geometryBytes / MIB, view: inView(city), frames, top });
    }
    return stops;
  } finally {
    city.scene.dispose();
  }
}

describe(`a tour of the city of 25,000 buildings on ${TIER} keeps its geometry budget`, () => {
  let page: { restore(): void };
  let bounded: Stop[], free: Stop[];
  beforeAll(async () => {
    page = installNullPage(WIDTH, HEIGHT, process.cwd());
    bounded = await tour(true);
    free = process.env['BUDGET_ONLY_BOUNDED'] ? bounded : await tour(false);
    if (process.env['BUDGET_OUT']) writeFileSync(process.env['BUDGET_OUT'], JSON.stringify({ tier: TIER, budget: GEOMETRY_BUDGETS[TIER], bounded, free }, null, 1));
  }, 3_000_000);
  afterAll(() => page.restore());

  it('holds the geometry under the tier\'s budget at every view', () => {
    const budget = GEOMETRY_BUDGETS[TIER].totalMB;
    for (const stop of bounded) expect(stop.geometryMB, `${stop.name}: ${stop.geometryMB.toFixed(1)} MB of ${budget}`).toBeLessThanOrEqual(budget);
  });

  it('draws in the view what the tour without a budget draws', () => {
    for (let i = 0; i < VIEWS.length; i++) expect(bounded[i]!.view, VIEWS[i]![0]).toEqual(free[i]!.view);
  });
});
