import { clamp } from '@core/scalar';
import type { Vec2 } from '@core/vec2';
import { MAP_SIZE } from '../bounds';
import { m } from '../units';
import type { CityPlan } from './plan';
import type { StreetEdge } from './streets';

/** DEBUG until the whole-map generator (rewrite F7): one generated city copied n × n over the map, the worst case to measure */

/** Longest stretch of a joining avenue between two nodes. */
const JOIN_STEP = m(160);
/** How close two border nodes must be across the gap to be joined (the copies are exact). */
const SAME_LINE = m(0.5);

/** The plan laid `perSide` × `perSide` times, one copy per square of the map, avenues joined across every gap. */
export function replicatePlan(plan: CityPlan, perSide: number): CityPlan {
  const spacing = MAP_SIZE / perSide;
  const half = (perSide - 1) / 2;
  const offsets: Vec2[] = [];
  for (let j = 0; j < perSide; j++) for (let i = 0; i < perSide; i++) offsets.push({ x: (i - half) * spacing, y: (j - half) * spacing });
  const { nodes, edges } = plan.graph;
  const count = nodes.length;
  const shift = (p: Vec2, o: Vec2): Vec2 => ({ x: p.x + o.x, y: p.y + o.y });
  const outNodes: Vec2[] = [];
  const outEdges: StreetEdge[] = [];
  offsets.forEach((o, t) => {
    for (const p of nodes) outNodes.push(shift(p, o));
    for (const e of edges) outEdges.push({ a: e.a + t * count, b: e.b + t * count, level: e.level, points: e.points.map((p) => shift(p, o)) });
  });
  // The border nodes an avenue leaves the city by, on each side: east/west matched by y, north/south by x.
  const avenueEnds = (axis: 'x' | 'y', side: 1 | -1): Map<number, number> => {
    const other = axis === 'x' ? 'y' : 'x';
    let edge = side > 0 ? -Infinity : Infinity;
    for (const p of nodes) edge = side > 0 ? Math.max(edge, p[axis]) : Math.min(edge, p[axis]);
    const out = new Map<number, number>();
    for (const e of edges) {
      if (e.level !== 0 || e.points.length) continue;
      for (const [end, from] of [[e.a, e.b], [e.b, e.a]] as const) {
        const p = nodes[end]!, q = nodes[from]!;
        // An avenue across the border line, not one running along it.
        if (Math.abs(p[axis] - edge) <= SAME_LINE && Math.abs(p[other] - q[other]) <= SAME_LINE) out.set(Math.round(p[other] / SAME_LINE), end);
      }
    }
    return out;
  };
  const join = (a: number, b: number): void => {
    const p = outNodes[a]!, q = outNodes[b]!;
    const steps = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / JOIN_STEP));
    const points = Array.from({ length: steps - 1 }, (_, k) => ({ x: p.x + ((q.x - p.x) * (k + 1)) / steps, y: p.y + ((q.y - p.y) * (k + 1)) / steps }));
    outEdges.push({ a, b, level: 0, points });
  };
  const east = avenueEnds('x', 1), west = avenueEnds('x', -1), north = avenueEnds('y', 1), south = avenueEnds('y', -1);
  for (let j = 0; j < perSide; j++) for (let i = 0; i < perSide; i++) {
    const t = j * perSide + i;
    if (i + 1 < perSide) for (const [key, end] of east) { const start = west.get(key); if (start !== undefined) join(t * count + end, (t + 1) * count + start); }
    if (j + 1 < perSide) for (const [key, end] of north) { const start = south.get(key); if (start !== undefined) join(t * count + end, (t + perSide) * count + start); }
  }
  // Each copy zoned as the city it copies: a point read in its own copy's frame.
  const tileOf = (p: Vec2): Vec2 => {
    const i = clamp(Math.round(p.x / spacing + half), 0, perSide - 1), j = clamp(Math.round(p.y / spacing + half), 0, perSide - 1);
    return offsets[j * perSide + i]!;
  };
  return {
    options: plan.options,
    field: plan.field,
    radius: plan.radius,
    centres: offsets.flatMap((o) => plan.centres.map((c) => shift(c, o))),
    graph: { nodes: outNodes, edges: outEdges },
    zoneAt: (p, onMain) => { const o = tileOf(p); return plan.zoneAt({ x: p.x - o.x, y: p.y - o.y }, onMain); },
  };
}
