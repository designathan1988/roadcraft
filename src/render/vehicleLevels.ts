import { BufferAttribute, BufferGeometry, Float32BufferAttribute } from 'three';
import { mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier } from 'meshoptimizer';
import { ladderIndices } from './people/lodWorker';
import { lodPool } from './people/lodPool';

/** Errors of a vehicle part's coarser levels, in the part's own units (metres; a wheel's diameters), finest first. */
export const LEVEL_ERRORS = [0.0125, 0.025, 0.05, 0.1, 0.2, 0.4] as const;
/** A level is drawn only while its error on the screen is under this: the swap is not seen (meshoptimizer README, `ErrorAbsolute`). */
export const ERROR_PIXELS = 0.5;
/** Levels of a part: 0 is the model's own geometry, `i + 1` the one within `LEVEL_ERRORS[i]`. */
export const LEVELS = LEVEL_ERRORS.length + 1;
/** A coarser level that keeps more than this share of the finer one's triangles is the finer one again (no draw for nothing). */
const WORTH = 0.9;
/** Faces meeting at more than this keep a hard edge when a welded box assembly gets its normals back (`toCreasedNormals`). */
const CREASE = Math.PI / 4;

/** The coarsest level whose error stays under `ERROR_PIXELS` for a part drawn at `pixelsPerUnit` (pixels a unit of its own geometry). */
export function levelFor(pixelsPerUnit: number): number {
  let level = 0;
  while (level < LEVEL_ERRORS.length && LEVEL_ERRORS[level]! * pixelsPerUnit <= ERROR_PIXELS) level++;
  return level;
}

/** `smooth`: welded by position, normal and colour (a body, glass); `boxes`: by position and colour, normals creased again after (welded with its normals a box assembly is all locked corners, meshoptimizer README). */
export type Weld = 'smooth' | 'boxes';

/** The levels of `source` (0 is `source` itself; null: nothing left to draw at that level), simplified off the main thread. */
export async function partLevels(source: BufferGeometry, weld: Weld): Promise<(BufferGeometry | null)[]> {
  try {
    await MeshoptSimplifier.ready;
  } catch (error) {
    // Said, not swallowed: the part is then drawn whole at every size.
    console.error('[vehicles] meshoptimizer did not load; parts are drawn unsimplified', error);
    return [source];
  }
  const copy = source.clone();
  for (const name of Object.keys(copy.attributes)) {
    if (name !== 'position' && name !== 'color' && !(weld === 'smooth' && name === 'normal')) copy.deleteAttribute(name);
  }
  const count = copy.getAttribute('position').count;
  if (!copy.getAttribute('color')) copy.setAttribute('color', new Float32BufferAttribute(new Float32Array(count * 3).fill(1), 3));
  if (weld === 'smooth' && !copy.getAttribute('normal')) copy.computeVertexNormals();
  const welded = mergeVertices(copy, 1e-4);
  copy.dispose();
  const position = welded.getAttribute('position');
  const colour = welded.getAttribute('color');
  const normal = welded.getAttribute('normal');
  const stride = weld === 'smooth' ? 6 : 3;
  const attributes = new Float32Array(position.count * stride);
  for (let v = 0; v < position.count; v++) {
    attributes[v * stride] = colour.getX(v);
    attributes[v * stride + 1] = colour.getY(v);
    attributes[v * stride + 2] = colour.getZ(v);
    if (stride === 6) {
      attributes[v * 6 + 3] = normal.getX(v);
      attributes[v * 6 + 4] = normal.getY(v);
      attributes[v * 6 + 5] = normal.getZ(v);
    }
  }
  const request = {
    positions: new Float32Array(position.array as ArrayLike<number>),
    attributes,
    weights: new Array<number>(stride).fill(0.5),
    index: new Uint32Array(welded.getIndex()!.array as ArrayLike<number>),
    errors: [...LEVEL_ERRORS],
  };
  const pool = lodPool();
  const indices = pool ? await pool.ladder(request) : ladderIndices(request);
  const levels: (BufferGeometry | null)[] = [source];
  let finer = (source.index ? source.index.count : source.getAttribute('position').count) / 3;
  for (const index of indices) {
    const triangles = index.length / 3;
    const previous = levels[levels.length - 1]!;
    if (triangles === 0) { levels.push(null); continue; }
    if (previous && triangles > finer * WORTH) { levels.push(previous); continue; }
    const level = new BufferGeometry();
    level.setAttribute('position', position);
    level.setAttribute('color', colour);
    if (normal) level.setAttribute('normal', normal);
    level.setIndex(new BufferAttribute(index, 1));
    const drawn = weld === 'boxes' ? toCreasedNormals(level, CREASE) : level;
    drawn.computeBoundingSphere();
    levels.push(drawn);
    finer = triangles;
  }
  return levels;
}
