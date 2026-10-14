import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step, tickWork } from '@sim/pipeline';
import { signalWork } from '@sim/signals/fsm';

/**
 * THE SCALE OF A TICK, BY COUNTING (docs/source/relatorio-desempenho-mapas-enormes-2026-10-11.md
 * 9.4; docs/research/source/fase-0-medida.md 3.4): the same few cars on a small
 * closed grid and on one 36 times its area. What a tick does for the map's
 * size - lanes looked at by the cleanup, signals that decide - must not grow
 * with the map: counted, not timed, so it runs in `npm run check` and holds
 * on any machine. Before phase 1 the cleanup looked at every lane of the map
 * every tick (20 876 on the large grid) and every signal was stepped and
 * decided (1 369).
 */
const BLOCK = 120;

function closedGrid(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, 1);
    }
  }
  return doc;
}

/** Per tick, after a warm-up with `cars` cars on the grid: cleanup lanes looked at, signals stepped and signals that decided. */
function workOf(n: number, cars: number): { cleanup: number; stepped: number; deciding: number; signals: number } {
  const doc = closedGrid(n);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x0be9);
  w.rebuildTopology();
  w.trafficCount = cars;
  w.ambient.enabled = true;
  w.ambient.source = 'edges';
  w.clock.paused = false;
  for (let i = 0; i < 300; i++) step(w, { traffic: true, pedestrians: false });
  const lanes = tickWork.cleanupLanes, controllers = tickWork.controllers, rested = signalWork.rested;
  const TICKS = 120;
  for (let i = 0; i < TICKS; i++) step(w, { traffic: true, pedestrians: false });
  return {
    cleanup: (tickWork.cleanupLanes - lanes) / TICKS,
    // Signals stage 1 stepped: those asleep (nobody near) only keep their time.
    stepped: (tickWork.controllers - controllers) / TICKS,
    // Signals that ran the decision: stepped, less those that rested with nobody near.
    deciding: (tickWork.controllers - controllers - (signalWork.rested - rested)) / TICKS,
    signals: w.signalisedControllers().length,
  };
}

describe('the work of a tick', () => {
  it('does not grow with the map for the same traffic', () => {
    // 4 times the area (36 times until 2026-10-13: building the large grid's topology took most of a
    // minute, every identical junction measured again, docs/research/regression-barrier.md).
    const small = workOf(6, 30), large = workOf(12, 30);
    expect(large.signals).toBeGreaterThan(small.signals * 3);
    // The cleanup looks at the lanes an edit left, none here, whatever the map.
    expect(large.cleanup).toBe(small.cleanup);
    // The signals stepped and those that decide are those with somebody near: about as many on both.
    expect(large.stepped).toBeLessThanOrEqual(small.stepped + 30);
    expect(large.deciding).toBeLessThanOrEqual(small.deciding + 30);
  });
});
