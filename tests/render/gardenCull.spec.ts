import { describe, expect, it } from 'vitest';
import { Frustum, Matrix4, OrthographicCamera, PerspectiveCamera, Sphere, type Camera, type InstancedMesh } from 'three';
import { Rng } from '@core/rng';
import { drawnMatrices, posesOf } from '@render/cellInstances';
import { createGardens, type GardenPlant, type Gardens } from '@render/gardens';
import { SHADOW_REACH, createSceneryKit } from '@render/scenery';
import { m } from '@world/units';
import { townChanges } from '../support/gardenChange';

/** The gardens are culled cell by cell down a quadtree (`gardens.ts`, audit C7) */
const KINDS: GardenPlant['kind'][] = ['tree', 'shrub', 'hedge', 'flowers'];
function town(count: number, spread: number, seed: number): GardenPlant[][] {
  const rng = new Rng(seed);
  return Array.from({ length: count }, () => {
    const cx = (rng.float() - 0.5) * spread, cy = (rng.float() - 0.5) * spread;
    return Array.from({ length: 3 + Math.floor(rng.float() * 8) }, (_, i) => ({
      kind: KINDS[Math.floor(rng.float() * 4)]!, x: cx + (rng.float() - 0.5) * m(40), y: cy + (rng.float() - 0.5) * m(40), z: rng.float() * m(3),
      w: m(1) + rng.float() * m(6), d: m(1) + rng.float() * m(2), h: m(1) + rng.float() * m(12), yaw: rng.float() * 6, seed: (i * 0.137 + rng.float()) % 1,
    }));
  });
}

function cameraAt(rng: Rng, spread: number): Camera {
  if (rng.float() < 0.3) {
    const half = m(20) + rng.float() * spread;
    const camera = new OrthographicCamera(-half, half, half * 0.6, -half * 0.6, 1, m(20000));
    camera.position.set((rng.float() - 0.5) * spread, m(300) + rng.float() * m(2000), (rng.float() - 0.5) * spread);
    camera.lookAt(camera.position.x + (rng.float() - 0.5) * m(400), 0, camera.position.z + (rng.float() - 0.5) * m(400));
    camera.updateMatrixWorld();
    return camera;
  }
  const camera = new PerspectiveCamera(30 + rng.float() * 50, 1.2 + rng.float(), 1, m(500) + rng.float() * m(5000));
  camera.position.set((rng.float() - 0.5) * spread, m(2) + rng.float() * m(400), (rng.float() - 0.5) * spread);
  camera.lookAt((rng.float() - 0.5) * spread, 0, (rng.float() - 0.5) * spread);
  camera.updateMatrixWorld();
  return camera;
}

const viewOf = (camera: Camera): { frustum: Frustum; view: Matrix4 } => {
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { frustum: new Frustum().setFromProjectionMatrix(view), view };
};
/** A view that sees everything. */
const everything = new Frustum().setFromProjectionMatrix(new Matrix4().makeOrthographic(-1e7, 1e7, 1e7, -1e7, -1e7, 1e7));

/** Each drawn instance of each mesh, as matrix and tint. */
function drawn(gardens: Gardens): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const mesh of gardens.meshes as InstancedMesh[]) {
    const rows = new Set<string>();
    const mats = drawnMatrices(mesh), tints = mesh.instanceColor!.array;
    for (let i = 0; i < mesh.count; i++) rows.add(`${Array.from(mats.slice(i * 16, i * 16 + 16)).join(',')}|${Array.from(tints.slice(i * 3, i * 3 + 3)).join(',')}`);
    out.set(mesh.name, rows);
  }
  return out;
}

describe('garden cull', () => {
  const kit = createSceneryKit();

  it('draws exactly the plants whose own sphere the view can see', () => {
    const spread = m(3000);
    let lists = town(150, spread, 7);
    const gardens = createGardens(kit);
    const change = townChanges();
    gardens.update(change(lists));
    // Some gardens gone and changed: dead slots in the cells, then a repack.
    lists = lists.map((list, g) => (g % 4 === 0 ? town(1, spread, 1000 + g)[0]! : list)).filter((_, g) => g % 3 !== 1);
    gardens.update(change(lists));
    // Every plant, with its sphere as the per-plant test would make it.
    gardens.cull(everything, new Matrix4().makeTranslation(-1, 0, 0));
    const all = new Map<string, { key: string; sphere: Sphere }[]>();
    // A plant is culled by the sphere round all its kind's meshes (body, cards, picture: `cellInstances.ts`).
    const kindOf = (name: string): string => name.replace(/-(cards|far)$/, '');
    const union = new Map<string, Sphere>();
    for (const mesh of gardens.meshes as InstancedMesh[]) {
      const s = mesh.geometry.boundingSphere!, was = union.get(kindOf(mesh.name));
      if (!was) union.set(kindOf(mesh.name), s.clone());
      else was.radius = Math.max(was.radius, was.center.distanceTo(s.center) + s.radius);
    }
    for (const mesh of gardens.meshes as InstancedMesh[]) {
      const model = union.get(kindOf(mesh.name))!;
      const matrix = new Matrix4();
      all.set(mesh.name, [...drawn(gardens).get(mesh.name)!].map((key) => {
        matrix.fromArray(key.split('|')[0]!.split(',').map(Number));
        const sphere = model.clone().applyMatrix4(matrix);
        return { key, sphere };
      }));
    }
    const rng = new Rng(99);
    const tolerance = m(0.01);
    let seen = 0;
    for (let c = 0; c < 40; c++) {
      const { frustum, view } = viewOf(cameraAt(rng, spread));
      gardens.cull(frustum, view);
      const now = drawn(gardens);
      for (const [name, plants] of all) {
        const got = now.get(name)!;
        expect(got.size).toBe((gardens.meshes as InstancedMesh[]).find((x) => x.name === name)!.count);
        for (const { key, sphere } of plants) {
          const probe = sphere.clone();
          probe.radius = sphere.radius + SHADOW_REACH + tolerance;
          if (!frustum.intersectsSphere(probe)) expect(got.has(key)).toBe(false);
          probe.radius = sphere.radius + SHADOW_REACH - tolerance;
          if (frustum.intersectsSphere(probe)) expect(got.has(key)).toBe(true);
        }
        seen += got.size;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('sends nothing to the GPU again when the same plants are in view', () => {
    const gardens = createGardens(kit);
    gardens.update({ added: town(200, m(2000), 3), removed: [] });
    const camera = new PerspectiveCamera(50, 1.6, 1, m(800));
    camera.position.set(0, m(80), 0);
    camera.lookAt(m(200), 0, -m(200));
    camera.updateMatrixWorld();
    const { frustum, view } = viewOf(camera);
    gardens.cull(frustum, view);
    const meshes = (gardens.meshes as InstancedMesh[]).filter((mesh) => mesh.count > 0);
    expect(meshes.length).toBeGreaterThan(0);
    // As if three uploaded them.
    for (const mesh of meshes) { posesOf(mesh).buffer.clearUpdateRanges(); mesh.instanceColor!.clearUpdateRanges(); }
    const versions = meshes.map((mesh) => [posesOf(mesh).buffer.version, mesh.instanceColor!.version]);
    const counts = meshes.map((mesh) => mesh.count);
    // Another view matrix, the same frustum: culled again, the same plants.
    gardens.cull(frustum, view.clone().multiply(new Matrix4().makeTranslation(0, 0, 0.5)));
    expect(meshes.map((mesh) => [posesOf(mesh).buffer.version, mesh.instanceColor!.version])).toEqual(versions);
    expect(meshes.map((mesh) => mesh.count)).toEqual(counts);
    expect(meshes.every((mesh) => posesOf(mesh).buffer.updateRanges.length === 0)).toBe(true);
  });

  it('sends at each cull no more than the positions whose instance changed, the buffers sent between culls', () => {
    const gardens = createGardens(kit);
    gardens.update({ added: town(200, m(2000), 5), removed: [] });
    const rng = new Rng(11);
    // Each buffer as three last sent it, and how many positions it drew then.
    const sent = new Map<object, { data: Float32Array; count: number }>();
    for (let c = 0; c < 30; c++) {
      for (const mesh of gardens.meshes as InstancedMesh[]) {
        const buffer = posesOf(mesh).buffer;
        // As if three sent it: its ranges gone, its upload told.
        buffer.clearUpdateRanges();
        buffer.onUploadCallback();
        sent.set(buffer, { data: Float32Array.from(buffer.array as Float32Array), count: mesh.count });
      }
      const { frustum, view } = viewOf(cameraAt(rng, m(2000)));
      gardens.cull(frustum, view);
      for (const mesh of gardens.meshes as InstancedMesh[]) {
        const buffer = posesOf(mesh).buffer, was = sent.get(buffer);
        // A buffer made anew is sent whole once, by three.
        if (!was) continue;
        const stride = buffer.stride, now = buffer.array as Float32Array;
        let changed = 0;
        for (let p = 0; p < mesh.count; p++) {
          if (p >= was.count) { changed++; continue; }
          for (let j = 0; j < stride; j++) if (!Object.is(now[p * stride + j], was.data[p * stride + j])) { changed++; break; }
        }
        const floats = buffer.updateRanges.reduce((n, r) => n + r.count, 0);
        expect(floats, `cull ${c}: ${floats / stride} positions sent, ${changed} changed`).toBeLessThanOrEqual(changed * stride);
      }
    }
  });

  it('never lets the pending upload ranges grow while a mesh is not drawn: one cull\'s runs, then one range round them', () => {
    const gardens = createGardens(kit);
    gardens.update({ added: town(200, m(2000), 5), removed: [] });
    const rng = new Rng(4);
    // Ranges waiting before the cull, by buffer: a cull that finds some waiting leaves one.
    const waiting = new Map<object, number>();
    for (let c = 0; c < 30; c++) {
      for (const mesh of gardens.meshes as InstancedMesh[]) for (const a of [posesOf(mesh).buffer, mesh.instanceColor!]) waiting.set(a, a.updateRanges.length);
      const { frustum, view } = viewOf(cameraAt(rng, m(2000)));
      gardens.cull(frustum, view);
      for (const mesh of gardens.meshes as InstancedMesh[]) {
        for (const a of [posesOf(mesh).buffer, mesh.instanceColor!]) {
          if ((waiting.get(a) ?? 0) > 0) expect(a.updateRanges.length, `cull ${c}`).toBeLessThanOrEqual(1);
          // One cull's runs are within the buffer.
          for (const r of a.updateRanges) expect(r.start + r.count).toBeLessThanOrEqual(a.array.length);
        }
      }
    }
  });
});
