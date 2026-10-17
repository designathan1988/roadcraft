import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InstancedMesh } from 'three';
import { createAgentMeshes } from '@render/agents';
import { FleetGrid, type GroundBox } from '@sim/host/fleetGrid';
import type { SimClient, VehicleView } from '@sim/host/simClient';
import type { PedView } from '@sim/people/view';
import { archetypeById } from '@sim/vehicles/archetypes';
import type { Network } from '@world/network';
import { ChangeJournal } from '@world/changes';
import { m } from '@world/units';

/** THE VIEW TEST BEFORE THE GROUND AND THE POSE (plan 9.6): walkers by place, their ground not asked off screen; a car only its shadow reaches drawn as its shell */
function parkedCar(id: number, x: number, y: number): VehicleView {
  return {
    id, archetype: archetypeById('sedan'), color: '#a83a2c', doors: [], kerbStop: null, people: [], peopleAge: [], seats: 0, slain: false, age: 0, v: 0,
    prev: { v: 0 }, free: { x, y, angle: 0, px: x, py: y, pangle: 0, lot: null },
    frames: { bx: x, by: y, bangle: 0, x, y, angle: 0, yawBefore: 0, yawNow: 0, jump: false },
    segment: undefined, inSegment: undefined, indicator: 0, curvature: 0, odometer: 0, tickRead: 0,
  };
}
const walker = (id: number, x: number, y: number): PedView =>
  ({ id, x, y, heading: 0, prev: { x, y, heading: 0 }, v: 0, turnV: 0, age: 0, segment: undefined, walking: false, kerbWait: 0, rank: 0, ground: 'open' }) as unknown as PedView;

function worldWith(parked: readonly VehicleView[], peds: readonly PedView[]): SimClient {
  const cars = new FleetGrid<VehicleView>();
  for (const car of parked) cars.place(car);
  const walkers = new FleetGrid<PedView>((p) => p.x, (p) => p.y);
  for (const p of peds) walkers.place(p);
  return {
    time: 0, traffic: [], vehicles: new Map(), parked, isParked: (v: VehicleView) => parked.includes(v), pedViews: peds, fleet: 0,
    vehiclesIn: (box: GroundBox, out: VehicleView[]) => { out.length = 0; return cars.near(box.x0, box.y0, box.x1, box.y1, out); },
    pedsIn: (box: GroundBox, out: PedView[]) => { out.length = 0; return walkers.near(box.x0, box.y0, box.x1, box.y1, out); },
  } as unknown as SimClient;
}
const netWith = (): Network => ({ doc: { changes: new ChangeJournal() } }) as unknown as Network;
const drawnOf = (agents: ReturnType<typeof createAgentMeshes>, name: RegExp): number =>
  agents.meshes.filter((o): o is InstancedMesh => (o as InstancedMesh).isInstancedMesh === true && name.test(o.name))
    .reduce((n, mesh) => n + (mesh.visible ? mesh.count : 0), 0);
const box: GroundBox = { x0: -m(1000), y0: -m(1000), x1: m(1000), y1: m(1000) };

describe('the view test of vehicles and walkers', () => {
  beforeAll(() => { vi.stubGlobal('window', { setInterval: () => 0, clearInterval: () => {} }); vi.stubGlobal('location', { search: '?bodies=cooked' }); });
  afterAll(() => { vi.unstubAllGlobals(); });

  it('draws a car only its shadow reaches as its body alone, no glass, and nothing of one whose shadow is a disc', () => {
    const world = worldWith([parkedCar(1, 0, 0)], []);
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    // Its body's sphere off the screen, its shadow's reach on it.
    const shadowOnly = (_x: number, _y: number, _h: number, radius: number): boolean => radius > m(4.5);
    agents.sync(world, netWith(), 0, true, undefined, { vehicleVisible: shadowOnly, vehicleBox: box });
    expect(drawnOf(agents, /^car-.*-shell(@\d)?$/)).toBe(1);
    expect(drawnOf(agents, /^car-.*-glass(@\d)?$/)).toBe(0);
    expect(drawnOf(agents, /^car-.*-interior(@\d)?$/)).toBe(0);
    // On the screen: drawn whole, its glass too.
    agents.sync(world, netWith(), 0, true, undefined, { vehicleVisible: () => true, vehicleBox: box });
    expect(drawnOf(agents, /^car-.*-glass(@\d)?$/)).toBe(1);
    // Far (its shadow a disc under it), only its shadow's reach on the screen: nothing.
    agents.sync(world, netWith(), 0, true, undefined, { vehicleVisible: shadowOnly, vehicleBox: box, screenScale: () => 0.6 });
    expect(drawnOf(agents, /^car-/)).toBe(0);
    agents.dispose();
  });

  it('asks a walker off the screen for its ground once, not again each frame while it stays near there', () => {
    const peds = Array.from({ length: 40 }, (_, i) => walker(i + 1, i * m(3), m(10)));
    const world = worldWith([], peds);
    let asked = 0;
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0, () => { asked++; return 0; });
    const off = { pedestrianVisible: () => false, vehicleBox: box };
    agents.sync(world, netWith(), 0, true, undefined, off);
    expect(asked).toBe(peds.length);
    agents.sync(world, netWith(), 0, true, undefined, off);
    agents.sync(world, netWith(), 0, true, undefined, off);
    expect(asked).toBe(peds.length);
    // Walked far from where it was asked: asked again.
    (peds[0] as { x: number }).x += m(30);
    (peds[0]!.prev as { x: number }).x += m(30);
    agents.sync(world, netWith(), 0, true, undefined, off);
    expect(asked).toBe(peds.length + 1);
    agents.dispose();
  });

  it('walks only the walkers on the view\'s ground', () => {
    const near = walker(1, 0, 0), far = walker(2, m(5000), m(5000));
    const world = worldWith([], [near, far]);
    const seen: number[] = [];
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0, () => 0);
    agents.sync(world, netWith(), 0, true, undefined, { pedestrianVisible: (x) => { seen.push(x); return false; }, vehicleBox: box });
    expect(seen).toEqual([0]);
    agents.dispose();
  });
});
