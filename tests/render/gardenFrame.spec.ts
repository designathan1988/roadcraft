import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, PerspectiveCamera, type InstancedMesh } from 'three';
import { Rng } from '@core/rng';
import { createGardens, type GardenPlant, type Gardens } from '@render/gardens';
import { createSceneryKit } from '@render/scenery';
import { m } from '@world/units';

/**
 * The gardens' work per frame and per building (docs/PLANO-ESPINHA-2026-10-14.md):
 * `renderer.ts` calls `setMap` every frame, which used to drop the cull, so a
 * still camera walked the whole tree of the town's gardens every frame and the
 * leaf cards were never left out at the map zoom; and every `update` forgot
 * what every store's GPU buffer held, so one garden more sent every plant in
 * view to the GPU again.
 */
const KINDS: GardenPlant['kind'][] = ['tree', 'shrub', 'hedge', 'flowers'];
function town(count: number, spread: number, seed: number, kinds = KINDS): GardenPlant[][] {
  const rng = new Rng(seed);
  return Array.from({ length: count }, () => {
    const cx = (rng.float() - 0.5) * spread, cy = (rng.float() - 0.5) * spread;
    return Array.from({ length: 3 + Math.floor(rng.float() * 8) }, (_, i) => ({
      kind: kinds[Math.floor(rng.float() * kinds.length)]!, x: cx + (rng.float() - 0.5) * m(40), y: cy + (rng.float() - 0.5) * m(40), z: rng.float() * m(3),
      w: m(1) + rng.float() * m(6), d: m(1) + rng.float() * m(2), h: m(1) + rng.float() * m(12), yaw: rng.float() * 6, seed: (i * 0.137 + rng.float()) % 1,
    }));
  });
}

/** A frustum that counts every read of it: the cull's work. */
function counted(frustum: Frustum): { frustum: Frustum; reads: () => number; reset: () => void } {
  let reads = 0;
  const proxy = new Proxy(frustum, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
  return { frustum: proxy, reads: () => reads, reset: () => { reads = 0; } };
}

function view(): { frustum: Frustum; view: Matrix4 } {
  const camera = new PerspectiveCamera(50, 1.6, 1, m(3000));
  camera.position.set(0, m(150), m(200));
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const matrix = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { frustum: new Frustum().setFromProjectionMatrix(matrix), view: matrix };
}

/** Each drawn instance of each mesh, as matrix and tint. */
function drawn(gardens: Gardens): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const mesh of gardens.meshes as InstancedMesh[]) {
    const rows = new Set<string>();
    const mats = mesh.instanceMatrix.array, tints = mesh.instanceColor!.array;
    for (let i = 0; i < mesh.count; i++) rows.add(`${Array.from(mats.slice(i * 16, i * 16 + 16)).join(',')}|${Array.from(tints.slice(i * 3, i * 3 + 3)).join(',')}`);
    out.set(mesh.name, rows);
  }
  return out;
}

describe('the gardens per frame', () => {
  const kit = createSceneryKit();

  it('a still camera culls nothing again, though setMap is called every frame', () => {
    const gardens = createGardens(kit);
    gardens.update(town(200, m(2000), 3));
    const { frustum, view: matrix } = view();
    const probe = counted(frustum);
    gardens.setMap(false);
    gardens.cull(probe.frustum, matrix);
    expect(probe.reads()).toBeGreaterThan(0);
    probe.reset();
    for (let frame = 0; frame < 5; frame++) {
      gardens.setMap(false);
      gardens.cull(probe.frustum, matrix);
    }
    expect(probe.reads()).toBe(0);
  });

  it('leaves the leaf cards out at the map zoom, and brings back the same plants', () => {
    const gardens = createGardens(kit);
    gardens.update(town(200, m(2000), 8));
    const { frustum, view: matrix } = view();
    gardens.setMap(false);
    gardens.cull(frustum, matrix);
    const before = drawn(gardens);
    const cards = (gardens.meshes as InstancedMesh[]).filter((mesh) => mesh.name.endsWith('-cards'));
    expect(cards.some((mesh) => mesh.count > 0)).toBe(true);
    gardens.setMap(true);
    gardens.cull(frustum, matrix);
    const atMap = drawn(gardens);
    for (const [name, rows] of before) {
      if (name.endsWith('-cards')) expect(atMap.get(name)!.size).toBe(0);
      else expect(atMap.get(name)).toEqual(rows);
    }
    gardens.setMap(false);
    gardens.cull(frustum, matrix);
    expect(drawn(gardens)).toEqual(before);
  });

  it('one garden more sends only the stores it touched to the GPU, and draws what a fresh build draws', () => {
    const lists = town(200, m(2000), 5, ['tree', 'shrub', 'hedge']);
    const gardens = createGardens(kit);
    gardens.update(lists);
    const { frustum, view: matrix } = view();
    gardens.setMap(false);
    gardens.cull(frustum, matrix);
    // As if three uploaded them.
    for (const mesh of gardens.meshes as InstancedMesh[]) { mesh.instanceMatrix.clearUpdateRanges(); mesh.instanceColor!.clearUpdateRanges(); }
    const known = new Set((gardens.meshes as InstancedMesh[]).map((mesh) => mesh.name));
    // A bed of flowers in view: only the flowering bushes' stores change.
    const bed: GardenPlant[] = [{ kind: 'flowers', x: 0, y: 0, z: 0, w: m(3), d: m(2), h: m(0.5), yaw: 0, seed: 0.3 }];
    const more = [...lists, bed];
    gardens.update(more);
    gardens.cull(frustum, matrix);
    const uploaded = (gardens.meshes as InstancedMesh[])
      .filter((mesh) => known.has(mesh.name) && mesh.instanceMatrix.updateRanges.length > 0)
      .map((mesh) => mesh.name);
    expect(uploaded.every((name) => name.startsWith('garden-bushes-bushFlowering'))).toBe(true);
    const fresh = createGardens(kit);
    fresh.update(more);
    fresh.setMap(false);
    fresh.cull(frustum, matrix);
    expect(drawn(gardens)).toEqual(drawn(fresh));
  });
});
