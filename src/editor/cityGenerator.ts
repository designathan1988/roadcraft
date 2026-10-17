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
import { ribbonsNear } from './snap';
import { LEVEL_ROAD, type CityPlan } from '@world/cityGen/plan';

/** The city generator's hand on the map: the planned streets laid as roads */

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

/** The generated city's footways, 3 m */
const CITY_FOOTWAY = m(3);
/** The generated avenues' median, planted (a canteiro of 2 m: a tree pit with a kerb each side). */
const CITY_MEDIAN = m(2);
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

/** The generated city's green (V7): a square in each neighbourhood */
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
  // DO NOT add them one by one: 11,000 entries told every reader of the landscaping that everything changed.
  doc.addLandscapeMany(pieces.map((piece) => ({ kind: piece.kind, at: piece.at })));
  // Every street named (V8).
  doc.addLandscapeMany(nameFor(net, doc.segments.keys()).map((name) => ({ kind: 'streetname' as const, at: name.at, extra: { text: name.text } })));
  return { squares: squares.length, pieces: pieces.length };
}

/** Every lot zoned by its district */
export function zoneCity(doc: RoadDoc, net: Network, plan: CityPlan): number {
  const main = new Set(['avenue', 'urban'].map((id) => ROAD_TYPES.findIndex((t) => t.id === id)));
  const reach = m(22);
  // DO NOT gather every main road of the map and test each lot against all of them (lots × roads).
  const mainsNear = (p: Vec2): [Vec2, Vec2][] => {
    const out: [Vec2, Vec2][] = [];
    for (const { id } of ribbonsNear(net, [p.x - reach, p.y - reach, p.x + reach, p.y + reach])) {
      const s = doc.segment(id);
      if (!s || !main.has(s.type)) continue;
      const a = doc.nodes.get(s.a), b = doc.nodes.get(s.b);
      if (a && b) out.push([a, b]);
    }
    return out;
  };
  const groups = new Map<string, number[]>();
  for (const lot of doc.lots as readonly Lot[]) {
    const anchor = lotFrame(lot).anchor;
    const zone = plan.zoneAt(anchor, nearAny(anchor, mainsNear(anchor), reach));
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
