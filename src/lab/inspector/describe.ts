import {
  AdditiveBlending, BackSide, type BufferAttribute, type BufferGeometry, ClampToEdgeWrapping, CustomBlending, DoubleSide, Euler, FloatType, FrontSide, HalfFloatType,
  IntType, LinearFilter, LinearMipmapLinearFilter, LinearMipmapNearestFilter, type Material, Matrix4, MirroredRepeatWrapping, MultiplyBlending, NearestFilter,
  NearestMipmapLinearFilter, NearestMipmapNearestFilter, NoBlending, NormalBlending, type Object3D, Quaternion, RedFormat, RepeatWrapping, RGBAFormat, RGFormat,
  ShaderLib, SubtractiveBlending, type Texture, UnsignedByteType, UnsignedIntType, UnsignedShortType, Vector3, type WebGLRenderer,
} from 'three';
import { geometryCost } from '@render/gpuLedger';
import { textureGpuBytes } from '@render/memoryCounters';

/** THE 3D OBJECT DESCRIBED: its place in the scene, its flags and matrices, its geometry's buffers, its materials' every property and texture, the program three compiled for it and the uniforms it was compiled with (`renderer.properties`). */

/** Names of three's numeric constants, as the inspector shows them. */
export const FILTERS: Readonly<Record<number, string>> = {
  [NearestFilter]: 'Nearest', [NearestMipmapNearestFilter]: 'NearestMipmapNearest', [NearestMipmapLinearFilter]: 'NearestMipmapLinear',
  [LinearFilter]: 'Linear', [LinearMipmapNearestFilter]: 'LinearMipmapNearest', [LinearMipmapLinearFilter]: 'LinearMipmapLinear',
};
export const SIDES: Readonly<Record<number, string>> = { [FrontSide]: 'FrontSide', [BackSide]: 'BackSide', [DoubleSide]: 'DoubleSide' };
const WRAPS: Readonly<Record<number, string>> = { [RepeatWrapping]: 'Repeat', [ClampToEdgeWrapping]: 'ClampToEdge', [MirroredRepeatWrapping]: 'MirroredRepeat' };
const BLENDINGS: Readonly<Record<number, string>> = { [NoBlending]: 'No', [NormalBlending]: 'Normal', [AdditiveBlending]: 'Additive', [SubtractiveBlending]: 'Subtractive', [MultiplyBlending]: 'Multiply', [CustomBlending]: 'Custom' };
const FORMATS: Readonly<Record<number, string>> = { [RGBAFormat]: 'RGBA', [RedFormat]: 'Red', [RGFormat]: 'RG' };
const TYPES: Readonly<Record<number, string>> = { [UnsignedByteType]: 'UnsignedByte', [FloatType]: 'Float', [HalfFloatType]: 'HalfFloat', [UnsignedShortType]: 'UnsignedShort', [UnsignedIntType]: 'UnsignedInt', [IntType]: 'Int' };
/** A constant's name by its table, else its number. */
export const named = (table: Readonly<Record<number, string>>, v: number): string => table[v] ?? String(v);

/** The scene's path down to an object: each ancestor's name (its type where unnamed). */
export function pathOf(object: Object3D): string {
  const names: string[] = [];
  for (let o: Object3D | null = object; o; o = o.parent) names.push(o.parent ? o.name || o.type : 'Scene');
  return names.reverse().join(' › ');
}

/** The top-level group under the scene it hangs from. */
export function layerOf(object: Object3D): Object3D | null {
  let o: Object3D = object;
  while (o.parent && o.parent.parent) o = o.parent;
  return o.parent ? o : null;
}

const v3 = (v: { x: number; y: number; z: number }): string => `${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)}`;
const deg = (e: Euler): string => `${(e.x * 57.2958).toFixed(1)}°, ${(e.y * 57.2958).toFixed(1)}°, ${(e.z * 57.2958).toFixed(1)}°`;

/** A matrix decomposed: position, rotation (degrees) and scale. */
export function decomposed(matrix: Matrix4): { position: string; rotation: string; scale: string } {
  const p = new Vector3(), q = new Quaternion(), s = new Vector3();
  matrix.decompose(p, q, s);
  return { position: v3(p), rotation: deg(new Euler().setFromQuaternion(q)), scale: v3(s) };
}

/** The matrix of an instance (or a batch's item) in the world. */
export function instanceMatrix(object: Object3D, instanceId: number | null, batchId: number | null): Matrix4 | null {
  const id = instanceId ?? batchId;
  const holder = object as unknown as { isInstancedMesh?: boolean; isBatchedMesh?: boolean; getMatrixAt?(i: number, m4: Matrix4): Matrix4; instanceMatrix?: { array: ArrayLike<number> | null } };
  if (id === null || !holder.getMatrixAt) return null;
  if (holder.isInstancedMesh && !holder.instanceMatrix?.array) return null;
  try {
    return holder.getMatrixAt(id, new Matrix4()).premultiply(object.matrixWorld);
  } catch (error) {
    console.warn('lab inspector: no instance matrix', error);
    return null;
  }
}

export interface AttributeRow {
  readonly name: string;
  readonly itemSize: number;
  readonly count: number;
  readonly type: string;
  readonly normalized: boolean;
  readonly bytes: number;
  /** Still on the CPU, or let go after its upload (`gpuOnly.ts`). */
  readonly onCpu: boolean;
  readonly interleaved: boolean;
  readonly usage: number;
}

export function attributeRows(geometry: BufferGeometry): AttributeRow[] {
  const rows: AttributeRow[] = [];
  const add = (name: string, a: BufferAttribute | null | undefined): void => {
    if (!a) return;
    const inter = a as unknown as { isInterleavedBufferAttribute?: boolean; data?: { array: ArrayLike<number> & { byteLength?: number } | null; usage: number } };
    const array = (inter.isInterleavedBufferAttribute ? inter.data?.array : a.array) as (ArrayLike<number> & { byteLength?: number; constructor: { name: string } }) | null;
    const kept = (a as unknown as { keptBytes?: number }).keptBytes;
    rows.push({
      name, itemSize: a.itemSize, count: a.count, type: array ? array.constructor.name : 'released', normalized: a.normalized,
      bytes: array?.byteLength ?? kept ?? 0, onCpu: !!array, interleaved: !!inter.isInterleavedBufferAttribute, usage: inter.isInterleavedBufferAttribute ? inter.data?.usage ?? 0 : a.usage,
    });
  };
  for (const [name, a] of Object.entries(geometry.attributes)) add(name, a as BufferAttribute);
  add('index', geometry.index);
  for (const [name, list] of Object.entries(geometry.morphAttributes)) (list ?? []).forEach((a, i) => add(`morph ${name}[${i}]`, a as BufferAttribute));
  return rows;
}

export function geometrySummary(geometry: BufferGeometry): Record<string, unknown> {
  const cost = geometryCost(geometry);
  return {
    type: geometry.type, name: geometry.name || '—', uuid: geometry.uuid, triangles: cost.triangles, bytes: cost.bytes,
    index: geometry.index ? `${geometry.index.count} (${(geometry.index.array as unknown as { constructor: { name: string } } | null)?.constructor.name ?? 'released'})` : 'not indexed',
    drawRange: `${geometry.drawRange.start} + ${geometry.drawRange.count}`, groups: geometry.groups.length,
    boundingSphere: geometry.boundingSphere ? `center ${v3(geometry.boundingSphere.center)}, radius ${geometry.boundingSphere.radius.toFixed(3)}` : 'not computed',
    boundingBox: geometry.boundingBox ? `${v3(geometry.boundingBox.min)} → ${v3(geometry.boundingBox.max)}` : 'not computed',
  };
}

/** Whether a material's `onBeforeCompile` is its own (the shader edited when compiled). */
export const ownCompile = (material: Material): boolean => material.onBeforeCompile !== Object.getPrototypeOf(material).onBeforeCompile;

export interface TextureInfo {
  readonly slot: string;
  readonly texture: Texture;
  readonly size: string;
  readonly rows: Record<string, unknown>;
  /** Its image still on the CPU: it can be sent again (a filter changed). */
  readonly reuploadable: boolean;
}

export function textureInfo(slot: string, t: Texture): TextureInfo {
  const image = t.image as { width?: number; height?: number; depth?: number; data?: unknown } | null;
  const level0 = (t.mipmaps as { width?: number; height?: number }[] | undefined)?.[0];
  const w = image?.width ?? level0?.width ?? 0;
  const h = image?.height ?? level0?.height ?? 0;
  const flags = t as Texture & { isCompressedTexture?: boolean; isDataTexture?: boolean; isRenderTargetTexture?: boolean; isDataArrayTexture?: boolean; isCanvasTexture?: boolean };
  const kind = flags.isRenderTargetTexture ? 'render target' : flags.isCompressedTexture ? 'compressed' : flags.isDataArrayTexture ? 'array' : flags.isDataTexture ? 'data' : flags.isCanvasTexture ? 'canvas' : 'image';
  const reuploadable = !flags.isRenderTargetTexture && (!!image && (image.width ?? 0) > 0 || !!level0);
  return {
    slot, texture: t, size: `${w}×${h}${image?.depth ? `×${image.depth}` : ''}`, reuploadable,
    rows: {
      name: t.name || '—', uuid: t.uuid, type: kind, size: `${w}×${h}${image?.depth ? `×${image.depth}` : ''}`, format: named(FORMATS, t.format as number),
      dataType: named(TYPES, t.type), colorSpace: t.colorSpace || '—', anisotropy: t.anisotropy, minFilter: named(FILTERS, t.minFilter), magFilter: named(FILTERS, t.magFilter),
      wrap: `${named(WRAPS, t.wrapS)} / ${named(WRAPS, t.wrapT)}`, mipmaps: t.mipmaps?.length ?? 0, generateMipmaps: t.generateMipmaps, flipY: t.flipY,
      repeat: `${t.repeat.x}, ${t.repeat.y}`, offset: `${t.offset.x}, ${t.offset.y}`, version: t.version, gpuBytes: textureGpuBytes(t), imageOnCpu: reuploadable,
    },
  };
}

/** Every texture a material holds: its fields, and the uniforms it was compiled with (a texture an `onBeforeCompile` put there). */
export function texturesOf(material: Material, compiled: Record<string, { value: unknown }> | null): TextureInfo[] {
  const out: TextureInfo[] = [];
  const seen = new Set<Texture>();
  const add = (slot: string, v: unknown): void => {
    const t = v as Texture | null;
    if (!t?.isTexture || seen.has(t)) return;
    seen.add(t);
    out.push(textureInfo(slot, t));
  };
  for (const [k, v] of Object.entries(material)) add(k, v);
  const own = (material as { uniforms?: Record<string, { value: unknown }> }).uniforms;
  for (const [k, u] of Object.entries(own ?? {})) add(`uniform ${k}`, u?.value);
  for (const [k, u] of Object.entries(compiled ?? {})) add(`uniform ${k}`, u?.value);
  return out;
}

/** What three keeps per material (`WebGLProperties`): the program it is drawn with and the uniforms it was compiled with. */
export interface ProgramInfo {
  readonly name: string;
  readonly id: number;
  readonly cacheKey: string;
  readonly usedTimes: number;
  /** Programs this material was compiled into (one per light state, fog, environment...). */
  readonly variants: number;
  readonly uniforms: Record<string, { value: unknown }> | null;
}

export function programOf(gl: WebGLRenderer, material: Material): ProgramInfo | null {
  const props = gl.properties.get(material) as { currentProgram?: { name: string; id: number; cacheKey: string; usedTimes: number }; programs?: Map<string, unknown>; uniforms?: Record<string, { value: unknown }> } | undefined;
  if (!props?.currentProgram) return props?.uniforms ? { name: '—', id: -1, cacheKey: '', usedTimes: 0, variants: props.programs?.size ?? 0, uniforms: props.uniforms } : null;
  const p = props.currentProgram;
  return { name: p.name, id: p.id, cacheKey: p.cacheKey, usedTimes: p.usedTimes, variants: props.programs?.size ?? 0, uniforms: props.uniforms ?? null };
}

/** The shader of three's own a built-in material compiles from (`ShaderLib`): its uniforms are set from the material's fields every frame. */
const SHADER_OF: Readonly<Record<string, string>> = {
  MeshBasicMaterial: 'basic', MeshLambertMaterial: 'lambert', MeshPhongMaterial: 'phong', MeshStandardMaterial: 'standard', MeshPhysicalMaterial: 'physical',
  MeshToonMaterial: 'toon', MeshMatcapMaterial: 'matcap', PointsMaterial: 'points', LineBasicMaterial: 'basic', LineDashedMaterial: 'dashed',
  MeshDepthMaterial: 'depth', MeshDistanceMaterial: 'distance', MeshNormalMaterial: 'normal', SpriteMaterial: 'sprite', ShadowMaterial: 'shadow',
};

/** The uniforms an edit can change: a ShaderMaterial's own; for a built-in material, the ones its `onBeforeCompile` added (three refreshes the rest from the fields). */
export function editableUniforms(material: Material, compiled: Record<string, { value: unknown }> | null): Record<string, { value: unknown }> {
  const own = (material as { uniforms?: Record<string, { value: unknown }>; isShaderMaterial?: boolean }).uniforms;
  if ((material as { isShaderMaterial?: boolean }).isShaderMaterial && own) return own;
  if (!compiled) return {};
  const shader = SHADER_OF[material.type];
  const builtIn = shader ? (ShaderLib as unknown as Record<string, { uniforms: Record<string, unknown> } | undefined>)[shader]?.uniforms ?? {} : {};
  return Object.fromEntries(Object.entries(compiled).filter(([k]) => !(k in builtIn)));
}

/** A material's every own property (not the private ones) for the full listing. */
export function materialProps(material: Material): [string, unknown][] {
  return Object.entries(material).filter(([k]) => !k.startsWith('_') && k !== 'uuid' && !k.startsWith('is'))
    .map(([k, v]) => [k, k === 'blending' ? named(BLENDINGS, v as number) : k === 'side' || k === 'shadowSide' ? (v === null ? null : named(SIDES, v as number)) : v]);
}

/** The materials of an object, an array's each. */
export const materialsOf = (object: Object3D): Material[] => {
  const mat = (object as { material?: Material | Material[] }).material;
  return Array.isArray(mat) ? mat : mat ? [mat] : [];
};

/** Triangles under an object (its subtree) as three submits them in one pass (r186 `WebGLRenderer.renderBufferDirect`): visible objects only,
 *  the draw range from its start, instances counted, a BatchedMesh by the lists of its last draw. DO NOT count the whole buffer: a hidden layer
 *  or a range of freed slots read as triangles drawn. */
export function trianglesUnder(object: Object3D): number {
  let total = 0;
  object.traverseVisible((o) => {
    const g = (o as { geometry?: BufferGeometry }).geometry;
    if (!g || !(o as { isMesh?: boolean }).isMesh) return;
    const batched = o as { isBatchedMesh?: boolean; _multiDrawCount?: number; _multiDrawCounts?: ArrayLike<number> };
    if (batched.isBatchedMesh && batched._multiDrawCounts) {
      for (let i = 0; i < (batched._multiDrawCount ?? 0); i++) total += Math.floor(batched._multiDrawCounts[i]! / 3);
      return;
    }
    const index = g.index;
    const count = index ? index.count : g.attributes['position']?.count ?? 0;
    const start = Math.max(0, g.drawRange.start);
    const drawn = Math.max(0, Math.min(count, start + g.drawRange.count) - start) / 3;
    const inst = (o as { isInstancedMesh?: boolean; count?: number }).isInstancedMesh ? (o as { count: number }).count : 1;
    total += Math.floor(drawn) * inst;
  });
  return total;
}
