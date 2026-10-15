import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Rng } from '@core/rng';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { NodeId, SegmentId } from '@world/ids';
import { type RoadElevation, buildRoadElevation } from '@world/elevation';
import { TerrainIndex, sampleTerrainHeight } from '@world/terrain';
import type { RoadStructure } from '@world/structures';
import { m } from '@world/units';

/**
 * THE ROADS' HEIGHTS SOLVED WHERE A CHANGE REACHES (`elevation.ts`, "what is
 * solved again"): after random edits with a seed - a node moved, raised or
 * lowered, a road made a viaduct, a bridge or a tunnel or put back on the
 * ground, a road taken away - the solve started from the last one equals a
 * solve from nothing, road by road and node by node; and an edit of one road
 * of a town solves a few roads, not the town (the town is one connected piece,
 * which was solved whole at every edit).
 */
function lines(doc: RoadDoc, elevation: RoadElevation): string[] {
  const out: string[] = [];
  const summaries = elevation.summaries!();
  for (const id of [...summaries.keys()].sort((a, b) => a - b)) out.push(`profile ${id} ${summaries.get(id)!.digest}`);
  for (const id of [...doc.nodes.keys()].sort((a, b) => a - b)) out.push(`node ${id} ${elevation.nodeHeight(id)}`);
  return out;
}

const STRUCTURES: readonly RoadStructure[] = ['ground', 'ground', 'elevated', 'bridge', 'tunnel'];

describe('the roads\' heights solved where a change reaches', () => {
  for (const seed of [1, 2, 3]) it(`equal a solve from nothing after every random edit (seed ${seed})`, () => {
    const doc = RoadDoc.fromJSON(JSON.parse(readFileSync('maps/cidade-com-estacionamento.json', 'utf8')));
    const net = new Network(doc);
    net.rebuild({ full: true });
    const index = new TerrainIndex(doc.terrainStamps, 0, doc.terrainRelief);
    const ground = (x: number, y: number): number => sampleTerrainHeight(index, x, y);
    let elevation = buildRoadElevation(net, ground);
    const total = elevation.summaries!().size;
    const rng = new Rng(seed);
    const solved: number[] = [];
    for (let step = 0; step < 14; step++) {
      const segments = [...doc.segments.keys()].sort((a, b) => a - b);
      const nodes = [...doc.nodes.keys()].sort((a, b) => a - b);
      const seg = segments[rng.int(0, segments.length - 1)] as SegmentId;
      const node = nodes[rng.int(0, nodes.length - 1)] as NodeId;
      const r = rng.float();
      let what: string;
      if (r < 0.3) { doc.setSegmentStructure(seg, STRUCTURES[rng.int(0, STRUCTURES.length - 1)]!); what = `structure of ${seg}`; }
      else if (r < 0.55) { doc.setNodeHeightOffset(node, m(rng.float() * 16 - 6)); what = `height of ${node}`; }
      else if (r < 0.8) {
        const n = doc.requireNode(node);
        doc.moveNode(node, { x: n.x + m(rng.float() * 8 - 4), y: n.y + m(rng.float() * 8 - 4) });
        what = `move of ${node}`;
      } else { doc.removeSegment(seg); doc.pruneOrphanNodes(); what = `removal of ${seg}`; }
      net.rebuild();
      elevation = buildRoadElevation(net, ground, elevation);
      // Never the whole town again (it was every road, and more for each round).
      expect(elevation.solved, `step ${step}: ${what}`).toBeLessThan(total);
      solved.push(elevation.solved!);
      const fresh = new Network(doc.clone());
      fresh.rebuild({ full: true });
      expect(lines(doc, elevation), `step ${step}: ${what}`).toEqual(lines(doc, buildRoadElevation(fresh, ground)));
    }
    // An edit reaches the roads two junctions round it: a handful of the town's.
    solved.sort((a, b) => a - b);
    expect(solved[Math.floor(solved.length / 2)]).toBeLessThan(total / 3);
  });
});
