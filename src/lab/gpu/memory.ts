import type { BufferAttribute, InterleavedBuffer, Light, Object3D, RenderTarget, Scene, Texture, WebGLRenderer } from 'three';
import { textureGpuBytes } from '@render/memoryCounters';
import { renderTargetBytes } from '@render/targetBytes';

/** THE GPU'S OBJECTS AS THE SCENE HOLDS THEM: textures (the materials' fields, their uniforms and the uniforms three compiled them with), render targets (the shadow maps and every target the last captured frame drew into), geometries (their buffers). Sizes are estimates (`memoryCounters.ts`, `targetBytes.ts`), not the driver's. */

export interface TextureRow {
  readonly name: string;
  readonly kind: string;
  readonly size: string;
  readonly format: string;
  readonly mipmaps: string;
  readonly anisotropy: number;
  readonly bytes: number;
  readonly users: number;
  /** Uploaded already (three made its GL texture: `__webglTexture`). */
  readonly uploaded: boolean;
}

export interface TargetRow {
  readonly name: string;
  readonly size: string;
  readonly samples: number;
  readonly textures: number;
  readonly depth: string;
  readonly bytes: number;
  readonly live: boolean;
}

export interface GeometryRow {
  readonly name: string;
  readonly holder: string;
  readonly attributes: number;
  readonly vertices: number;
  readonly indices: number;
  readonly bytes: number;
  /** Bytes whose array was let go after the upload (`mesh/gpuOnly.ts` keptBytes). */
  readonly gpuOnlyBytes: number;
  readonly users: number;
}

export interface GpuObjects {
  readonly textures: TextureRow[];
  readonly targets: TargetRow[];
  readonly geometries: GeometryRow[];
}

type Attribute = BufferAttribute & { readonly isInterleavedBufferAttribute?: boolean; readonly data?: InterleavedBuffer; readonly keptBytes?: number };

const FORMATS: Record<number, string> = { 1021: 'Alpha', 1023: 'RGBA', 1024: 'Luminance', 1025: 'LuminanceAlpha', 1026: 'Depth', 1027: 'DepthStencil', 1028: 'Red', 1029: 'RedInteger', 1030: 'RG', 1031: 'RGInteger', 1033: 'RGBAInteger' };
const TYPES: Record<number, string> = { 1009: 'u8', 1010: 'i8', 1011: 'i16', 1012: 'u16', 1013: 'i32', 1014: 'u32', 1015: 'f32', 1016: 'f16', 1017: 'u4444', 1018: 'u5551', 1020: 'u24_8', 35902: 'u5999', 35899: 'u10f11f11f' };

const formatOf = (t: Texture): string => `${FORMATS[t.format] ?? `fmt${t.format}`}${(t as { isCompressedTexture?: boolean }).isCompressedTexture ? ' (comprimida)' : ` ${TYPES[t.type] ?? t.type}`}`;
const sizeOf = (t: Texture): string => {
  const image = t.image as { width?: number; height?: number; depth?: number } | null;
  const w = image?.width ?? 0, h = image?.height ?? 0, d = image?.depth;
  return d && d > 1 ? `${w}×${h}×${d}` : `${w}×${h}`;
};

export function scanGpuObjects(renderer: WebGLRenderer, scene: Scene, seenTargets: Iterable<RenderTarget>): GpuObjects {
  const textures = new Map<Texture, number>();
  const geometries = new Map<object, { holder: string; users: number }>();
  const properties = renderer.properties as unknown as { has(o: object): boolean; get(o: object): unknown };
  /** DO NOT `get` what three never saw: r186 `WebGLProperties.get` makes an entry for it. */
  const props = { get: (o: object): unknown => (properties.has(o) ? properties.get(o) : {}) };
  const addTexture = (value: unknown): void => {
    const t = value as (Texture & { isRenderTargetTexture?: boolean }) | null;
    if (!t?.isTexture || t.isRenderTargetTexture) return;
    textures.set(t, (textures.get(t) ?? 0) + 1);
  };
  const lights: Light[] = [];
  scene.traverse((object: Object3D) => {
    if ((object as Light).isLight) lights.push(object as Light);
    for (const value of Object.values(object)) addTexture(value);
    const geometry = (object as { geometry?: object }).geometry;
    if (geometry) {
      const known = geometries.get(geometry);
      if (known) known.users++;
      else geometries.set(geometry, { holder: object.name || object.type, users: 1 });
    }
    const material = (object as { material?: object | object[] }).material;
    for (const m of Array.isArray(material) ? material : material ? [material] : []) {
      for (const value of Object.values(m)) addTexture(value);
      const uniforms = (m as { uniforms?: Record<string, { value: unknown }> }).uniforms;
      if (uniforms) for (const u of Object.values(uniforms)) addTexture(u?.value);
      // The uniforms three compiled it with: `onBeforeCompile` puts textures there that no field holds (`memoryCounters.ts`).
      const compiled = (props.get(m) as { uniforms?: Record<string, { value: unknown }> }).uniforms;
      if (compiled) for (const u of Object.values(compiled)) addTexture(u?.value);
    }
  });

  const textureRows: TextureRow[] = [...textures].map(([t, users]) => ({
    name: t.name || '(sem nome)',
    kind: t.constructor.name || 'Texture',
    size: sizeOf(t),
    format: formatOf(t),
    mipmaps: t.mipmaps?.length ? `${t.mipmaps.length} dados` : t.generateMipmaps ? 'geradas' : 'não',
    anisotropy: t.anisotropy,
    bytes: textureGpuBytes(t),
    users,
    uploaded: (props.get(t) as { __webglTexture?: unknown }).__webglTexture !== undefined,
  }));

  const targets = new Map<RenderTarget, string>();
  for (const light of lights) {
    const map = (light as Light & { shadow?: { map: RenderTarget | null } }).shadow?.map;
    if (map) targets.set(map, `sombra: ${light.name || light.type}`);
  }
  for (const t of seenTargets) if (!targets.has(t)) targets.set(t, t.texture?.name || 'alvo do quadro');
  const targetRows: TargetRow[] = [...targets].map(([t, name]) => ({
    name,
    size: `${t.width}×${t.height}`,
    samples: t.samples,
    textures: t.textures.length,
    depth: t.depthTexture ? `textura ${TYPES[t.depthTexture.type] ?? t.depthTexture.type}` : t.depthBuffer ? 'renderbuffer' : 'não',
    bytes: renderTargetBytes(t),
    live: (props.get(t) as { __webglFramebuffer?: unknown }).__webglFramebuffer !== undefined,
  }));

  const geometryRows: GeometryRow[] = [...geometries].map(([g, { holder, users }]) => {
    const geometry = g as { name: string; attributes: Record<string, Attribute>; index: Attribute | null; morphAttributes: Record<string, Attribute[]> };
    const seen = new Set<object>();
    let bytes = 0, gpuOnlyBytes = 0;
    const add = (a: Attribute | null | undefined): void => {
      if (!a) return;
      const owner = (a.isInterleavedBufferAttribute && a.data ? a.data : a) as { array: ArrayLike<number> & { byteLength?: number } | null; keptBytes?: number };
      if (seen.has(owner)) return;
      seen.add(owner);
      if (owner.array) bytes += owner.array.byteLength ?? owner.array.length * 4;
      else if (owner.keptBytes !== undefined) { bytes += owner.keptBytes; gpuOnlyBytes += owner.keptBytes; }
    };
    const attributes = Object.values(geometry.attributes);
    for (const a of attributes) add(a);
    add(geometry.index);
    for (const list of Object.values(geometry.morphAttributes)) for (const a of list) add(a);
    return {
      name: geometry.name || '(sem nome)',
      holder,
      attributes: attributes.length,
      vertices: geometry.attributes['position']?.count ?? 0,
      indices: geometry.index?.count ?? 0,
      bytes,
      gpuOnlyBytes,
      users,
    };
  });
  return { textures: textureRows, targets: targetRows, geometries: geometryRows };
}
