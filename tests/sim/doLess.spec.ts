import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { step, tickWork } from '@sim/pipeline';
import { createAgentWalkEngine } from '@sim/agents/walk';

/**
 * DOING LESS, AND THE SAME (docs/relatorio-desempenho-mapas-enormes-2026-10-11.md
 * 5.1, phase 1): a tick that visits only the lanes with a vehicle, the lanes
 * an edit left behind and the signals that can change (`SimWorld.doLess`)
 * is the tick that visits everything - the same vehicles, lanes, signals and
 * people, tick by tick, exactly - through edits that take lanes away and add
 * new ones.
 */
const BLOCK = 120;

/** A grid of `n` x `n` blocks with a road off the map at two corners: traffic comes in and leaves. */
function town(n: number): RoadDoc {
  const doc = new RoadDoc();
  const ids: number[][] = [];
  for (let i = 0; i <= n; i++) {
    ids.push([]);
    for (let j = 0; j <= n; j++) ids[i]!.push(doc.addNode({ x: m(BLOCK) * (i - n / 2), y: m(BLOCK) * (j - n / 2) }).id);
  }
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= n; j++) {
      if (i < n) doc.addSegment(ids[i]![j]! as never, ids[i + 1]![j]! as never, j % 3 === 0 ? 3 : 1);
      if (j < n) doc.addSegment(ids[i]![j]! as never, ids[i]![j + 1]! as never, i % 3 === 0 ? 3 : 1);
    }
  }
  const half = m(BLOCK) * (n / 2);
  doc.addSegment(ids[0]![0]! as never, doc.addNode({ x: -half - m(150), y: -half }).id as never, 1);
  doc.addSegment(ids[n]![n]! as never, doc.addNode({ x: half + m(150), y: half }).id as never, 1);
  return doc;
}

function world(doLess: boolean): SimWorld {
  const doc = town(5);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x0be9);
  w.doLess = doLess;
  w.rebuildTopology();
  w.usePedestrianEngine(createAgentWalkEngine());
  w.trafficCount = 160;
  w.pedestrianCount = 120;
  w.ambient.enabled = true;
  w.ambient.source = 'edges';
  w.clock.paused = false;
  return w;
}

/** Everything a tick writes, exactly: vehicles, lane orders and ghosts, signals, people. */
function state(w: SimWorld): string {
  const out: string[] = [];
  for (const v of w.vehiclesInIdOrder()) out.push(`v${v.id}:${v.lanelet}:${v.s}:${v.v}:${v.admittedConnector ?? '-'}:${v.route.join('>')}`);
  for (const [id, rt] of [...w.runtime].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    if (rt.order.length || rt.ghost) out.push(`l${id}:${rt.order.join(',')}:${rt.ghost ? rt.ghostSince : '-'}`);
  }
  for (const node of w.junctionNodesInOrder()) {
    const c = w.controllers.get(node);
    if (c) out.push(`c${node}:${c.stageIndex}:${c.sub}:${c.elapsed}:${[...c.lastServed].join(';')}:${[...c.stageServed].join(';')}`);
  }
  for (const p of [...w.pedViews].sort((a, b) => a.id - b.id)) out.push(`p${p.id}:${p.x}:${p.y}:${p.heading}`);
  return out.join('|');
}

/** The same edit on a world's document: a road through the town taken away, or one drawn across it. */
function edit(w: SimWorld, k: number): void {
  const doc = w.doc;
  if (k % 2 === 0) {
    const victim = [...doc.segments.keys()].sort((a, b) => a - b)[7 + k];
    if (victim !== undefined) doc.removeSegment(victim);
  } else {
    const y = m(BLOCK) * 0.5 + k * m(3);
    doc.addSegment(doc.addNode({ x: -m(BLOCK) * 2.5, y }).id, doc.addNode({ x: m(BLOCK) * 2.5, y }).id, 1);
  }
  w.net.rebuild();
}

describe('doing less', () => {
  it('runs the same ticks as doing everything, through edits', () => {
    const fast = world(true), full = world(false);
    let retiredFast = 0, retiredFull = 0, lookedFast = 0, lookedFull = 0, steppedFast = 0, steppedFull = 0;
    for (let t = 1; t <= 2400; t++) {
      let r = tickWork.retired, l = tickWork.cleanupLanes, c = tickWork.controllers;
      step(fast, { traffic: true, pedestrians: true });
      retiredFast += tickWork.retired - r; lookedFast += tickWork.cleanupLanes - l; steppedFast += tickWork.controllers - c;
      r = tickWork.retired; l = tickWork.cleanupLanes; c = tickWork.controllers;
      step(full, { traffic: true, pedestrians: true });
      retiredFull += tickWork.retired - r; lookedFull += tickWork.cleanupLanes - l; steppedFull += tickWork.controllers - c;
      if (t % 400 === 0) { edit(fast, t / 400); edit(full, t / 400); }
      if (t % 5 === 0) {
        const a = state(fast), b = state(full);
        if (a !== b) {
          const pa = a.split('|'), pb = b.split('|');
          const i = pa.findIndex((x, j) => x !== pb[j]);
          expect(pa[i], `tick ${t}, first difference`).toBe(pb[i]);
        }
      }
    }
    // The run had traffic, signals, and lanes an edit took (stage 7's work list was not empty).
    expect(full.vehicles.size).toBeGreaterThan(40);
    expect(full.signalisedControllers().length).toBeGreaterThan(3);
    // Signals slept with nobody near (only their time kept), and the run came out the same.
    expect(steppedFull - steppedFast).toBeGreaterThan(100);
    // The same lanes retired, for a small part of the looking.
    expect(retiredFast).toBeGreaterThan(0);
    expect(retiredFast).toBe(retiredFull);
    expect(lookedFast * 50).toBeLessThan(lookedFull);
  }, 240_000);
});
