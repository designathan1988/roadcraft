import { BatchedMesh, type BufferAttribute, BufferGeometry, type Camera, GLBufferAttribute, type Group, type Intersection, type InterleavedBufferAttribute, type Material, type Raycaster, type Scene, type WebGLRenderer } from 'three';

/** A BATCHED MESH WHOSE BUFFERS LIVE ON THE GPU ONLY */
// three's BatchedMesh keeps every attribute and its index as arrays of the batch's whole size and sends the ranges it writes from
// them (r186 `setGeometryAt`, `addUpdateRange`): a large city's three shell batches held 333 MB of arrays on the page, a copy of
// what the GPU draws (heap snapshot, 2026-10-20). Here each buffer is a `GLBufferAttribute` (three.js docs: "does not construct a
// VBO. Instead, it uses whatever VBO is passed in"), a geometry written into it straight from its own arrays, and a resize copies on
// the GPU (`copyBufferSubData`). Writes go through COPY_WRITE_BUFFER: an index buffer, typed "element array" on its first bind, may
// be bound there (WebGL 2.0 spec, "Buffer Object Binding"), and the vertex array objects three keeps are left untouched.
// The draw is three's own (its multi-draw lists, culling, visibility); only the geometry's storage is replaced.

type TypedArray = Float32Array | Int8Array | Uint8Array | Int16Array | Uint16Array | Int32Array | Uint32Array;
type TypedArrayOf = { new (length: number): TypedArray; readonly BYTES_PER_ELEMENT: number };

/** One attribute's storage: as the first geometry gave it. */
interface Layout { readonly itemSize: number; readonly normalized: boolean; readonly type: number; readonly of: TypedArrayOf; readonly gpuType: number | undefined }

/** BatchedMesh's own state this class reads and keeps (three r186 `BatchedMesh`): not in its typings. */
interface Inner {
  _geometryInfo: {
    vertexStart: number; vertexCount: number; reservedVertexCount: number;
    indexStart: number; indexCount: number; reservedIndexCount: number;
    start: number; count: number;
    boundingBox: BufferGeometry['boundingBox']; boundingSphere: BufferGeometry['boundingSphere']; active: boolean;
  }[];
  _geometryCount: number;
  _maxVertexCount: number;
  _maxIndexCount: number;
  _nextVertexStart: number;
  _nextIndexStart: number;
  _geometryInitialized: boolean;
  _visibilityChanged: boolean;
  _validateGeometry(geometry: BufferGeometry): void;
  _instanceInfo: { visible: boolean; active: boolean }[];
}

/** The context the batches write with, given by the renderer (`renderer.ts`); none in tests, where a batch keeps three's arrays. */
let context: WebGL2RenderingContext | null = null;
export function gpuBatchContext(gl: WebGL2RenderingContext | null): void {
  context = gl;
}

/** Every index 32-bit: a batch grown past 65,535 vertices keeps its indices as they are (three's 16-bit start would need them converted, read back from the GPU). */
const INDEX_BYTES = 4;

/** What a normalized value of 1 is stored as in `of` (three's MathUtils.normalize); a float array stores it as is. */
function normalizer(of: TypedArrayOf): number {
  switch (of) {
    case Uint8Array: return 255;
    case Int8Array: return 127;
    case Uint16Array: return 65535;
    case Int16Array: return 32767;
    case Uint32Array: return 4294967295;
    case Int32Array: return 2147483647;
    default: return 1;
  }
}

function glTypeOf(gl: WebGL2RenderingContext, array: TypedArray): number {
  if (array instanceof Float32Array) return gl.FLOAT;
  if (array instanceof Int16Array) return gl.SHORT;
  if (array instanceof Uint16Array) return gl.UNSIGNED_SHORT;
  if (array instanceof Int8Array) return gl.BYTE;
  if (array instanceof Uint8Array) return gl.UNSIGNED_BYTE;
  if (array instanceof Int32Array) return gl.INT;
  return gl.UNSIGNED_INT;
}

export class GpuBatchedMesh extends BatchedMesh {
  private readonly gl: WebGL2RenderingContext | null = context;
  private layouts: Map<string, Layout> | null = null;
  /** The buffers this batch made, let go with it. */
  private readonly made = new Set<WebGLBuffer>();
  /** Each geometry's own indices (its vertices from 0, two bytes each while it has under 65,536), kept on the page: packing the batch (`compact`) writes the index buffer again from them, shifted to where each geometry lands. DO NOT read the stored indices back from the GPU for it (`getBufferSubData`): it waits for every draw queued before it, on the page, as cells come and go under a moving camera (the player's list, 2026-10-22). */
  private readonly localIndex = new Map<number, Uint16Array | Uint32Array>();

  /** Instances left out of the draws seen from one camera alone (`render/occlusion.ts`: behind the walls standing before the eye). The
   *  shadow passes draw them: three's `onBeforeShadow` lists the batch's draws through `onBeforeRender` with the shadow camera (r186
   *  `BatchedMesh.onBeforeShadow`), which is not this one. */
  colourHidden: { camera: Camera; readonly ids: number[] } | null = null;
  /** The instances `onBeforeRender` turned off for its listing, turned back on after it. */
  private readonly flipped: number[] = [];

  constructor(maxInstanceCount: number, maxVertexCount: number, maxIndexCount: number, material: Material) {
    super(maxInstanceCount, maxVertexCount, maxIndexCount, material);
  }

  /** three's listing of the multi-draw (frustum, visibility), with the instances hidden from this camera left out of it. */
  override onBeforeRender(renderer: WebGLRenderer, scene: Scene | null, camera: Camera, geometry: BufferGeometry, material: Material, group: Group | null): void {
    const hide = this.colourHidden;
    // three passes no scene when it lists the draws for a shadow (r186 `BatchedMesh.onBeforeShadow`).
    const list = (): void => super.onBeforeRender(renderer, scene as Scene, camera, geometry, material, group as Group);
    if (hide === null || hide.camera !== camera || hide.ids.length === 0) { list(); return; }
    const info = this.inner._instanceInfo, flipped = this.flipped;
    for (const id of hide.ids) {
      const one = info[id];
      if (one?.visible && one.active) { one.visible = false; flipped.push(id); }
    }
    try {
      list();
    } finally {
      for (const id of flipped) info[id]!.visible = true;
      flipped.length = 0;
      // The next listing (another camera: a shadow cascade) made whole again, whatever three's own culling settings.
      this.inner._visibilityChanged = true;
    }
  }

  private get inner(): Inner {
    return this as unknown as Inner;
  }

  /** A buffer of `bytes`, bound first to `target` (its WebGL buffer type), the bindings three keeps put back. */
  private buffer(target: number, bytes: number): WebGLBuffer {
    const gl = this.gl!;
    const buffer = gl.createBuffer()!;
    // The element array binding is the bound vertex array's: given back as it was.
    const binding = target === gl.ELEMENT_ARRAY_BUFFER ? gl.ELEMENT_ARRAY_BUFFER_BINDING : gl.ARRAY_BUFFER_BINDING;
    const was = gl.getParameter(binding) as WebGLBuffer | null;
    gl.bindBuffer(target, buffer);
    // STATIC_DRAW, as three's own attributes: written when a cell comes, drawn every frame. DO NOT hint DYNAMIC_DRAW: ANGLE takes it to its streaming buffers, "not optimal for performance" (ANGLE doc/BufferImplementation.md), and the district and street views of a large city lost 15-19 % of their frames to it (bisected, 2026-10-21).
    gl.bufferData(target, bytes, gl.STATIC_DRAW);
    gl.bindBuffer(target, was);
    this.made.add(buffer);
    return buffer;
  }

  /** The batch's attributes and index at its current size, empty. */
  private storage(): BufferGeometry {
    const gl = this.gl!;
    const { _maxVertexCount: vertices, _maxIndexCount: indices } = this.inner;
    const geometry = new BufferGeometry();
    for (const [name, layout] of this.layouts!) {
      const bytes = vertices * layout.itemSize * layout.of.BYTES_PER_ELEMENT;
      const attribute = new GLBufferAttribute(this.buffer(gl.ARRAY_BUFFER, bytes), layout.type, layout.itemSize, layout.of.BYTES_PER_ELEMENT as 1 | 2 | 4, vertices, layout.normalized);
      // An integer attribute stays one (r186 `WebGLBindingStates`: `gpuType === IntType` reads it with vertexAttribIPointer).
      if (layout.gpuType !== undefined) (attribute as unknown as { gpuType: number }).gpuType = layout.gpuType;
      (attribute as unknown as { keptBytes: number }).keptBytes = bytes;
      geometry.setAttribute(name, attribute as unknown as BufferAttribute);
    }
    const bytes = indices * INDEX_BYTES;
    const index = new GLBufferAttribute(this.buffer(gl.ELEMENT_ARRAY_BUFFER, bytes), gl.UNSIGNED_INT, 1, INDEX_BYTES, indices);
    (index as unknown as { keptBytes: number }).keptBytes = bytes;
    // three's multi-draw reads its starts in bytes from the index's element size (r186 `BatchedMesh.onBeforeRender`: `index.array.BYTES_PER_ELEMENT`).
    Object.defineProperty(index, 'array', { value: { BYTES_PER_ELEMENT: INDEX_BYTES } });
    geometry.setIndex(index as unknown as BufferAttribute);
    return geometry;
  }

  /** three's arrays laid out on the first geometry; here their storage on the GPU. */
  protected _initializeGeometry(reference: BufferGeometry): void {
    if (!this.gl) {
      (BatchedMesh.prototype as unknown as { _initializeGeometry(r: BufferGeometry): void })._initializeGeometry.call(this, reference);
      return;
    }
    if (this.inner._geometryInitialized) return;
    if (reference.getIndex() === null) throw new Error('GpuBatchedMesh: geometries must have an index');
    this.layouts = new Map();
    for (const name of Object.keys(reference.attributes)) {
      const source = reference.getAttribute(name) as BufferAttribute | InterleavedBufferAttribute;
      const array = ((source as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (source as InterleavedBufferAttribute).data.array : (source as BufferAttribute).array) as TypedArray;
      const gpuType = (source as BufferAttribute).gpuType as number | undefined;
      this.layouts.set(name, { itemSize: source.itemSize, normalized: source.normalized, type: glTypeOf(this.gl, array), of: array.constructor as TypedArrayOf, gpuType });
    }
    this.geometry = this.storage();
    this.inner._geometryInitialized = true;
  }

  override setGeometryAt(geometryId: number, geometry: BufferGeometry): number {
    const gl = this.gl;
    if (!gl) return super.setGeometryAt(geometryId, geometry);
    const inner = this.inner;
    if (geometryId >= inner._geometryCount) throw new Error('GpuBatchedMesh: maximum geometry count reached');
    inner._validateGeometry(geometry);
    const info = inner._geometryInfo[geometryId]!;
    const sourceIndex = geometry.getIndex()!;
    const vertices = geometry.getAttribute('position').count;
    if (sourceIndex.count > info.reservedIndexCount || vertices > info.reservedVertexCount) throw new Error('GpuBatchedMesh: reserved space not large enough for the geometry');
    info.vertexCount = vertices;
    const target = gl.COPY_WRITE_BUFFER;
    for (const [name, layout] of this.layouts!) {
      const source = geometry.getAttribute(name) as BufferAttribute | InterleavedBufferAttribute;
      const size = layout.itemSize, of = layout.of;
      // Its own array when it is laid out as the batch's; else written out value by value.
      let data: TypedArray;
      const own = (source as BufferAttribute).array as TypedArray | undefined;
      if (!(source as InterleavedBufferAttribute).isInterleavedBufferAttribute && own && own.constructor === of && info.reservedVertexCount === vertices) {
        data = own.length === vertices * size ? own : own.subarray(0, vertices * size);
      } else {
        data = new of(info.reservedVertexCount * size);
        const interleaved = (source as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (source as InterleavedBufferAttribute) : null;
        const raw = (interleaved ? interleaved.data.array : own) as TypedArray;
        if (raw.constructor === of) {
          // The stored values as they are, a stride apart in an interleaved buffer. DO NOT go through getComponent: it gives a normalized value denormalized (0..1), and written into a byte array it truncated every opening to 0.
          const stride = interleaved ? interleaved.data.stride : size, offset = interleaved ? interleaved.offset : 0;
          for (let i = 0; i < vertices; i++) for (let c = 0; c < size; c++) data[i * size + c] = raw[i * stride + offset + c]!;
        } else {
          // Another type: through the value it stands for, stored as the batch stores it (three's copyAttributeData, setComponent).
          const scale = layout.normalized ? normalizer(of) : 1;
          const whole = of !== Float32Array;
          for (let i = 0; i < vertices; i++) {
            for (let c = 0; c < size; c++) {
              const value = source.getComponent(i, c) * scale;
              data[i * size + c] = whole ? Math.round(value) : value;
            }
          }
        }
      }
      const attribute = this.geometry.getAttribute(name) as unknown as GLBufferAttribute;
      gl.bindBuffer(target, attribute.buffer);
      gl.bufferSubData(target, info.vertexStart * size * of.BYTES_PER_ELEMENT, data);
    }
    const index = new Uint32Array(info.reservedIndexCount);
    const sourceArray = sourceIndex.array;
    const count = sourceIndex.count, start = info.vertexStart;
    // The geometry's own indices kept as they are (a typed copy, the engine's), the batch's shifted to its first vertex: one walk, not two
    // (setGeometryAt was 0.37 s of a 13 s flight over the city, `npm run diagnose`, 2026-10-22).
    const local = vertices <= 65535 ? new Uint16Array(count) : new Uint32Array(count);
    local.set(sourceArray.length === count ? sourceArray : sourceArray.subarray(0, count));
    for (let i = 0; i < count; i++) index[i] = start + local[i]!;
    this.localIndex.set(geometryId, local);
    // The rest of what is reserved points at its first vertex, as three's fill (degenerate triangles).
    index.fill(info.vertexStart, sourceIndex.count);
    gl.bindBuffer(target, (this.geometry.getIndex() as unknown as GLBufferAttribute).buffer);
    gl.bufferSubData(target, info.indexStart * INDEX_BYTES, index);
    gl.bindBuffer(target, null);
    info.indexCount = sourceIndex.count;
    info.start = info.indexStart;
    info.count = info.indexCount;
    // Its bounds from its own arrays: the batch has none to work them out from (three's `getBoundingBoxAt` reads them).
    if (geometry.boundingBox === null) geometry.computeBoundingBox();
    if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
    info.boundingBox = geometry.boundingBox!.clone();
    info.boundingSphere = geometry.boundingSphere!.clone();
    inner._visibilityChanged = true;
    return geometryId;
  }

  override deleteGeometry(geometryId: number): this {
    this.localIndex.delete(geometryId);
    return super.deleteGeometry(geometryId);
  }

  override setGeometrySize(maxVertexCount: number, maxIndexCount: number): void {
    const gl = this.gl;
    const inner = this.inner;
    if (!gl || !inner._geometryInitialized) {
      super.setGeometrySize(maxVertexCount, maxIndexCount);
      return;
    }
    const active = inner._geometryInfo.filter((info) => info.active);
    const vertexEnd = Math.max(0, ...active.map((info) => info.vertexStart + info.reservedVertexCount));
    const indexEnd = Math.max(0, ...active.map((info) => info.indexStart + info.reservedIndexCount));
    if (vertexEnd > maxVertexCount || indexEnd > maxIndexCount) throw new Error('GpuBatchedMesh: geometries are stored past the size asked; cannot shrink further');
    const old = this.geometry;
    inner._maxVertexCount = maxVertexCount;
    inner._maxIndexCount = maxIndexCount;
    const fresh = this.storage();
    // What is stored copied on the GPU: up to the next free start (every geometry, live or deleted, lies before it).
    const copy = (from: GLBufferAttribute, to: GLBufferAttribute, bytes: number): void => {
      if (bytes <= 0) return;
      gl.bindBuffer(gl.COPY_READ_BUFFER, from.buffer);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, to.buffer);
      gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, 0, 0, bytes);
    };
    const vertices = Math.min(inner._nextVertexStart, maxVertexCount), indices = Math.min(inner._nextIndexStart, maxIndexCount);
    for (const [name, layout] of this.layouts!) {
      copy(old.getAttribute(name) as unknown as GLBufferAttribute, fresh.getAttribute(name) as unknown as GLBufferAttribute, vertices * layout.itemSize * layout.of.BYTES_PER_ELEMENT);
    }
    copy(old.getIndex() as unknown as GLBufferAttribute, fresh.getIndex() as unknown as GLBufferAttribute, indices * INDEX_BYTES);
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    this.geometry = fresh;
    this.letGo(old);
  }

  /** The vertices and indices the live geometries reserve: what the batch holds once its holes are packed (`compact`). three counts its
   *  room from the end of the last geometry ever stored (r186 `unusedVertexCount`), so a deleted geometry's range stays taken: the
   *  facade batch of a large city grew from 121 MB to 373 MB touring its corners, every cell let go a hole no new one went into (2026-10-21). */
  usedCounts(): { readonly vertices: number; readonly indices: number } {
    let vertices = 0, indices = 0;
    for (const info of this.inner._geometryInfo) if (info.active) { vertices += info.reservedVertexCount; indices += Math.max(0, info.reservedIndexCount); }
    return { vertices, indices };
  }

  /**
   * The live geometries packed to the front of storage of `maxVertexCount` vertices and `maxIndexCount` indices, the holes deleted
   * geometries left gone (three's `optimize`, done on the GPU): the vertices copied buffer to buffer (`copyBufferSubData`), the indices
   * read back once (`getBufferSubData`, WebGL 2.0 spec 5.14.3) and shifted by the distance their geometry moved, as three's own
   * `optimize` shifts its index array (r186) - WebGL 2 has no base vertex for the multi-draw, the indices hold their vertex's place.
   */
  compact(maxVertexCount: number, maxIndexCount: number): void {
    const gl = this.gl;
    const inner = this.inner;
    if (!gl || !inner._geometryInitialized) {
      if (inner._geometryInitialized) this.optimize();
      super.setGeometrySize(maxVertexCount, maxIndexCount);
      return;
    }
    const live = inner._geometryInfo.map((info, id) => ({ info, id })).filter(({ info }) => info.active).sort((a, b) => a.info.vertexStart - b.info.vertexStart);
    const used = this.usedCounts();
    if (used.vertices > maxVertexCount || used.indices > maxIndexCount) throw new Error('GpuBatchedMesh: the live geometries do not fit the size asked');
    const old = this.geometry;
    // The indices written again from each geometry's own (`localIndex`); only a geometry whose own are missing (none is stored without them) has every index read back from the GPU, in one call.
    const indexEnd = inner._nextIndexStart;
    let stored: Uint32Array | null = null;
    if (live.some(({ id }) => !this.localIndex.has(id)) && indexEnd > 0) {
      stored = new Uint32Array(indexEnd);
      gl.bindBuffer(gl.COPY_READ_BUFFER, (old.getIndex() as unknown as GLBufferAttribute).buffer);
      gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, stored);
    }
    inner._maxVertexCount = maxVertexCount;
    inner._maxIndexCount = maxIndexCount;
    const fresh = this.storage();
    const packed = new Uint32Array(used.indices);
    let nextVertex = 0, nextIndex = 0;
    // Runs of geometries lying next to each other in the old storage moved in one copy an attribute.
    let runFrom = -1, runTo = -1, runAt = 0;
    const flush = (): void => {
      if (runFrom < 0) return;
      for (const [name, layout] of this.layouts!) {
        const bytes = layout.itemSize * layout.of.BYTES_PER_ELEMENT;
        gl.bindBuffer(gl.COPY_READ_BUFFER, (old.getAttribute(name) as unknown as GLBufferAttribute).buffer);
        gl.bindBuffer(gl.COPY_WRITE_BUFFER, (fresh.getAttribute(name) as unknown as GLBufferAttribute).buffer);
        gl.copyBufferSubData(gl.COPY_READ_BUFFER, gl.COPY_WRITE_BUFFER, runFrom * bytes, runAt * bytes, (runTo - runFrom) * bytes);
      }
      runFrom = -1;
    };
    for (const { info, id } of live) {
      if (info.vertexStart !== runTo) { flush(); runFrom = info.vertexStart; runAt = nextVertex; }
      runTo = info.vertexStart + info.reservedVertexCount;
      const local = this.localIndex.get(id);
      if (local) {
        // Its own indices from its new first vertex; the rest of what it reserves points at that vertex (degenerate triangles, as `setGeometryAt` filled it).
        for (let j = 0; j < info.indexCount; j++) packed[nextIndex + j] = nextVertex + local[j]!;
        packed.fill(nextVertex, nextIndex + info.indexCount, nextIndex + info.reservedIndexCount);
      } else {
        const delta = nextVertex - info.vertexStart;
        for (let j = 0; j < info.reservedIndexCount; j++) packed[nextIndex + j] = stored![info.indexStart + j]! + delta;
      }
      info.vertexStart = nextVertex;
      info.indexStart = nextIndex;
      info.start = nextIndex;
      nextVertex += info.reservedVertexCount;
      nextIndex += Math.max(0, info.reservedIndexCount);
    }
    flush();
    if (nextIndex > 0) {
      gl.bindBuffer(gl.COPY_WRITE_BUFFER, (fresh.getIndex() as unknown as GLBufferAttribute).buffer);
      gl.bufferSubData(gl.COPY_WRITE_BUFFER, 0, packed);
    }
    gl.bindBuffer(gl.COPY_READ_BUFFER, null);
    gl.bindBuffer(gl.COPY_WRITE_BUFFER, null);
    inner._nextVertexStart = nextVertex;
    inner._nextIndexStart = nextIndex;
    inner._visibilityChanged = true;
    this.geometry = fresh;
    this.letGo(old);
  }

  /** A geometry's buffers deleted (three deletes those it registered when the geometry is disposed; deleting one twice is harmless). */
  private letGo(geometry: BufferGeometry): void {
    geometry.dispose();
    const gl = this.gl!;
    const buffers = [...Object.values(geometry.attributes), geometry.getIndex()].map((a) => (a as unknown as GLBufferAttribute | null)?.buffer);
    for (const buffer of buffers) {
      if (!buffer) continue;
      gl.deleteBuffer(buffer);
      this.made.delete(buffer);
    }
  }

  /** No hits: its vertices are on the GPU (the lab's inspector picks buildings by their records). */
  override raycast(raycaster: Raycaster, intersects: Intersection[]): void {
    if (!this.gl) super.raycast(raycaster, intersects);
  }

  /** A copy drawing the same buffers (what the programs are built ahead with, `uploads.ts` compileCopy): three's copy clones the geometry, which has no arrays here. */
  private sharing = false;
  override copy(source: GpuBatchedMesh, recursive?: boolean): this {
    if (!source.gl || !source.inner._geometryInitialized) return super.copy(source, recursive);
    const geometry = source.geometry;
    source.geometry = new BufferGeometry();
    try {
      super.copy(source, recursive);
    } finally {
      source.geometry = geometry;
    }
    this.geometry.dispose();
    this.geometry = geometry;
    this.layouts = source.layouts;
    this.sharing = true;
    return this;
  }

  override dispose(): this {
    // A copy lets go of its own textures only: the buffers are its source's.
    if (this.sharing) this.geometry = new BufferGeometry();
    super.dispose();
    if (this.gl) {
      for (const buffer of this.made) this.gl.deleteBuffer(buffer);
      this.made.clear();
    }
    return this;
  }
}
