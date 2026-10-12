import { InstancedMesh, Line, LineSegments, Mesh, Points, Vector3, type BufferGeometry, type Object3D } from 'three';
import { tileCellOf } from '@world/planet/atlas';

/**
 * PHANTOMS ACROSS THE ATLAS (the class of the "wire grown straight up" of
 * 2026-10-10, docs/PROBLEMAS.md PL2): on the planet every point is an address
 * in the atlas, a piece's centre plus a point of its own map
 * (`world/planet/atlas.ts`), and the picture bends each vertex onto the
 * sphere by the cell it falls in (`planet/bend.ts`). A triangle or a line
 * whose vertices lie in two cells of the atlas is not a short piece of ground
 * across a border but a phantom kilometres long through the sphere: its ends
 * were written on two pieces' maps and joined as they stood. Everything built
 * on one piece's map reaches at most `TILE_REACH` past its border, well inside
 * its cell, so no honest geometry crosses one.
 *
 * Counts, per named object under `root`, the triangles and line segments that
 * do (instanced parts are small and placed one by one: skipped, as are
 * points). For the F9 monitor (`main.ts`), in development, after a rebuild.
 */
export interface AtlasPhantom {
  readonly name: string;
  readonly count: number;
}

const a = new Vector3();
const b = new Vector3();
const c = new Vector3();

/** The atlas cell of a vertex of `geometry` (three's x, height, -y), moved by `object`'s world matrix. */
function cellOf(geometry: BufferGeometry, object: Object3D, i: number, out: Vector3): number {
  const position = geometry.getAttribute('position');
  out.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
  return tileCellOf(out.x, -out.z);
}

export function atlasPhantoms(root: Object3D): AtlasPhantom[] {
  const steps = atlasPhantomSteps(root);
  for (;;) { const step = steps.next(); if (step.done) return step.value; }
}

/** Primitives checked between two yields of `atlasPhantomSteps`. */
const STEP_PRIMITIVES = 4096;

/**
 * `atlasPhantoms` in small steps: it yields after each object and every
 * `STEP_PRIMITIVES` of a big one, so the caller can spread it over idle time
 * (MDN, Background Tasks API: work while `timeRemaining()` lasts, then ask
 * again). Done in one go, it held the frame after every road edit 81 ms on the
 * player's map (2026-10-11).
 */
export function* atlasPhantomSteps(root: Object3D): Generator<void, AtlasPhantom[], void> {
  const found = new Map<string, number>();
  root.updateMatrixWorld(true);
  const objects: Object3D[] = [];
  root.traverse((object) => { objects.push(object); });
  for (const object of objects) {
    if (object instanceof InstancedMesh || object instanceof Points) continue;
    const isLines = object instanceof Line;
    if (!(object instanceof Mesh) && !isLines) continue;
    const geometry = (object as Mesh | Line).geometry as BufferGeometry;
    const position = geometry.getAttribute('position');
    if (!position) continue;
    const index = geometry.getIndex();
    const at = (k: number): number => (index ? index.getX(k) : k);
    const total = index ? index.count : position.count;
    let count = 0;
    if (isLines) {
      // Pairs for LineSegments, a strip for a Line.
      const pairs = object instanceof LineSegments;
      for (let k = 0, n = 0; k + 1 < total; k += pairs ? 2 : 1) {
        if (cellOf(geometry, object, at(k), a) !== cellOf(geometry, object, at(k + 1), b)) count++;
        if (++n % STEP_PRIMITIVES === 0) yield;
      }
    } else {
      for (let k = 0, n = 0; k + 2 < total; k += 3) {
        const ca = cellOf(geometry, object, at(k), a);
        if (ca !== cellOf(geometry, object, at(k + 1), b) || ca !== cellOf(geometry, object, at(k + 2), c)) count++;
        if (++n % STEP_PRIMITIVES === 0) yield;
      }
    }
    if (count > 0) {
      const name = object.name || object.parent?.name || object.type;
      found.set(name, (found.get(name) ?? 0) + count);
    }
    yield;
  }
  return [...found].map(([name, count]) => ({ name, count }));
}
