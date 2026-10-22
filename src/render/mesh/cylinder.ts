import { BufferAttribute, BufferGeometry, CylinderGeometry } from 'three';

/** A CYLINDER WITH ONLY THE CAPS THAT ARE EVER SEEN */

/** Which caps to keep: the top (+y) and the bottom (-y), as three's `CylinderGeometry` builds them. */
export interface Caps {
  readonly top: boolean;
  readonly bottom: boolean;
}

/** three r186 `CylinderGeometry`'s groups: the side is material 0, the top cap 1, the bottom cap 2. */
const SIDE = 0, TOP = 1, BOTTOM = 2;

/** `CylinderGeometry(radiusTop, radiusBottom, height, radialSegments)` with the caps `caps` leaves out removed, and their vertices with them:
 *  DO NOT draw a cap that stands buried, inside another solid or against a housing - a closed post was a quarter caps no one saw. */
export function cylinderWith(radiusTop: number, radiusBottom: number, height: number, radialSegments: number, caps: Caps): BufferGeometry {
  const full = new CylinderGeometry(radiusTop, radiusBottom, height, radialSegments);
  if (caps.top && caps.bottom) return full;
  const index = full.index!;
  const kept: number[] = [];
  for (const group of full.groups) {
    const material = group.materialIndex ?? SIDE;
    if (material === TOP && !caps.top) continue;
    if (material === BOTTOM && !caps.bottom) continue;
    for (let i = group.start; i < group.start + group.count; i++) kept.push(index.getX(i));
  }
  // The vertices the kept triangles use, renumbered in the order they were made.
  const remap = new Int32Array(full.getAttribute('position').count).fill(-1);
  let used = 0;
  for (const v of kept) if (remap[v] === -1) remap[v] = used++;
  const out = new BufferGeometry();
  for (const [name, attribute] of Object.entries(full.attributes)) {
    const size = attribute.itemSize;
    const array = new Float32Array(used * size);
    for (let v = 0; v < remap.length; v++) {
      const to = remap[v]!;
      if (to < 0) continue;
      for (let k = 0; k < size; k++) array[to * size + k] = attribute.array[v * size + k]!;
    }
    out.setAttribute(name, new BufferAttribute(array, size));
  }
  out.setIndex(kept.map((v) => remap[v]!));
  full.dispose();
  return out;
}
