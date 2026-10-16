import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InstancedMesh } from 'three';

import { createAgentMeshes } from '@render/agents';
import { archetypeById } from '@sim/vehicles/archetypes';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import type { Network } from '@world/network';
import { ChangeJournal } from '@world/changes';
import { FLEET_CEILING } from '@sim/params';
import { m } from '@world/units';

/** Parked cars as the renderer draws them: written once, then copied each frame (`parkedDraws`). */

/** A car standing in its bay with nobody in it: what `sync` takes as parked. */
function parkedCar(id: number, x: number, y: number, lot: number | null = 1): VehicleView {
  // Nobody aboard: its engine off and its instances copied from frame to frame (`sync` `still`).
  return {
    id, archetype: archetypeById('sedan'), color: '#a83a2c', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: { x, y, angle: 0.3, px: x, py: y, pangle: 0.3, lot },
    frames: { bx: x, by: y, bangle: 0.3, x, y, angle: 0.3, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0,
  };
}

/** The simulation's view `sync` reads (`SimClient`): no traffic, the parked cars, nobody walking. */
function worldWith(parked: readonly VehicleView[]): SimClient {
  return { time: 0, traffic: [], vehicles: new Map(), parked, isParked: (v: VehicleView) => parked.includes(v), pedViews: [], fleet: 0 } as unknown as SimClient;
}

/** The network `sync` reads: only its document's diary of changes. */
const netWith = (changes = new ChangeJournal()): Network => ({ doc: { changes } }) as unknown as Network;

const meshesOf = (agents: ReturnType<typeof createAgentMeshes>, test: RegExp): InstancedMesh[] =>
  agents.meshes.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && test.test(o.name));
const drawn = (meshes: readonly InstancedMesh[]): number => meshes.reduce((n, mesh) => n + (mesh.visible ? mesh.count : 0), 0);

describe('parked cars drawn by copying their first frame', () => {
  // The page the meshes are made in: the cooked bodies only (`?bodies=cooked`), no procedural crowd.
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('keep their steering wheel in the copied frames', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const world = worldWith([parkedCar(1, 0, 0), parkedCar(2, m(10), 0)]);
    const wheels = meshesOf(agents, /^car-.*-wheel$/);
    expect(wheels.length).toBeGreaterThan(0);
    agents.sync(world, netWith(), 0, true);
    const first = drawn(wheels);
    expect(first).toBe(2);
    // The second frame copies what the first wrote (`replay`).
    agents.sync(world, netWith(), 0, true);
    expect(drawn(wheels)).toBe(first);
    agents.dispose();
  });

  it('stand on the ground again after the ground under them changed', () => {
    let lot = 0;
    const changes = new ChangeJournal();
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => lot);
    const world = worldWith([parkedCar(1, m(5), m(5))]);
    const net = netWith(changes);
    const bodies = meshesOf(agents, /^car-.*-shell$/);
    const height = (): number => {
      const mesh = bodies.find((b) => b.visible && b.count > 0);
      if (!mesh) throw new Error('no body drawn');
      return mesh.instanceMatrix.array[13]!;
    };
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(0, 6);
    // The lot raised by 2 m, and the diary told where (the ground cut and filled).
    lot = m(2);
    changes.record('ground', [[0, 0, m(10), m(10)]]);
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(m(2), 6);
    // A change elsewhere does not move it (it is not asked again).
    lot = m(7);
    changes.record('ground', [[m(100), m(100), m(110), m(110)]]);
    agents.sync(world, net, 0, true);
    expect(height()).toBeCloseTo(m(2), 6);
    agents.dispose();
  });

  it('hold instance buffers sized to what is drawn, not to the fleet ceiling', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const all = meshesOf(agents, /^(car-|vehicle-(wheels|hubs|lamps)|bicycle-|bike-|rider-)/);
    expect(all.length).toBeGreaterThan(100);
    // Before anything is drawn: every part's buffers are a few instances, not the ceiling's.
    for (const mesh of all) expect(mesh.instanceMatrix.count).toBeLessThanOrEqual(16);
    const cars: VehicleView[] = [];
    for (let i = 0; i < 40; i++) cars.push(parkedCar(i + 1, (i % 10) * m(8), Math.floor(i / 10) * m(8)));
    agents.sync(worldWith(cars), netWith(), 0, true);
    const wheels = meshesOf(agents, /^vehicle-(wheels|hubs|lamps)|bicycle-wheels$/)[0]!;
    expect(wheels.count).toBe(160);
    // Doubled to hold them, no further.
    expect(wheels.instanceMatrix.count).toBeGreaterThanOrEqual(160);
    expect(wheels.instanceMatrix.count).toBeLessThan(320);
    expect(wheels.instanceColor!.count).toBe(wheels.instanceMatrix.count);
    agents.dispose();
  });

  it('are all drawn past the fleet ceiling', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const count = FLEET_CEILING + 300;
    const cars: VehicleView[] = [];
    for (let i = 0; i < count; i++) cars.push(parkedCar(i + 1, (i % 60) * m(8), Math.floor(i / 60) * m(8)));
    const world = worldWith(cars);
    const bodies = meshesOf(agents, /^car-.*-(shell|shell-lite|far)$/);
    // The cars' wheels alone: hubs and lamps grow with them too, past the ceiling (`growPart`).
    const wheels = meshesOf(agents, /^vehicle-wheels$/);
    agents.sync(world, netWith(), 0, true);
    expect(drawn(bodies)).toBe(count);
    expect(drawn(wheels)).toBe(count * 4);
    // And copied in the next frame.
    agents.sync(world, netWith(), 0, true);
    expect(drawn(bodies)).toBe(count);
    expect(drawn(wheels)).toBe(count * 4);
    agents.dispose();
  });
});
