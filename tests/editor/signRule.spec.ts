import { describe, expect, it } from 'vitest';

import { StreetscapeTool } from '@editor/streetscapeTool';
import { RoadDoc } from '@world/doc';
import type { SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { derivedSigns } from '@world/roads/derivedSigns';
import { legRule } from '@world/roads/rules';
import { m } from '@world/units';

/**
 * "PLACA = REGRA" (docs/VIAS.md V7): a stop or give-way plate put at a
 * junction's approach sets that leg's rule, and the plate drawn is the one
 * the rule puts up; anywhere else a plate is only a plate.
 */
function tee() {
  const doc = new RoadDoc();
  const c = doc.addNode({ x: 0, y: 0 });
  for (const [x, y] of [[300, 0], [-300, 0], [0, 300]] as const) doc.addSegment(c.id, doc.addNode({ x, y }).id, 1);
  const net = new Network(doc);
  net.rebuild();
  let signType: 'stop' | 'yield' | 'speed' = 'stop';
  const hints: string[] = [];
  const tool = new StreetscapeTool({
    doc, net, zoom: () => 1, kind: () => 'sign', extra: () => ({ signType }),
    mutate: (fn) => { fn(); net.rebuild(); }, hint: (k) => hints.push(k), redraw: () => {},
  });
  return { doc, net, centre: c.id, tool, hints, set: (t: typeof signType) => { signType = t; } };
}

describe('a plate is the rule', () => {
  it('a stop plate by the side road sets its rule to stop and adds no loose item', () => {
    const { doc, net, centre, tool, hints } = tee();
    const side = [...doc.segments.values()].find((s) => doc.node(s.b)!.y === 300)!.id as SegmentId;
    const kerb = net.ribbons.get(side)!.road.width / 2 + m(0.4);
    tool.down({ x: kerb, y: m(14) }, false);
    expect(hints.at(-1)).toBe('hint.streetscape.rule.stop');
    expect(doc.landscape.size).toBe(0);
    expect(doc.node(centre)!.control).toBe('priority');
    expect(legRule(doc, doc.node(centre)!, side)).toBe('stop');
    expect(derivedSigns(net).filter((s) => s.type === 'stop').map((s) => s.segment)).toEqual([side]);
  });

  it('far from any junction a plate is only a plate', () => {
    const { doc, net, tool } = tee();
    const kerb = net.ribbons.get([...doc.segments.keys()][0]!)!.road.width / 2 + m(0.4);
    tool.down({ x: 250, y: -kerb }, false);
    expect(doc.landscape.size).toBe(1);
  });
});

describe('a row of furniture dragged along a footway', () => {
  it('lamps every 30 m from the first to the pointer, laid on release', () => {
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 }), b = doc.addNode({ x: 500, y: 0 });
    doc.addSegment(a.id, b.id, 3);
    const net = new Network(doc);
    net.rebuild();
    const tool = new StreetscapeTool({
      doc, net, zoom: () => 1, kind: () => 'lamp', extra: () => ({}),
      mutate: (fn) => { fn(); }, hint: () => {}, redraw: () => {},
    });
    const kerb = net.ribbons.get([...doc.segments.keys()][0]!)!.road.width / 2 + m(0.3);
    tool.down({ x: 40, y: kerb }, false);
    expect(doc.landscape.size).toBe(1);
    tool.move({ x: 40 + m(95), y: kerb }, true);
    expect(tool.row?.pieces.length).toBe(3);
    tool.up();
    const xs = [...doc.landscape.values()].map((i) => i.x).sort((p, q) => p - q);
    expect(xs.length).toBe(4);
    for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeCloseTo(m(30), 0);
  });
});
