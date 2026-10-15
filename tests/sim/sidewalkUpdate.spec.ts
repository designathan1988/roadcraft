import { describe, expect, it } from 'vitest';
import { Digest } from '@core/digest';
import { ChangeLog } from '@core/changeLog';
import { LaneletGraph, type GraphChange } from '@world/lanelets';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { SidewalkGraph } from '@sim/peds/sidewalk';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

/** THE KERBS AND ZEBRAS KEPT BY WHAT CHANGED (`SidewalkGraph.update`) */
function lines(g: SidewalkGraph): string[] {
  const out: string[] = [];
  for (const n of g.nodes.values()) out.push(`node ${n.id} ${n.at.x} ${n.at.y}`);
  for (const e of g.edges.values()) {
    out.push(`edge ${e.id} ${e.kind} ${e.from} ${e.to} ${e.crossing ?? '-'} ${[...e.lanes ?? []].sort().join(',')} ${new Digest().addAll(e.path.xy).value()}`);
  }
  for (const [crossing, edge] of g.crossings) out.push(`crossing ${crossing} ${edge}`);
  for (const seg of new Set([...g.edges.values()].map((e) => e.segment).filter((s) => s !== undefined))) {
    out.push(`beside ${seg} ${g.walksBeside(seg!).map((e) => e.id).join(',')}`);
  }
  return out.sort();
}

function fresh(doc: RoadDoc, net: Network): string[] {
  const graph = new LaneletGraph();
  graph.build(doc, net);
  const g = new SidewalkGraph();
  g.build(doc, net, graph);
  return lines(g);
}

/** The lane graph, its log and the kerbs read from it every `every` edits, as the world keeps them. */
function keptOf(doc: RoadDoc, net: Network): { follow(read: boolean): void; lines(): string[] } {
  const graph = new LaneletGraph();
  const log = new ChangeLog<GraphChange>();
  log.push(graph.update(doc, net));
  const g = new SidewalkGraph();
  let seen: object | null = null;
  const read = (): void => { g.update(doc, net, graph, log.since(seen)); seen = log.state; };
  read();
  return {
    follow: (now) => { log.push(graph.update(doc, net)); if (now) read(); },
    lines: () => { read(); return lines(g); },
  };
}

describe('the kerbs and zebras kept by the lane graph\'s changes', () => {
  for (const every of [1, 2]) for (let seed = 1; seed <= 8; seed++) it(`equal those built from nothing, read every ${every} edit(s), fuzz sequence ${seed}`, () => {
    const ops = generate(seed, 24);
    const state = freshState();
    const kept = keptOf(state.doc, state.net);
    let made = 0;
    for (let i = 0; i < ops.length; i++) {
      let changed: boolean;
      try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      made++;
      kept.follow(made % every === 0);
      if (made % every === 0) expect(kept.lines(), `seed ${seed} op ${i} (${ops[i]!.op})`).toEqual(fresh(state.doc, state.net));
    }
  });

  for (const fixture of loadFixtures()) it(`equal those built from nothing over the fuzz fixture ${fixture.name}`, () => {
    const state = freshState();
    const kept = keptOf(state.doc, state.net);
    fixture.ops.forEach((op, i) => {
      let changed: boolean;
      try { changed = applyOp(state, op); } catch (error) { recordRejected(error); return; }
      if (!changed) return;
      kept.follow(true);
      expect(kept.lines(), `${fixture.name} op ${i}`).toEqual(fresh(state.doc, state.net));
    });
  });
});
