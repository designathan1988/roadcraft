import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { onChartOf } from '@world/planet/charts';
import { commitRoadPath } from '@editor/commit';
import { layPowerLines } from '@editor/roads/powerLine';

/**
 * THE POWER LINE OF A LONG STREET ON THE PLANET (`editor/roads/powerLine.ts`).
 * Run with `vitest.planet.config.ts`.
 *
 * On the planet a street is cut every 200 m (editor/commit.ts cutLongRoads),
 * and a line strung per segment broke at every cut: a gap of wire between two
 * poles 8 m apart, the second chart's pole never found by the first's.
 */

const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const c = tileCentre(chart);

describe('the power line of a long street across the pieces', () => {
  it('is one line, a pole at each joint, however many segments and charts it crosses', () => {
    const doc = new RoadDoc();
    doc.setBalance(1e9);
    const net = new Network(doc);
    net.rebuild();
    const a = { x: c.x - 150, y: c.y }, b = { x: c.x + 1350, y: c.y };
    expect(commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
      [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]).committed).toBe(true);
    if (net.revision !== doc.revision) net.rebuild();
    expect(doc.segments.size).toBeGreaterThan(4);
    expect(layPowerLines(doc, net, [...doc.segments.keys()])).toBeGreaterThan(0);

    // One connected line.
    const adj = new Map<number, number[]>();
    for (const p of doc.poles.values()) adj.set(p.id, []);
    for (const s of doc.poleSpans.values()) { adj.get(s.a)!.push(s.b); adj.get(s.b)!.push(s.a); }
    const seen = new Set<number>();
    let lines = 0;
    for (const id of adj.keys()) {
      if (seen.has(id)) continue;
      lines++;
      const stack = [id];
      while (stack.length) { const x = stack.pop()!; if (seen.has(x)) continue; seen.add(x); stack.push(...adj.get(x)!); }
    }
    expect(lines).toBe(1);
    expect(doc.poleSpans.size).toBe(doc.poles.size - 1);

    // No two poles at a joint, and no span longer than a span is (each met on one chart).
    const poles = [...doc.poles.values()];
    for (let i = 0; i < poles.length; i++) for (let j = i + 1; j < poles.length; j++) {
      const q = onChartOf(poles[j]!, poles[i]!);
      expect(Math.hypot(q.x - poles[i]!.x, q.y - poles[i]!.y)).toBeGreaterThan(3);
    }
    for (const s of doc.poleSpans.values()) {
      const p = doc.poles.get(s.a)!, q = onChartOf(doc.poles.get(s.b)!, p);
      expect(Math.hypot(q.x - p.x, q.y - p.y)).toBeLessThan(120);
    }
  });
});
