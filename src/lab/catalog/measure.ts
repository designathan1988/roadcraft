import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute, Material, Texture } from 'three';

/** THE MEASURES OF ONE PIECE OF GEOMETRY AND ITS MATERIAL, as the catalogue of the engine's objects reports them (`scripts/model-catalog.mjs`). */

/** One vertex attribute: its name, its components and what one vertex of it weighs. */
export interface AttributeMeasure {
  readonly name: string;
  readonly itemSize: number;
  readonly type: string;
  /** Bytes a vertex of this attribute takes (components times the array's element size). */
  readonly bytesPerVertex: number;
  /** One per instance, not per vertex (an instanced attribute). */
  readonly perInstance?: boolean;
}

export interface GeometryMeasure {
  readonly triangles: number;
  readonly vertices: number;
  readonly indexed: boolean;
  readonly attributes: readonly AttributeMeasure[];
  /** Bytes of one vertex over every per-vertex attribute. */
  readonly bytesPerVertex: number;
  /** Bytes of the vertex buffers, the index and the morph targets. */
  readonly bytes: number;
  /** Bytes of the morph targets alone (the shape targets of a body). */
  readonly morphBytes: number;
  readonly morphTargets: number;
  /** The arrays are gone from JavaScript (sent to the GPU only, `mesh/gpuOnly.ts`): sizes from the counts, no vertex-level measure. */
  readonly released: boolean;
  /** Width, height, depth of its bounds, metres. */
  readonly size: readonly [number, number, number] | null;
}

type AnyAttribute = BufferAttribute | InterleavedBufferAttribute;

const elementBytes = (array: ArrayLike<number> | null | undefined, fallback = 4): number =>
  array && 'BYTES_PER_ELEMENT' in array ? (array as unknown as { BYTES_PER_ELEMENT: number }).BYTES_PER_ELEMENT : fallback;

const arrayOf = (a: AnyAttribute): ArrayLike<number> | null =>
  (a as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (a as InterleavedBufferAttribute).data.array : (a as BufferAttribute).array;

/** Triangles, vertices, attributes and bytes of a geometry. */
export function measureGeometry(g: BufferGeometry): GeometryMeasure {
  const position = g.getAttribute('position') as AnyAttribute | undefined;
  const vertices = position ? position.count : 0;
  const indexed = g.index !== null;
  const triangles = Math.floor((indexed ? g.index!.count : vertices) / 3);
  const attributes: AttributeMeasure[] = [];
  let bytes = 0;
  let released = false;
  const seen = new Set<object>();
  for (const [name, attribute] of Object.entries(g.attributes) as [string, AnyAttribute][]) {
    const array = arrayOf(attribute);
    if (!array) released = true;
    const size = elementBytes(array);
    const perInstance = (attribute as { isInstancedBufferAttribute?: boolean }).isInstancedBufferAttribute === true;
    attributes.push({ name, itemSize: attribute.itemSize, type: array ? array.constructor.name : 'released', bytesPerVertex: attribute.itemSize * size, ...(perInstance ? { perInstance } : {}) });
    const owner = (attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (attribute as InterleavedBufferAttribute).data : attribute;
    if (seen.has(owner)) continue;
    seen.add(owner);
    const interleaved = (attribute as InterleavedBufferAttribute).isInterleavedBufferAttribute ? (attribute as InterleavedBufferAttribute).data : null;
    bytes += interleaved ? interleaved.count * interleaved.stride * size : attribute.count * attribute.itemSize * size;
  }
  if (g.index) {
    if (!g.index.array) released = true;
    bytes += g.index.count * elementBytes(g.index.array, g.index.count > 65535 ? 4 : 2);
  }
  let morphBytes = 0, morphTargets = 0;
  for (const list of Object.values(g.morphAttributes) as AnyAttribute[][]) {
    morphTargets = Math.max(morphTargets, list.length);
    for (const a of list) morphBytes += a.count * a.itemSize * elementBytes(arrayOf(a));
  }
  bytes += morphBytes;
  if (!g.boundingBox && position && arrayOf(position)) g.computeBoundingBox();
  const box = g.boundingBox;
  const size = box ? [box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z].map((v) => Math.round(v * 1000) / 1000) as [number, number, number] : null;
  const bytesPerVertex = attributes.filter((a) => !a.perInstance).reduce((sum, a) => sum + a.bytesPerVertex, 0);
  return { triangles, vertices, indexed, attributes, bytesPerVertex, bytes, morphBytes, morphTargets, released, size };
}

export interface TextureMeasure {
  readonly slot: string;
  readonly name: string;
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly mips: number;
  /** Bytes on the GPU: its levels' own data where it holds them, else its size by its format with the mip chain (4/3). */
  readonly bytes: number;
}

/** The bytes one texel of an uncompressed format takes (three's format and type constants, r186). */
function texelBytes(format: number, type: number): number {
  const channels = format === 1028 || format === 1026 || format === 1029 ? 1 : format === 1030 ? 2 : format === 1022 ? 3 : 4;
  const size = type === 1015 ? 4 : type === 1016 ? 2 : type === 1012 || type === 1013 || type === 1017 || type === 1018 ? 2 : type === 1014 || type === 1011 ? 4 : 1;
  return channels * size;
}

export function measureTexture(slot: string, t: Texture): TextureMeasure {
  const image = (t.image ?? {}) as { width?: number; height?: number; depth?: number };
  const mipmaps = (t as { mipmaps?: { data?: ArrayLike<number> | null; width: number; height: number }[] }).mipmaps ?? [];
  const width = image.width ?? mipmaps[0]?.width ?? 0;
  const height = image.height ?? mipmaps[0]?.height ?? 0;
  const array = (t as { isCompressedArrayTexture?: boolean; isDataArrayTexture?: boolean }).isCompressedArrayTexture || (t as { isDataArrayTexture?: boolean }).isDataArrayTexture;
  const layers = array ? image.depth ?? 1 : 1;
  const compressed = (t as { isCompressedTexture?: boolean }).isCompressedTexture === true;
  const held = mipmaps.reduce((sum, level) => sum + (level.data && 'byteLength' in level.data ? (level.data as unknown as ArrayBufferView).byteLength : 0), 0);
  const chain = mipmaps.length > 1 || t.generateMipmaps ? 4 / 3 : 1;
  // A compressed texture let go of its texels (`surfaceTextures.ts` letTexelsGo): a block format is a byte a texel (BC7, ASTC 4x4).
  const estimate = width * height * layers * (compressed ? 1 : texelBytes(t.format as number, t.type as number)) * chain;
  return { slot, name: t.name, type: t.constructor.name, width, height, layers, mips: mipmaps.length || (t.generateMipmaps ? Math.floor(Math.log2(Math.max(1, width, height))) + 1 : 1), bytes: Math.round(held > 0 ? held : estimate) };
}

export interface MaterialMeasure {
  readonly type: string;
  readonly name: string;
  /** The shader: three's own, a built-in one patched (`onBeforeCompile`), or one written whole. */
  readonly shader: 'built-in' | 'patched built-in' | 'written';
  /** The program's cache key where the material sets one (its patch's name). */
  readonly key: string;
  readonly flags: readonly string[];
  readonly textures: readonly TextureMeasure[];
  /** The patch or the shaders' text, to read what the shader does (wind, skinning, rounding). */
  readonly source: string;
}

/** A material's type, shader, flags and textures. */
export function measureMaterial(m: Material): MaterialMeasure {
  const record = m as unknown as Record<string, unknown> & { uniforms?: Record<string, { value: unknown }>; vertexShader?: string; fragmentShader?: string; isShaderMaterial?: boolean };
  const patched = Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile');
  const written = record.isShaderMaterial === true;
  const textures: TextureMeasure[] = [];
  const seen = new Set<Texture>();
  const add = (slot: string, value: unknown): void => {
    const t = value as Texture | null;
    if (!t || !(t as { isTexture?: boolean }).isTexture || seen.has(t)) return;
    seen.add(t);
    textures.push(measureTexture(slot, t));
  };
  for (const [k, v] of Object.entries(record)) add(k, v);
  for (const [k, u] of Object.entries(record.uniforms ?? {})) {
    add(`uniform ${k}`, u?.value);
    if (Array.isArray(u?.value)) (u.value as unknown[]).forEach((v, i) => add(`uniform ${k}[${i}]`, v));
  }
  const flags: string[] = [];
  const bool = (key: string, label = key): void => { if (record[key] === true) flags.push(label); };
  bool('vertexColors', 'vertex colours'); bool('transparent'); bool('flatShading', 'flat shading'); bool('wireframe');
  if (record['side'] === 2) flags.push('double-sided'); else if (record['side'] === 1) flags.push('back side');
  if (typeof record['alphaTest'] === 'number' && (record['alphaTest'] as number) > 0) flags.push(`alpha test ${record['alphaTest'] as number}`);
  for (const key of ['roughness', 'metalness', 'opacity'] as const) if (typeof record[key] === 'number') flags.push(`${key} ${Math.round((record[key] as number) * 100) / 100}`);
  const source = patched ? String(m.onBeforeCompile) : written ? `${record.vertexShader ?? ''}\n${record.fragmentShader ?? ''}` : '';
  const key = patched && typeof m.customProgramCacheKey === 'function' ? String(m.customProgramCacheKey()).split('\n')[0]!.slice(0, 120) : '';
  return { type: m.type, name: m.name, shader: written ? 'written' : patched ? 'patched built-in' : 'built-in', key, flags, textures, source };
}

/** What the shader moves or animates, read from its source: the wind, a skeleton, morph targets, a wave, the time. */
export function shaderMotion(materials: readonly MaterialMeasure[], skinned: boolean, morphs: number): string {
  const found = new Set<string>();
  for (const m of materials) {
    const s = m.source;
    if (/uWind|WIND_GLSL|windSway|windUniforms/.test(s)) found.add('wind sway (vertex)');
    if (/wave/.test(s) && /sin\(/.test(s)) found.add('wave (vertex)');
    if (/USE_SKINNING|citizenBones|boneTexture/.test(s)) found.add('skinned on the GPU');
    if (/louvreSlat/.test(s)) found.add('slats ray-cast in the pixel shader');
    if (/vRoundP|aRoundP/.test(s)) found.add('rounded edges in the shading');
    if (/uTime|uClock|time\b/.test(s) && found.size === 0) found.add('animated by time');
  }
  if (skinned) found.add('skeleton');
  if (morphs > 0) found.add(`${morphs} morph targets`);
  return [...found].join('; ');
}

export interface SolidsMeasure {
  /** Separate solids (welded by position). */
  readonly count: number;
  /** How many of each shape: box, quad, open prism, closed cylinder, other. */
  readonly byShape: Readonly<Record<string, number>>;
  /** Triangles no one sees: their centre strictly inside another convex closed solid of the geometry, or pressed face to face against another triangle. */
  readonly hidden: number;
}

/** The separate solids of a geometry and the faces still in it that no one sees; null when its arrays are gone or it is too big to walk. */
export function measureSolids(g: BufferGeometry, limit = 400000): SolidsMeasure | null {
  const position = g.getAttribute('position') as AnyAttribute | undefined;
  if (!position || !arrayOf(position) || (g.index && !g.index.array)) return null;
  const triangles = Math.floor((g.index ? g.index.count : position.count) / 3);
  if (triangles < 1 || triangles > limit) return null;
  const vertexAt = (t: number, k: number): number => (g.index ? g.index.getX(t * 3 + k) : t * 3 + k);
  const ids = new Map<string, number>();
  const parent: number[] = [];
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; } return a; };
  const idOf = (i: number): number => {
    const key = `${Math.round(position.getX(i) * 1e4)},${Math.round(position.getY(i) * 1e4)},${Math.round(position.getZ(i) * 1e4)}`;
    let id = ids.get(key);
    if (id === undefined) { id = parent.length; ids.set(key, id); parent.push(id); }
    return id;
  };
  const corners: number[][] = [];
  for (let t = 0; t < triangles; t++) {
    const c = [idOf(vertexAt(t, 0)), idOf(vertexAt(t, 1)), idOf(vertexAt(t, 2))];
    corners.push(c);
    parent[find(c[0]!)] = find(c[1]!);
    parent[find(c[1]!)] = find(c[2]!);
  }
  type Solid = { triangles: number; vertices: Set<number>; min: number[]; max: number[] };
  const solids = new Map<number, Solid>();
  const solidOf: number[] = [];
  for (let t = 0; t < triangles; t++) {
    const root = find(corners[t]![0]!);
    solidOf.push(root);
    let s = solids.get(root);
    if (!s) solids.set(root, s = { triangles: 0, vertices: new Set(), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    s.triangles++;
    for (let k = 0; k < 3; k++) {
      const i = vertexAt(t, k);
      s.vertices.add(corners[t]![k]!);
      const p = [position.getX(i), position.getY(i), position.getZ(i)];
      for (let d = 0; d < 3; d++) { s.min[d] = Math.min(s.min[d]!, p[d]!); s.max[d] = Math.max(s.max[d]!, p[d]!); }
    }
  }
  const byShape: Record<string, number> = {};
  for (const s of solids.values()) {
    const v = s.vertices.size, n = s.triangles;
    const shape = n === 12 && v === 8 ? 'box' : n === 2 && v === 4 ? 'quad' : v === n && n >= 6 && n % 2 === 0 ? 'open prism' : v === n / 2 + 2 && n % 4 === 0 ? 'closed cylinder' : 'other';
    byShape[shape] = (byShape[shape] ?? 0) + 1;
  }
  // Each triangle's centre and plane (unit normal, offset).
  const centres = new Float64Array(triangles * 3), planes = new Float64Array(triangles * 4);
  for (let t = 0; t < triangles; t++) {
    const p = [0, 1, 2].map((k) => { const i = vertexAt(t, k); return [position.getX(i), position.getY(i), position.getZ(i)]; });
    const u = [0, 1, 2].map((d) => p[1]![d]! - p[0]![d]!), w = [0, 1, 2].map((d) => p[2]![d]! - p[0]![d]!);
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!];
    const length = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
    for (let d = 0; d < 3; d++) { centres[t * 3 + d] = (p[0]![d]! + p[1]![d]! + p[2]![d]!) / 3; planes[t * 4 + d] = n[d]! / length; }
    planes[t * 4 + 3] = -(planes[t * 4]! * p[0]![0]! + planes[t * 4 + 1]! * p[0]![1]! + planes[t * 4 + 2]! * p[0]![2]!);
  }
  // The convex closed solids that can hide another's faces: their triangles' planes (a box, a closed cylinder, any small closed convex part).
  const trianglesOf = new Map<number, number[]>();
  for (let t = 0; t < triangles; t++) { const r = solidOf[t]!; const l = trianglesOf.get(r); if (l) l.push(t); else trianglesOf.set(r, [t]); }
  const eps = 1e-4;
  const convex: { root: number; min: number[]; max: number[]; tris: number[] }[] = [];
  for (const [root, s] of solids) {
    const tris = trianglesOf.get(root)!;
    if (tris.length < 4 || tris.length > 256) continue;
    // Convex: every vertex of the solid on the same side of every face's plane (or on it).
    const verts = new Set<number>();
    for (const t of tris) for (let k = 0; k < 3; k++) verts.add(vertexAt(t, k));
    let sign = 0, ok = true;
    for (const t of tris) {
      for (const i of verts) {
        const d = planes[t * 4]! * position.getX(i) + planes[t * 4 + 1]! * position.getY(i) + planes[t * 4 + 2]! * position.getZ(i) + planes[t * 4 + 3]!;
        if (Math.abs(d) < eps) continue;
        const sd = Math.sign(d);
        if (sign === 0) sign = sd; else if (sd !== sign) { ok = false; break; }
      }
      if (!ok) break;
    }
    if (ok && sign !== 0) convex.push({ root, min: s.min, max: s.max, tris });
  }
  // A grid over the convex solids' bounds: each triangle tests only the solids whose bounds hold its centre's cell.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const s of solids.values()) for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d]!, s.min[d]!); hi[d] = Math.max(hi[d]!, s.max[d]!); }
  const cell = Math.max(1e-3, ...[0, 1, 2].map((d) => (hi[d]! - lo[d]!) / 32));
  const cellKey = (x: number, y: number, z: number): string => `${Math.floor((x - lo[0]!) / cell)},${Math.floor((y - lo[1]!) / cell)},${Math.floor((z - lo[2]!) / cell)}`;
  const grid = new Map<string, number[]>();
  convex.forEach((s, k) => {
    const a = [0, 1, 2].map((d) => Math.floor((s.min[d]! - lo[d]!) / cell)), b = [0, 1, 2].map((d) => Math.floor((s.max[d]! - lo[d]!) / cell));
    if ((b[0]! - a[0]! + 1) * (b[1]! - a[1]! + 1) * (b[2]! - a[2]! + 1) > 4096) return;
    for (let x = a[0]!; x <= b[0]!; x++) for (let y = a[1]!; y <= b[1]!; y++) for (let z = a[2]!; z <= b[2]!; z++) {
      const key = `${x},${y},${z}`;
      const l = grid.get(key);
      if (l) l.push(k); else grid.set(key, [k]);
    }
  });
  // Hidden: a triangle whose centre lies strictly inside another convex closed solid, or one pressed face to face against another triangle.
  const faces = new Map<string, number[]>();
  let hidden = 0;
  for (let t = 0; t < triangles; t++) {
    const cx = centres[t * 3]!, cy = centres[t * 3 + 1]!, cz = centres[t * 3 + 2]!;
    let buried = false;
    for (const k of grid.get(cellKey(cx, cy, cz)) ?? []) {
      const s = convex[k]!;
      if (s.root === solidOf[t]) continue;
      if (cx <= s.min[0]! || cx >= s.max[0]! || cy <= s.min[1]! || cy >= s.max[1]! || cz <= s.min[2]! || cz >= s.max[2]!) continue;
      let sign = 0, inside = true;
      for (const f of s.tris) {
        const d = planes[f * 4]! * cx + planes[f * 4 + 1]! * cy + planes[f * 4 + 2]! * cz + planes[f * 4 + 3]!;
        if (Math.abs(d) < eps) { inside = false; break; }
        const sd = Math.sign(d);
        if (sign === 0) sign = sd; else if (sd !== sign) { inside = false; break; }
      }
      if (inside) { buried = true; break; }
    }
    const key = `${Math.round(cx * 1000)},${Math.round(cy * 1000)},${Math.round(cz * 1000)}`;
    const same = faces.get(key);
    if (!buried && same?.some((f) => planes[f * 4]! * planes[t * 4]! + planes[f * 4 + 1]! * planes[t * 4 + 1]! + planes[f * 4 + 2]! * planes[t * 4 + 2]! < -0.99)) buried = true;
    if (same) same.push(t); else faces.set(key, [t]);
    if (buried) hidden++;
  }
  return { count: solids.size, byShape, hidden };
}
