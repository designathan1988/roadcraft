import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Frustum,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Sphere,
  type BufferAttribute,
  type Camera,
} from 'three';
import { Rng } from '@core/rng';
import { createInstanceCull, spatialOrder, type CulledInstances } from '@render/instanceCull';
import { SHADOW_REACH, buildStreetFurniture, createSceneryKit } from '@render/scenery';
import { buildRoadElevation } from '@world/elevation';
import { Network } from '@world/network';
import { applyLots, planLots } from '@world/lots';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { m } from '@world/units';

/**
 * The street furniture is culled cell by cell down a quadtree of the ground
 * (`instanceCull.ts`, audit C7), not instance by instance over the town: the
 * instances drawn for a view must be exactly, and in the same order, the
 * ones the old per-instance pass (`scenery.ts` `cullInstances`, copied here)
 * drew, and what the GPU holds after the partial uploads must be the same.
 */

// ---- The old cull, as it was (scenery.ts before the quadtree). ----

interface OldInstances extends CulledInstances { readonly bounds: { x: number; y: number; z: number; r: number } }

function boundsOf(spheres: Float32Array, count: number): { x: number; y: number; z: number; r: number } {
  if (count === 0) return { x: 0, y: 0, z: 0, r: 0 };
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < count; i++) { x += spheres[i * 4]!; y += spheres[i * 4 + 1]!; z += spheres[i * 4 + 2]!; }
  x /= count; y /= count; z /= count;
  let r = 0;
  for (let i = 0; i < count; i++) {
    const dx = spheres[i * 4]! - x, dy = spheres[i * 4 + 1]! - y, dz = spheres[i * 4 + 2]! - z;
    r = Math.max(r, Math.hypot(dx, dy, dz) + spheres[i * 4 + 3]!);
  }
  return { x, y, z, r };
}

const oldProbe = new Sphere();
function oldCullInstances(meshes: readonly InstancedMesh[], instances: Map<InstancedMesh, OldInstances>, frustum: Frustum): void {
  for (const mesh of meshes) {
    const all = instances.get(mesh)!;
    const matrices = mesh.instanceMatrix.array as Float32Array;
    const colours = all.colours && mesh.instanceColor ? mesh.instanceColor.array as Float32Array : null;
    oldProbe.center.set(all.bounds.x, all.bounds.y, all.bounds.z);
    oldProbe.radius = all.bounds.r + SHADOW_REACH;
    if (!frustum.intersectsSphere(oldProbe)) { mesh.count = 0; continue; }
    let n = 0;
    for (let i = 0; i < all.count; i++) {
      const s = all.spheres;
      oldProbe.center.set(s[i * 4]!, s[i * 4 + 1]!, s[i * 4 + 2]!);
      oldProbe.radius = s[i * 4 + 3]! + SHADOW_REACH;
      if (!frustum.intersectsSphere(oldProbe)) continue;
      for (let j = 0; j < 16; j++) matrices[n * 16 + j] = all.matrices[i * 16 + j]!;
      if (colours && all.colours) for (let j = 0; j < 3; j++) colours[n * 3 + j] = all.colours[i * 3 + j]!;
      n++;
    }
    mesh.count = n;
  }
}

// ---- Instances, cameras and a stand-in for the GPU's copy. ----

const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial();

/** A mesh's instances placed at random round `centres`, in `spatialOrder`, and two meshes holding them. */
function randomSet(rng: Rng, count: number, centres: readonly [number, number][], spread: number, tinted: boolean):
  { data: OldInstances; fresh: InstancedMesh; old: InstancedMesh } {
  const object = new Object3D();
  const matrices = new Float32Array(count * 16), colours = tinted ? new Float32Array(count * 3) : null, spheres = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const [cx, cz] = centres[Math.floor(rng.float() * centres.length)]!;
    const s = m(0.3) + rng.float() * m(12);
    object.position.set(cx + (rng.float() - 0.5) * spread, rng.float() * m(30), cz + (rng.float() - 0.5) * spread);
    object.rotation.set(0, rng.float() * 6, 0);
    object.scale.set(s, s * (0.5 + rng.float()), s);
    object.updateMatrix();
    object.matrix.toArray(matrices, i * 16);
    spheres[i * 4] = object.position.x + (rng.float() - 0.5) * s;
    spheres[i * 4 + 1] = object.position.y + s * 0.5;
    spheres[i * 4 + 2] = object.position.z + (rng.float() - 0.5) * s;
    spheres[i * 4 + 3] = s * (0.5 + rng.float());
    if (colours) for (let j = 0; j < 3; j++) colours[i * 3 + j] = rng.float();
  }
  const order = spatialOrder(spheres, count);
  const sorted = (from: Float32Array, size: number): Float32Array => {
    const out = new Float32Array(count * size);
    order.forEach((i, at) => out.set(from.subarray(i * size, i * size + size), at * size));
    return out;
  };
  const data: OldInstances = {
    matrices: sorted(matrices, 16), colours: colours ? sorted(colours, 3) : null, spheres: sorted(spheres, 4), count,
    bounds: { x: 0, y: 0, z: 0, r: 0 },
  };
  Object.assign(data, { bounds: boundsOf(data.spheres, count) });
  const mesh = (): InstancedMesh => {
    const out = new InstancedMesh(geometry, material, count);
    (out.instanceMatrix.array as Float32Array).set(data.matrices);
    if (data.colours) out.instanceColor = new InstancedBufferAttribute(Float32Array.from(data.colours), 3);
    return out;
  };
  return { data, fresh: mesh(), old: mesh() };
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
  const camera = new PerspectiveCamera(30 + rng.float() * 50, 1.2 + rng.float(), 1, m(200) + rng.float() * m(5000));
  camera.position.set((rng.float() - 0.5) * spread, m(2) + rng.float() * m(400), (rng.float() - 0.5) * spread);
  camera.lookAt((rng.float() - 0.5) * spread, 0, (rng.float() - 0.5) * spread);
  camera.updateMatrixWorld();
  return camera;
}

const viewOf = (camera: Camera): { frustum: Frustum; view: Matrix4 } => {
  const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  return { frustum: new Frustum().setFromProjectionMatrix(view), view };
};

/** What the GPU holds of an attribute, updated as `WebGLAttributes` does when the mesh is drawn. */
class GpuCopy {
  private data: Float32Array | null = null;
  private version = -1;
  constructor(private readonly attribute: BufferAttribute) {}
  draw(): Float32Array {
    const a = this.attribute, array = a.array as Float32Array;
    if (!this.data) {
      // createBuffer: the whole array, the ranges left as they are.
      this.data = Float32Array.from(array);
      this.version = a.version;
    } else if (this.version < a.version) {
      if (a.updateRanges.length === 0) this.data.set(array);
      else for (const r of a.updateRanges) this.data.set(array.subarray(r.start, r.start + r.count), r.start);
      a.clearUpdateRanges();
      this.version = a.version;
    }
    return this.data;
  }
}

/** The first place two arrays differ (-1: none), compared bit for bit. */
function firstDiff(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return Math.min(a.length, b.length);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return i;
  return -1;
}

describe('street furniture cull', () => {
  it('draws the instances the old per-instance pass drew, in its order, through rebuilds and hidden meshes', () => {
    const rng = new Rng(2026);
    let compared = 0, cameras = 0;
    // Each round a rebuild of the furniture: new sets of every size and spread.
    const rounds: { spread: number; centres: [number, number][] }[] = [
      { spread: m(3000), centres: [[0, 0]] },
      { spread: m(800), centres: [[-m(30000), m(41000)], [m(70000), -m(66000)], [0, 0], [m(65536), m(65536)]] },
      { spread: m(12000), centres: [[m(5000), -m(3000)]] },
      { spread: m(150), centres: [[m(10), m(10)], [-m(2000), m(900)], [m(1500), m(1500)]] },
    ];
    for (const round of rounds) {
      const sets = Array.from({ length: 7 }, (_, k) => randomSet(rng, [1, 2, 40, 300, 2500, 9, 1200][k]!, round.centres, round.spread, k % 2 === 0));
      const instances = new Map(sets.map((set) => [set.old, set.data]));
      const cull = createInstanceCull(sets.map((set) => ({ mesh: set.fresh, instances: set.data })), SHADOW_REACH);
      const gpu = sets.map((set) => ({ matrix: new GpuCopy(set.fresh.instanceMatrix), colour: set.fresh.instanceColor ? new GpuCopy(set.fresh.instanceColor) : null }));
      const reach = Math.max(round.spread, ...round.centres.map(([x, z]) => Math.hypot(x, z))) * 2;
      for (let c = 0; c < 80; c++) {
        const camera = cameraAt(rng, reach / (c % 3 === 0 ? 1 : 6));
        const { frustum } = viewOf(camera);
        cameras++;
        cull.invalidate();
        // Some meshes hidden this frame; some of them shown again for the same view.
        const visible = sets.map(() => rng.float() < 0.7);
        for (let pass = 0; pass < 2; pass++) {
          cull.cull(frustum, (k) => visible[k]!);
          oldCullInstances(sets.map((set) => set.old), instances, frustum);
          sets.forEach((set, k) => {
            if (!visible[k]) return;
            const { fresh, old } = set;
            expect(fresh.count).toBe(old.count);
            const n = old.count;
            const want = (old.instanceMatrix.array as Float32Array).subarray(0, n * 16);
            expect(firstDiff((fresh.instanceMatrix.array as Float32Array).subarray(0, n * 16), want)).toBe(-1);
            expect(firstDiff(gpu[k]!.matrix.draw().subarray(0, n * 16), want)).toBe(-1);
            if (old.instanceColor) {
              const tints = (old.instanceColor.array as Float32Array).subarray(0, n * 3);
              expect(firstDiff((fresh.instanceColor!.array as Float32Array).subarray(0, n * 3), tints)).toBe(-1);
              expect(firstDiff(gpu[k]!.colour!.draw().subarray(0, n * 3), tints)).toBe(-1);
            }
            // At most one range waits for the GPU.
            expect(fresh.instanceMatrix.updateRanges.length).toBeLessThanOrEqual(1);
            compared += n;
          });
          for (let k = 0; k < visible.length; k++) visible[k] = visible[k] || rng.float() < 0.5;
        }
      }
    }
    expect(cameras).toBe(320);
    expect(compared).toBeGreaterThan(100_000);
  }, 60_000);

  it('sends nothing to the GPU again when the same instances are in view', () => {
    const rng = new Rng(5);
    const set = randomSet(rng, 3000, [[0, 0]], m(2000), true);
    const cull = createInstanceCull([{ mesh: set.fresh, instances: set.data }], SHADOW_REACH);
    const camera = new PerspectiveCamera(50, 1.6, 1, m(800));
    camera.position.set(0, m(80), 0);
    camera.lookAt(m(200), 0, -m(200));
    camera.updateMatrixWorld();
    const { frustum } = viewOf(camera);
    cull.cull(frustum, () => true);
    const mesh = set.fresh;
    expect(mesh.count).toBeGreaterThan(0);
    mesh.instanceMatrix.clearUpdateRanges();
    mesh.instanceColor!.clearUpdateRanges();
    const versions = [mesh.instanceMatrix.version, mesh.instanceColor!.version], count = mesh.count;
    cull.invalidate();
    cull.cull(frustum, () => true);
    expect([mesh.instanceMatrix.version, mesh.instanceColor!.version]).toEqual(versions);
    expect(mesh.count).toBe(count);
    expect(mesh.instanceMatrix.updateRanges.length).toBe(0);
  });

  it('refuses instances not stored in spatial order', () => {
    const rng = new Rng(8);
    const set = randomSet(rng, 200, [[0, 0]], m(4000), false);
    const spheres = Float32Array.from(set.data.spheres);
    spheres.copyWithin(0, 4, 8);
    spheres.set([m(5000), 0, m(5000), 1], 4);
    expect(() => createInstanceCull([{ mesh: set.fresh, instances: { ...set.data, spheres } }], SHADOW_REACH)).toThrow();
  });

  it('culls a generated town\'s furniture to exactly what each instance\'s sphere lets the view see', () => {
    const doc = layCity(planCity({ ...DEFAULT_CITY, size: 'small' }));
    widenCityFootways(doc);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    greenCity(doc, net, DEFAULT_CITY.seed);
    if (net.revision !== doc.revision) net.rebuild();
    const kit = createSceneryKit();
    const furniture = buildStreetFurniture(net, buildRoadElevation(net, () => 0), kit);
    const meshes = furniture.meshes as InstancedMesh[];
    // Every instance as built (all drawn before the first cull), with its sphere.
    const all = meshes.map((mesh) => {
      const model = mesh.geometry.boundingSphere ?? (mesh.geometry.computeBoundingSphere(), mesh.geometry.boundingSphere!);
      const matrix = new Matrix4();
      const rows: { key: string; sphere: Sphere }[] = [];
      for (let i = 0; i < mesh.count; i++) {
        mesh.getMatrixAt(i, matrix);
        rows.push({ key: matrix.elements.join(','), sphere: model.clone().applyMatrix4(matrix) });
      }
      return { mesh, rows, index: new Map(rows.map((row, i) => [row.key, i])) };
    });
    const total = all.reduce((sum, { rows }) => sum + rows.length, 0);
    expect(total).toBeGreaterThan(500);
    let xs = 0, zs = 0;
    for (const { rows } of all) for (const { sphere } of rows) { xs += sphere.center.x; zs += sphere.center.z; }
    const cx = xs / total, cz = zs / total;
    const rng = new Rng(17);
    const tolerance = m(0.01);
    const matrix = new Matrix4();
    let seen = 0;
    for (let c = 0; c < 60; c++) {
      const camera = cameraAt(rng, m(1500));
      camera.position.x += cx; camera.position.z += cz;
      camera.updateMatrixWorld();
      const { frustum, view } = viewOf(camera);
      // Hidden first (left as it was), then shown for the same view: culled then.
      const hide = c % 4 === 0;
      for (const mesh of meshes) mesh.visible = !hide;
      furniture.cull(frustum, view);
      for (const mesh of meshes) mesh.visible = true;
      furniture.cull(frustum, view);
      for (const { mesh, rows, index } of all) {
        let last = -1;
        const got = new Set<number>();
        for (let i = 0; i < mesh.count; i++) {
          mesh.getMatrixAt(i, matrix);
          const at = index.get(matrix.elements.join(','))!;
          // In the order they were stored, each once.
          expect(at).toBeGreaterThan(last);
          last = at;
          got.add(at);
        }
        rows.forEach(({ sphere }, at) => {
          const probe = sphere.clone();
          probe.radius = sphere.radius + SHADOW_REACH + tolerance;
          if (!frustum.intersectsSphere(probe)) expect(got.has(at)).toBe(false);
          probe.radius = sphere.radius + SHADOW_REACH - tolerance;
          if (frustum.intersectsSphere(probe)) expect(got.has(at)).toBe(true);
        });
        seen += got.size;
      }
    }
    expect(seen).toBeGreaterThan(0);
    furniture.dispose();
  }, 60_000);
});
