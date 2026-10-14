import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { planCity, DEFAULT_CITY, type CitySize } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { layPowerLines } from '@editor/roads/powerLine';
import { planPoleRun } from '@editor/poles';
import { m } from '@world/units';

/**
 * A GENERATED CITY'S POWER LINES ARE THE SAME planned over shared tiles
 * (`poleRunPlanner`) as planned street by street over a region round each
 * run (the pole tool's way, the oracle): the same poles, each within the
 * millimetres Clipper rounds a kerb line to where a region cuts it, the same
 * lamps, and the same spans.
 */
function city(seed: number, size: CitySize): { doc: RoadDoc; net: Network } {
  const doc = layCity(planCity({ ...DEFAULT_CITY, seed, size }));
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** A city's poles in id order and its spans as pairs of pole indices. */
function lines(doc: RoadDoc): { poles: { x: number; y: number; lamp: boolean }[]; spans: string[] } {
  const ids = [...doc.poles.keys()].sort((a, b) => a - b);
  const index = new Map(ids.map((id, i) => [id, i]));
  const poles = ids.map((id) => { const p = doc.poles.get(id)!; return { x: p.x, y: p.y, lamp: p.lamp }; });
  const spans = [...doc.poleSpans.values()].map((s) => [index.get(s.a)!, index.get(s.b)!].sort((p, q) => p - q).join('-')).sort();
  return { poles, spans };
}

describe('a generated city\'s power lines', () => {
  for (const [seed, size] of [[3, 'small'], [8, 'medium']] as const) {
    it(`are the same over shared tiles as street by street (seed ${seed}, ${size})`, () => {
      const tiled = city(seed, size), oracle = city(seed, size);
      const segments = [...tiled.doc.segments.keys()];
      expect(segments.length).toBeGreaterThan(24);
      const builtTiled = layPowerLines(tiled.doc, tiled.net, segments);
      const builtOracle = layPowerLines(oracle.doc, oracle.net, segments,
        (doc, from, to) => planPoleRun(doc, oracle.net, from, to, m(8), undefined, 'all'));
      expect(builtTiled).toBe(builtOracle);
      expect(builtTiled).toBeGreaterThan(10);
      const a = lines(tiled.doc), b = lines(oracle.doc);
      expect(a.poles.length).toBe(b.poles.length);
      a.poles.forEach((p, k) => {
        const q = b.poles[k]!;
        expect(Math.hypot(p.x - q.x, p.y - q.y), `pole ${k}`).toBeLessThan(m(0.005));
        expect(p.lamp).toBe(q.lamp);
      });
      expect(a.spans).toEqual(b.spans);
    });
  }
});
