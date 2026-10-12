import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import type { SegmentParking } from '@world/parking';
import { commitRoadPath } from './commit';
import { findAnchor, type Anchor } from './snap';

/**
 * Several blocks at once: a grid of streets laid in one gesture (the player's
 * order of 2026-10-05), as city builders' grid tools do. `cols` x `rows`
 * blocks of `blockMetres` between street centrelines, centred on a point and
 * turned by `angle`. Each street line is laid with the road tool's own commit
 * (`commitRoadPath`), the lines across joining the ones already laid at real
 * junctions, so the result is exactly what drawing the streets one by one
 * would give.
 */
export interface BlockGrid {
  readonly cols: number;
  readonly rows: number;
  /** Distance between street centrelines, metres (whole metres: the zoning subgrid). */
  readonly blockMetres: number;
  /** Turn of the grid, radians. */
  readonly angle: number;
}

/** The street lines of a grid, as pairs of world points. */
export function blockGridLines(centre: Vec2, grid: BlockGrid): [Vec2, Vec2][] {
  const step = m(Math.round(grid.blockMetres));
  const w = grid.cols * step, h = grid.rows * step;
  const c = Math.cos(grid.angle), s = Math.sin(grid.angle);
  const at = (u: number, v: number): Vec2 => ({ x: centre.x + u * c - v * s, y: centre.y + u * s + v * c });
  const lines: [Vec2, Vec2][] = [];
  for (let j = 0; j <= grid.rows; j++) lines.push([at(-w / 2, -h / 2 + j * step), at(w / 2, -h / 2 + j * step)]);
  for (let i = 0; i <= grid.cols; i++) lines.push([at(-w / 2 + i * step, -h / 2), at(-w / 2 + i * step, h / 2)]);
  return lines;
}

/**
 * Lays the grid into `doc` through the road tool's commit, line after line.
 * Returns how many lines were laid. `net` is rebuilt as it goes.
 */
export function commitBlockGrid(
  doc: RoadDoc, centre: Vec2, grid: BlockGrid, type: number, lanes: number | null, parking?: SegmentParking,
): number {
  let laid = 0;
  for (const [a, b] of blockGridLines(centre, grid)) {
    const net = new Network(doc);
    net.rebuild();
    // Ends join what is already there (an earlier line, an existing street).
    const anchor = (p: Vec2): Anchor => {
      const hit = findAnchor(doc, net, p, 4);
      return hit.kind === 'free' ? { kind: 'free', at: p } : hit;
    };
    const start = anchor(a), end = anchor(b);
    const result = commitRoadPath(doc, net, start, end, type,
      [{ start: { at: start.at, heightOffset: 0 }, end: { at: end.at, heightOffset: 0 }, curve: null }], lanes, parking);
    if (result.committed) laid++;
  }
  return laid;
}
