import { describe, expect, it } from 'vitest';

import { step } from '@sim/pipeline';
import { DT } from '@sim/params';
import type { SimWorld } from '@sim/world';
import type { LaneletId } from '@world/lanelets';
import type { SegmentId } from '@world/ids';
import { fixtureDoc, simOf } from './support/bodies';

const run = (sim: SimWorld, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds / DT); i++) step(sim, { traffic: true, pedestrians: true });
};

/** A link lane with a vehicle on it, and the road it belongs to. */
function busyLink(sim: SimWorld): { lane: LaneletId; segment: SegmentId } {
  for (const v of sim.vehiclesInIdOrder()) {
    const lane = sim.lanelet(v.lanelet);
    if (lane?.kind === 'link' && lane.segment !== undefined) return { lane: lane.id, segment: lane.segment as SegmentId };
  }
  throw new Error('no vehicle on a link lane');
}

describe('a lane an edit took and an undo gave back', () => {
  it('is no longer a ghost once it is in the graph again, and traffic enters it', () => {
    const sim = simOf(fixtureDoc(), 0x5eed, 2);
    run(sim, 20);
    const { lane, segment } = busyLink(sim);
    const before = sim.doc.toJSON();

    // The edit takes the road; the lane is kept while a vehicle is still on it
    // and marked a ghost, as stage 7 does (`collectGhosts`). Marked here by
    // hand: today the pipeline removes a vehicle whose lane left the graph
    // before stage 7 sees it (`rebindVehicles`, `integrateAll`,
    // `stepDespawn`), so the mark is reached only by a caller that rebuilds
    // without rebinding - and must still come off when the lane comes back.
    sim.doc.removeSegment(segment);
    sim.net.rebuild();
    sim.rebuildTopology();
    expect(sim.lanelet(lane)).toBeUndefined();
    const rt = sim.runtime.get(lane)!;
    expect(rt.order.length, 'precondition: a vehicle still on the lane taken').toBeGreaterThan(0);
    rt.ghost = true;
    rt.ghostSince = sim.clock.tick;

    // Undo: the same road, the same lane ids.
    sim.doc.replaceFromJSON(before, { repair: false });
    sim.net.rebuild();
    step(sim, { traffic: true, pedestrians: true });
    expect(sim.lanelet(lane)).toBeDefined();
    expect(sim.rt(lane).ghost, 'a lane back in the graph is not a ghost').toBe(false);

    // And it is driven again: a vehicle that was not on it at the undo enters it.
    const onItAtUndo = new Set(sim.rt(lane).order);
    let entered = false;
    for (let i = 0; i < Math.round(60 / DT) && !entered; i++) {
      step(sim, { traffic: true, pedestrians: true });
      entered = sim.rt(lane).order.some((id) => !onItAtUndo.has(id));
    }
    expect(entered, 'a vehicle drove into the lane after the undo').toBe(true);
  });
});

describe('reading a lane', () => {
  it('makes no runtime state for it', () => {
    const sim = simOf(fixtureDoc(), 0x5eed, 2);
    const live = [...sim.graph.lanelets.keys()][0]!;
    const size = sim.runtime.size;
    expect(sim.rt(live).order.length).toBe(0);
    expect(sim.rt('no-such-lane' as LaneletId).ghost).toBe(false);
    expect(sim.runtime.size, 'a read added no lane runtime').toBe(size);
    expect(sim.ghostCandidates.size, 'a read added no ghost candidate').toBe(0);
  });

  it('cannot be written through: the empty answer is shared and frozen', () => {
    const sim = simOf(fixtureDoc(), 0x5eed, 2);
    const live = [...sim.graph.lanelets.keys()][0]!;
    expect(() => sim.rt(live).order.push(1 as never)).toThrow();
  });
});
