import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Vector3 } from 'three';
import { createAgentMeshes } from '@render/agents';
import { FleetGrid, type FleetCell, type GroundBox } from '@sim/host/fleetGrid';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import { archetypeById } from '@sim/vehicles/archetypes';
import type { Network } from '@world/network';
import { ChangeJournal } from '@world/changes';
import { m } from '@world/units';
import { TILE } from '@world/tiles';
import { createTransit } from '@render/transit';
import { createDensityCars } from '@render/densityCars';
import { MC, ML, MESO_PRESENT, MESO_RECORD, MesoMemory } from '@sim/meso/memory';
import { linkId } from '@sim/meso/tileLinks';

/** The garbage a frame leaves on the page while the camera moves (V8's sampling heap profiler): the vehicles, the trains and the far cars draw into buffers kept from frame to frame */

function parkedCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById(id % 3 === 0 ? 'suv' : 'sedan'), color: '#a83a2c', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: { x, y, angle: 0.3, px: x, py: y, pangle: 0.3, lot: null },
    frames: { bx: x, by: y, bangle: 0.3, x, y, angle: 0.3, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

/** A car stopped at a light a whole tick, on its lane. */
function stoppedCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById('sedan'), color: '#2f5f92', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: null, frames: { bx: x, by: y, bangle: 0, x, y, angle: 0, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}

function worldWith(parked: readonly VehicleView[], traffic: readonly VehicleView[]): SimClient {
  const grid = new FleetGrid<VehicleView>();
  for (const car of parked) grid.place(car);
  const vehiclesIn = (_box: GroundBox, out: VehicleView[], which = 'all'): VehicleView[] => { out.length = 0; if (which === 'traffic') out.push(...traffic); return out; };
  const parkedCellsIn = (box: GroundBox, out: FleetCell<VehicleView>[]): FleetCell<VehicleView>[] => { out.length = 0; return grid.cellsNear(box.x0, box.y0, box.x1, box.y1, out); };
  const vehicles = new Map<number, VehicleView>(traffic.map((v) => [v.id, v] as const));
  return { time: 0, traffic, vehicles, parked, isParked: (v: VehicleView) => parked.includes(v), pedViews: [], fleet: 0, vehiclesIn, parkedCellsIn } as unknown as SimClient;
}



describe("the page's garbage a frame", () => {
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });
  it('is a few hundred bytes for 420 vehicles, a train and 40 far roads, the camera moving: nothing a vehicle', () => {
    const net = { doc: { changes: new ChangeJournal() }, state: {}, changesSince: () => ({ segments: [] }), ribbons: new Map() } as unknown as Network;
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const parked = Array.from({ length: 300 }, (_, c) => parkedCar(c + 1, (c % 30) * m(30), Math.floor(c / 30) * m(30)));
    const traffic = Array.from({ length: 120 }, (_, k) => ({ ...stoppedCar(10000 + k, (k % 20) * m(20), (k / 20) * m(40)), v: m(8), prev: { v: m(8) } }));
    const world = worldWith(parked, traffic);
    const transit = createTransit();
    const trains = [{ colour: '#c0392b', metro: false, cars: Array.from({ length: 6 }, (_, i) => ({ x: m(100) + i * m(20), y: m(50), heading: 0 })) }];
    const density = createDensityCars(() => 0);
    let buffer: SharedArrayBuffer | null = null;
    const sim = { window: (_x: number, _y: number, _r: number, b: SharedArrayBuffer) => { buffer = b; }, clock: { time: 0 } } as unknown as SimClient;
    density.update(net, sim, 0, 0);
    const memory = new MesoMemory(buffer!);
    for (let s = 0; s < 40; s++) {
      const r = s * MESO_RECORD, recs = memory.links;
      memory.ids[s] = linkId(s + 1, 0);
      recs[r + ML.count] = 5; recs[r + ML.queued] = 1; recs[r + ML.speed] = m(10); recs[r + ML.lanes] = 1; recs[r + ML.flags] = MESO_PRESENT;
      const x = (s % 8 + 0.5) * TILE, y = (Math.floor(s / 8) + 0.5) * TILE;
      recs[r + ML.ax] = x - m(100); recs[r + ML.ay] = y; recs[r + ML.mx] = x; recs[r + ML.my] = y; recs[r + ML.bx] = x + m(100); recs[r + ML.by] = y; recs[r + ML.shape] = 1;
    }
    Atomics.store(memory.control, MC.wanted, 40);
    let serial = 1;
    let pos = 0;
    const frame = (): void => {
      pos += m(2);
      for (const car of traffic) { car.frames.bx = car.frames.x; car.frames.x += m(0.3); }
      for (const car of trains[0]!.cars) car.x += m(0.5);
      for (let s = 0; s < 40; s++) memory.links[s * MESO_RECORD + ML.count] = 5 + (serial % 3);
      Atomics.store(memory.control, MC.serial, ++serial);
      agents.sync(world, net, 0.5, true, 6, { vehicleVisible: () => true, vehicleBox: { x0: pos - m(800), y0: -m(800), x1: pos + m(800), y1: m(800) }, screenScale: () => 6, eye: new Vector3(pos, m(200), 0) });
      transit.update(trains as never, () => 0);
      density.update(net, sim, pos, 0);
    };
    for (let f = 0; f < 300; f++) frame();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const inspector = require('inspector');
    const session = new inspector.Session(); session.connect();
    const post = (method: string, params?: object): unknown => { let r: unknown; session.post(method, params ?? {}, (e: unknown, v: unknown) => { if (e) throw e; r = v; }); return r; };
    post('HeapProfiler.enable'); post('HeapProfiler.startSampling', { samplingInterval: 256 });
    const FRAMES = 200;
    for (let f = 0; f < FRAMES; f++) frame();
    const prof = (post('HeapProfiler.stopSampling') as { profile: { head: unknown } }).profile;
    type N = { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children: N[] };
    const bySite = new Map<string, number>();
    const walk = (n: N): void => {
      const url = n.callFrame.url;
      const site = `${n.callFrame.functionName || '(anon)'} ${url.replace(/^.*\/(src|tests|node_modules)\//, '$1/')}:${n.callFrame.lineNumber + 1}`;
      if (n.selfSize && !/syncBench|inspector/.test(site)) bySite.set(site, (bySite.get(site) ?? 0) + n.selfSize);
      for (const c of n.children) walk(c);
    };
    walk(prof.head as N);
    const total = [...bySite.values()].reduce((a, b) => a + b, 0);
    // DO NOT allocate per vehicle or per part a frame: one object a vehicle would be 13 KB and more here (420 of them); what is left is V8 boxing numbers in calls not yet inlined (0.7 to 1.3 KB).
    expect(total / FRAMES).toBeLessThan(4096);
    session.disconnect();
    agents.dispose();
    transit.dispose();
    density.dispose();
  }, 10000);
});
