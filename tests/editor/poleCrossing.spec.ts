import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { onFootway, poleLines } from '@world/poleLines';
import { planPoleRun } from '@editor/poles';
import type { Vec2 } from '@core/vec2';

/**
 * A POLE LINE CROSSES A STREET BY ONE SQUARE SPAN (docs/PLANO.md, 5h).
 *
 * The player's report of 2026-10-09: drawing a line from one footway to the
 * one across the road, it went down the street, into the next one and back.
 * In a network of open-ended streets the kerb line is one contour, and the
 * route followed it. Measured: footways 21.6 units apart, a line of 176.
 */

/** A crossroads of four open-ended streets, at 45 degrees, as the town where it was reported. */
function town(): Network {
  const doc = new RoadDoc();
  const centre = doc.addNode({ x: -152.5, y: -7.5 }).id;
  for (const end of [{ x: -275, y: -130 }, { x: 10, y: 155 }, { x: -332.5, y: 172.5 }, { x: -32.5, y: -127.5 }]) {
    doc.addSegment(doc.addNode(end).id, centre, 1);
  }
  const net = new Network(doc);
  net.rebuild();
  return net;
}

/** The kerb-line points nearest `at` on each side of the line through it along `along`. */
function facing(net: Network, at: Vec2, along: Vec2): [Vec2, Vec2] {
  const line = poleLines(net).contours[0]!;
  const n = { x: -along.y, y: along.x };
  let left: Vec2 | null = null, right: Vec2 | null = null, dl = Infinity, dr = Infinity;
  for (let s = 0; s < line.length; s += 0.5) {
    const p = line.sampleAt(s).p;
    const side = (p.x - at.x) * n.x + (p.y - at.y) * n.y;
    const d = Math.hypot(p.x - at.x, p.y - at.y);
    if (side > 0 && d < dl) { left = p; dl = d; }
    if (side < 0 && d < dr) { right = p; dr = d; }
  }
  return [left!, right!];
}

const length = (points: readonly Vec2[]): number =>
  points.reduce((sum, p, i) => (i ? sum + Math.hypot(p.x - points[i - 1]!.x, p.y - points[i - 1]!.y) : 0), 0);

describe('pole lines over streets', () => {
  const net = town();
  const doc = net.doc;
  // The west arm, half way along, and its direction.
  const mid = { x: -213.75, y: -68.75 };
  const along = { x: Math.SQRT1_2, y: Math.SQRT1_2 };

  it('crosses to the footway opposite by one square span', () => {
    expect(poleLines(net).contours.length).toBe(1);
    const [a, b] = facing(net, mid, along);
    const straight = Math.hypot(a.x - b.x, a.y - b.y);
    const plan = planPoleRun(doc, net, a, b, 10);
    expect(plan.refused).toBeUndefined();
    const poles = plan.poles.map((p) => p.at);
    // No more line than the span across and a step either side.
    expect(length(poles)).toBeLessThan(straight * 1.3 + 10);
    for (const p of poles) expect(onFootway(net, p)).toBe(true);
  });

  it('keeps along one side when both ends are on it', () => {
    const [a] = facing(net, mid, along);
    const [b] = facing(net, { x: mid.x - along.x * 40, y: mid.y - along.y * 40 }, along);
    const plan = planPoleRun(doc, net, a, b, 10);
    expect(plan.refused).toBeUndefined();
    const n = { x: -along.y, y: along.x };
    for (const p of plan.poles) {
      expect((p.at.x - mid.x) * n.x + (p.at.y - mid.y) * n.y).toBeGreaterThan(0);
      expect(onFootway(net, p.at)).toBe(true);
    }
  });
});
