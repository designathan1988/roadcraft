import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { junctionDetail } from '@world/markings';
import { Level } from '@world/roadTypes';
import { stopLineDistance } from '@world/approach';

/** A WIDE ROAD FORKING INTO TWO NARROWER ONES. */
function fork(): { doc: RoadDoc; net: Network; node: number; avenue: number } {
  const doc = new RoadDoc();
  const node = doc.addNode({ x: 0, y: 0 });
  const west = doc.addNode({ x: -500, y: 0 });
  const avenue = doc.addSegment(west.id, node.id, 2)!;
  doc.addSegment(node.id, doc.addNode({ x: 420, y: 196 }).id, 1);
  doc.addSegment(node.id, doc.addNode({ x: 420, y: -196 }).id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net, node: node.id, avenue: avenue.id };
}

describe('a fork', () => {
  it('gives the wide approach a crossing, and a stop line behind it', () => {
    const { net, node, avenue } = fork();
    const crossing = net.crosswalkDistanceAt(avenue as never, node as never);
    const stop = net.stopLineDistance(avenue as never, node as never);
    expect(crossing).toBeGreaterThan(0);
    expect(stop).toBeGreaterThan(crossing);
  });

  it('stops the traffic where the bar is painted', () => {
    const { net, node, avenue } = fork();
    const junction = net.junctions.get(node as never)?.get(Level.Asphalt);
    const i = junction!.legs.findIndex((l) => l.seg === avenue);
    const painted = stopLineDistance(junction!.trims[i] as number);
    expect(Math.abs(net.stopLineDistance(avenue as never, node as never) - painted)).toBeLessThan(1.5);
  });

  it('paints a zebra on the wide arm too', () => {
    const { net } = fork();
    const { zebras } = junctionDetail(net);
    // The two street arms lie east of the node, the avenue arm west of it.
    expect(zebras.some((z) => (z.a.x + z.b.x) / 2 > 1)).toBe(true);
    expect(zebras.some((z) => (z.a.x + z.b.x) / 2 < -1)).toBe(true);
  });
});
