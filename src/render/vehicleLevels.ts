import { BufferAttribute, BufferGeometry, Sphere, Vector3 } from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { VEHICLE_ERROR_PIXELS } from './quality';
import { lodPool } from './people/lodPool';
import { LEVEL_ERRORS, partLevelArrays, type ArrayOf, type PartArrays, type PartLevels, type Weld } from './partLevelsWork';

/** An attribute from the numbers sent back. */
const attributeOf = (a: ArrayOf): BufferAttribute => new BufferAttribute(a.array, a.itemSize, a.normalized);

export { LEVEL_ERRORS, type Weld } from './partLevelsWork';
/** A level is drawn only while its error on the screen is under this: the swap is not seen (meshoptimizer README, `ErrorAbsolute`). */
export const ERROR_PIXELS = VEHICLE_ERROR_PIXELS;
/** Levels of a part: 0 is the model's own geometry, `i + 1` the one within `LEVEL_ERRORS[i]`. */
export const LEVELS = LEVEL_ERRORS.length + 1;
/** A coarser level is a draw of its own only where it sheds at least this many triangles a vehicle: each level is a draw for every body
 *  style (glass, trim and cabin at a street's distances), and a few triangles a car never paid for one. A car's glazing went 1008, 42, 24,
 *  14, 8, 2: five draws for 40 triangles (2026-10-20). The finer level is drawn instead, never a worse shape. */
export const SHED = 64;

const trianglesOf = (g: BufferGeometry): number => (g.index ? g.index.count : g.getAttribute('position').count) / 3;

/** The coarsest level whose error stays under `ERROR_PIXELS` for a part drawn at `pixelsPerUnit` (pixels a unit of its own geometry). */
export function levelFor(pixelsPerUnit: number): number {
  let level = 0;
  while (level < LEVEL_ERRORS.length && LEVEL_ERRORS[level]! * pixelsPerUnit <= ERROR_PIXELS) level++;
  return level;
}

/** A copy of an attribute's numbers, to be moved to the worker (the part keeps its own). */
const copyOf = (geometry: BufferGeometry, name: string): ArrayOf | null => {
  const a = geometry.getAttribute(name) as BufferAttribute | undefined;
  return a ? { array: a.array.slice(), itemSize: a.itemSize, normalized: a.normalized } : null;
};

/** The levels of `source` (0 is `source` itself; null: nothing left to draw at that level): welded, simplified and creased in the levels' worker (`partLevelsWork.ts`), the page only putting the geometries together.
 *  `copies`: how many a vehicle draws (a car's four tyres), for what a level sheds a vehicle (`SHED`). */
export async function partLevels(source: BufferGeometry, weld: Weld, copies = 1): Promise<(BufferGeometry | null)[]> {
  try {
    await MeshoptSimplifier.ready;
  } catch (error) {
    // Said, not swallowed: the part is then drawn whole at every size.
    console.error('[vehicles] meshoptimizer did not load; parts are drawn unsimplified', error);
    return [source];
  }
  const index = source.getIndex();
  const part: PartArrays = {
    position: copyOf(source, 'position')!, color: copyOf(source, 'color'), normal: copyOf(source, 'normal'),
    index: index ? (index.array as Uint32Array | Uint16Array).slice() : null,
  };
  const pool = lodPool();
  const made: PartLevels = pool ? await pool.part(part, weld) : partLevelArrays(part, weld);
  const shared = made.shared ? {
    position: attributeOf(made.shared.position), color: attributeOf(made.shared.color), normal: made.shared.normal ? attributeOf(made.shared.normal) : null,
  } : null;
  const levels: (BufferGeometry | null)[] = [source];
  for (const l of made.levels) {
    if (l === 'same') { levels.push(levels[levels.length - 1]!); continue; }
    if (l === null) { levels.push(null); continue; }
    const level = new BufferGeometry();
    if (l.position) {
      level.setAttribute('position', attributeOf(l.position));
      level.setAttribute('color', attributeOf(l.color!));
      level.setAttribute('normal', attributeOf(l.normal!));
    } else if (shared) {
      level.setAttribute('position', shared.position);
      level.setAttribute('color', shared.color);
      if (shared.normal) level.setAttribute('normal', shared.normal);
    }
    if (l.index) level.setIndex(new BufferAttribute(l.index, 1));
    level.boundingSphere = new Sphere(new Vector3(l.sphere[0], l.sphere[1], l.sphere[2]), l.sphere[3]);
    levels.push(level);
  }
  // A level that sheds too little a vehicle is the finer one again: one draw fewer for every body style.
  let finer = trianglesOf(source);
  for (let k = 1; k < levels.length; k++) {
    const level = levels[k], before = levels[k - 1];
    if (!level || level === before) continue;
    if (before && (finer - trianglesOf(level)) * copies < SHED) { levels[k] = before; continue; }
    finer = trianglesOf(level);
  }
  return levels;
}
