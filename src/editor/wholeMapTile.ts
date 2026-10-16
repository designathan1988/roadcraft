import type { Vec2 } from '@core/vec2';
import { GROUND_ONLY, buildRoadElevation } from '@world/elevation';
import { applyLots, lotCentre, planLots } from '@world/lots';
import { Network } from '@world/network';
import { pavedHeightFrom } from '@world/paving';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { m } from '@world/units';
import type { BuildingId } from '@world/buildings/types';
import type { TilePiece } from '@world/cityGen/assemble';
import type { SerializedDoc } from '@world/doc';
import { type TilePlan, planTile } from '@world/cityGen/tile';
import { type WholeMapOptions, planWholeMap } from '@world/cityGen/wholeMap';
import { greenCity, layCity, widenCityFootways, zoneCity } from './cityGenerator';
import { LOT_PLAN_VERSION, growOnLot } from './zoning';

/** ONE TILE OF THE WHOLE MAP BUILT (`world/cityGen/tile.ts`), in a worker of the job pool (`cityTile.worker.ts`): the steps a generated city takes on the page (`main.ts` `generateCity`) - its roads, footways, lots, squares, power lines, furniture, names, zones and every building grown (`growOnLot`, as `growthReplica.ts` grows them) - taken here on the tile alone, on the flat ground a new map has. What the tile owns is handed back as a map's own records (`SerializedDoc`), ids its own; the page joins the tiles (`world/cityGen/assemble.ts`). A pure function of the options and the tile's place: the same tile comes out the same in any worker, at any time. */

/** The seed the buildings' streams are drawn from, as the page grows a city (`main.ts` `askCity`). */
const GROWTH_SEED = 0x5eed;

/** Where a lot's key says its land lies (`lots.ts` keys: `b:` a block's middle, `s:` a strip's, in steps of 4 m). */
function keyPlace(key: string): Vec2 | null {
  const [x, y] = key.slice(2).split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: x! * m(4), y: y! * m(4) } : null;
}

/** Builds tile (i, j) of the whole map. */
export function buildTile(options: WholeMapOptions, i: number, j: number): TilePiece {
  const started = performance.now();
  const tile = planTile(planWholeMap(options), i, j);
  const doc = layCity(tile.city);
  widenCityFootways(doc);
  const net = new Network(doc);
  net.rebuild();
  applyLots(doc, planLots(doc, net));
  // Only the tile's own lots: the land beyond its border avenues is its neighbours' to cut and build.
  const foreign = doc.lots.filter((l) => !tile.owns(lotCentre(l))).map((l) => l.id);
  if (foreign.length) doc.lotStore.apply({ remove: foreign }, 'lots of the next tile');
  greenCity(doc, net, tile.seed);
  // The roads as they stand for the zones (a rebuild finds what changed, nothing when nothing did).
  net.rebuild();
  zoneCity(doc, net, tile.city);
  // The flat ground of a new map, and the paving its streets lay on it (as the renderer reads it, `renderer.ts` `pavedHeightAt`).
  const ground = (): number => 0;
  const elevation = buildRoadElevation(net, ground);
  const pavedAt = (x: number, y: number): number => (elevation.has(GROUND_ONLY) ? pavedHeightFrom(elevation, GROUND_ONLY, (px, py) => footwayRiseAt(net, px, py), x, y) : NaN);
  const refused = new Set<number>();
  const open = doc.openLots.count(refused);
  for (let guard = 0; guard < open * 3 + 50; guard++) {
    const id = growOnLot({ doc, net, groundAt: ground, pavedAt }, refused, GROWTH_SEED);
    if (id !== null) {
      // Stamped as the page stamps a building grown (`main.ts` `growthAnswered`), at the city's first minute.
      const fresh = doc.buildings.get(id as BuildingId)!;
      doc.buildings.put({ ...fresh, builtAt: 0, decay: 0, lotPlan: LOT_PLAN_VERSION });
    } else if (doc.openLots.count(refused) === 0) break;
  }
  return pieceOf(tile, doc.toJSON(), performance.now() - started);
}

/** What of a tile's document is the tile's: its nodes and the border's (not the neighbours' gate pieces), the roads between them, and what stands on its own land. */
export function pieceOf(tile: TilePlan, data: SerializedDoc, ms: number): TilePiece {
  const kept = new Set<number>();
  const nodes = data.nodes.filter((n) => tile.keepsNode(n) && kept.add(n.id));
  const poles = (data.poles ?? []).filter((p) => tile.owns(p));
  const poleIds = new Set(poles.map((p) => p.id));
  return {
    i: tile.i, j: tile.j, nodes,
    segments: data.segments.filter((s) => kept.has(s.a) && kept.has(s.b)),
    lots: data.lots ?? [],
    lotKeys: (data.lotKeys ?? []).filter((key) => { const p = keyPlace(key); return p !== null && tile.owns(p); }),
    buildings: data.buildings ?? [],
    poles,
    poleSpans: (data.poleSpans ?? []).filter((s) => poleIds.has(s.a) && poleIds.has(s.b)),
    landscape: (data.landscape ?? []).filter((item) => tile.owns(item)),
    paint: (data.paint ?? []).filter((dab) => tile.owns(dab)),
    trees: (data.trees ?? []).filter((t) => tile.owns(t as Vec2)),
    ms,
  };
}
