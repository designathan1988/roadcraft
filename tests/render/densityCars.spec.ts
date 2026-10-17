import { describe, expect, it } from 'vitest';
import type { InstancedBufferGeometry, Mesh } from 'three';
import { createDensityCars } from '@render/densityCars';
import { MC, ML, MESO_PRESENT, MESO_RECORD, MesoMemory } from '@sim/meso/memory';
import { linkId } from '@sim/meso/tileLinks';
import { TILE } from '@world/tiles';
import { m } from '@world/units';
import type { Network } from '@world/network';
import type { SimClient } from '@sim/host/simClient';

/** THE FAR CARS: a mesh a tile, culled by the tile's sphere; a meso step writes only the tiles whose links changed (`densityCars.ts`, R15) */

/** A far road (not on the page): its slot's record, its middle in the tile wanted, `count` cars on it. */
function road(memory: MesoMemory, slot: number, x: number, y: number, count: number, shape: number): void {
  const r = slot * MESO_RECORD, recs = memory.links;
  memory.ids[slot] = linkId(slot + 1, 0);
  recs[r + ML.count] = count; recs[r + ML.queued] = 0; recs[r + ML.speed] = m(10); recs[r + ML.lanes] = 1; recs[r + ML.flags] = MESO_PRESENT;
  recs[r + ML.ax] = x - m(100); recs[r + ML.ay] = y; recs[r + ML.mx] = x; recs[r + ML.my] = y; recs[r + ML.bx] = x + m(100); recs[r + ML.by] = y;
  recs[r + ML.shape] = shape;
}

describe('the far cars', () => {
  it('are a mesh a tile, and a step that changes one link writes only its tile', () => {
    const cars = createDensityCars(() => 0);
    let buffer: SharedArrayBuffer | null = null;
    const sim = { window: (_x: number, _y: number, _r: number, b: SharedArrayBuffer) => { buffer = b; }, clock: { time: 0 } } as unknown as SimClient;
    const net = { state: {}, changesSince: () => ({ segments: [] }), ribbons: new Map() } as unknown as Network;
    cars.update(net, sim, 0, 0);
    const memory = new MesoMemory(buffer!);
    road(memory, 0, TILE * 0.5, TILE * 0.5, 4, 1);
    road(memory, 1, TILE * 3.5, TILE * 0.5, 6, 1);
    Atomics.store(memory.control, MC.wanted, 2);
    Atomics.store(memory.control, MC.serial, 1);
    cars.update(net, sim, 0, 0);
    const meshes = cars.object.children as Mesh[];
    expect(meshes.length).toBe(2);
    const counts = meshes.map((mesh) => (mesh.geometry as InstancedBufferGeometry).instanceCount).sort();
    expect(counts).toEqual([4, 6]);
    // Each culled by its own tile's sphere.
    for (const mesh of meshes) {
      const sphere = mesh.geometry.boundingSphere!;
      expect(mesh.frustumCulled).toBe(true);
      expect(Math.abs(sphere.center.x % TILE)).toBeCloseTo(TILE / 2, 3);
    }
    const versions = (): number[] => meshes.map((mesh) => mesh.geometry.getAttribute('aLink').version);
    const before = versions();
    // A step with the second road's count changed: its tile written again, the first one's left as it was.
    memory.links[1 * MESO_RECORD + ML.count] = 3;
    Atomics.store(memory.control, MC.serial, 2);
    cars.update(net, sim, 0, 0);
    const after = versions();
    const second = meshes.findIndex((mesh) => (mesh.geometry as InstancedBufferGeometry).instanceCount === 3);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(after[second]).toBeGreaterThan(before[second]!);
    expect(after[1 - second]).toBe(before[1 - second]);
    // A step that changes nothing writes nothing.
    Atomics.store(memory.control, MC.serial, 3);
    cars.update(net, sim, 0, 0);
    expect(versions()).toEqual(after);
    cars.dispose();
  });
});
