import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { laneletWork } from '@world/lanelets';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';

/**
 * THE SAME EDIT COSTS THE SAME ON A SMALL MAP AND A LARGE ONE (CLAUDE.md:
 * "A scale test proves the same edit costs the same on a small map and a large
 * one (work counters, not timings)"). One isolated road added beside a closed
 * grid of 3 x 3 blocks and beside one of 12 x 12 (16 times the area); each
 * derived product counts what it looked at.
 *
 * At the SOURCE some products rebuild the whole map on every edit (docs/PROBLEMS.md,
 * the audit 3.1). They are listed in `baseline.json` with the ratio measured
 * (large / small): a product NOT listed must not grow with the map, and a listed
 * ratio may only fall (stage F3 brings each to 1 and takes it out).
 */
const BLOCK = 120;

function grid(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  return doc;
}

/** What one isolated road beside the grid costs each product, once the grid is built. */
function editWork(n: number): Record<string, number> {
  const doc = grid(n);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x5ca1e);
  w.rebuildTopology();
  const before = { ...laneletWork };
  const x = m(BLOCK) * (n / 2 + 2);
  const a = doc.addNode({ x, y: 0 });
  const b = doc.addNode({ x: x + m(60), y: 0 });
  doc.addSegment(a.id, b.id, 1);
  net.rebuild();
  w.rebuildTopology();
  return {
    'lanes.segments': laneletWork.segments - before.segments,
    'lanes.nodes': laneletWork.nodes - before.nodes,
  };
}

describe('the cost of one road edit', () => {
  it('does not grow with the map, but for the products still in the baseline, whose growth may only fall', () => {
    const small = editWork(3);
    const large = editWork(12);
    const baseline = JSON.parse(readFileSync(join(process.cwd(), 'tests/scale/baseline.json'), 'utf8')) as Record<string, number>;
    const report: string[] = [];
    for (const key of Object.keys(small)) {
      const ratio = small[key]! > 0 ? large[key]! / small[key]! : large[key]! > 0 ? Infinity : 1;
      const allowed = baseline[key];
      if (allowed === undefined) {
        if (ratio > 1.05) report.push(`${key}: grows with the map (${small[key]} -> ${large[key]}, x${ratio.toFixed(2)})`);
      } else if (ratio > allowed * 1.001) {
        report.push(`${key}: x${ratio.toFixed(2)}, more than the baseline's x${allowed}`);
      } else if (ratio <= 1.05) {
        report.push(`${key}: no longer grows with the map (x${ratio.toFixed(2)}): take it out of tests/scale/baseline.json`);
      }
    }
    expect(report).toEqual([]);
  });
});
