import { BufferAttribute, BufferGeometry, Float32BufferAttribute, type InterleavedBufferAttribute, type TypedArray } from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { weldGeometry } from './mesh/weld';
import { MeshoptSimplifier } from 'meshoptimizer';

/** One welded mesh simplified once per error: its positions, its other attributes interleaved (`weights` a float each), its index. */
interface Ladder { readonly positions: Float32Array; readonly attributes: Float32Array; readonly weights: readonly number[]; readonly index: Uint32Array; readonly errors: readonly number[] }

/** `index` simplified to the fewest triangles each error allows (meshoptimizer README: `ErrorAbsolute`, `Prune`), finest first. */
export function ladderIndices(req: Ladder): Uint32Array[] {
  const stride = req.weights.length;
  return req.errors.map((error) => MeshoptSimplifier.simplifyWithAttributes(req.index, req.positions, 3, req.attributes, stride,
    [...req.weights], null, 3, error, ['ErrorAbsolute', 'Prune'])[0]);
}

/** A VEHICLE PART'S LEVELS AS ARRAYS (`vehicleLevels.ts`): welded, simplified once per error and, for box assemblies, their normals creased again; all of it in the levels' worker (`people/lodWorker.ts` 'part') */
/** DO NOT weld a part's vertices on the page (`mergeVertices`, `toCreasedNormals`: every vertex of every part of every vehicle while the map opens). */

/** Errors of a vehicle part's coarser levels, in the part's own units (metres; a wheel's diameters), finest first. */
export const LEVEL_ERRORS = [0.0125, 0.025, 0.05, 0.1, 0.2, 0.4] as const;
/** A coarser level that keeps more than this share of the finer one's triangles is the finer one again (no draw for nothing). */
const WORTH = 0.9;
/** Faces meeting at more than this keep a hard edge when a welded box assembly gets its normals back (`toCreasedNormals`). */
const CREASE = Math.PI / 4;

/** `smooth`: welded by position, normal and colour (a body, glass); `boxes`: by position and colour, normals creased again after (welded with its normals a box assembly is all locked corners, meshoptimizer README). */
export type Weld = 'smooth' | 'boxes';

/** One attribute's numbers, as a geometry holds them. */
export interface ArrayOf { readonly array: TypedArray; readonly itemSize: number; readonly normalized: boolean }

/** A part as the page sends it: its position, colour and normal (where it has them) and its index. */
export interface PartArrays {
  readonly position: ArrayOf;
  readonly color: ArrayOf | null;
  readonly normal: ArrayOf | null;
  readonly index: Uint32Array | Uint16Array | null;
}

/** A level: the finer one again (`same`), nothing to draw (null), or its own attributes (none: the welded ones, `shared`), index and bounding sphere. */
export type LevelArrays = 'same' | null | {
  readonly position?: ArrayOf; readonly color?: ArrayOf; readonly normal?: ArrayOf;
  readonly index: Uint32Array | null; readonly sphere: readonly number[];
};

/** Levels 1.. of a part, and the welded attributes its smooth levels share. */
export interface PartLevels { readonly shared: { position: ArrayOf; color: ArrayOf; normal: ArrayOf | null } | null; readonly levels: LevelArrays[] }

/** An attribute's numbers as sent. */
const arrayOf = (a: BufferAttribute | InterleavedBufferAttribute): ArrayOf => ({ array: (a as BufferAttribute).array, itemSize: a.itemSize, normalized: a.normalized });
const attributeOf = (a: ArrayOf): BufferAttribute => new BufferAttribute(a.array, a.itemSize, a.normalized);

/** A part's coarser levels from its arrays: what `partLevels` made on the page, made here. */
export function partLevelArrays(part: PartArrays, weld: Weld): PartLevels {
  const copy = new BufferGeometry();
  copy.setAttribute('position', attributeOf(part.position));
  if (part.color) copy.setAttribute('color', attributeOf(part.color));
  if (weld === 'smooth' && part.normal) copy.setAttribute('normal', attributeOf(part.normal));
  if (part.index) copy.setIndex(new BufferAttribute(part.index, 1));
  const count = copy.getAttribute('position').count;
  if (!copy.getAttribute('color')) copy.setAttribute('color', new Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  if (weld === 'smooth' && !copy.getAttribute('normal')) copy.computeVertexNormals();
  const welded = weldGeometry(copy, 1e-4);
  const position = welded.getAttribute('position') as BufferAttribute;
  const colour = welded.getAttribute('color') as BufferAttribute;
  const normal = welded.getAttribute('normal') as BufferAttribute | undefined;
  const stride = weld === 'smooth' ? 6 : 3;
  const attributes = new Float32Array(position.count * stride);
  for (let v = 0; v < position.count; v++) {
    attributes[v * stride] = colour.getX(v);
    attributes[v * stride + 1] = colour.getY(v);
    attributes[v * stride + 2] = colour.getZ(v);
    if (stride === 6) {
      attributes[v * 6 + 3] = normal!.getX(v);
      attributes[v * 6 + 4] = normal!.getY(v);
      attributes[v * 6 + 5] = normal!.getZ(v);
    }
  }
  const indices = ladderIndices({
    positions: new Float32Array(position.array as ArrayLike<number>),
    attributes,
    weights: new Array<number>(stride).fill(0.5),
    index: new Uint32Array(welded.getIndex()!.array as ArrayLike<number>),
    errors: [...LEVEL_ERRORS],
  });
  const levels: LevelArrays[] = [];
  let finer = (part.index ? part.index.length : count) / 3;
  let drawnBefore = true;
  for (const index of indices) {
    const triangles = index.length / 3;
    if (triangles === 0) { levels.push(null); drawnBefore = false; continue; }
    if (drawnBefore && triangles > finer * WORTH) { levels.push('same'); continue; }
    const level = new BufferGeometry();
    level.setAttribute('position', position);
    level.setAttribute('color', colour);
    if (normal) level.setAttribute('normal', normal);
    level.setIndex(new BufferAttribute(index, 1));
    const drawn = weld === 'boxes' ? toCreasedNormals(level, CREASE) : level;
    drawn.computeBoundingSphere();
    const s = drawn.boundingSphere!;
    const sphere = [s.center.x, s.center.y, s.center.z, s.radius];
    if (weld === 'boxes') {
      levels.push({ position: arrayOf(drawn.getAttribute('position')), color: arrayOf(drawn.getAttribute('color')), normal: arrayOf(drawn.getAttribute('normal')), index: null, sphere });
    } else levels.push({ index, sphere });
    drawnBefore = true;
    finer = triangles;
  }
  const shared = weld === 'smooth' ? { position: arrayOf(position), color: arrayOf(colour), normal: normal ? arrayOf(normal) : null } : null;
  return { shared, levels };
}

/** The buffers a part's levels hold, to be moved to the page. */
export function levelBuffers(made: PartLevels): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  for (const a of [made.shared?.position, made.shared?.color, made.shared?.normal]) if (a) out.add(a.array.buffer as ArrayBuffer);
  for (const l of made.levels) {
    if (!l || l === 'same') continue;
    for (const a of [l.position, l.color, l.normal]) if (a) out.add(a.array.buffer as ArrayBuffer);
    if (l.index) out.add(l.index.buffer as ArrayBuffer);
  }
  return [...out];
}
