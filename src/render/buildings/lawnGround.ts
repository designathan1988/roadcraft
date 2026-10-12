/**
 * The highest the drawn ground rises under a part laid on a lawn.
 *
 * The terrain is drawn as triangles over a square grid (`render/terrain.ts`
 * `sampleGrid`): flat on each, so over a part's footprint the ground is
 * highest at a corner of the footprint, at a corner of the grid inside it, or
 * where an edge of the footprint crosses an edge of a triangle - a line of the
 * grid or a cell's diagonal, either way (`gx`, `gy`, `gx - gy`, `gx + gy`
 * whole, in cells). Those few points are read, and the answer is exact. Four
 * corners and the centre were read before (Etapa 5b): a ridge of the mesh
 * under a part rose through it between them (Etapa 5a).
 */

/** The terrain grid the ground is drawn on: cell size and the half width (world units). */
export interface GroundLattice { readonly cell: number; readonly half: number }

export function highestGroundUnder(
  corners: readonly (readonly [number, number])[],
  groundAt: (x: number, y: number) => number,
  lattice: GroundLattice,
): number {
  const { cell, half } = lattice;
  // Grid coordinates as `sampleGrid` reads them: x from the west edge, y from the north.
  const gx = (x: number): number => (x + half) / cell;
  const gy = (y: number): number => (half - y) / cell;
  let best = -Infinity;
  const read = (x: number, y: number): void => { best = Math.max(best, groundAt(x, y)); };
  const families = [
    (x: number, _y: number): number => gx(x),
    (_x: number, y: number): number => gy(y),
    (x: number, y: number): number => gx(x) - gy(y),
    (x: number, y: number): number => gx(x) + gy(y),
  ];
  const n = corners.length;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = corners[i]!;
    const [bx, by] = corners[(i + 1) % n]!;
    read(ax, ay);
    x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, ax); y1 = Math.max(y1, ay);
    // Where this edge crosses an edge of a triangle.
    for (const f of families) {
      const fa = f(ax, ay), fb = f(bx, by);
      if (fa === fb) continue;
      const lo = Math.ceil(Math.min(fa, fb)), hi = Math.floor(Math.max(fa, fb));
      for (let k = lo; k <= hi; k++) {
        const t = (k - fa) / (fb - fa);
        read(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
  }
  // The grid's corners inside the footprint (a convex quad, wound either way).
  const inside = (x: number, y: number): boolean => {
    let sign = 0;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = corners[i]!;
      const [bx, by] = corners[(i + 1) % n]!;
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      if (cross === 0) continue;
      if (sign === 0) sign = Math.sign(cross);
      else if (Math.sign(cross) !== sign) return false;
    }
    return true;
  };
  for (let i = Math.ceil(gx(x0)); i <= Math.floor(gx(x1)); i++) {
    const x = -half + i * cell;
    for (let j = Math.ceil(gy(y1)); j <= Math.floor(gy(y0)); j++) {
      const y = half - j * cell;
      if (inside(x, y)) read(x, y);
    }
  }
  return best;
}
