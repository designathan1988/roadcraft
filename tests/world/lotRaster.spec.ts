import { describe, expect, it } from 'vitest';
import { Network } from '@world/network';
import type { RoadDoc } from '@world/doc';
import { applyLots, planLots, type LotPlan } from '@world/lots';
import { markPaved, pavedTester } from '@world/zoneGrid';
import { LAND, NEAR, PAVED } from '@world/rasterGrid';
import { layCity } from '@editor/cityGenerator';
import { DEFAULT_CITY, planCity, type CityOptions } from '@world/cityGen/plan';
import { m } from '@world/units';
import type { ChangeRect } from '@world/changes';
import { planLots as planLotsOld } from './oracle/lotsOld';

/** The lots' raster scan-converted */

function city(options: Partial<CityOptions>): { doc: RoadDoc; net: Network } {
  const doc = layCity(planCity({ ...DEFAULT_CITY, ...options }));
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

const run = (steps: Generator<void, void>): void => { while (!steps.next().done) { /* to the end */ } };

/** Lists compared whatever their order: the oracle plans group by group of streets, the planner the whole plane in one order. */
const sorted = <T>(list: readonly T[]): string[] => list.map((item) => JSON.stringify(item)).sort();

function samePlans(doc: RoadDoc, net: Network): LotPlan {
  // The keys the document knows are left out of a plan (`LotPlan.keys`).
  const fresh = (key: string): boolean => !doc.lotStore.hasKey(key);
  const now = planLots(doc, net);
  const before = planLotsOld(doc, net);
  const keyed = (plan: { keys: string[]; keyRects?: ChangeRect[] }) => plan.keys.map((key, i) => ({ key, rect: plan.keyRects![i] })).filter((k) => fresh(k.key));
  expect(sorted(keyed(now))).toEqual(sorted(keyed(before)));
  expect(now.drop).toEqual(before.drop);
  expect(sorted(now.add)).toEqual(sorted(before.add));
  return now;
}

describe('lots planned again', () => {
  it('plans again only where the roads and the lots changed, as a plan of the whole map would', () => {
    const { doc, net } = city({ seed: 7, size: 'small', style: 'organic' });
    // The same document planned whole by a planner of its own.
    const whole = (): LotPlan => {
      const other = new Network(doc);
      other.rebuild();
      return planLots(doc, other);
    };
    applyLots(doc, planLots(doc, net));
    expect(planLots(doc, net)).toEqual(whole());
    // A street taken out: new land, lots dropped where the paving moved.
    const ids = [...doc.segments.keys()].sort((a, b) => a - b);
    doc.removeSegment(ids[Math.floor(ids.length / 3)]!);
    net.rebuild();
    const plan = planLots(doc, net);
    expect(plan).toEqual(whole());
    // Part of that land cut, then a street far out drawn.
    applyLots(doc, { add: plan.add.slice(0, Math.ceil(plan.add.length / 2)), keys: [], drop: [] });
    expect(planLots(doc, net)).toEqual(whole());
    const a = doc.addNode({ x: m(3000), y: m(0) });
    const b = doc.addNode({ x: m(3080), y: m(10) });
    doc.addSegment(a.id, b.id, 1);
    net.rebuild();
    expect(planLots(doc, net)).toEqual(whole());
  });
});

describe('lot raster', () => {
  const cities: Partial<CityOptions>[] = [
    { seed: 1, size: 'small', style: 'blocks' },
    { seed: 7, size: 'small', style: 'organic' },
    { seed: 20261009, size: 'small', style: 'grid' },
    { seed: 3, size: 'small', style: 'radial', parks: 0.15 },
    { seed: 11, size: 'small', style: 'mixed', industry: false },
  ];
  for (const options of cities) {
    it(`plans the same lots as asking every cell: ${options.style} ${options.seed}`, () => {
      const { doc, net } = city(options);
      const plan = samePlans(doc, net);
      expect(plan.add.length).toBeGreaterThan(20);
      // Planned again over the lots stored: every key known, nothing new.
      applyLots(doc, plan);
      samePlans(doc, net);
      // A street taken out: new land, lots dropped where the paving moved.
      const ids = [...doc.segments.keys()].sort((a, b) => a - b);
      doc.removeSegment(ids[Math.floor(ids.length / 2)]!);
      net.rebuild();
      samePlans(doc, net);
    });
  }

  it('marks exactly the cells pavedTester answers paved', () => {
    const { doc, net } = city({ seed: 5, size: 'small', style: 'organic' });
    const { onRoad, onPlate } = pavedTester(doc, net);
    const step = m(2);
    const minX = m(-300) + 0.3141, minY = m(-260) + 0.2718, W = 260, H = 240;
    const label = new Int32Array(W * H).fill(NEAR);
    // Some cells not asked about: they stay land.
    label.fill(LAND, 0, W * 10);
    run(markPaved(doc, net, { minX, minY, W, H, step }, label));
    let paved = 0;
    const wrong: string[] = [];
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const p = { x: minX + (i + 0.5) * step, y: minY + (j + 0.5) * step };
      const want = j >= 10 && (onRoad(p) || onPlate(p));
      if (want) paved++;
      if (label[j * W + i] !== (want ? PAVED : LAND)) wrong.push(`${i},${j}`);
    }
    expect(wrong).toEqual([]);
    expect(paved).toBeGreaterThan(1000);
  });
});
