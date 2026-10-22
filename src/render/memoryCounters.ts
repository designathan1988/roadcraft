import { LinearMipmapLinearFilter, LinearMipmapNearestFilter, NearestMipmapLinearFilter, NearestMipmapNearestFilter, type BufferAttribute, type InterleavedBuffer, type Object3D, type Texture } from 'three';

/** What the scene holds in memory, counted from the scene itself, in bytes */
export interface MemoryCounters {
  /** Distinct vertex and index buffers in the scene (an interleaved buffer once). */
  readonly buffers: number;
  /** Size of those buffers: what the GPU holds for them once drawn. */
  readonly geometryBytes: number;
  /** The part still held by a JavaScript array (not let go after upload, `mesh/gpuOnly.ts`). */
  readonly geometryCpuBytes: number;
  /** Buffers whose array was let go with no size kept (`mesh/roadResidency.ts` gives a far block's back and disposes it): not counted as held anywhere. */
  readonly releasedBuffers: number;
  /** Who holds `geometryCpuBytes`: the objects' names (the type when unnamed), most first, the first `TOP` of them. */
  readonly cpuByName: readonly (readonly [name: string, bytes: number])[];
  /** `geometryBytes` by every holder's name, for the plan's levels (`core/perfBudget.ts` `memoryGroup`). */
  readonly bytesByName: ReadonlyMap<string, number>;
  /** Distinct textures reachable from the scene's objects and materials, and the uniforms the renderer compiled them with. */
  readonly textures: number;
  /** Their bytes on the GPU, every level of the mip chain: a data texture's array (what is uploaded), a compressed chain's levels, an image at 4 bytes a texel (uploaded as RGBA8). */
  readonly textureBytes: number;
  /** `textureBytes` by holder: the first object reaching each texture and the texture's own name (`holder :: texture`), digits kept. */
  readonly textureBytesByName: ReadonlyMap<string, number>;
}

type Attribute = BufferAttribute & { readonly isInterleavedBufferAttribute?: boolean; readonly data?: InterleavedBuffer };

export interface CountOptions {
  /** The uniforms a material was compiled with (`renderer.properties.get(material).uniforms`): the textures `onBeforeCompile` puts there are in no field of the material (`uLots`, `uDetailMap`: report TST-09). */
  readonly uniformsOf?: (material: object) => Record<string, { value: unknown }> | undefined;
}

/** Counts every object under `root`, shown or not: a hidden mesh holds its memory all the same. */
export function countMemory(root: Object3D, options: CountOptions = {}): MemoryCounters {
  const buffers = new Set<object>();
  const textures = new Set<Texture>();
  /** The holder each texture was first reached from. */
  const textureHolder = new Map<Texture, string>();
  let geometryBytes = 0;
  let geometryCpuBytes = 0;
  let releasedBuffers = 0;
  const cpuByName = new Map<string, number>();
  const bytesByName = new Map<string, number>();
  let holder = '';

  const addBuffer = (a: Attribute | null | undefined): void => {
    if (!a) return;
    // An interleaved attribute is a view into a buffer other attributes share.
    const owner: { array: ArrayLike<number> | null; count: number; itemSize?: number; stride?: number } = a.isInterleavedBufferAttribute && a.data ? a.data : a;
    if (buffers.has(owner)) return;
    buffers.add(owner);
    const array = owner.array as (ArrayLike<number> & { byteLength?: number }) | null;
    // Let go after upload with its size kept (`gpuOnly.ts`): on the GPU, off the CPU.
    const kept = (owner as { keptBytes?: number }).keptBytes;
    // A buffer three never held an array for (`GLBufferAttribute`, the shell batches' `gpuBatchedMesh.ts`): on the GPU, its size kept.
    if ((owner as { isGLBufferAttribute?: boolean }).isGLBufferAttribute) {
      if (kept === undefined) { releasedBuffers++; return; }
      geometryBytes += kept;
      bytesByName.set(holder, (bytesByName.get(holder) ?? 0) + kept);
      return;
    }
    // DO NOT guess a buffer let go without its size at 4 bytes an item: `roadResidency.ts` lets a far block's go AND disposes it - nothing held anywhere, and it was counted as GPU memory (report TST-09).
    if (!array && kept === undefined) { releasedBuffers++; return; }
    const bytes = array ? array.byteLength ?? array.length * 4 : kept!;
    geometryBytes += bytes;
    bytesByName.set(holder, (bytesByName.get(holder) ?? 0) + bytes);
    if (array) {
      geometryCpuBytes += bytes;
      cpuByName.set(holder, (cpuByName.get(holder) ?? 0) + bytes);
    }
  };
  const addTexture = (value: unknown): void => {
    // DO NOT count a render target's texture here: it is in the targets' bytes (`targetBytes.ts`), and the post chain's uniforms counted 68 MB of them twice.
    if ((value as Texture | null)?.isTexture && !(value as Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture && !textures.has(value as Texture)) {
      textures.add(value as Texture);
      textureHolder.set(value as Texture, holder);
    }
  };
  /** Textures a material or an object holds as its own fields (maps, a BatchedMesh's matrices). */
  const scanFields = (holder: object): void => {
    for (const value of Object.values(holder)) {
      addTexture(value);
      if ((value as Attribute | null)?.isBufferAttribute || (value as Attribute | null)?.isInterleavedBufferAttribute) addBuffer(value as Attribute);
    }
  };

  root.traverse((object) => {
    holder = object.name || object.type;
    scanFields(object);
    const geometry = (object as { geometry?: { attributes: Record<string, Attribute>; index: Attribute | null; morphAttributes: Record<string, Attribute[]> } }).geometry;
    if (geometry) {
      for (const a of Object.values(geometry.attributes)) addBuffer(a);
      addBuffer(geometry.index);
      for (const list of Object.values(geometry.morphAttributes)) for (const a of list) addBuffer(a);
    }
    const material = (object as { material?: object | object[] }).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      scanFields(m);
      const uniforms = (m as { uniforms?: Record<string, { value: unknown }> }).uniforms;
      if (uniforms) for (const u of Object.values(uniforms)) addTexture(u?.value);
      const compiled = options.uniformsOf?.(m);
      if (compiled) for (const u of Object.values(compiled)) addTexture(u?.value);
    }
  });

  let textureBytes = 0;
  const textureBytesByName = new Map<string, number>();
  for (const t of textures) {
    const bytes = textureGpuBytes(t);
    textureBytes += bytes;
    const key = `${textureHolder.get(t) ?? ''} :: ${t.name || t.type}`;
    textureBytesByName.set(key, (textureBytesByName.get(key) ?? 0) + bytes);
  }
  const top = [...cpuByName].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  return { buffers: buffers.size, geometryBytes, geometryCpuBytes, releasedBuffers, cpuByName: top, bytesByName, textures: textures.size, textureBytes, textureBytesByName };
}

const TOP = 10;

/** Whether a minification filter samples a mip chain. */
const mipmapped = (filter: number): boolean => filter === NearestMipmapNearestFilter || filter === NearestMipmapLinearFilter || filter === LinearMipmapNearestFilter || filter === LinearMipmapLinearFilter;

/** A texture's bytes on the GPU, every level of its chain */
export function textureGpuBytes(t: Texture): number {
  // A canvas let go after its upload (`signs.ts` sheets): its size as uploaded, kept before the canvas was emptied.
  const uploaded = (t.userData as { uploadedBytes?: number } | undefined)?.uploadedBytes;
  if (uploaded !== undefined) return uploaded;
  // Levels given (compressed, KTX2): each level's own bytes, every layer of an array texture already in them.
  const levels = t.mipmaps as readonly { data?: { byteLength?: number }; width?: number; height?: number }[] | undefined;
  if (levels?.length) {
    let bytes = 0;
    for (const level of levels) bytes += level?.data?.byteLength ?? levelBytes(t, level?.width ?? 0, level?.height ?? 0) * depthOf(t);
    // DO NOT multiply a level's array by the layers: it holds them all (the buildings' finishes, 13 layers, counted 236 MB for 18).
    return bytes;
  }
  const image = t.image as { width?: number; height?: number; depth?: number; data?: { byteLength?: number } } | null;
  if (!image) return 0;
  // Data: its array is what is uploaded, whole (every layer of a 3D or array texture already in it).
  const base = image.data?.byteLength ?? levelBytes(t, image.width ?? 0, image.height ?? 0) * depthOf(t);
  // A chain the GPU makes (`generateMipmaps` with a mipmap filter): the levels below add a third.
  return t.generateMipmaps && mipmapped(t.minFilter) ? Math.round((base * 4) / 3) : base;
}

/** One level's bytes with no array to read: an image (a canvas, a bitmap) goes up as RGBA8, 4 bytes a texel. */
const levelBytes = (_t: Texture, width: number, height: number): number => width * height * 4;

const depthOf = (t: Texture): number => (t.image as { depth?: number } | null)?.depth ?? 1;
