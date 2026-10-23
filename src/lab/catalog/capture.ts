import { BufferAttribute, BufferGeometry, Matrix4, type BatchedMesh, type InstancedMesh, type InterleavedBufferAttribute, type Material, type Object3D } from 'three';
import { drawnMatrices } from '../../render/cellInstances';
import { poseMatrixInto } from '../../render/buildings/partPose';

/** ONE MESH OF THE TEST CITY TAKEN AS IT IS DRAWN, kept whatever the engine does with it afterwards: its geometry's attributes held (a far cell let go deletes them from
 *  its geometry, `cellInstances.ts` letGo), the world matrix of every copy it draws (three's `instanceMatrix`, or the poses the GPU makes them from, or a GPU batch's
 *  instances), and a GPU batch's geometries read back from the GPU (`gpuBatchedMesh.ts` keeps them there alone). Only for the catalogue's run. */

export interface Taken {
  readonly name: string;
  /** What the geometry is, the same for the same model in another cell or in a cell made again: its name, sizes and centre. */
  readonly key: string;
  readonly geometry: BufferGeometry;
  readonly material: unknown;
  readonly type: 'mesh' | 'lines' | 'points';
  /** Every copy drawn, its world matrix (16 floats each). */
  readonly matrices: Float32Array;
}

const POSE_A = 'instancePoseA';

/** The geometry's own attributes (not the copies'), its index, groups and draw range, in a geometry of its own. */
function held(g: BufferGeometry): BufferGeometry {
  const out = new BufferGeometry();
  out.name = g.name;
  for (const [name, a] of Object.entries(g.attributes)) {
    const own = a as BufferAttribute & { isInstancedBufferAttribute?: boolean; data?: { isInstancedInterleavedBuffer?: boolean } };
    if (own.isInstancedBufferAttribute || own.data?.isInstancedInterleavedBuffer) continue;
    out.setAttribute(name, a);
  }
  if (g.index) out.setIndex(g.index);
  for (const group of g.groups) out.addGroup(group.start, group.count, group.materialIndex);
  out.setDrawRange(g.drawRange.start, g.drawRange.count);
  return out;
}

/** A geometry's key: its name, vertices, indices and the centre of its box, to the decimetre. */
function keyOf(name: string, g: BufferGeometry): string {
  const position = g.getAttribute('position');
  if (!g.boundingBox && position && (position as { array?: unknown }).array) g.computeBoundingBox();
  const b = g.boundingBox;
  const centre = b ? `${Math.round((b.min.x + b.max.x) * 5)},${Math.round((b.min.y + b.max.y) * 5)},${Math.round((b.min.z + b.max.z) * 5)}` : '?';
  return `${name}|${position?.count ?? 0}|${g.index?.count ?? 0}|${centre}`;
}

/** The world matrices of an instanced mesh's copies: from its poses where it is drawn from them, else from three's instance matrices. */
function instanceMatrices(mesh: InstancedMesh): Float32Array {
  const world = mesh.matrixWorld;
  const pose = mesh.geometry.getAttribute(POSE_A) as InterleavedBufferAttribute | undefined;
  let local: Float32Array;
  const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material | undefined;
  if (pose && material && String(material.customProgramCacheKey()).endsWith('|part-pose')) {
    // A building part's poses (`partPose.ts` posePart): eight floats, the same math as its shader.
    const data = pose.data.array as Float32Array, stride = pose.data.stride;
    local = new Float32Array(mesh.count * 16);
    for (let i = 0; i < mesh.count; i++) poseMatrixInto(data, pose.offset + i * stride, local, i * 16);
  } else if (pose) {
    // A cell's poses (`cellInstances.ts` posedMaterial): their format's own math.
    local = drawnMatrices(mesh);
  } else local = (mesh.instanceMatrix.array as Float32Array).slice(0, mesh.count * 16);
  const out: number[] = [], m = new Matrix4();
  for (let i = 0; i < mesh.count; i++) {
    m.fromArray(local, i * 16);
    // A copy folded to nothing (a zero scale) draws nothing.
    if (m.elements[0] === 0 && m.elements[1] === 0 && m.elements[2] === 0 && m.elements[5] === 0 && m.elements[10] === 0) continue;
    m.premultiply(world);
    out.push(...m.elements);
  }
  return Float32Array.from(out);
}

const TYPED: Readonly<Record<number, { new (n: number): Float32Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array }>> = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5124: Int32Array, 5125: Uint32Array, 5126: Float32Array,
};

/** What three keeps of a batch (r186 `BatchedMesh`, not in its typings). */
interface BatchInner {
  readonly gl?: WebGL2RenderingContext | null;
  readonly localIndex?: Map<number, Uint16Array | Uint32Array>;
  readonly _geometryInfo: readonly { vertexStart: number; vertexCount: number; indexStart: number; indexCount: number; active: boolean }[];
  readonly _instanceInfo: readonly { visible: boolean; active: boolean; geometryIndex: number }[];
}

/** One range of a buffer the GPU holds, read back (WebGL 2 `getBufferSubData`), the bindings put back as they were. */
function readBack(gl: WebGL2RenderingContext, buffer: WebGLBuffer, type: number, itemSize: number, from: number, count: number): Float32Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array {
  const Of = TYPED[type];
  if (!Of) throw new Error(`unknown GL type ${type}`);
  const out = new Of(count * itemSize);
  const was = gl.getParameter(gl.COPY_READ_BUFFER_BINDING) as WebGLBuffer | null;
  gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, from * itemSize * out.BYTES_PER_ELEMENT, out);
  gl.bindBuffer(gl.COPY_READ_BUFFER, was);
  return out;
}

/** A batch's geometries already read, by batch and range: read once whatever the views. */
type BatchCache = Map<string, BufferGeometry>;

/** Every geometry a batch draws, each with its visible copies: its arrays where three keeps them, else read back from the GPU. */
function batchTaken(mesh: BatchedMesh, cache: BatchCache): Taken[] {
  const inner = mesh as unknown as BatchInner;
  const source = mesh.geometry;
  const out: Taken[] = [];
  const m = new Matrix4();
  inner._geometryInfo.forEach((info, id) => {
    if (!info.active || info.vertexCount <= 0) return;
    const copies: number[] = [];
    inner._instanceInfo.forEach((one, i) => { if (one.active && one.visible && one.geometryIndex === id) copies.push(i); });
    if (!copies.length) return;
    const cacheKey = `${mesh.uuid}|${info.vertexStart}|${info.vertexCount}|${info.indexStart}|${info.indexCount}`;
    let g = cache.get(cacheKey);
    if (!g) {
      g = new BufferGeometry();
      g.name = mesh.name;
      for (const [name, a] of Object.entries(source.attributes)) {
        const gpu = a as unknown as { isGLBufferAttribute?: boolean; buffer: WebGLBuffer; type: number; itemSize: number; normalized: boolean };
        if (gpu.isGLBufferAttribute) {
          if (!inner.gl) throw new Error(`${mesh.name}: a GPU batch with no context to read it back from`);
          g.setAttribute(name, new BufferAttribute(readBack(inner.gl, gpu.buffer, gpu.type, gpu.itemSize, info.vertexStart, info.vertexCount), gpu.itemSize, gpu.normalized));
        } else {
          const own = a as BufferAttribute;
          const size = own.itemSize;
          g.setAttribute(name, new BufferAttribute(own.array.slice(info.vertexStart * size, (info.vertexStart + info.vertexCount) * size), size, own.normalized));
        }
      }
      // Its indices from its first vertex: the batch's own copy where it keeps one (`gpuBatchedMesh.ts` localIndex), else the stored ones shifted back.
      const local = inner.localIndex?.get(id);
      if (local) g.setIndex(new BufferAttribute(local.slice(0, info.indexCount), 1));
      else if (source.index && info.indexCount > 0) {
        const gpu = source.index as unknown as { isGLBufferAttribute?: boolean; buffer: WebGLBuffer; type: number };
        const stored = gpu.isGLBufferAttribute && inner.gl ? readBack(inner.gl, gpu.buffer, gpu.type, 1, info.indexStart, info.indexCount)
          : (source.index.array as Uint32Array).slice(info.indexStart, info.indexStart + info.indexCount);
        const shifted = new Uint32Array(info.indexCount);
        for (let i = 0; i < info.indexCount; i++) shifted[i] = stored[i]! - info.vertexStart;
        g.setIndex(new BufferAttribute(shifted, 1));
      }
      cache.set(cacheKey, g);
    }
    const matrices = new Float32Array(copies.length * 16);
    copies.forEach((i, k) => { mesh.getMatrixAt(i, m); m.premultiply(mesh.matrixWorld).toArray(matrices, k * 16); });
    out.push({ name: mesh.name, key: keyOf(mesh.name, g), geometry: g, material: mesh.material, type: 'mesh', matrices });
  });
  return out;
}

/** One object of the scene as it is drawn now: nothing for an object that draws nothing (no geometry, no copy, never drawn: its layers off). */
export function take(o: Object3D, cache: BatchCache): Taken[] {
  const holder = o as Object3D & { geometry?: BufferGeometry; material?: unknown; isMesh?: boolean; isLine?: boolean; isPoints?: boolean; isInstancedMesh?: boolean; isBatchedMesh?: boolean; count?: number };
  if (!holder.geometry || !(holder.isMesh || holder.isLine || holder.isPoints) || o.layers.mask === 0) return [];
  if (holder.isBatchedMesh) return batchTaken(o as BatchedMesh, cache);
  const type = holder.isPoints ? 'points' : holder.isLine ? 'lines' : 'mesh';
  const geometry = held(holder.geometry);
  if (!geometry.getAttribute('position')) return [];
  const matrices = holder.isInstancedMesh ? ((holder.count ?? 0) > 0 ? instanceMatrices(o as InstancedMesh) : new Float32Array(0)) : Float32Array.from(o.matrixWorld.elements);
  if (!matrices.length) return [];
  return [{ name: o.name, key: keyOf(o.name, holder.geometry), geometry, material: holder.material, type, matrices }];
}

export type { BatchCache };

/** A copy's place, to the centimetre, with its first axis: the same copy in another view or in a cell made again. */
export function placeKey(matrices: Float32Array, i: number): string {
  const e = (k: number): number => Math.round(matrices[i * 16 + k]! * 100);
  return `${e(12)},${e(13)},${e(14)},${e(0)},${e(2)},${e(5)}`;
}
