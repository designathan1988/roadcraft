import { describe, expect, it, vi } from 'vitest';
import { SimWorld } from '@sim/world';
import { Network } from '@world/network';
import { type LaneletGraph } from '@world/lanelets';
import { WAITING } from '@world/conflictPoints';
import { type PairMeasurer, type SampledSweep, type SweepSamples, firstCrossing, pairTable, sampleSweep } from '@world/conflictTable';
import type { ChosenTurn } from '@world/junctionTurns';
import type { JunctionSurface } from '@world/turnPaths';
import { chooseTurnOf } from '@world/turnChoice';
import { planCity, DEFAULT_CITY } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import type { RoadDoc } from '@world/doc';
import { Polyline } from '@core/polyline';
import { applyOp, freshState } from '../fuzz/support/ops';
import { generate } from '../fuzz/support/runner';
import { conflictLines, graphLines } from '../world/support/graphLines';
import { m } from '@world/units';

/** The generated towns' radius: a few dozen junctions, every kind the generator lays, inside a test's time. */
const TOWN = m(260);
/** A smaller one, where the town's size is not what is checked. */
const SMALL_TOWN = m(200);

/**
 * THE TRAFFIC'S TOPOLOGY PREPARED OFF THE PAGE (`SimWorld.prepareVehicleTopology` with workers,
 * `conflictPool.ts`): the turns chosen, the movements' sweeps sampled and the pairs measured by
 * workers, and the pairs' centreline crossings found by them - here answered as a worker answers,
 * every ask and answer through `structuredClone` as `postMessage` copies them - must give the lane
 * graph, the sweeps, the pair tables and the conflict index that the same preparation done wholly on
 * the page gives, to the last bit; and no sweep is sampled, nor crossing found, on the page while
 * there are workers.
 */
interface Workers extends PairMeasurer {
  /** Every frame a worker sampled, as the page received it. */
  readonly frames: Set<Float64Array>;
  readonly asked: { sweeps: number; pairs: number; turns: number; crossings: number };
}

function workers(failSweeps = false): Workers {
  const frames = new Set<Float64Array>();
  const asked = { sweeps: 0, pairs: 0, turns: 0, crossings: 0 };
  return {
    frames,
    asked,
    measure(pairs) {
      asked.pairs += pairs.length;
      const plain = (s: SweepSamples) => ({ c0: s.c0, count: s.count, length: s.length, frame: s.frame, frameLengthSq: s.frameLengthSq });
      const sent = structuredClone(pairs.map((p) => ({ a: plain(p.a), b: plain(p.b) })));
      const fresh = (s: ReturnType<typeof plain>): SweepSamples => ({ ...s, bounds: null, grid: null, range: null });
      return Promise.resolve(structuredClone(sent.map((p) => pairTable(fresh(p.a), fresh(p.b)))));
    },
    chooseTurns(asks, surfaces) {
      asked.turns += asks.length;
      const sent = structuredClone(asks), rings = structuredClone(surfaces);
      const made = new Map<string, JunctionSurface>();
      return Promise.resolve(structuredClone(sent.map((t) => chooseTurnOf(t, rings.get(t.surfaceKey)!, made))) as ChosenTurn[]);
    },
    sampleSweeps(asks) {
      if (failSweeps) return Promise.reject(new Error('no workers'));
      asked.sweeps += asks.length;
      const sent = structuredClone(asks);
      const lines = new Map<Float64Array, { line: Polyline; digest: number }>();
      const answer: SampledSweep[] = structuredClone(sent.map((a) => sampleSweep(a, lines)));
      for (const s of answer) frames.add(s.frame);
      return Promise.resolve(answer);
    },
    crossings(pairs) {
      asked.crossings += pairs.length;
      const sent = structuredClone(pairs);
      return Promise.resolve(structuredClone(sent.map((p) => firstCrossing(Polyline.fromFlat(p.a).toPoints(), Polyline.fromFlat(p.b).toPoints()))));
    },
  };
}

/** The pairs the index holds, with their zones and their crossing as far as it is known. */
const pairsOf = (w: SimWorld) => (w.conflicts as unknown as { pairCache: Map<string, { zones: unknown; crossing?: unknown }> }).pairCache;

/** The topology brought up to the network as the frame loop does (`TopologyCatchUp`): WAITING waits for the workers. */
async function catchUp(w: SimWorld, measurer?: PairMeasurer): Promise<void> {
  const prep = w.prepareVehicleTopology(measurer);
  for (let step = prep.next(); !step.done; step = prep.next()) {
    if (step.value === WAITING) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  // With workers, every pair with zones knows its crossing before the index is built: none is found on the page.
  if (measurer?.crossings) for (const pair of pairsOf(w).values()) if (pair.zones) expect(pair.crossing).not.toBeUndefined();
  w.rebuildVehicleTopology();
}

const internals = (w: SimWorld) => w as unknown as { prepGraph: LaneletGraph };

/**
 * The graph the agents run on and the conflict index, taken over from the preparation (`LaneletGraph.adopt`),
 * must be what a world that never prepared builds on its own (`rebuildTopology`, `LaneletGraph.update`).
 */
function expectAsBuiltHere(off: SimWorld, here: SimWorld, where: string): void {
  expect(graphLines(off.graph), `${where}: graph taken over`).toEqual(graphLines(here.graph));
  expect(conflictLines(off.conflicts).sort(), `${where}: conflicts taken over`).toEqual(conflictLines(here.conflicts).sort());
}
const sweepsOf = (w: SimWorld) => (w.conflicts as unknown as { sweepCache: Map<string, Float64Array> }).sweepCache;

/** Everything the two preparations must agree on: both graphs, the conflicts, the sweeps and the tables measured. */
function expectSame(off: SimWorld, page: SimWorld, measuredOff: Map<string, Float64Array | null>, measuredPage: Map<string, Float64Array | null>, where: string): void {
  expect(graphLines(internals(off).prepGraph), `${where}: prepared graph`).toEqual(graphLines(internals(page).prepGraph));
  expect(graphLines(off.graph), `${where}: graph`).toEqual(graphLines(page.graph));
  expect(conflictLines(off.conflicts).sort(), `${where}: conflicts`).toEqual(conflictLines(page.conflicts).sort());
  const sweeps = (w: SimWorld) => [...sweepsOf(w)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  expect(sweeps(off), `${where}: sweeps`).toEqual(sweeps(page));
  const tables = (m: Map<string, Float64Array | null>) => [...m].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  expect(tables(measuredOff), `${where}: pair tables`).toEqual(tables(measuredPage));
}


/** Every sweep the index holds was sampled by a worker: none on the page. */
function expectNoneOnPage(w: SimWorld, off: Workers): void {
  for (const frame of sweepsOf(w).values()) expect(off.frames.has(frame)).toBe(true);
}

/** The ops the editor refused (a fuzz op may be one it would not do): the sequence stops there. */
const rejected: unknown[] = [];
const recordRejected = (error: unknown): void => { rejected.push(error); };

function pair(doc: RoadDoc): { off: SimWorld; page: SimWorld; net: Network } {
  const net = new Network(doc);
  net.rebuild();
  return { off: new SimWorld(doc, net, 7), page: new SimWorld(doc, net, 7), net };
}

describe('the traffic topology prepared off the page', () => {
  it('builds a generated city as the page does, no sweep sampled on the page', async () => {
    const { off, page } = pair(layCity(planCity({ ...DEFAULT_CITY, seed: 3, size: 'small', radius: TOWN })));
    const measurer = workers();
    await catchUp(off, measurer);
    await catchUp(page);
    const here = new SimWorld(off.doc, off.net, 7);
    here.rebuildTopology();
    expectAsBuiltHere(off, here, 'city');
    expect(off.graph.connectors.size).toBeGreaterThan(100);
    expect(off.graph.junctions.size).toBeGreaterThan(20);
    expect(measurer.asked.turns).toBeGreaterThan(0);
    expect(measurer.asked.sweeps).toBeGreaterThan(off.graph.connectors.size / 2);
    expect(measurer.asked.pairs).toBeGreaterThan(0);
    expect(measurer.asked.crossings).toBeGreaterThan(0);
    expect(off.conflicts.measured.build).toBe(0);
    expectNoneOnPage(off, measurer);
    expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), 'city');
  });

  it('opens a city whose zones an earlier session kept as the page does, the crossings found off the page', async () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, seed: 4, size: 'small', radius: SMALL_TOWN }));
    const first = pair(doc).page;
    await catchUp(first);
    const kept = first.conflicts.takeMeasured();
    const { off, page } = pair(doc);
    off.conflicts.seed(kept);
    page.conflicts.seed(kept);
    const measurer = workers();
    await catchUp(off, measurer);
    await catchUp(page);
    // Every table read back, none measured; the crossings still found by the workers.
    expect(measurer.asked.pairs).toBe(0);
    expect(measurer.asked.crossings).toBeGreaterThan(0);
    expectNoneOnPage(off, measurer);
    expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), 'city kept');
  });

  it('builds the city as the page does when the workers cannot sample the sweeps', async () => {
    const { off, page } = pair(layCity(planCity({ ...DEFAULT_CITY, seed: 5, size: 'small', radius: SMALL_TOWN })));
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await catchUp(off, workers(true));
    expect(warned).toHaveBeenCalled();
    warned.mockRestore();
    await catchUp(page);
    expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), 'city, sweeps on the page');
  });

  for (let seed = 1; seed <= 3; seed++) it(`keeps what the page keeps after every op of fuzz sequence ${seed}`, async () => {
    const ops = generate(seed, 24);
    const state = freshState();
    const off = new SimWorld(state.doc, state.net, 7), page = new SimWorld(state.doc, state.net, 7);
    const here = new SimWorld(state.doc, state.net, 7);
    const measurer = workers();
    await catchUp(off, measurer);
    await catchUp(page);
    here.rebuildTopology();
    let edits = 0;
    for (let i = 0; i < ops.length; i++) {
      let changed: boolean;
      try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
      if (!changed) continue;
      edits++;
      await catchUp(off, measurer);
      await catchUp(page);
      expectNoneOnPage(off, measurer);
      expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), `seed ${seed} op ${i} (${ops[i]!.op})`);
      here.rebuildTopology();
      expectAsBuiltHere(off, here, `seed ${seed} op ${i} (${ops[i]!.op})`);
    }
    expect(edits).toBeGreaterThan(0);
  });

  /**
   * A PREPARATION GIVEN UP while the workers choose its turns (`TopologyCatchUp` starts another when the
   * network is edited meanwhile) left junctions on stand-in turns in the preparation graph: the next one
   * must finish them, so no stand-in ever reaches a graph - the graph, the one taken over and the conflicts
   * as a world that prepared nothing builds them.
   */
  it('finishes the junctions of a preparation given up while its turns were chosen', async () => {
    let givenUp = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const ops = generate(seed, 24);
      const state = freshState();
      const off = new SimWorld(state.doc, state.net, 7), page = new SimWorld(state.doc, state.net, 7);
      const here = new SimWorld(state.doc, state.net, 7);
      const measurer = workers();
      await catchUp(off, measurer);
      await catchUp(page);
      for (let i = 0; i + 1 < ops.length; i++) {
        let changed: boolean;
        try { changed = applyOp(state, ops[i]!); } catch (error) { recordRejected(error); break; }
        if (!changed) continue;
        // Prepared up to the workers' first answer awaited, then given up for the next edit.
        const prep = off.prepareVehicleTopology(measurer);
        let step = prep.next();
        while (!step.done && step.value !== WAITING) step = prep.next();
        const plan = internals(off).prepGraph.turnPlan;
        if (plan && plan.provisional.size > 0) givenUp++;
        try { changed = applyOp(state, ops[++i]!); } catch (error) { recordRejected(error); break; }
        await catchUp(off, measurer);
        await catchUp(page);
        here.rebuildTopology();
        const where = `seed ${seed} ops ${i - 1}, ${i}`;
        expect(internals(off).prepGraph.turnPlan, `${where}: plan finished`).toBeNull();
        expectNoneOnPage(off, measurer);
        expectSame(off, page, off.conflicts.takeMeasured(), page.conflicts.takeMeasured(), where);
        expectAsBuiltHere(off, here, where);
      }
    }
    // The case is met: preparations were given up with junctions on stand-ins.
    expect(givenUp).toBeGreaterThan(0);
  });
});
