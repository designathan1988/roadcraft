import { describe, expect, it } from 'vitest';
import { U, borderShift } from './_border';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { segmentPolyline } from '@world/geometry';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { tileCentre } from '@world/planet/atlas';
import { atlasToSphereInto, chartAt, onChartOf, toOwner } from '@world/planet/charts';
import { commitRoadPath, moveNodeChecked, splitSegment } from '@editor/commit';
import { commitRoundabout } from '@editor/roundabout';
import { PLANET_MAX_PIECE } from '@editor/planetFrame';

/**
 * MOVING A NODE, A ROUNDABOUT AND A SPLIT ACROSS THE PIECES' BORDERS
 * (`editor/commit.ts` editOnChart, splitSegmentAtCuts; `editor/roundabout.ts`).
 * Run with `vitest.planet.config.ts`.
 *
 * Worked out on the stored points as they stood: a node dropped on one kept on
 * the next piece's chart did not join it, a road dragged across another there
 * crossed it with no junction, a road stretched past a piece stayed one piece
 * reaching out of its chart's cell, and a curve split between two charts' ends
 * was junk.
 */

// Over an edge of the cube: west of the second piece of face 3.
const chart = 3 * TILES_PER_SIDE * TILES_PER_SIDE + 1 * TILES_PER_SIDE + 1;
const c = tileCentre(chart);
// Moved out as the border moved (`_border.ts`); the scenes in 0.4 m units, times U.
const shift = borderShift(chart, -1, 0);
const at = (x: number, y: number): Vec2 => toOwner(chart, { x: c.x - (x * U + shift), y: c.y + y * U });

function world() {
  const doc = new RoadDoc();
  doc.setBalance(1e9);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

/** A straight road from `a` to `b` (each kept on its own piece), drawn on `a`'s chart. */
function road(doc: RoadDoc, net: Network, a: Vec2, b0: Vec2) {
  const b = onChartOf(b0, a);
  const r = commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
    [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: null }]);
  expect(r.committed, `road refused: ${r.reason}`).toBe(true);
  if (net.revision !== doc.revision) net.rebuild();
}

const nodeNear = (doc: RoadDoc, p: Vec2) => [...doc.nodes.values()].find((n) => {
  const q = onChartOf(p, n);
  return Math.hypot(q.x - n.x, q.y - n.y) < U;
});

const sphere = (p: Vec2) => atlasToSphereInto(p.x, p.y, { x: 0, y: 0, z: 0 });

describe('editing roads across the borders between pieces', () => {
  it('joins a node dropped on one kept on the next piece', () => {
    const { doc, net } = world();
    road(doc, net, at(100, 0), at(200, 0));
    road(doc, net, at(260, 40), at(360, 40));
    const end = nodeNear(doc, at(200, 0))!, other = nodeNear(doc, at(260, 40))!;
    expect(chartAt(end.x, end.y)).not.toBe(chartAt(other.x, other.y));
    const nodes = doc.nodes.size;
    // Dragged from its own piece: the pointer read on that piece's chart.
    const r = moveNodeChecked(doc, net, end.id, onChartOf(other, end));
    expect(r.committed, `refused: ${r.reason}`).toBe(true);
    expect(doc.nodes.size).toBe(nodes - 1);
    expect([...doc.nodes.values()].some((n) => n.incident.length === 2)).toBe(true);
  });

  it('makes a junction where a dragged road crosses one kept on the next piece', () => {
    const { doc, net } = world();
    // A road north-south across the border, and one ending short of it.
    road(doc, net, at(270, -120), at(270, 120));
    road(doc, net, at(120, 0), at(200, 0));
    const end = nodeNear(doc, at(200, 0))!;
    const r = moveNodeChecked(doc, net, end.id, onChartOf(at(330, 0), end));
    expect(r.committed, `refused: ${r.reason}`).toBe(true);
    expect([...doc.nodes.values()].filter((n) => n.incident.length === 4)).toHaveLength(1);
  });

  it('cuts a road stretched past a piece', () => {
    const { doc, net } = world();
    road(doc, net, at(100, 0), at(150, 0));
    const end = nodeNear(doc, at(150, 0))!;
    const r = moveNodeChecked(doc, net, end.id, onChartOf(at(700, 30), end));
    expect(r.committed, `refused: ${r.reason}`).toBe(true);
    for (const seg of doc.segments.values()) expect(segmentPolyline(doc, seg).length).toBeLessThanOrEqual(PLANET_MAX_PIECE + 1);
    expect(doc.segments.size).toBeGreaterThan(2);
  });

  it('lays a large roundabout over a border in pieces, and refuses it on a road kept on the next piece', () => {
    const { doc, net } = world();
    const r = commitRoundabout(doc, net, at(250, 0), 300 * U, 0);
    expect(r.committed).toBe(true);
    for (const seg of doc.segments.values()) expect(segmentPolyline(doc, seg).length).toBeLessThanOrEqual(PLANET_MAX_PIECE + 1);
    expect(new Set([...doc.nodes.values()].map((n) => chartAt(n.x, n.y))).size).toBeGreaterThan(1);
    // Another, its ring across the first's arms on the next piece: refused, not laid over them.
    const again = commitRoundabout(doc, net, at(250, 450), 300 * U, 0);
    expect(again.committed).toBe(false);
  });

  it('splits a curve with its ends on two pieces where it lies', () => {
    const { doc, net } = world();
    const a = at(150, 0), b = onChartOf(at(330, 0), a);
    const r = commitRoadPath(doc, net, { kind: 'free', at: a }, { kind: 'free', at: b }, 1,
      [{ start: { at: a, heightOffset: 0 }, end: { at: b, heightOffset: 0 }, curve: { t: 0.5, h: -30 * U } }]);
    expect(r.committed, `road refused: ${r.reason}`).toBe(true);
    if (net.revision !== doc.revision) net.rebuild();
    const seg = [...doc.segments.values()][0]!;
    const before = segmentPolyline(doc, seg);
    const chartOf = net.polylines.chart(doc, seg.id);
    const half = before.sampleAt(before.length / 2).p;
    const node = splitSegment(doc, net, seg.id, before.length / 2, half);
    expect(node).not.toBeNull();
    net.rebuild();
    // Both pieces lie on the old curve: their points within a few cm of it, on the sphere.
    const old = before.toPoints().map((p) => sphere(toOwner(chartOf, p)));
    for (const piece of doc.segments.values()) {
      for (const p of segmentPolyline(doc, piece).toPoints()) {
        const s = sphere(toOwner(net.polylines.chart(doc, piece.id), p));
        const nearest = Math.min(...old.map((o) => Math.hypot(o.x - s.x, o.y - s.y, o.z - s.z)));
        expect(nearest * 3820).toBeLessThan(1.5);
      }
    }
  });
});
