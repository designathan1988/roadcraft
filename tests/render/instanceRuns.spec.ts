import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Frustum,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  ShaderLib,
  Sphere,
  Vector3,
  type BufferAttribute,
  type Camera,
  type InstancedMesh,
  type InterleavedBuffer,
  type WebGLProgramParametersWithUniforms,
  type WebGLRenderer,
} from 'three';
import { Rng } from '@core/rng';
import { drawnMatrices, posedMaterial, posesOf } from '@render/cellInstances';
import { COVER_POSE, coverPoseInto, type CoverPlacement, type TreePlacement } from '@render/groundCover';
import { RunBuilder, YAW_POSE, createInstanceRuns, type PoseFormat, type Run, type RunStore } from '@render/instanceRuns';
import { TREE_POSE, treePoseInto } from '@render/natureTrees';
import { SHADOW_REACH } from '@render/scenery';
import { applyWind } from '@render/wind';
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
    YAW_POSE.matrixInto(Float32Array.from([x, y, z, yaw, s, sy, s, -1]), 0, matrix, 0);
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

/** What the GPU holds of an attribute or an interleaved buffer, updated as `WebGLAttributes` does when the mesh is drawn. */
class GpuCopy {
  private data: Float32Array | null = null;
  private version = -1;
  constructor(readonly attribute: BufferAttribute | InterleavedBuffer) {}
  draw(): Float32Array {
    const a = this.attribute, array = a.array as Float32Array;
    // As three r186 `WebGLAttributes`: made whole (its ranges kept), then sent by its ranges; told each time (`onUploadCallback`).
    if (!this.data) {
      this.data = Float32Array.from(array);
      this.version = a.version;
      a.onUploadCallback();
    } else if (this.version < a.version) {
      if (a.updateRanges.length === 0) this.data.set(array);
      else for (const r of a.updateRanges) this.data.set(array.subarray(r.start, r.start + r.count), r.start);
      a.clearUpdateRanges();
      this.version = a.version;
      a.onUploadCallback();
    }
    return this.data;
  }
}

describe('instances kept thing by thing', () => {
  it('draws the live instances each sphere lets the view see, through things coming and going and hidden stores', () => {
    const rng = new Rng(2026);
    const layer = createInstanceRuns('test', specs, SHADOW_REACH);
    const live: ReturnType<typeof thing>[] = [];
    const gpu = new Map<object, { poses: GpuCopy; colour: GpuCopy | null }>();
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
          // Kept by buffer, as `WebGLAttributes` keeps one: buffers grown or shrunk for what is in view are new buffers.
          const { buffer } = posesOf(mesh), stride = buffer.stride, poses = buffer.array as Float32Array;
          let copy = gpu.get(buffer);
          if (!copy) gpu.set(buffer, copy = { poses: new GpuCopy(buffer), colour: mesh.instanceColor ? new GpuCopy(mesh.instanceColor) : null });
          const on = copy.poses.draw(), tints = copy.colour?.draw() ?? null;
          const matrices = drawnMatrices(mesh);
          const got: string[] = [];
          for (let i = 0; i < mesh.count; i++) {
            const row = [...matrices.subarray(i * 16, i * 16 + 16), ...(tints ? (mesh.instanceColor!.array as Float32Array).subarray(i * 3, i * 3 + 3) : [])];
            got.push(row.join(','));
            // The GPU's copy is the mesh's: its poses, and its tints.
            expect([...on.subarray(i * stride, i * stride + stride)].join(',')).toBe([...poses.subarray(i * stride, i * stride + stride)].join(','));
            if (tints) expect([...tints.subarray(i * 3, i * 3 + 3)].join(',')).toBe(row.slice(16).join(','));
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
          expect(buffer.updateRanges.length).toBeLessThanOrEqual(1);
        }
      }
    }
    expect(compared).toBeGreaterThan(5_000);
    layer.dispose();
  });

  it('sends only the positions whose instance changed when the view moves a little, not every instance in view', () => {
    const rng = new Rng(9);
    const layer = createInstanceRuns('test', specs, SHADOW_REACH);
    layer.update({ added: Array.from({ length: 1_500 }, () => thing(rng, (rng.float() - 0.5) * m(3000), (rng.float() - 0.5) * m(3000), m(40)).run), removed: [] });
    const viewAt = (x: number): { frustum: Frustum; view: Matrix4 } => {
      const camera = new PerspectiveCamera(50, 1.6, 1, m(1500));
      camera.position.set(x, m(120), m(300));
      camera.lookAt(x, 0, -m(300));
      camera.updateMatrixWorld();
      const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      return { frustum: new Frustum().setFromProjectionMatrix(view), view };
    };
    let x = 0;
    for (let step = 0; step < 30; step++, x += m(6)) {
      const { frustum, view } = viewAt(x);
      const mesh = layer.meshes.find((s) => s.name === 'plain');
      const before = mesh ? Float32Array.from(posesOf(mesh).buffer.array as Float32Array) : null;
      const bufferBefore = mesh ? posesOf(mesh).buffer : null;
      // As if three sent it: its ranges gone, its upload told.
      if (bufferBefore) { bufferBefore.clearUpdateRanges(); bufferBefore.onUploadCallback(); }
      layer.cull(frustum, view);
      const now = layer.meshes.find((s) => s.name === 'plain')!;
      const { buffer } = posesOf(now);
      // A buffer made anew (grown or shrunk) is sent whole: nothing to count.
      if (step === 0 || buffer !== bufferBefore || !before) continue;
      const stride = buffer.stride, after = buffer.array as Float32Array;
      let changed = 0;
      for (let p = 0; p < now.count; p++) {
        for (let j = 0; j < stride; j++) if (!Object.is(after[p * stride + j], before[p * stride + j])) { changed++; break; }
      }
      const sent = buffer.updateRanges.reduce((n, r) => n + r.count, 0) / stride;
      // The positions written are those whose slot changed (one moved in may hold the same pose to the bit: never more sent than that).
      expect(sent, `step ${step}`).toBeGreaterThanOrEqual(changed);
      expect(sent, `step ${step}: ${sent} of ${now.count} sent`).toBeLessThan(Math.max(8, now.count / 4));
    }
    layer.dispose();
  });

  it('keeps in the scene only the meshes that draw something, and puts one back once its instances come into view', () => {
    const layer = createInstanceRuns('test', specs, SHADOW_REACH);
    const near = (store: number, x: number): Run => { const b = new RunBuilder(specs); b.turned(store, x, 0, 0, 0, m(2), m(2), m(2), m(2), { r: 1, g: 1, b: 1 }); return b.build(); };
    // Store 0 near the origin; store 1 far away; store 2 near too, but only once added.
    layer.update({ added: [near(0, 0), near(1, m(40_000))], removed: [] });
    const viewAt = (): { frustum: Frustum; view: Matrix4 } => {
      const camera = new PerspectiveCamera(50, 1.6, 1, m(800));
      camera.position.set(0, m(60), m(80));
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      return { frustum: new Frustum().setFromProjectionMatrix(view), view };
    };
    let { frustum, view } = viewAt();
    layer.cull(frustum, view);
    // Both meshes made; only the one drawing stays under the layer's group.
    expect(layer.meshes.length).toBe(2);
    expect(layer.group.children.map((c) => c.name)).toEqual(['plain']);
    // A store's thing comes into view: its mesh made and drawn; the far one stays out.
    layer.update({ added: [near(2, m(3))], removed: [] });
    ({ frustum, view } = viewAt());
    layer.cull(frustum, view.clone());
    expect(layer.group.children.map((c) => c.name).sort()).toEqual(['cards', 'plain'].filter((n) => layer.meshes.some((x) => x.name === n && x.count > 0)).sort());
    expect(layer.group.children.every((c) => (c as InstancedMesh).count > 0)).toBe(true);
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
    const { buffer } = posesOf(mesh);
    buffer.clearUpdateRanges();
    const version = buffer.version, count = mesh.count;
    // Another view, then this one again: only what moved is written; the same view itself writes nothing.
    layer.cull(frustum, view.clone());
    expect(posesOf(mesh).buffer).toBe(buffer);
    expect(buffer.version).toBe(version);
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

  it('keeps 8 floats a thing turned about the up axis (its place, yaw, scales and the cell a far batch hides it in), not a matrix', () => {
    const builder = new RunBuilder(specs);
    for (let i = 0; i < 10; i++) builder.turned(1, i, 0, -i, i * 0.3, 1, 2, 3, 3);
    const pack = builder.build().get(1)!;
    expect(pack.count).toBe(10);
    expect(pack.data.length).toBe(10 * YAW_POSE.stride);
    expect(YAW_POSE.stride).toBe(8);
    // A run's thing is drawn wherever it stands: no far batch's cell (`propCells.ts`).
    for (let i = 0; i < 10; i++) expect(pack.data[i * 8 + 7]).toBe(-1);
    expect(() => new RunBuilder(specs, COVER_POSE).turned(0, 0, 0, 0, 0, 1, 1, 1, 1)).toThrow();
  });
});

type Vec4 = { readonly x: number; readonly y: number; readonly z: number; readonly w: number };

/** `SlotFormat.glsl` run as JavaScript: its `float`s as constants, `sin` and `cos` as Math's, `mat4(...)` as its 16 numbers in the constructor's order (column by column: three's `elements`). */
function glslMatrix(glsl: string): (a: Vec4, b: Vec4) => number[] {
  const js = glsl.trim()
    .replace(/\bfloat\s+/g, 'const ')
    .replace(/\b(sin|cos)\(/g, 'Math.$1(')
    .replace(/return\s+mat4\(([\s\S]*)\);$/, 'return [$1];');
  // Nothing of GLSL left that JavaScript would read another way.
  expect(js).not.toMatch(/\b(vec[234]|mat[234]|float|int|uniform|attribute)\b/);
  expect(js).toMatch(/return \[/);
  return new Function('a', 'b', js) as (a: Vec4, b: Vec4) => number[];
}

describe('a pose made a matrix by the GPU (`cellInstances.ts` `posedMaterial`)', () => {
  let seed = 31;
  const rand = (): number => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);

  it('is the matrix the CPU makes of it (`matrixInto`), for every format', () => {
    // The numbers after x, y, z and yaw, by format: scales, a tree's width, height and lean, a cover's lean and scales.
    const ranges: Record<string, readonly (readonly [number, number])[]> = {
      yaw: [[0.05, 30], [0.05, 30], [0.05, 30], [-1, -1]],
      tree: [[0.5, 25], [0.5, 25], [-0.3, 0.3], [-0.3, 0.3]],
      cover: [[-0.3, 0.3], [0.05, 30], [0.05, 30], [0.05, 30]],
    };
    for (const format of [YAW_POSE, TREE_POSE, COVER_POSE]) {
      const gpu = glslMatrix(format.glsl), range = ranges[format.key]!;
      expect(range.length).toBe(format.stride - 4);
      const pose = new Float32Array(format.stride), cpu = new Float32Array(16);
      for (let k = 0; k < 5_000; k++) {
        pose[0] = (rand() - 0.5) * 20_000; pose[1] = rand() * 300; pose[2] = (rand() - 0.5) * 20_000; pose[3] = (rand() - 0.5) * 16;
        range.forEach(([lo, hi], i) => { pose[4 + i] = lo + rand() * (hi - lo); });
        format.matrixInto(pose, 0, cpu, 0);
        // As the vertex shader reads the pose: its floats, b.w 1 where it has 7 (a vec4 attribute fed 3 numbers).
        const mine = gpu({ x: pose[0]!, y: pose[1]!, z: pose[2]!, w: pose[3]! }, { x: pose[4]!, y: pose[5]!, z: pose[6]!, w: format.stride > 7 ? pose[7]! : 1 });
        expect(mine.length).toBe(16);
        const scale = Math.max(1, ...Array.from(pose.subarray(4), Math.abs));
        for (let i = 0; i < 16; i++) {
          // The place to the bit (the far pictures' pick hashes it, `impostorPick`); the rest within float rounding.
          if (i >= 12) expect(Math.fround(mine[i]!) === cpu[i], `${format.key} ${k}: element ${i}`).toBe(true);
          else expect(Math.abs(mine[i]! - cpu[i]!), `${format.key} ${k}: element ${i}`).toBeLessThanOrEqual(1e-6 * scale);
        }
      }
    }
  });

  it("puts the pose's matrix where three's instancing reads its own, the material's patches kept", () => {
    const material = new MeshStandardMaterial();
    applyWind(material, { sway: 0.05, flutter: 0.01 }, 'pose-test');
    expect(posedMaterial(material, TREE_POSE)).toBe(material);
    expect(posedMaterial(material, TREE_POSE)).toBe(material);
    // One format a material: its program is one variant.
    expect(() => posedMaterial(material, YAW_POSE)).toThrow();
    expect(material.customProgramCacheKey()).toBe('wind-nearfade|pose-tree');
    const shader = { vertexShader: ShaderLib.standard.vertexShader, fragmentShader: ShaderLib.standard.fragmentShader, uniforms: {} } as unknown as WebGLProgramParametersWithUniforms;
    material.onBeforeCompile(shader, {} as WebGLRenderer);
    const vertex = shader.vertexShader;
    // The macro before any chunk that reads three's matrix; the matrix made first thing in main.
    expect(vertex.indexOf('#define instanceMatrix posedInstanceMatrix')).toBeGreaterThanOrEqual(0);
    expect(vertex.indexOf('#define instanceMatrix posedInstanceMatrix')).toBeLessThan(vertex.indexOf('#include <common>'));
    expect(vertex).toMatch(/void main\(\) \{\n#ifdef USE_INSTANCING\n {2}posedInstanceMatrix = poseMatrixOf\(instancePoseA, instancePoseB\);/);
    expect(vertex).toContain(TREE_POSE.glsl);
    expect(vertex).toContain('windOffset');
    // A material with no key of its own: its patch's source, then the format.
    expect(posedMaterial(new MeshBasicMaterial(), COVER_POSE).customProgramCacheKey()).toMatch(/\|pose-cover$/);
  });
});

describe('the buffers a layer draws from', () => {
  const body = new BoxGeometry(1, 1, 1);
  body.computeBoundingSphere();
  const leaves = new BoxGeometry(1, 2, 1);
  leaves.computeBoundingSphere();
  const plants: RunStore[] = [{
    name: 'plant', geometry: body, material, castShadow: true, receiveShadow: true, tinted: true, cards: false,
    with: [{ name: 'plant-cards', geometry: leaves, material, castShadow: false, receiveShadow: true, cards: true, far: false }],
  }];
  const everything = new Frustum().setFromProjectionMatrix(new Matrix4().makeOrthographic(-1e7, 1e7, 1e7, -1e7, -1e7, 1e7));

  it("are one buffer of poses and one of tints for a plant's body and its cards", () => {
    const layer = createInstanceRuns('test', plants, 0);
    const builder = new RunBuilder(plants);
    for (let i = 0; i < 200; i++) builder.turned(0, i * 2, 0, -i, i * 0.1, 1, 1, 1, 1, { r: 0.5, g: 0.6, b: 0.7 });
    layer.update({ added: [builder.build()], removed: [] });
    layer.cull(everything, new Matrix4().makeTranslation(-1, 0, 0));
    const [plant, cards] = layer.meshes;
    expect([plant!.name, cards!.name]).toEqual(['plant', 'plant-cards']);
    expect([plant!.count, cards!.count]).toEqual([200, 200]);
    expect(posesOf(plant!).buffer).toBe(posesOf(cards!).buffer);
    expect(plant!.instanceColor).toBe(cards!.instanceColor);
    // The model's own attributes, not a copy.
    expect(plant!.geometry.getAttribute('position')).toBe(body.getAttribute('position'));
    layer.dispose();
  });

  it('follow what is in view: grown for a wide view, shrunk again for a narrow one', () => {
    const layer = createInstanceRuns('test', plants, 0);
    const builder = new RunBuilder(plants);
    for (let i = 0; i < 5_000; i++) builder.turned(0, (i % 100) * m(10), 0, -Math.floor(i / 100) * m(10), 0, 1, 1, 1, 1);
    layer.update({ added: [builder.build()], removed: [] });
    layer.cull(everything, new Matrix4().makeTranslation(-1, 0, 0));
    const [plant, cards] = layer.meshes;
    expect(plant!.count).toBe(5_000);
    expect(posesOf(plant!).buffer.count).toBeGreaterThanOrEqual(5_000);
    // A view of a corner: a few in it.
    const camera = new OrthographicCamera(-m(15), m(15), m(15), -m(15), 1, m(1000));
    camera.position.set(0, m(100), 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const view = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    layer.cull(new Frustum().setFromProjectionMatrix(view), view);
    expect(plant!.count).toBeGreaterThan(0);
    expect(plant!.count).toBeLessThan(50);
    const { buffer } = posesOf(plant!);
    expect(buffer.count).toBeLessThanOrEqual(64);
    expect(posesOf(cards!).buffer).toBe(buffer);
    expect(cards!.instanceColor).toBe(plant!.instanceColor);
    // Each one drawn is one of the corner's.
    const matrices = drawnMatrices(plant!);
    for (let i = 0; i < plant!.count; i++) {
      expect(Math.abs(matrices[i * 16 + 12]!)).toBeLessThanOrEqual(m(20));
      expect(Math.abs(matrices[i * 16 + 14]!)).toBeLessThanOrEqual(m(20));
    }
    layer.dispose();
  });
});
