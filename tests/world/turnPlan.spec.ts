import { describe, expect, it } from 'vitest';
import { LaneletGraph } from '@world/lanelets';
import { type ChosenTurn, TurnPlan } from '@world/junctionTurns';
import type { JunctionSurface } from '@world/turnPaths';
import { chooseTurnOf } from '@world/turnChoice';
import { Network } from '@world/network';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import type { RoadDoc } from '@world/doc';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate, loadFixtures } from '../fuzz/support/runner';
import { graphLines } from './support/graphLines';

/**
 * THE TURNS CHOSEN OFF THE PAGE (`TurnPlan`, `conflictPool.ts`): a build that
 * stands in the turns it does not know, has them chosen as a worker would -
 * the asks through `structuredClone`, as `postMessage` copies them, answered by
 * `chooseTurnOf` - and builds those junctions again, makes the graph a build
 * that chose every turn on the page makes: every lanelet and connector, every
 * turn's points to the last bit.
 */
function update(graph: LaneletGraph, doc: RoadDoc, net: Network): { asked: number; redone: number } {
  graph.turnPlan = new TurnPlan();
  graph.update(doc, net);
  const plan = graph.turnPlan;
  const asks = structuredClone([...plan.asks]);
  const surfaces = new Map<string, JunctionSurface>();
  for (const [key, ask] of asks) plan.chosen.set(key, structuredClone(chooseTurnOf(ask, surfaces)) as ChosenTurn);
  const redone = plan.provisional.size;
  graph.redoProvisional(doc, net);
  expect(graph.turnPlan).toBeNull();
  return { asked: asks.length, redone };
}

/** Every connector's points, exactly. */
function turnPoints(graph: LaneletGraph): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const c of graph.connectors.values()) out.set(c.id, [...graph.lanelets.get(c.lanelet)!.centre.xy]);
  return out;
}

function expectSame(planned: LaneletGraph, here: LaneletGraph, where: string): void {
  expect(graphLines(planned), where).toEqual(graphLines(here));
  expect(turnPoints(planned), where).toEqual(turnPoints(here));
}

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

describe('junction turns chosen off the page', () => {
  it('build a generated city as the page does', () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 3, size: 'small' }));
    const net = new Network(doc);
    net.rebuild();
    const here = new LaneletGraph();
    here.update(doc, net);
    const planned = new LaneletGraph();
    const { asked, redone } = update(planned, doc, net);
    expect(planned.connectors.size).toBeGreaterThan(100);
    // The turns were chosen off the page, not here: most of the city's, its junctions built again.
    expect(asked).toBeGreaterThan(planned.connectors.size / 2);
    expect(redone).toBeGreaterThan(20);
    expectSame(planned, here, 'city');
  });

  for (let seed = 1; seed <= 6; seed++) it(`keep the graph the page keeps after every op of fuzz sequence ${seed}`, () => {
    const ops = generate(seed, 24);
    const state = freshState();
    const here = new LaneletGraph();
    const planned = new LaneletGraph();
    here.update(state.doc, state.net);
    update(planned, state.doc, state.net);
    for (let i = 0; i < ops.length; i++) {
      let changed: boolean;
      try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      here.update(state.doc, state.net);
      update(planned, state.doc, state.net);
      expectSame(planned, here, `seed ${seed} op ${i} (${ops[i]!.op})`);
    }
  });

  for (const fixture of loadFixtures().slice(0, 12)) it(`keep the graph the page keeps over the fuzz fixture ${fixture.name}`, () => {
    const state = freshState();
    const here = new LaneletGraph();
    const planned = new LaneletGraph();
    here.update(state.doc, state.net);
    update(planned, state.doc, state.net);
    fixture.ops.forEach((op, i) => {
      let changed: boolean;
      try { changed = applyOp(state, op); } catch (error) { recordRejected(error); return; }
      if (!changed) return;
      here.update(state.doc, state.net);
      update(planned, state.doc, state.net);
      expectSame(planned, here, `${fixture.name} op ${i}`);
    });
  });
});
