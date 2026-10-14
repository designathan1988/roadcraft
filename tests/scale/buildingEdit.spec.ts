import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { createBuildingLayer } from '@render/buildings/layer';
import { beginFrameWork } from '@core/frameWork';
import { m } from '@world/units';

/**
 * ONE MORE BUILDING COSTS THE SAME IN A SMALL TOWN AND A LARGE ONE (the same
 * rule as `edit.spec.ts` for a road): a town of 16 buildings and one of 64,
 * one building added beside each, and what each derived product read of the
 * town's buildings to take it in. Counted as incremental engines track their
 * inputs (Salsa logs every query it re-executes after an input changes): each
 * building `all()` hands out, each `has` and `get`, by the product reading.
 *
 * Products that still read the whole town for one building are listed in
 * `baseline.json` under `building+1:` with the ratio measured (large /
 * small): one NOT listed must not grow with the town, and a listed ratio may
 * only fall (each is brought to 1 and taken out).
 */
const SPACING = m(60);

function placed(index: number, column: number, row: number): Omit<Building, 'id'> {
  const bp = BLUEPRINTS[index % BLUEPRINTS.length]!;
  return { ...JSON.parse(JSON.stringify(bp.body)), x: column * SPACING, y: row * SPACING, rotation: 0 } as Omit<Building, 'id'>;
}

/** A square town of `n` buildings, and the reads of its buildings counted from now on. */
function town(n: number): { doc: RoadDoc; reads: { count: number } } {
  const doc = new RoadDoc();
  const side = Math.round(Math.sqrt(n));
  for (let i = 0; i < n; i++) doc.buildings.add(placed(i, i % side, Math.floor(i / side)));
  const reads = { count: 0 };
  const store = doc.buildings;
  const all = store.all.bind(store);
  const has = store.has.bind(store);
  const get = store.get.bind(store);
  store.all = function* () { for (const b of all()) { reads.count++; yield b; } };
  store.has = (id) => { reads.count++; return has(id); };
  store.get = (id) => { reads.count++; return get(id); };
  return { doc, reads };
}

const flat = (): number => 0;

/** The buildings layer (`render/buildings/layer.ts`) run frame by frame until it is done, as the game runs it. */
function settle(layer: ReturnType<typeof createBuildingLayer>, doc: RoadDoc): void {
  for (let frame = 0; frame < 2000; frame++) {
    beginFrameWork();
    layer.update(doc, flat, 'g');
    if (!layer.pending) return;
  }
  throw new Error('the layer never settled');
}

/** What each product read to take in one building added beside a town of `n`. */
function addWork(n: number): Record<string, number> {
  const { doc, reads } = town(n);
  const layer = createBuildingLayer();
  settle(layer, doc);
  const side = Math.round(Math.sqrt(n));
  reads.count = 0;
  doc.buildings.add(placed(n, side + 1, 0));
  settle(layer, doc);
  const out = { layer: reads.count };
  layer.dispose();
  return out;
}

describe('the cost of one building added', () => {
  it('does not grow with the town, but for the products still in the baseline, whose growth may only fall', () => {
    const small = addWork(16);
    const large = addWork(64);
    const baseline = JSON.parse(readFileSync(join(process.cwd(), 'tests/scale/baseline.json'), 'utf8')) as Record<string, number>;
    const report: string[] = [];
    for (const product of Object.keys(small)) {
      const key = `building+1:${product}`;
      const ratio = small[product]! > 0 ? large[product]! / small[product]! : large[product]! > 0 ? Infinity : 1;
      const allowed = baseline[key];
      if (allowed === undefined) {
        if (ratio > 1.05) report.push(`${key}: grows with the town (${small[product]} -> ${large[product]}, x${ratio.toFixed(2)})`);
      } else if (ratio > allowed * 1.001) {
        report.push(`${key}: x${ratio.toFixed(2)}, more than the baseline's x${allowed}`);
      } else if (ratio <= 1.05) {
        report.push(`${key}: no longer grows with the town (x${ratio.toFixed(2)}): take it out of tests/scale/baseline.json`);
      }
    }
    expect(report).toEqual([]);
  });
});
