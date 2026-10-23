import { Group, Mesh, MeshStandardMaterial, type BufferGeometry, type Material, type Object3D } from 'three';
import { measureGeometry, measureMaterial, measureSolids, shaderMotion, type MaterialMeasure } from './measure';

/** ONE ENTRY OF THE ENGINE'S CATALOGUE: what an object is made of, measured from the pieces its builder made (`scripts/model-catalog.mjs`). */

/** Where the object came from: its own builder (kit), a model file, the test city (it depends on the city's layout), an editor preview, an effect. */
export type Origin = 'kit' | 'file' | 'test city' | 'editor preview' | 'effect';
/** How the engine draws it: one draw for many copies, merged into a bigger mesh, a mesh of its own, skinned, points, lines. */
export type Build = 'instanced' | 'merged' | 'individual' | 'skinned' | 'points' | 'lines';

export interface PieceSpec {
  readonly label: string;
  readonly geometry: BufferGeometry;
  readonly material: Material | readonly Material[] | null;
  /** Its coarser levels, finest first (the piece's own geometry is level 0). */
  readonly levels?: readonly BufferGeometry[];
  readonly bones?: number;
  /** Copies of it inside the object (an instanced part of one building): its triangles count that many times, its buffers once. */
  readonly copies?: number;
}

export interface ItemSpec {
  readonly group: string;
  readonly name: string;
  readonly variation?: string;
  readonly origin: Origin;
  /** The source file that builds it. */
  readonly source: string;
  readonly build: Build;
  readonly pieces: readonly PieceSpec[];
  /** Whether it casts a shadow and with which geometry, when its builder says so (else read from the test city's meshes). */
  readonly shadow?: string;
  readonly notes?: readonly string[];
  /** What the test city's count of it is read from (`city.ts`). */
  readonly countKey?: string;
  /** Floors, for a building: its cost a floor. */
  readonly floors?: number;
  /** Bytes outside the geometry and textures that it needs (a body's shape targets). */
  readonly extraBytes?: number;
  /** Kept out of the running game's cost (an editor preview). */
  readonly preview?: boolean;
  /** Counted in the effects' section. */
  readonly effect?: boolean;
  /** Numbers measured elsewhere, for an object with no pieces of its own here (a test city layer read from the scene). */
  readonly given?: { readonly triangles: number; readonly vertices: number; readonly bytes: number; readonly released: boolean };
}

export interface LevelRow { readonly level: number; readonly triangles: number; readonly vertices: number }

export interface CatalogRow {
  readonly id: string;
  readonly group: string;
  readonly name: string;
  readonly variation: string;
  readonly origin: Origin;
  readonly source: string;
  readonly build: Build;
  readonly triangles: number;
  readonly vertices: number;
  readonly attributes: string;
  readonly bytesPerVertex: number;
  readonly geometryBytes: number;
  readonly textureBytes: number;
  readonly extraBytes: number;
  readonly totalBytes: number;
  readonly materials: string;
  readonly shader: string;
  readonly motion: string;
  readonly levels: readonly LevelRow[];
  readonly solids: string;
  /** Triangles still in it that no one sees (inside another part, or pressed face to face); null when its arrays are not readable. */
  readonly hiddenTriangles: number | null;
  shadow: string;
  readonly bones: number;
  readonly morphTargets: number;
  readonly morphBytes: number;
  readonly released: boolean;
  readonly floors: number;
  readonly trianglesPerFloor: number;
  readonly preview: boolean;
  readonly effect: boolean;
  readonly pieces: readonly { label: string; triangles: number; vertices: number; bytes: number; material: string }[];
  readonly notes: string[];
  readonly countKey: string;
  /** Filled by the test city: copies of it, where the count was read, triangles times copies. */
  instances: number;
  instancesFrom: string;
  totalTriangles: number;
}

const materialsOf = (m: Material | readonly Material[] | null): Material[] => (m === null ? [] : Array.isArray(m) ? [...m] : [m as Material]);

const describe = (m: MaterialMeasure): string => `${m.type}${m.name ? ` "${m.name}"` : ''}${m.key ? ` [${m.key}]` : ''}${m.flags.length ? ` (${m.flags.join(', ')})` : ''}`;

/** A stand-in for drawing a piece on its own when its material needs the engine's uniforms to draw (a patched or written shader). */
function sheetMaterial(m: Material | null, geometry: BufferGeometry): Material {
  if (m && !Object.prototype.hasOwnProperty.call(m, 'onBeforeCompile') && !(m as { isShaderMaterial?: boolean }).isShaderMaterial) return m;
  const source = m as (Material & { color?: { getHex(): number } }) | null;
  return new MeshStandardMaterial({ color: source?.color?.getHex() ?? 0xb8b4ad, vertexColors: geometry.getAttribute('color') !== undefined, roughness: 0.8, metalness: 0 });
}

/** Measures one item from its pieces; with it, a group of its finest level to draw it on a sheet. */
export function measureItem(spec: ItemSpec, id: string): { row: CatalogRow; object: Object3D } {
  let triangles = 0, vertices = 0, geometryBytes = 0, hidden: number | null = 0, morphTargets = 0, morphBytes = 0, released = false;
  const attributes = new Map<string, string>();
  let bytesPerVertex = 0;
  const materials = new Map<string, MaterialMeasure>();
  const textures = new Map<string, number>();
  const shapes: Record<string, number> = {};
  let solidCount = 0;
  const levels: { triangles: number; vertices: number }[] = [];
  const pieces: CatalogRow['pieces'][number][] = [];
  const object = new Group();
  object.name = id;
  let bones = 0;
  for (const piece of spec.pieces) {
    const g = measureGeometry(piece.geometry);
    const copies = piece.copies ?? 1;
    triangles += g.triangles * copies; vertices += g.vertices * copies; geometryBytes += g.bytes;
    morphTargets = Math.max(morphTargets, g.morphTargets); morphBytes += g.morphBytes;
    if (g.released) released = true;
    bytesPerVertex = Math.max(bytesPerVertex, g.bytesPerVertex);
    for (const a of g.attributes) attributes.set(`${a.name}${a.perInstance ? '/instance' : ''}`, `${a.name}${a.perInstance ? '/instance' : ''}:${a.itemSize}x${a.type.replace('Array', '')}=${a.bytesPerVertex}B`);
    const ms = materialsOf(piece.material).map(measureMaterial);
    for (const m of ms) {
      materials.set(describe(m), m);
      for (const t of m.textures) textures.set(`${t.name}|${t.width}x${t.height}x${t.layers}|${t.type}`, t.bytes);
    }
    const solids = measureSolids(piece.geometry);
    if (solids) {
      solidCount += solids.count * copies;
      for (const [shape, n] of Object.entries(solids.byShape)) shapes[shape] = (shapes[shape] ?? 0) + n * copies;
      if (hidden !== null) hidden += solids.hidden * copies;
    } else hidden = null;
    const all = [piece.geometry, ...(piece.levels ?? [])];
    all.forEach((geometry, level) => {
      const m = level === 0 ? g : measureGeometry(geometry);
      if (level > 0) geometryBytes += m.bytes;
      levels[level] ??= { triangles: 0, vertices: 0 };
      levels[level]!.triangles += m.triangles * copies;
      levels[level]!.vertices += m.vertices * copies;
    });
    bones = Math.max(bones, piece.bones ?? 0);
    pieces.push({ label: `${piece.label}${copies > 1 ? ` x${copies}` : ''}`, triangles: g.triangles * copies, vertices: g.vertices * copies, bytes: g.bytes, material: ms.map(describe).join(' + ') });
    if (!g.released) {
      const first = materialsOf(piece.material)[0] ?? null;
      object.add(new Mesh(piece.geometry, sheetMaterial(first, piece.geometry)));
    }
  }
  if (spec.given) {
    triangles = spec.given.triangles; vertices = spec.given.vertices; geometryBytes = spec.given.bytes; released = spec.given.released;
    levels.push({ triangles, vertices });
  }
  // Lines and points draw no triangles: their segments or points said instead.
  const primitives = spec.build === 'lines' ? `${Math.floor(vertices / 2)} line segments` : spec.build === 'points' ? `${vertices} points` : '';
  if (primitives) {
    triangles = 0; hidden = null; solidCount = 0;
    for (const l of levels) l.triangles = 0;
  }
  const textureBytes = [...textures.values()].reduce((a, b) => a + b, 0);
  const extraBytes = spec.extraBytes ?? 0;
  const all = [...materials.values()];
  const shaders = [...new Set(all.map((m) => (m.shader === 'built-in' ? `three ${m.type}` : `${m.shader}${m.key ? ` ${m.key}` : ''}`)))];
  const floors = spec.floors ?? 0;
  const row: CatalogRow = {
    id, group: spec.group, name: spec.name, variation: spec.variation ?? '', origin: spec.origin, source: spec.source, build: spec.build,
    triangles, vertices, attributes: [...attributes.values()].join(' '), bytesPerVertex, geometryBytes, textureBytes, extraBytes,
    totalBytes: geometryBytes + textureBytes + extraBytes, materials: [...materials.keys()].join(' | '), shader: shaders.join(' | '),
    motion: shaderMotion(all, bones > 0, morphTargets), levels: levels.map((l, level) => ({ level, ...l })),
    solids: solidCount ? `${solidCount} solids: ${Object.entries(shapes).map(([s, n]) => `${n} ${s}`).join(', ')}` : '',
    hiddenTriangles: released ? null : hidden, shadow: spec.shadow ?? '', bones, morphTargets, morphBytes, released, floors,
    trianglesPerFloor: floors > 0 ? Math.round(triangles / floors) : 0, preview: spec.preview ?? false, effect: spec.effect ?? false, pieces,
    notes: [...(primitives ? [primitives] : []), ...(spec.notes ?? [])], countKey: spec.countKey ?? '', instances: 0, instancesFrom: '', totalTriangles: 0,
  };
  return { row, object };
}
