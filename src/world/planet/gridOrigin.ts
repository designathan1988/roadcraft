import { PLANET_RADIUS, type Vec3 } from '@core/cubeSphere';
import { TILES_PER_SIDE, TILE_COUNT } from '@core/planetTiles';
import { m } from '../units';
import { tileCentre } from './atlas';
import { atlasToSphereInto } from './charts';

/**
 * WHERE THE PLANET'S LOCAL GRID HANGS (`charts.ts` setGridOrigin), chosen by
 * the map and the place looked at alone - never by the way the view came
 * there. As Medieval Engineers builds on its planets (developer diary 9,
 * 2016: a build's first block sets a local coordinate system, and what is
 * built near it snaps to the closest build's), a town keeps the origin it was
 * started on (`doc.gridOrigins`). Before anything is built, the grid hung
 * where the view had come in, and the town then started was saved on that:
 * the same place had another grid by another way in.
 *
 * Away from saved origins the grid hangs on one of a fixed set of points of
 * the sphere - the middle of every third piece each way of every cube face,
 * some 1.5 km apart, `GRID_CANDIDATES` - the one nearest the town in reach
 * (its nodes' mean) or, with none, nearest the view. Nearest by a margin:
 * the one held is kept until another is `GRID_SWITCH_MARGIN` nearer, so a
 * view resting on the line between two does not flick between them.
 */
export const GRID_CANDIDATES: readonly Readonly<{ x: number; y: number }>[] = Object.freeze(
  Array.from({ length: TILE_COUNT }, (_, t) => t).filter((t) => {
    const row = Math.floor((t % (TILES_PER_SIDE * TILES_PER_SIDE)) / TILES_PER_SIDE);
    const col = t % TILES_PER_SIDE;
    return row % 3 === 1 && col % 3 === 1;
  }).map((t) => Object.freeze({ x: tileCentre(t).x, y: tileCentre(t).y })),
);

/** How much nearer another candidate must be before the grid leaves the one it hangs on. */
export const GRID_SWITCH_MARGIN = m(50);

const a: Vec3 = { x: 0, y: 0, z: 0 };
const b: Vec3 = { x: 0, y: 0, z: 0 };

/** The distance along the ground between two atlas points. */
export function groundApart(p: { x: number; y: number }, q: { x: number; y: number }): number {
  atlasToSphereInto(p.x, p.y, a);
  atlasToSphereInto(q.x, q.y, b);
  // atan2 of the cross and the dot: exact near zero, where acos is not.
  const cx = a.y * b.z - a.z * b.y, cy = a.z * b.x - a.x * b.z, cz = a.x * b.y - a.y * b.x;
  return Math.atan2(Math.hypot(cx, cy, cz), a.x * b.x + a.y * b.y + a.z * b.z) * PLANET_RADIUS;
}

/** The candidate nearest a point (and how far). */
function nearestCandidate(p: { x: number; y: number }): { at: Readonly<{ x: number; y: number }>; apart: number } {
  let at = GRID_CANDIDATES[0]!, apart = Infinity;
  for (const c of GRID_CANDIDATES) {
    const d = groundApart(c, p);
    if (d < apart) { apart = d; at = c; }
  }
  return { at, apart };
}

export interface GridChoice {
  /** The origin the grid hangs on. */
  readonly origin: Readonly<{ x: number; y: number }>;
  /** A town in reach had none saved: this one, to save with the map once something is built there. */
  readonly town: boolean;
}

/**
 * The grid's origin for a view at `view`: a saved origin within `reach`;
 * else the candidate nearest the mean of the `nodes` within reach (a town
 * built before origins were kept); else the candidate nearest the view, the
 * one `held` kept while no other is `GRID_SWITCH_MARGIN` nearer.
 */
export function chooseGridOrigin(
  view: { x: number; y: number },
  saved: readonly { x: number; y: number }[],
  nodes: Iterable<{ x: number; y: number }>,
  held: { x: number; y: number } | null,
  reach: number,
): GridChoice {
  let best: { x: number; y: number } | null = null;
  let bestApart = reach;
  for (const o of saved) {
    const d = groundApart(o, view);
    if (d < bestApart) { bestApart = d; best = o; }
  }
  if (best) return { origin: best, town: false };
  // A town in reach: the mean of its nodes on the sphere.
  let sx = 0, sy = 0, sz = 0, count = 0;
  const s: Vec3 = { x: 0, y: 0, z: 0 };
  for (const n of nodes) {
    if (groundApart(n, view) >= reach) continue;
    atlasToSphereInto(n.x, n.y, s);
    sx += s.x; sy += s.y; sz += s.z; count++;
  }
  if (count > 0) {
    // The candidate nearest that direction.
    const l = Math.hypot(sx, sy, sz) || 1;
    let at = GRID_CANDIDATES[0]!, dot = -Infinity;
    for (const c of GRID_CANDIDATES) {
      atlasToSphereInto(c.x, c.y, s);
      const d = (s.x * sx + s.y * sy + s.z * sz) / l;
      if (d > dot) { dot = d; at = c; }
    }
    return { origin: at, town: true };
  }
  const near = nearestCandidate(view);
  if (held && GRID_CANDIDATES.includes(held) && groundApart(held, view) < near.apart + GRID_SWITCH_MARGIN) return { origin: held, town: false };
  return { origin: near.at, town: false };
}
