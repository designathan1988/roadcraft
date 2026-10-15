import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LaneletGraph } from '@world/lanelets';

/** `LaneletGraph.linksOfSegment` is the filter over every lanelet it stands for. */
describe('the links of a segment', () => {
  it('are the link lanelets of that segment, in the order of the lanelets', () => {
    const doc = RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);
    const net = new Network(doc);
    net.rebuild();
    const graph = new LaneletGraph();
    graph.build(doc, net);
    expect(graph.lanelets.size).toBeGreaterThan(0);
    for (const id of doc.segments.keys()) {
      const filtered = [...graph.lanelets.values()].filter((l) => l.kind === 'link' && l.segment === id).map((l) => l.id);
      expect(graph.linksOfSegment(id)).toEqual(filtered);
    }
  });
});
