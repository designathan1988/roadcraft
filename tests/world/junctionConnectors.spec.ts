import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { Network } from '@world/network';
import { type Connector, LaneletGraph } from '@world/lanelets';
import { planCity, DEFAULT_CITY, type CityStyle } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import type { RoadDoc } from '@world/doc';
import type { NodeId, SegmentId } from '@world/ids';
import { m } from '@world/units';

/**
 * ONE JUNCTION'S CONNECTORS WITHOUT THE MAP'S GRAPH (`LaneletGraph.junctionConnectors`):
 * made from the roads that meet there and the junction's surface alone, they
 * are the whole graph's for that junction - the same movements, the same
 * paths bit for bit, the same largest body - on generated towns of every
 * street style, before and after random edits with a seed.
 */
const line = (c: Connector, path: Float64Array): string =>
  `${c.id} ${c.turn} ${c.carried} ${c.group} ${c.maxBodyClass} ${c.inSegment}>${c.outSegment} ${c.length} ${Buffer.from(path.buffer, path.byteOffset, path.byteLength).toString('base64')}`;

function expectSame(doc: RoadDoc, net: Network, graph: LaneletGraph, nodes: readonly NodeId[], where: string): number {
  let compared = 0;
  for (const node of nodes) {
    const whole = (graph.junctions.get(node)?.connectors ?? []).map((id) => graph.connectors.get(id)!);
    const alone = LaneletGraph.junctionConnectors(doc, net, node);
    const lines = (list: readonly Connector[], g: (c: Connector) => Float64Array): string[] => list.map((c) => line(c, g(c))).sort();
    expect(lines(alone.connectors, (c) => alone.centres.get(c.id)!.xy), `${where}: node ${node}`)
      .toEqual(lines(whole, (c) => graph.lanelet(c.lanelet)!.centre.xy));
    compared += whole.length;
  }
  return compared;
}

const STYLES: CityStyle[] = ['blocks', 'grid', 'organic', 'radial'];

describe('one junction\'s connectors, without the graph of the map', () => {
  for (const [i, style] of STYLES.entries()) it(`equal the whole graph's on a ${style} town, edit after edit`, () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: i + 1, size: 'small', style }));
    const net = new Network(doc);
    net.rebuild();
    const graph = new LaneletGraph();
    graph.build(doc, net);
    const rng = new Rng(17 + i);
    const junctions = (): NodeId[] => [...doc.nodes.values()].filter((n) => n.incident.length >= 2).map((n) => n.id).sort((a, b) => a - b);
    const pick = <T>(list: readonly T[]): T => list[rng.int(0, list.length - 1)]!;
    let compared = expectSame(doc, net, graph, junctions().filter((_, k) => k % 7 === 0), 'built');
    for (let step = 0; step < 10; step++) {
      const nodes = junctions();
      const node = pick(nodes);
      const n = doc.requireNode(node);
      const r = rng.float();
      if (r < 0.3) doc.setNodeControl(node, pick(['auto', 'signal', 'stop', 'yield', 'priority'] as const));
      else if (r < 0.5 && n.incident.length >= 2) doc.setMovementBlocked(node, n.incident[0] as SegmentId, n.incident[1] as SegmentId, true);
      else if (r < 0.65) doc.setSegmentLanes(pick(n.incident) as SegmentId, pick([2, 4, 6]));
      // A U-turn through the median, as the U-turn tool puts it (`editor/streetObjects.ts`).
      else if (r < 0.8 && n.incident.length === 2) doc.setNodeUturn(node, pick(n.incident) as SegmentId);
      else doc.moveNode(node, { x: n.x + m(rng.float() * 6 - 3), y: n.y + m(rng.float() * 6 - 3) });
      net.rebuild();
      graph.build(doc, net);
      // The node edited and the junctions one road from it, and a few others.
      const around = new Set<NodeId>([node]);
      for (const s of doc.node(node)?.incident ?? []) { const seg = doc.requireSegment(s); around.add(seg.a); around.add(seg.b); }
      for (let k = 0; k < 4; k++) around.add(pick(junctions()));
      compared += expectSame(doc, net, graph, [...around].filter((id) => (doc.node(id)?.incident.length ?? 0) >= 2), `step ${step}`);
    }
    expect(compared).toBeGreaterThan(100);
  });
});
