import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Frustum,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Sphere,
  Vector3,
  type BufferAttribute,
  type Camera,
} from 'three';
import { Rng } from '@core/rng';
import { COVER_POSE, coverPoseInto, type CoverPlacement, type TreePlacement } from '@render/groundCover';
import { RunBuilder, YAW_POSE, createInstanceRuns, type PoseFormat, type Run, type RunStore } from '@render/instanceRuns';
import { TREE_POSE, treePoseInto } from '@render/natureTrees';
import { SHADOW_REACH } from '@render/scenery';
import { m } from '@world/units';

/** THE LAYER KEPT THING BY THING (`instanceRuns.ts`) */

const geometry = new BoxGeometry(1, 1, 1);
geometry.computeBoundingSphere();
const material = new MeshBasicMaterial();
const specs: RunStore[] = [
  { name: 'plain', geometry, material, castShadow: true, receiveShadow: true, tinted: false, cards: false },
  { name: 'tinted', geometry, material, castShadow: true, receiveShadow: true, tinted: true, cards: false },
  { name: 'cards', geometry, material, castShadow: false, receiveShadow: true, tinted: true, cards: true },
];

/** A thing: a few instances round a centre, in some of the stores. */
function thing(rng: Rng, cx: number, cz: number, spread: number): { run: Run; spheres: Map<number, Sphere[]>; rows: Map<number, string[]> } {
  const builder = new RunBuilder(specs);
  const object = new Object3D();
  const spheres = new Map<number, Sphere[]>(), rows = new Map<number, string[]>();
  const n = 1 + Math.floor(rng.float() * 6);
  for (let i = 0; i < n; i++) {
    const store = Math.floor(rng.float() * specs.length);
    const s = m(0.3) + rng.float() * m(8);
    const x = cx + (rng.float() - 0.5) * spread, y = rng.float() * m(20), z = cz + (rng.float() - 0.5) * spread;
    const yaw = rng.float() * 6, sy = s * (0.5 + rng.float());
    object.position.set(x, y, z);
    object.rotation.set(0, yaw, 0);
    object.scale.set(s, sy, s);
    object.updateMatrix();
    const tint = { r: rng.float(), g: rng.float(), b: rng.float() };
    builder.turned(store, x, y, z, yaw, s, sy, s, Math.max(s, s * (0.5 + 1)), tint);
    const sphere = geometry.boundingSphere!.clone().applyMatrix4(object.matrix);
    // The matrix the layer writes: its pose as kept (floats), written out.
    const matrix = new Float32Array(16);
    YAW_POSE.matrixInto(Float32Array.from([x, y, z, yaw, s, sy, s]), 0, matrix, 0);
    const colour = specs[store]!.tinted ? Float32Array.from([tint.r, tint.g, tint.b]) : new Float32Array(0);
    (spheres.get(store) ?? spheres.set(store, []).get(store)!).push(sphere);
    (rows.get(store) ?? rows.set(store, []).get(store)!).push([...matrix, ...colour].join(','));
  }
  return { run: builder.build(), spheres, rows };
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

/** What the GPU holds of an attribute, updated as `WebGLAttributes` does when the mesh is drawn. */
class GpuCopy {
  private data: Float32Array | null = null;
  private version = -1;
  constructor(readonly attribute: BufferAttribute) {}
  draw(): Float32Array {
    const a = this.attribute, array = a.array as Float32Array;
    if (!this.data) {
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

describe('instances kept thing by thing', () => {
  it('draws the live instances each sphere lets the view see, through things coming and going and hidden stores', () => {
    const rng = new Rng(2026);
    const layer = createInstanceRuns('test', specs, SHADOW_REACH);
    const live: ReturnType<typeof thing>[] = [];
    const gpu = new Map<object, { matrix: GpuCopy; colour: GpuCopy | null }>();
    const spread = m(3000);
    let compared = 0;
    const tolerance = m(0.01);
    for (let round = 0; round < 60; round++) {
      // Things come and go.
      const added: ReturnType<typeof thing>[] = [], removed: ReturnType<typeof thing>[] = [];
      for (let k = Math.floor(rng.float() * 40); k > 0; k--) {
        const c = rng.float() < 0.8 ? [(rng.float() - 0.5) * spread, (rng.float() - 0.5) * spread] : [m(70000), -m(66000)];
        added.push(thing(rng, c[0]!, c[1]!, m(50)));
      }
      for (let k = Math.floor(rng.float() * 20); k > 0 && live.length; k--) removed.push(...live.splice(Math.floor(rng.float() * live.length), 1));
      layer.update({ added: added.map((t) => t.run), removed: removed.map((t) => t.run) });
      live.push(...added);
      if (round % 7 === 3) layer.setMap(round % 2 === 1);
      for (let c = 0; c < 4; c++) {
        const camera = cameraAt(rng, spread);
        const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const frustum = new Frustum().setFromProjectionMatrix(view);
        // Some stores hidden for this view, shown again for the same view.
        const hidden = layer.meshes.filter((mesh) => mesh.visible && rng.float() < 0.3);
        for (const mesh of hidden) mesh.visible = false;
        layer.cull(frustum, view);
        for (const mesh of hidden) mesh.visible = true;
        layer.cull(frustum, view);
        for (const mesh of layer.meshes) {
          if (!mesh.visible) continue;
          const store = specs.findIndex((s) => s.name === mesh.name);
          // Kept by attribute, as `WebGLAttributes` keeps a buffer: buffers grown for more in view are new attributes.
          let copy = gpu.get(mesh.instanceMatrix);
          if (!copy) gpu.set(mesh.instanceMatrix, copy = { matrix: new GpuCopy(mesh.instanceMatrix), colour: mesh.instanceColor ? new GpuCopy(mesh.instanceColor) : null });
          const on = copy.matrix.draw(), tints = copy.colour?.draw() ?? null;
          const got: string[] = [];
          for (let i = 0; i < mesh.count; i++) {
            const row = [...(mesh.instanceMatrix.array as Float32Array).subarray(i * 16, i * 16 + 16), ...(tints ? (mesh.instanceColor!.array as Float32Array).subarray(i * 3, i * 3 + 3) : [])];
            got.push(row.join(','));
            // The GPU's copy is the mesh's.
            expect([...on.subarray(i * 16, i * 16 + 16)].join(',')).toBe(row.slice(0, 16).join(','));
          }
          expect(new Set(got).size, 'each instance once').toBe(got.length);
          const drawnSet = new Set(got);
          for (const t of live) {
            (t.spheres.get(store) ?? []).forEach((sphere, i) => {
              const row = t.rows.get(store)![i]!;
              const probe = sphere.clone();
              probe.radius = sphere.radius * 1.5 + SHADOW_REACH + tolerance;
              if (!frustum.intersectsSphere(probe)) expect(drawnSet.has(row)).toBe(false);
              probe.radius = sphere.radius + SHADOW_REACH - tolerance;
              if (frustum.intersectsSphere(probe)) expect(drawnSet.has(row)).toBe(true);
            });
          }
          compared += got.length;
          expect(mesh.instanceMatrix.updateRanges.length).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(compared).toBeGreaterThan(5_000);
    layer.dispose();
  });

  it('sends nothing to the GPU again when the same instances are in view', () => {
    const rng = new Rng(5);
    const layer = createInstanceRuns('test', specs, SHADOW_REACH);
    layer.update({ added: Array.from({ length: 400 }, () => thing(rng, (rng.float() - 0.5) * m(2000), (rng.float() - 0.5) * m(2000), m(40)).run), removed: [] });
    const camera = new PerspectiveCamera(50, 1.6, 1, m(800));
    camera.position.set(0, m(80), 0);
    camera.lookAt(m(200), 0, -m(200));
    camera.updateMatrixWorld();
    const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const frustum = new Frustum().setFromProjectionMatrix(view);
    layer.cull(frustum, view);
    const mesh = layer.meshes.find((x) => x.name === 'tinted')!;
    expect(mesh.count).toBeGreaterThan(0);
    mesh.instanceMatrix.clearUpdateRanges();
    const version = mesh.instanceMatrix.version, count = mesh.count;
    // Another view, then this one again: only what moved is written; the same view itself writes nothing.
    layer.cull(frustum, view.clone());
    expect(mesh.instanceMatrix.version).toBe(version);
    expect(mesh.count).toBe(count);
    layer.dispose();
  });
});

/** The matrix written from a pose of `format` (as kept: floats), at `at` of a fresh array. */
function written(format: PoseFormat, pose: ArrayLike<number>): Float32Array {
  const out = new Float32Array(16);
  format.matrixInto(Float32Array.from(pose), 0, out, 0);
  return out;
}

/** The same matrix as the one kept before (three's, rounded to floats): the place to the bit, the rest within float rounding of the pose. */
function expectSameMatrix(mine: Float32Array, old: Float32Array, scale: number, label: string): void {
  for (let i = 0; i < 16; i++) {
    if (i >= 12 || i % 4 === 3) expect(mine[i] === old[i], `${label}: element ${i}`).toBe(true);
    else expect(Math.abs(mine[i]! - old[i]!), `${label}: element ${i}`).toBeLessThanOrEqual(2e-6 * scale);
  }
}

describe('a thing kept as a pose, not a matrix', () => {
  let seed = 77;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

  it('turned about the up axis: the matrix an Object3D composed', () => {
    const object = new Object3D();
    for (let k = 0; k < 5_000; k++) {
      const x = (rand() - 0.5) * 10_000, y = (rand() - 0.5) * 200, z = (rand() - 0.5) * 10_000;
      const yaw = (rand() - 0.5) * 14, sx = 0.05 + rand() * 30, sy = 0.05 + rand() * 30, sz = 0.05 + rand() * 30;
      object.position.set(x, y, z);
      object.rotation.set(0, yaw, 0);
      object.scale.set(sx, sy, sz);
      object.updateMatrix();
      expectSameMatrix(written(YAW_POSE, [x, y, z, yaw, sx, sy, sz]), Float32Array.from(object.matrix.elements), Math.max(sx, sy, sz), `yaw ${yaw}`);
    }
  });

  it('a tree of a wood: the matrix the stand made (yaw, width, height, lean to the open side)', () => {
    for (let k = 0; k < 5_000; k++) {
      const item = { x: (rand() - 0.5) * 10_000, y: (rand() - 0.5) * 10_000, z: rand() * 300, size: 2 + rand() * 20, yaw: rand() * Math.PI * 2, seed: rand(), species: 'broadleaf' } as TreePlacement;
      const crowd = rand(), a = rand() * Math.PI * 2, open = rand() < 0.2 ? 0 : 1;
      const openX = Math.cos(a) * open, openY = Math.sin(a) * open;
      // The matrix as `treeMatrixInto` wrote it before (DO NOT call it: it is written from the pose now).
      const tall = item.size * (0.92 + 0.22 * crowd);
      const wide = item.size * (1.12 - 0.3 * crowd) * (0.94 + ((item.seed * 5.3) % 1) * 0.12);
      const lean = 0.22 * (1 - crowd) * Math.min(1, crowd * 4);
      const sx = openX * lean, sz = -openY * lean;
      const c = Math.cos(item.yaw), s = Math.sin(item.yaw);
      const old = Float32Array.from([c * wide, 0, -s * wide, 0, sx * tall, tall, sz * tall, 0, s * wide, 0, c * wide, 0, item.x, item.z, -item.y, 1]);
      const pose = new Float32Array(TREE_POSE.stride);
      treePoseInto(item, crowd, openX, openY, pose, 0);
      expectSameMatrix(written(TREE_POSE, pose), old, Math.max(wide, tall), `tree ${k}`);
    }
  });

  it('a stone, a bush or a card tree: the matrix three composed (yaw, then a lean about its x)', () => {
    const up = new Vector3(0, 1, 0), side = new Vector3(1, 0, 0);
    const position = new Vector3(), rotation = new Quaternion(), leaning = new Quaternion(), scale = new Vector3(), matrix = new Matrix4();
    for (let k = 0; k < 5_000; k++) {
      const item: CoverPlacement = { x: (rand() - 0.5) * 10_000, y: (rand() - 0.5) * 10_000, z: rand() * 300, size: 0.2 + rand() * 20, yaw: (rand() - 0.2) * 8, seed: rand() };
      const sink = rand() * 0.2, tilt = rand() * 0.4, upright = rand() < 0.4;
      // The matrix as `coverMatrixInto` composed it before.
      const half = item.size / 2;
      position.set(item.x, item.z - half * sink, -item.y);
      rotation.setFromAxisAngle(up, item.yaw);
      leaning.setFromAxisAngle(side, ((item.seed * 31.7) % 1 - 0.5) * tilt);
      rotation.multiply(leaning);
      if (upright) {
        const spread = 0.9 + ((item.seed * 5.3) % 1) * 0.25;
        scale.set(half * 2 * spread, half * 2, half * 2 * spread);
      } else {
        const squat = 0.75 + ((item.seed * 5.3) % 1) * 0.5;
        scale.set(half, half * squat, half * (0.8 + ((item.seed * 13.1) % 1) * 0.4));
      }
      matrix.compose(position, rotation, scale);
      const pose = new Float32Array(COVER_POSE.stride);
      coverPoseInto(item, sink, tilt, upright, pose, 0);
      expectSameMatrix(written(COVER_POSE, pose), Float32Array.from(matrix.elements), Math.max(scale.x, scale.y, scale.z), `cover ${k}`);
    }
  });

  it('keeps 7 floats a thing turned about the up axis, not a matrix', () => {
    const builder = new RunBuilder(specs);
    for (let i = 0; i < 10; i++) builder.turned(1, i, 0, -i, i * 0.3, 1, 2, 3, 3);
    const pack = builder.build().get(1)!;
    expect(pack.count).toBe(10);
    expect(pack.data.length).toBe(10 * YAW_POSE.stride);
    expect(YAW_POSE.stride).toBe(7);
    expect(() => new RunBuilder(specs, COVER_POSE).turned(0, 0, 0, 0, 0, 1, 1, 1, 1)).toThrow();
  });
});
