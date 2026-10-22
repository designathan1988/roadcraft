import { Box3, BufferAttribute, type BufferGeometry, Vector3 } from 'three';

/** THE FACES OF A MODEL'S PARTS NO ONE CAN SEE, TAKEN OUT BEFORE THE PARTS ARE MERGED */

/** How far out of a face it is looked at to tell whether another part covers it: deeper than float noise, thinner than any gap drawn (6 mm between books). */
const COVER_PROBE = 0.002;

/** Whether `g` is a box standing square to the axes (three's BoxGeometry: six faces of four corners, each facing an axis), and so a solid a face can lie in. */
function axisBox(g: BufferGeometry): boolean {
  if (g.groups.length !== 6 || g.getAttribute('position').count !== 24) return false;
  const normal = g.getAttribute('normal');
  for (let i = 0; i < normal.count; i++) {
    const a = Math.abs(normal.getX(i)), b = Math.abs(normal.getY(i)), c = Math.abs(normal.getZ(i));
    if (Math.max(a, b, c) < 0.9999) return false;
  }
  return true;
}

/** The faces of the parts no one can see taken out: one lying on the floor facing down, or one whose every point, `COVER_PROBE` out of it, is inside
 *  another part's box (a book's bottom on its shelf, a tread inside the next, a leg's ends in the floor and in the top). A face only partly
 *  covered is kept whole. DO NOT keep them: they are drawn and cast for every instance of the model. */
export function dropHiddenFaces(parts: readonly BufferGeometry[]): void {
  const solids: { part: BufferGeometry; box: Box3 }[] = [];
  for (const part of parts) {
    if (!axisBox(part)) continue;
    part.computeBoundingBox();
    solids.push({ part, box: part.boundingBox!.clone() });
  }
  const at = new Vector3(), a = new Vector3(), b = new Vector3(), c = new Vector3(), n = new Vector3(), centre = new Vector3();
  const covered = (self: BufferGeometry, p: Vector3): boolean => {
    for (const s of solids) if (s.part !== self && s.box.containsPoint(p)) return true;
    return false;
  };
  for (const part of parts) {
    const index = part.index;
    if (!index || !part.groups.length) continue;
    const position = part.getAttribute('position');
    const kept: number[] = [];
    let dropped = false;
    for (const group of part.groups) {
      const end = group.start + group.count;
      // A flat face: every triangle facing the first's way (a cylinder's side is not one, and is kept).
      a.fromBufferAttribute(position, index.getX(group.start));
      b.fromBufferAttribute(position, index.getX(group.start + 1));
      c.fromBufferAttribute(position, index.getX(group.start + 2));
      n.subVectors(c, b).cross(at.subVectors(a, b)).normalize();
      let flat = n.lengthSq() > 0.5;
      let lowest = Infinity;
      for (let i = group.start; flat && i < end; i += 3) {
        a.fromBufferAttribute(position, index.getX(i));
        b.fromBufferAttribute(position, index.getX(i + 1));
        c.fromBufferAttribute(position, index.getX(i + 2));
        flat = at.subVectors(c, b).cross(centre.subVectors(a, b)).normalize().dot(n) > 0.9999;
        lowest = Math.min(lowest, a.y, b.y, c.y);
      }
      let hidden = false;
      if (flat) {
        const onFloor = n.y < -0.9999 && lowest <= 1e-4;
        hidden = onFloor;
        if (!hidden) {
          // Each triangle's corners drawn in a little towards its middle, its middle, its edges' middles: all must be inside another part.
          hidden = true;
          for (let i = group.start; hidden && i < end; i += 3) {
            a.fromBufferAttribute(position, index.getX(i));
            b.fromBufferAttribute(position, index.getX(i + 1));
            c.fromBufferAttribute(position, index.getX(i + 2));
            centre.copy(a).add(b).add(c).divideScalar(3);
            for (const [p, q, w] of [[a, a, 0.98], [b, b, 0.98], [c, c, 0.98], [a, b, 0.98], [b, c, 0.98], [c, a, 0.98], [centre, centre, 0]] as const) {
              at.copy(p).add(q).multiplyScalar(0.5).lerp(centre, 1 - w).addScaledVector(n, COVER_PROBE);
              if (!covered(part, at)) { hidden = false; break; }
            }
          }
        }
      }
      if (hidden) { dropped = true; continue; }
      for (let i = group.start; i < end; i++) kept.push(index.getX(i));
    }
    if (!dropped) continue;
    // Only the corners the kept faces use, renumbered in their order.
    const remap = new Int32Array(position.count).fill(-1);
    let used = 0;
    for (const v of kept) if (remap[v] === -1) remap[v] = used++;
    for (const [name, attribute] of Object.entries(part.attributes)) {
      const size = attribute.itemSize;
      const array = new Float32Array(used * size);
      for (let v = 0; v < remap.length; v++) {
        const to = remap[v]!;
        if (to >= 0) for (let k = 0; k < size; k++) array[to * size + k] = attribute.array[v * size + k]!;
      }
      part.setAttribute(name, new BufferAttribute(array, size, attribute.normalized));
    }
    part.setIndex(kept.map((v) => remap[v]!));
    part.clearGroups();
  }
}
