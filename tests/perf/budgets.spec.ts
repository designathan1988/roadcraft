import { MeshBasicMaterial, type BufferGeometry, type Mesh } from 'three';
import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { QUALITY, type QualityLevel } from '@render/quality';
import { installNullPage, primeCookedSurfaces } from '../support/nullGpu';
import { DISTRICT, HEIGHT, MAP, STREET, WIDTH, openSmallCity, setView, settle, type View } from '../support/sceneHarness';
import type { Budget } from '@core/perfBudget';
import { COUNT_BUDGETS, TIER_COUNTS, TIER_HEAP_MARGIN, TIER_MARGIN, withinBudget, type TierView, type TierViewCounts } from './support/countBudgets';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildDefaultTown } from '../world/support/town/defaultTown';
import { buildingPads, padsWork } from '@world/buildings/pads';
import { kerbward, kerbWork } from '@world/poleLines';
import { buildRoadElevation } from '@world/elevation';
import { buildRoadSurfaces } from '@render/roadSurfaces';
import type { SceneMaterials } from '@render/materials';
import { m } from '@world/units';

/** THE PERFORMANCE BUDGETS, COUNTED (`core/perfBudget.ts` COUNT_BUDGETS) */

const materials = new Proxy({}, { get: (_t, key) => key === 'scale' ? new Proxy({}, { get: () => 4 }) : new MeshBasicMaterial() }) as unknown as SceneMaterials;
const report = (name: string, value: number, budget: Budget): void => {
  expect(withinBudget(value, budget), `${name} = ${value} (budget ${budget.min ?? '-'}..${budget.max}: ${budget.why})`).toBe(true);
};

describe('performance budgets, counted', () => {
  const doc = new RoadDoc();
  buildDefaultTown(doc);
  const net = new Network(doc);
  net.rebuild();
  const ground = (x: number, y: number): number => 2 * Math.sin(x / 37) + 1.3 * Math.cos(y / 23);
  const pads = buildingPads([...doc.buildings.all()], ground, undefined, m(6.4));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of pads.shapeBounds()) { x0 = Math.min(x0, b.minX); y0 = Math.min(y0, b.minY); x1 = Math.max(x1, b.maxX); y1 = Math.max(y1, b.maxY); }

  it('grades the ground to the platforms measuring few rings a corner', () => {
    padsWork.rings = 0;
    let corners = 0;
    for (let y = y0; y <= y1; y += m(2)) for (let x = x0; x <= x1; x += m(2)) { pads.shapeAt(x, y, ground(x, y)); corners++; }
    report('rings per corner', padsWork.rings / corners, COUNT_BUDGETS.padRingsPerCorner);
  });

  it('finds the kerb nearest a pole walking few edges', () => {
    kerbWork.edges = 0;
    let asks = 0;
    for (let y = y0; y <= y1; y += m(8)) for (let x = x0; x <= x1; x += m(8)) { kerbward(net, { x, y }, m(6)); asks++; }
    report('edges per ask', kerbWork.edges / asks, COUNT_BUDGETS.kerbEdgesPerAsk);
  });

  it("files the town's crossing surface in a small grid", () => {
    report('crossing cells', net.crossingSurface().cells, COUNT_BUDGETS.townWalkableCells);
  });

  it('draws the fixed scene with its detail, in few meshes', () => {
    const fixture = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);
    const fnet = new Network(fixture);
    fnet.rebuild();
    const surfaces = buildRoadSurfaces(fnet, buildRoadElevation(fnet, () => 0), materials, () => 0);
    let triangles = 0, meshes = 0;
    surfaces.group.traverse((o) => {
      const g = (o as Mesh).geometry as BufferGeometry | undefined;
      if (!g) return;
      meshes++;
      triangles += (g.getIndex()?.count ?? g.getAttribute('position').count) / 3;
    });
    report('road triangles', triangles, COUNT_BUDGETS.fixtureRoadTriangles);
    report('road meshes', meshes, COUNT_BUDGETS.fixtureRoadMeshes);
  });
});

/** The JS heap after a full collection: `gc` exposed for this spec alone (V8's `--expose-gc` set at run time, the function read from a new context), the run's own when started with the flag. */
function collectedHeap(): number {
  let gc = (globalThis as { gc?: () => void }).gc;
  if (!gc) {
    setFlagsFromString('--expose-gc');
    gc = runInNewContext('gc') as () => void;
  }
  // Twice: what the first frees (finalizers, weak references) the second collects.
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

const TIERS: readonly QualityLevel[] = ['low', 'medium', 'high', 'ultra'];
const VIEWS: readonly (readonly [TierView, View])[] = [['map', MAP], ['district', DISTRICT], ['street', STREET]];
const COUNTED = ['draws', 'triangles', 'peakDraws', 'peakTriangles'] as const satisfies readonly (keyof TierViewCounts)[];

/**
 * THE TIERS DRAWN, COUNTED: the small city of seed 7 opened once on the null GPU (`tests/support/sceneHarness.ts`) on `low`, then
 * raised a tier at a time on the same scene (`setQuality` with the tier's settings, as `graphicsWiring.ts` applies a tier), the map,
 * district and street views settled on each: three's draws and triangles (the colour pass, the post chain, the sun's cascades) standing
 * still and at most in a frame on the way there, and the heap the city keeps. Every count is exact on every run (`TIER_COUNTS`).
 */
describe('the tiers drawn, counted', () => {
  const measured = new Map<QualityLevel, { views: Record<TierView, TierViewCounts>; heapMB: number }>();
  let page: { restore(): void };
  beforeAll(async () => {
    page = installNullPage(WIDTH, HEIGHT, process.cwd());
    primeCookedSurfaces(process.cwd());
    const before = collectedHeap();
    const city = await openSmallCity('low');
    try {
      for (const tier of TIERS) {
        if (tier !== 'low') city.scene.setQuality(tier, QUALITY[tier]);
        const views = {} as Record<TierView, TierViewCounts>;
        for (const [name, view] of VIEWS) {
          setView(city.scene, view);
          const { census, peak } = await settle(city);
          views[name] = { draws: census.draws, triangles: census.triangles, peakDraws: peak.draws, peakTriangles: peak.triangles };
        }
        measured.set(tier, { views, heapMB: Math.round(((collectedHeap() - before) / 1048576) * 10) / 10 });
      }
    } finally {
      city.scene.dispose();
    }
    // `TIER_COUNTS_OUT=<file>`: today's counts written out, for a change made on purpose to update `TIER_COUNTS` from.
    if (process.env['TIER_COUNTS_OUT']) writeFileSync(process.env['TIER_COUNTS_OUT'], JSON.stringify(Object.fromEntries(measured), null, 1));
  }, 240_000);
  afterAll(() => page.restore());

  it.each(TIERS)('keeps %s under its draws and triangles on every view', (tier) => {
    const today = TIER_COUNTS[tier].views;
    for (const [view] of VIEWS) {
      const now = measured.get(tier)!.views[view];
      for (const key of COUNTED) {
        const most = Math.floor(today[view][key] * (1 + TIER_MARGIN));
        expect(now[key], `${tier} ${view} ${key} = ${now[key]} (today ${today[view][key]}, budget ${most})`).toBeLessThanOrEqual(most);
      }
    }
  });

  it('draws no more on a lower tier than on a higher one, standing still', () => {
    for (const [view] of VIEWS) {
      for (const key of ['draws', 'triangles'] as const) {
        const row = TIERS.map((tier) => measured.get(tier)!.views[view][key]);
        // The peaks are left out: the frame that drew the cascades whole falls where each tier's loading lands, not in the tiers' order.
        expect([...row].sort((a, b) => a - b), `${view} ${key} by tier ${row.join(' <= ')}`).toEqual(row);
      }
    }
  });

  it.each(TIERS)('keeps the heap the city holds on %s under its budget', (tier) => {
    const now = measured.get(tier)!.heapMB;
    const most = Math.round(TIER_COUNTS[tier].heapMB * (1 + TIER_HEAP_MARGIN));
    expect(now, `${tier} heap ${now} MB (today ${TIER_COUNTS[tier].heapMB} MB, budget ${most} MB)`).toBeLessThanOrEqual(most);
  });
});
