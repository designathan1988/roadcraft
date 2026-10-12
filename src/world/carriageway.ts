import type { Vec2 } from '@core/vec2';
import type { Polyline } from '@core/polyline';
import type { Network } from './network';
import { Level, halfWidth } from './roadTypes';
import { chartsReaching } from './planet/charts';
import { carryPolyline } from './geometry';
import { m } from './units';

/** Side of a cell of the carriageway index, world units. */
const CELL = m(25.6);

interface Lane {
  readonly centre: Polyline;
  readonly half: number;
}

/**
 * The asphalt centre lines of a network by grid cell: each one registered in
 * every cell a piece of it (grown by its half width) reaches, so a point need
 * only be tested against the lines of its own cell (Nystrom, "Spatial
 * Partition"). The plants, the stones and the planted trees ask this for tens
 * of thousands of points on every rebuild; each call used to walk every road.
 */
interface CarriagewayIndex {
  readonly revision: number;
  readonly cells: Map<number, Lane[]>;
}

const indexes = new WeakMap<Network, CarriagewayIndex>();

const cellKey = (ix: number, iy: number): number => ix * 100_003 + iy;

function indexOf(net: Network): CarriagewayIndex {
  const known = indexes.get(net);
  if (known && known.revision === net.revision) return known;
  const cells = new Map<number, Lane[]>();
  const file = (lane: Lane): void => {
    const points = lane.centre.toPoints();
    const seen = new Set<number>();
    const add = (minX: number, minY: number, maxX: number, maxY: number): void => {
      for (let ix = Math.floor(minX / CELL); ix <= Math.floor(maxX / CELL); ix++) {
        for (let iy = Math.floor(minY / CELL); iy <= Math.floor(maxY / CELL); iy++) {
          const key = cellKey(ix, iy);
          if (seen.has(key)) continue;
          seen.add(key);
          const list = cells.get(key);
          if (list) list.push(lane); else cells.set(key, [lane]);
        }
      }
    };
    const h = lane.half;
    if (points.length === 1) add(points[0]!.x - h, points[0]!.y - h, points[0]!.x + h, points[0]!.y + h);
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!;
      add(Math.min(a.x, b.x) - h, Math.min(a.y, b.y) - h, Math.max(a.x, b.x) + h, Math.max(a.y, b.y) + h);
    }
  };
  for (const ribbon of net.ribbons.values()) {
    const centre = ribbon.centre[Level.Asphalt];
    if (!centre) continue;
    const half = halfWidth(ribbon.road, Level.Asphalt);
    file({ centre, half });
    if (!__PLANET__) continue;
    // On the planet a road's ribbon is kept on its segment's chart, and a
    // point asked about is written on its own piece's - or on the chart a
    // gesture is read on, past that piece. Each road is filed as well on
    // every other chart whose kept ground its box can reach, carried there: a
    // ghost image, as molecular dynamics keeps the atoms near a boundary on
    // both sides of it, already at their image there (LAMMPS, "Communication",
    // doc.lammps.org/Developer_par_comm.html), so a query stays one cell's.
    const chart = net.polylines.chart(net.doc, ribbon.id);
    const bb = centre.bbox;
    const charts = chartsReaching(chart, bb.minX - half, bb.minY - half, bb.maxX + half, bb.maxY + half);
    for (const other of charts) if (other !== chart) file({ centre: carryPolyline(centre, chart, other), half });
  }
  const index = { revision: net.revision, cells };
  indexes.set(net, index);
  return index;
}

/** Whether a point is on the carriageway of a road of the network (kerb to kerb). */
export function onCarriageway(net: Network, p: Vec2): boolean {
  const lanes = indexOf(net).cells.get(cellKey(Math.floor(p.x / CELL), Math.floor(p.y / CELL)));
  if (!lanes) return false;
  for (const { centre, half } of lanes) {
    const bb = centre.bbox;
    if (p.x < bb.minX - half || p.x > bb.maxX + half || p.y < bb.minY - half || p.y > bb.maxY + half) continue;
    if (centre.closestPoint(p).distance < half) return true;
  }
  return false;
}
