import type { BufferAttribute, InterleavedBuffer, Object3D, Texture } from 'three';

/**
 * What the scene holds in memory, counted from the scene itself, in bytes:
 * a before-and-after for a performance change in seconds, at one view, no
 * game run against an old build. `renderer.info.memory` only counts
 * geometries and textures, not their size.
 *
 * The 2026-10-14 regression (a `BatchedMesh` keeping its whole capacity on
 * the CPU, ~1 GB of the heap) shows as `geometryCpuBytes` going up.
 */
export interface MemoryCounters {
  /** Distinct vertex and index buffers in the scene (an interleaved buffer once). */
  readonly buffers: number;
  /** Size of those buffers: what the GPU holds for them once drawn. */
  readonly geometryBytes: number;
  /** The part still held by a JavaScript array (not let go after upload, `mesh/gpuOnly.ts`). */
  readonly geometryCpuBytes: number;
  /** Who holds `geometryCpuBytes`: the objects' names (the type when unnamed), most first, the first `TOP` of them. */
  readonly cpuByName: readonly (readonly [name: string, bytes: number])[];
  /** `geometryBytes` by every holder's name, for the plan's levels (`core/perfBudget.ts` `memoryGroup`). */
  readonly bytesByName: ReadonlyMap<string, number>;
  /** Distinct textures reachable from the scene's objects and materials. */
  readonly textures: number;
  /** Their pixels, base level only (no mipmaps): data arrays by size, images at 4 bytes a texel. */
  readonly textureBytes: number;
}

type Attribute = BufferAttribute & { readonly isInterleavedBufferAttribute?: boolean; readonly data?: InterleavedBuffer };

/** Counts every object under `root`, shown or not: a hidden mesh holds its memory all the same. */
export function countMemory(root: Object3D): MemoryCounters {
  const buffers = new Set<object>();
  const textures = new Set<Texture>();
  let geometryBytes = 0;
  let geometryCpuBytes = 0;
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
    // Let go after upload: `count` stays (a plain field in three r186). The
    // arrays let go are the shells' Float32/Uint32, 4 bytes a value.
    const bytes = array ? array.byteLength ?? array.length * 4 : owner.count * (owner.stride ?? owner.itemSize ?? 1) * 4;
    geometryBytes += bytes;
    bytesByName.set(holder, (bytesByName.get(holder) ?? 0) + bytes);
    if (array) {
      geometryCpuBytes += bytes;
      cpuByName.set(holder, (cpuByName.get(holder) ?? 0) + bytes);
    }
  };
  const addTexture = (value: unknown): void => {
    if ((value as Texture | null)?.isTexture) textures.add(value as Texture);
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
    }
  });

  let textureBytes = 0;
  for (const t of textures) textureBytes += texelBytes(t);
  const top = [...cpuByName].sort((a, b) => b[1] - a[1]).slice(0, TOP);
  return { buffers: buffers.size, geometryBytes, geometryCpuBytes, cpuByName: top, bytesByName, textures: textures.size, textureBytes };
}

const TOP = 10;

function texelBytes(t: Texture): number {
  const image = t.image as { data?: { byteLength?: number }; width?: number; height?: number; depth?: number } | null;
  if (!image) return 0;
  if (image.data?.byteLength !== undefined) return image.data.byteLength;
  return (image.width ?? 0) * (image.height ?? 0) * (image.depth ?? 1) * 4;
}
