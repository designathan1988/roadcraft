import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InstancedMesh } from 'three';

import { createAgentMeshes } from '@render/agents';
import { archetypeById } from '@sim/vehicles/archetypes';
import { createVehicle, type Vehicle } from '@sim/vehicles/state';
import type { SimWorld } from '@sim/world';
import type { LaneletId } from '@world/lanelets';
import { ChangeJournal } from '@world/changes';
import { FLEET_CEILING } from '@sim/params';
import { m } from '@world/units';

/**
 * Parked cars as the renderer draws them: written once, then copied each
 * frame (`parkedDraws`). These check what the copy shows against what was
 * worked out, and that the town's parked cars past the fleet's ceiling are
 * drawn.
 */

/** A car standing in its bay with nobody in it: what `sync` takes as parked. */
function parkedCar(id: number, x: number, y: number, lot: number | null = 1): Vehicle {
  const v = createVehicle(id, archetypeById('sedan'), {} as never, '#a83a2c', '' as LaneletId, 0, 0);
  v.free = { x, y, angle: 0.3, px: x, py: y, pangle: 0.3, lot };
  // Nobody aboard: its engine off and its instances copied from frame to frame (`sync` `still`).
  v.seats = 0;
  return v;
}

/** The world `sync` reads: no traffic, the parked cars, nobody walking, the diary of changes. */
function worldWith(parked: readonly Vehicle[], changes = new ChangeJournal()): SimWorld {
  return {
    clock: { time: 0 },
    vehiclesInIdOrder: () => [],
    vehicles: new Map(),
    ambient: { parked, isParked: (v: Vehicle) => parked.includes(v) },
    pedViews: [],
    lanelet: () => undefined,
    connector: () => undefined,
    net: { doc: { changes } },
  } as unknown as SimWorld;
}

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
    agents.sync(world, 0, true);
    const first = drawn(wheels);
    expect(first).toBe(2);
    // The second frame copies what the first wrote (`replay`).
    agents.sync(world, 0, true);
    expect(drawn(wheels)).toBe(first);
    agents.dispose();
  });

  it('stand on the ground again after the ground under them changed', () => {
    let lot = 0;
    const changes = new ChangeJournal();
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => lot);
    const world = worldWith([parkedCar(1, m(5), m(5))], changes);
    const bodies = meshesOf(agents, /^car-.*-shell$/);
    const height = (): number => {
      const mesh = bodies.find((b) => b.visible && b.count > 0);
      if (!mesh) throw new Error('no body drawn');
      return mesh.instanceMatrix.array[13]!;
    };
    agents.sync(world, 0, true);
    expect(height()).toBeCloseTo(0, 6);
    // The lot raised by 2 m, and the diary told where (the ground cut and filled).
    lot = m(2);
    changes.record('ground', [[0, 0, m(10), m(10)]]);
    agents.sync(world, 0, true);
    expect(height()).toBeCloseTo(m(2), 6);
    // A change elsewhere does not move it (it is not asked again).
    lot = m(7);
    changes.record('ground', [[m(100), m(100), m(110), m(110)]]);
    agents.sync(world, 0, true);
    expect(height()).toBeCloseTo(m(2), 6);
    agents.dispose();
  });

  it('are all drawn past the fleet ceiling', () => {
    const agents = createAgentMeshes(() => 0, () => {}, () => 0, () => 0);
    const count = FLEET_CEILING + 300;
    const cars: Vehicle[] = [];
    for (let i = 0; i < count; i++) cars.push(parkedCar(i + 1, (i % 60) * m(8), Math.floor(i / 60) * m(8)));
    const world = worldWith(cars);
    const bodies = meshesOf(agents, /^car-.*-(shell|shell-lite|far)$/);
    const wheels = meshesOf(agents, /^vehicle-wheels$/);
    agents.sync(world, 0, true);
    expect(drawn(bodies)).toBe(count);
    expect(drawn(wheels)).toBe(count * 4);
    // And copied in the next frame.
    agents.sync(world, 0, true);
    expect(drawn(bodies)).toBe(count);
    expect(drawn(wheels)).toBe(count * 4);
    agents.dispose();
  });
});
