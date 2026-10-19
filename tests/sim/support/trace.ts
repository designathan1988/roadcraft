import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld } from '@sim/world';
import { step } from '@sim/pipeline';

/** A city of multi-lane avenues with a fixed seed: traffic that spawns, routes, changes lanes and queues at signals. */
export function avenueGrid(seed = 0x5eed): { doc: RoadDoc; net: Network; sim: SimWorld } {
  const doc = new RoadDoc();
  const n = 3, gap = 320;
  const ids: number[][] = [];
  for (let i = 0; i < n; i++) {
    ids.push([]);
    for (let j = 0; j < n; j++) ids[i]!.push(doc.addNode({ x: (i - 1) * gap, y: (j - 1) * gap }).id);
  }
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + 1 < n) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, 3);
      if (j + 1 < n) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, j === 1 ? 3 : 1);
    }
  }
  // Stubs out of the grid, where traffic comes from and goes to.
  for (let i = 0; i < n; i++) {
    const west = doc.addNode({ x: -gap * 2, y: (i - 1) * gap });
    const east = doc.addNode({ x: gap * 2, y: (i - 1) * gap });
    doc.addSegment(west.id, ids[0]![i]!, 3);
    doc.addSegment(ids[n - 1]![i]!, east.id, 3);
  }
  doc.setNodeControl(ids[1]![1]!, 'signal');
  doc.setNodeControl(ids[0]![1]!, 'signal');
  const net = new Network(doc);
  net.rebuild();
  const sim = new SimWorld(doc, net, seed);
  sim.rebuildTopology();
  sim.trafficIntensity = 1.8;
  sim.demandMultiplier = 1.8;
  sim.clock.paused = false;
  return { doc, net, sim };
}

export interface Trace {
  /** FNV over every vehicle's exact state (bits of the doubles), its route and its lane intent, after every step. */
  readonly hash: number;
  readonly vehicles: number;
  /** Lane changes made: a vehicle on a sibling lane of the same carriageway one step later. */
  readonly laneChanges: number;
  /** Routes seen to change, step to step. */
  readonly routeChanges: number;
}

/** Runs `steps` steps and fingerprints the WHOLE driving state after each one: positions, speeds, routes, lane changes. */
export function traceRun(sim: SimWorld, steps: number): Trace {
  let h = 2166136261;
  const f64 = new Float64Array(1);
  const u32 = new Uint32Array(f64.buffer);
  const mix = (n: number): void => {
    h = Math.imul(h ^ (n & 0xffff), 16777619) >>> 0;
    h = Math.imul(h ^ (n >>> 16), 16777619) >>> 0;
  };
  const num = (x: number): void => { f64[0] = x; mix(u32[0]!); mix(u32[1]!); };
  const text = (s: string | null): void => {
    if (s === null) { mix(0xdead); return; }
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    mix(s.length);
  };
  const lastLane = new Map<number, string>();
  const lastRoute = new Map<number, string>();
  let laneChanges = 0, routeChanges = 0;
  for (let k = 0; k < steps; k++) {
    step(sim, { traffic: true, pedestrians: true });
    for (const v of sim.vehiclesInIdOrder()) {
      mix(v.id);
      text(v.lanelet);
      num(v.s); num(v.v); num(v.lateral); num(v.accel);
      const route = v.route.join(' ');
      text(route);
      text(v.desiredLane);
      text(v.movementIntent);
      text(v.destination);
      text(v.laneIntent);
      const was = lastLane.get(v.id);
      if (was !== undefined && was !== v.lanelet) {
        const a = sim.lanelet(was), b = sim.lanelet(v.lanelet);
        if (a && b && a.kind === 'link' && b.kind === 'link' && a.segment === b.segment && a.from === b.from) laneChanges++;
      }
      if (lastRoute.has(v.id) && lastRoute.get(v.id) !== route) routeChanges++;
      lastLane.set(v.id, v.lanelet);
      lastRoute.set(v.id, route);
    }
    for (const p of [...sim.pedViews].sort((a, b) => a.id - b.id)) {
      mix(p.id); text(p.ground); num(p.x); num(p.y); num(p.heading);
    }
  }
  return { hash: h >>> 0, vehicles: sim.vehicles.size, laneChanges, routeChanges };
}
