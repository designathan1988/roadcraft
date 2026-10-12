import type { FacePoint } from '@core/cubeSphere';
import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { chartAt, inChartInto, toOwnerInto } from '@world/planet/charts';
import type { TerrainStamp } from '@world/terrain';
import { m } from '@world/units';
import type { RoadPathPiece } from './roadPath';

/**
 * A ROAD EDIT WORKED OUT ON ONE CHART OF THE PLANET.
 *
 * Every point of the planet is written on the chart of the piece that owns
 * it (`world/planet/charts.ts`). A road drawn is worked out where it was
 * drawn: on the chart of the piece the gesture started on, which the gesture
 * was read on (`Viewport.holdChart`) and whose map goes on past its piece.
 * EVERY point of the working copy is brought onto that chart (`enterFrame`:
 * the same ground, other coordinates, no edit), the edit runs there with the
 * flat map's own code - crossings, splits, joins, heights, rules, price - and
 * every point is written back on its own piece's chart (`leaveFrame`), a node
 * the edit did not move getting its very coordinates back.
 *
 * Every point, not only those near the gesture: the flat code measures any
 * two points of the copy against each other (a road between two nodes, a
 * junction's legs, the price of every road), and two points written on two
 * different charts are ~30 km apart in the atlas when they are 500 m apart on
 * the sphere. Bringing only the roads round the gesture left a road with one
 * end brought and one not drawn straight across the atlas: a phantom tens of
 * km long that the gesture crossed - a junction with nothing, a crossing
 * refused as squeezed or overlapping, a price of hundreds of millions. It is
 * the rule PostGIS states for the same reason: an operation on two
 * geometries needs both in one spatial reference system, and geography's
 * planar operations (`ST_Buffer`) project ALL their input onto one plane,
 * work there and project back (https://postgis.net/docs/ST_Buffer.html).
 * Far from the chart's centre its map stretches, but every rule and price is
 * differential (`editRules.ts`, `economy.ts`): what the edit did not touch
 * reads the same before and after it.
 *
 * On the flat map nothing here is called.
 */

/**
 * The longest road left in one segment on the planet: a segment is drawn on
 * the chart halfway along it (`world/geometry.ts` `segmentChart`), and a short
 * one stays close to it. Applied to the roads an edit laid, once its crossings
 * are made (`commit.ts` `cutLongRoads`).
 */
export const PLANET_MAX_PIECE = m(80);

export interface EditFrame {
  readonly chart: number;
  /** Every node of the copy, and where it was written before. */
  readonly kept: ReadonlyMap<NodeId, Vec2>;
  /** The terrain stamps as they were written. */
  readonly stamps: readonly TerrainStamp[];
}

const q: FacePoint = { x: 0, y: 0 };

/** The chart a gesture is worked out on: the one its first point is written on. */
export const gestureChart = (pieces: readonly RoadPathPiece[]): number =>
  chartAt(pieces[0]?.start.at.x ?? 0, pieces[0]?.start.at.y ?? 0);

/**
 * Brings every point of the working copy `work` onto `chart`: every node and
 * every terrain stamp, so that no two points the edit measures against each
 * other are written on different charts.
 */
export function enterFrame(work: RoadDoc, chart: number): EditFrame {
  const kept = new Map<NodeId, Vec2>();
  for (const node of work.nodes.values()) {
    kept.set(node.id, { x: node.x, y: node.y });
    inChartInto(chart, node.x, node.y, q);
    work.recodeNode(node.id, { x: q.x, y: q.y });
  }
  const stamps = work.terrainStamps.map((s) => ({ ...s }));
  for (let i = 0; i < work.terrainStamps.length; i++) {
    const s = work.terrainStamps[i]!;
    inChartInto(chart, s.x, s.y, q);
    const at = { x: q.x, y: q.y };
    // Its noise's origin with it (`TerrainStamp.ox`), or the heights the edit reads are another hill's.
    if (s.ox !== undefined && s.oy !== undefined) {
      inChartInto(chart, s.ox, s.oy, q);
      work.terrainStamps[i] = { ...s, ...at, ox: q.x, oy: q.y };
    } else work.terrainStamps[i] = { ...s, ...at };
  }
  return { chart, kept, stamps };
}

/**
 * Writes every point of the working copy back on its own piece's chart: a
 * node the edit did not move gets its very coordinates back (so the edit
 * changes nothing it did not touch); one it moved, and every new one, is
 * written on the chart of the piece it now lies on. The terrain stamps as
 * they were.
 */
export function leaveFrame(work: RoadDoc, frame: EditFrame): void {
  for (const node of work.nodes.values()) {
    const was = frame.kept.get(node.id);
    if (was) {
      inChartInto(frame.chart, was.x, was.y, q);
      if (Math.abs(q.x - node.x) < 1e-6 && Math.abs(q.y - node.y) < 1e-6) {
        work.recodeNode(node.id, was);
        continue;
      }
    }
    toOwnerInto(frame.chart, node.x, node.y, q);
    work.recodeNode(node.id, { x: q.x, y: q.y });
  }
  work.terrainStamps.length = 0;
  work.terrainStamps.push(...frame.stamps.map((s) => ({ ...s })));
}

/** A ground sampler of the atlas read at points of `chart`'s map. */
export function groundOnChart(chart: number, ground: (x: number, y: number) => number): (x: number, y: number) => number {
  const p: FacePoint = { x: 0, y: 0 };
  return (x, y) => {
    toOwnerInto(chart, x, y, p);
    return ground(p.x, p.y);
  };
}

/** A point of `chart`'s map written on its own piece's chart (a gesture's preview drawn). */
export const ownPoint = (chart: number, p: Readonly<Vec2>): Vec2 => toOwnerInto(chart, p.x, p.y, { x: 0, y: 0 });
