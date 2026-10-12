import { nameFor } from '@world/roads/streetNames';
import { layPowerLines } from './roads/powerLine';
import type { Vec2 } from '@core/vec2';
import { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { deleteLot } from '@world/lots';
import { planSquares } from '@world/cityGen/squares';
import { furnitureFor } from '@world/roads/furnitureSets';
import { roadProfile, sectionFromProfile } from '@world/roadTypes';
import { lotFrame, zoneLots, type Lot } from '@world/lots';
import { ROAD_TYPES } from '@world/roadTypes';
import { m } from '@world/units';
import { LEVEL_ROAD, type CityPlan } from '@world/cityGen/plan';

/**
 * The city generator's hand on the map: the planned streets laid as roads
 * (`world/cityGen/plan.ts`), and once the lots are cut (`world/lots.ts`),
 * each lot zoned for what its district is for. The buildings then grow on
 * the zoned lots as any zoned lot's do (`zoning.ts` `growOnLot`): a generated
 * city is an ordinary map, every road, lot and building of it editable.
 */

/** A new document with the plan's streets: a node at every crossing and bend, a road between. */
export function layCity(plan: CityPlan): RoadDoc {
  const doc = new RoadDoc();
  const types = LEVEL_ROAD.map((id) => Math.max(0, ROAD_TYPES.findIndex((t) => t.id === id)));
  const ids = plan.graph.nodes.map((p) => doc.addNode(p).id);
  for (const e of plan.graph.edges) {
    const chain = [ids[e.a]!, ...e.points.map((p) => doc.addNode(p).id), ids[e.b]!];
    for (let i = 0; i + 1 < chain.length; i++) doc.addSegment(chain[i]!, chain[i + 1]!, types[Math.min(e.level, types.length - 1)]!);
  }
  return doc;
}

/**
 * The generated city's footways, 3 m (docs/VIAS.md V7): wide enough for a
 * street tree's pit beside the kerb with the 1,20 m clear walk of NBR 9050
 * behind it (a 2 m footway takes no tree under that rule), and the avenues a
 * 2 m planted median. Before the lots
 * are cut, so they are cut against the wider street.
 */
export const CITY_FOOTWAY = m(3);
/** The generated avenues' median, planted (a canteiro of 2 m: a tree pit with a kerb each side). */
export const CITY_MEDIAN = m(2);
export function widenCityFootways(doc: RoadDoc): void {
  for (const s of [...doc.segments.values()]) {
    const rt = roadProfile(s.type, s.lanes, s.direction, s.section, s.parking);
    if (rt.id === 'highway' || rt.id === 'ramp') continue;
    // An avenue of four lanes gets a planted median between its directions.
    const median = rt.id === 'avenue' && s.direction === 'both' && rt.median < CITY_MEDIAN ? CITY_MEDIAN : rt.median;
    if (rt.sidewalk >= CITY_FOOTWAY && median === rt.median) continue;
    doc.setSegmentSection(s.id, { ...sectionFromProfile(rt), sidewalk: Math.max(rt.sidewalk, CITY_FOOTWAY), median });
  }
}

/**
 * The generated city's green (V7): a square in each neighbourhood
 * (`world/cityGen/squares.ts`, its lots taken away, its ground painted, its
 * trees planted) and every street's furniture: lamps, bins, benches,
 * hydrants - no street trees, on the footways or down the medians (the
 * player, 2026-10-09: "não gere ruas com árvores"). Returns how many squares
 * and pieces were laid.
 */
export function greenCity(doc: RoadDoc, net: Network, seed: number): { squares: number; pieces: number } {
  const squares = planSquares(doc, seed);
  for (const square of squares) {
    for (const id of square.lots) deleteLot(doc, id);
    for (const dab of square.dabs) doc.addPaintDab(dab);
    doc.plantTrees(square.trees);
  }
  if (net.revision !== doc.revision) net.rebuild();
  // The power lines first (their poles lit), the furniture round them.
  const power = layPowerLines(doc, net, doc.segments.keys()) > 0;
  const pieces = furnitureFor(net, doc.segments.keys(), 'complete', doc.landscape.values(), power, false);
  for (const piece of pieces) doc.addLandscape(piece.kind, piece.at);
  // Every street named (V8).
  for (const name of nameFor(net, doc.segments.keys())) doc.addLandscape('streetname', name.at, { text: name.text });
  return { squares: squares.length, pieces: pieces.length };
}

/**
 * Every lot zoned by its district: commerce where its front is on an avenue
 * or a collector and the district is lively enough, parks left open. Returns
 * how many lots were zoned.
 */
/**
 * `toPlan`: a point of the document in the plan's own coordinates (on the
 * planet the city is laid about the place looked at, each point kept on its
 * piece's chart, and read back on one chart here; the identity on the flat
 * map). The plan's zones and the nearness to a main road are both read there.
 */
export function zoneCity(doc: RoadDoc, plan: CityPlan, toPlan: (p: Vec2) => Vec2 = (p) => p): number {
  const main = new Set(['avenue', 'urban'].map((id) => ROAD_TYPES.findIndex((t) => t.id === id)));
  const mains: [Vec2, Vec2][] = [];
  for (const s of doc.segments.values()) {
    if (!main.has(s.type)) continue;
    const a = doc.nodes.get(s.a), b = doc.nodes.get(s.b);
    if (a && b) mains.push([toPlan(a), toPlan(b)]);
  }
  const groups = new Map<string, number[]>();
  for (const lot of doc.lots as readonly Lot[]) {
    const anchor = toPlan(lotFrame(lot).anchor);
    const zone = plan.zoneAt(anchor, nearAny(anchor, mains, m(22)));
    if (zone === 'park') continue;
    const key = `${zone.use}:${zone.density}`;
    let list = groups.get(key);
    if (!list) groups.set(key, list = []);
    list.push(lot.id);
  }
  let zoned = 0;
  for (const [key, ids] of groups) {
    const [use, density] = key.split(':') as [Lot['use'] & string, Lot['density'] & string];
    if (zoneLots(doc, ids, { use, density })) zoned += ids.length;
  }
  return zoned;
}

function nearAny(p: Vec2, segs: readonly [Vec2, Vec2][], d: number): boolean {
  for (const [a, b] of segs) {
    const ex = b.x - a.x, ey = b.y - a.y, l2 = ex * ex + ey * ey;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.y - a.y) * ey) / l2)) : 0;
    if (Math.hypot(a.x + ex * t - p.x, a.y + ey * t - p.y) < d) return true;
  }
  return false;
}
