import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { insideMulti, kerbward, onFootway, poleLines, poleLinesAt, poleLinesWork, type PoleLines } from '@world/poleLines';
import { cellWork } from '@world/cells';
import { planPoleRun, planPoleRunWhole } from '@editor/poles';
import { m } from '@world/units';

/**
 * THE POLE LINES BY CELL (docs/PROBLEMAS.md P7.7): what is asked about a
 * place is answered from the ribbons and junctions of the cells round it
 * (`poleLinesIn`), and must be exactly what the whole map's lines say there
 * (`poleLines`, the oracle) - before an edit, and after one, when only the
 * cells it reached are made again.
 */
function town(seed: number): { doc: RoadDoc; net: Network } {
  const doc = layCity(planCity({ ...DEFAULT_CITY, seed, size: 'small' }));
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** The town's bounds. */
function boundsOf(doc: RoadDoc): [number, number, number, number] {
  const ns = [...doc.nodes.values()];
  return [Math.min(...ns.map((n) => n.x)), Math.min(...ns.map((n) => n.y)), Math.max(...ns.map((n) => n.x)), Math.max(...ns.map((n) => n.y))];
}

/** A grid of points over the town, `step` apart, with a fixed jitter (no two on a cell edge). */
function samples(doc: RoadDoc, step: number): Vec2[] {
  const [x0, y0, x1, y1] = boundsOf(doc);
  const out: Vec2[] = [];
  let k = 0;
  for (let x = x0 - m(40); x <= x1 + m(40); x += step) {
    for (let y = y0 - m(40); y <= y1 + m(40); y += step) {
      k = (k * 1103515245 + 12345) % 2147483648;
      out.push({ x: x + (k % 997) / 997 * step * 0.5, y: y + (k % 991) / 991 * step * 0.5 });
    }
  }
  return out;
}

/** `kerbward` over every kerb edge of the whole map's lines (its tie rule too). */
function kerbwardWhole(lines: PoleLines, p: Vec2, reach: number): Vec2 | null {
  let best: Vec2 | null = null, bestD = reach;
  for (const poly of lines.kerbed) for (const ring of poly) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!, b = ring[(i + 1) % ring.length]!;
      const ax = a[0]!, ay = a[1]!, dx = b[0]! - ax, dy = b[1]! - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / len2)) : 0;
      const qx = ax + dx * t - p.x, qy = ay + dy * t - p.y;
      const d = Math.hypot(qx, qy);
      if (d <= 1e-9 || d > bestD + 1e-9) continue;
      const x = qx / d, y = qy / d;
      if (best && d >= bestD - 1e-9 && (x < best.x || (x === best.x && y <= best.y))) continue;
      bestD = Math.min(bestD, d);
      best = { x, y };
    }
  }
  return best;
}

/**
 * How far two answers about the pole lines may differ: their vertices are on
 * Clipper's grid of 1 mm (3 decimals, `poleLines.ts` `contoursOf`), and in a
 * half-millimetre tie the side a vertex of the offset falls on depends on the
 * order Clipper's offset walks the set it is given (it turns a whole group by
 * its lowest path): the cells' lines and the whole map's agree to that grid,
 * a vertex at most one step off in each axis. Measured on a town of blocks of
 * varied sizes: 0.8 mm (`poles-varied-blocks.json`).
 */
const GRID_TIE = Math.SQRT2 * 0.001;

/** Distance from a point to the nearest contour of a set of lines (within `reach`, else Infinity). */
function toContour(lines: PoleLines, p: Vec2, reach: number): number {
  let best = Infinity;
  for (const line of lines.contours) {
    const b = line.bbox;
    if (p.x < b.minX - reach || p.x > b.maxX + reach || p.y < b.minY - reach || p.y > b.maxY + reach) continue;
    best = Math.min(best, line.distanceTo(p));
  }
  return best <= reach ? best : Infinity;
}

function expectSameAnswers(net: Network, points: readonly Vec2[]): void {
  const whole = poleLines(net);
  let footway = 0;
  for (const p of points) {
    const inWhole = insideMulti(p, whole.paving) && !insideMulti(p, whole.kerbed);
    expect(onFootway(net, p), `footway at ${p.x},${p.y}`).toBe(inWhole);
    if (inWhole) footway++;
    const k = kerbward(net, p, m(6)), kw = kerbwardWhole(whole, p, m(6));
    if (kw === null) expect(k).toBeNull();
    else {
      expect(k).not.toBeNull();
      expect(k!.x).toBeCloseTo(kw.x, 9);
      expect(k!.y).toBeCloseTo(kw.y, 9);
    }
    const near = toContour(poleLinesAt(net, p), p, m(12)), nearWhole = toContour(whole, p, m(12));
    if (nearWhole === Infinity) expect(near).toBe(Infinity);
    else expect(Math.abs(near - nearWhole), `contour at ${p.x},${p.y}`).toBeLessThan(GRID_TIE);
  }
  // The samples reached the footways, not only open ground.
  expect(footway).toBeGreaterThan(points.length / 50);
}

describe('pole lines by cell', () => {
  it('answer as the whole map\'s lines do, at every point of a town', () => {
    const { doc, net } = town(7);
    expectSameAnswers(net, samples(doc, m(7)));
  });

  it('answer as the whole map\'s lines do in a town of blocks of varied sizes', () => {
    // The generated town with its blocks' sides varied (the construction
    // agent's grid, 2026-10-11), where a contour came out 0.8 mm off.
    const doc = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/poles-varied-blocks.json', 'utf8')));
    const net = new Network(doc);
    net.rebuild();
    expectSameAnswers(net, samples(doc, m(7)));
  });

  it('are made again only where an edit reached, and then still agree', () => {
    const { doc, net } = town(11);
    const points = samples(doc, m(9));
    expectSameAnswers(net, points);
    // A road far from the town: nothing of the town is made again.
    const [, , x1, y1] = boundsOf(doc);
    doc.addSegment(doc.addNode({ x: x1 + m(1500), y: y1 }).id, doc.addNode({ x: x1 + m(1600), y: y1 }).id, 1);
    net.rebuild();
    const made = poleLinesWork.made;
    for (const p of points) onFootway(net, p);
    expect(poleLinesWork.made - made).toBe(0);
    // A road across the town: the cells it reaches are made again, and agree.
    const [x0, y0] = boundsOf(doc);
    doc.addSegment(doc.addNode({ x: x0 + m(10), y: y0 + m(15) }).id, doc.addNode({ x: x0 + m(170), y: y0 + m(15) }).id, 1);
    net.rebuild();
    const before = poleLinesWork.made;
    expectSameAnswers(net, points);
    expect(poleLinesWork.made - before).toBeGreaterThan(0);
  });

  it('plan pole runs exactly as over the whole map\'s lines', () => {
    const { doc, net } = town(5);
    const footways = samples(doc, m(11)).filter((p) => onFootway(net, p));
    expect(footways.length).toBeGreaterThan(40);
    let planned = 0;
    for (let i = 0; i + 7 < footways.length && planned < 25; i += 7) {
      const from = footways[i]!, to = footways[i + 7]!;
      const plan = planPoleRun(doc, net, from, to, m(6));
      const whole = planPoleRunWhole(doc, net, from, to, m(6));
      expect(plan.refused ?? null).toBe(whole.refused ?? null);
      expect(plan.poles.length).toBe(whole.poles.length);
      // The same poles; a kerb line cut at the region's edge is rounded there (Clipper, 1 mm) - nothing else.
      plan.poles.forEach((pole, k) => {
        expect(Math.hypot(pole.at.x - whole.poles[k]!.at.x, pole.at.y - whole.poles[k]!.at.y)).toBeLessThan(m(0.005));
        expect(pole.existing).toBe(whole.poles[k]!.existing);
        expect(pole.lamp).toBe(whole.poles[k]!.lamp);
      });
      if (plan.poles.length) planned++;
    }
    expect(planned).toBeGreaterThan(5);
  });

  it('read the same cells for an isolated question on a small map and on a large one', () => {
    const small = town(3), large = town(3);
    // The large map: the same town and a far district of streets, kilometres away.
    const [, , x1, y1] = boundsOf(large.doc);
    for (let i = 0; i < 12; i++) {
      for (let j = 0; j < 12; j++) {
        const x = x1 + m(3000) + i * m(120), y = y1 + j * m(120);
        large.doc.addSegment(large.doc.addNode({ x, y }).id, large.doc.addNode({ x: x + m(100), y }).id, 1);
      }
    }
    large.net.rebuild();
    // A footway point, found on a third copy so the two maps are asked cold.
    const probe = town(3);
    const p = samples(probe.doc, m(23)).find((q) => onFootway(probe.net, q))!;
    const read = (net: Network): number => {
      const before = cellWork.cellsRead, segments = poleLinesWork.segments;
      onFootway(net, { x: p.x + m(0.01), y: p.y });
      return cellWork.cellsRead - before + (poleLinesWork.segments - segments);
    };
    // The first question about the place, on each map: the same cells and the same streets read.
    const onSmall = read(small.net), onLarge = read(large.net);
    expect(onSmall).toBeGreaterThan(0);
    expect(onLarge).toBe(onSmall);
  });
});
