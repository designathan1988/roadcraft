import type { Vec2 } from '@core/vec2';
import { GROUND_ONLY, buildRoadElevation } from '@world/elevation';
import { type Lot, applyLots, lotCentre, planLots } from '@world/lots';
import { Network } from '@world/network';
import { pavedHeightFrom } from '@world/paving';
import { movementKey } from '@world/roads/connectors';
import { footwayRiseAt } from '@world/roads/footwayRise';
import { OWNER, TILE_COUNTED, edgeNodeId, tileIdBase, tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';
import { type Building, type BuildingId, generatedBuiltAt } from '@world/buildings/types';
import { gatesOf } from '@world/parkingLayout';
import { asSegmentId } from '@world/ids';
import type { SerializedDoc } from '@world/doc';
import { type TilePlan, planTile } from '@world/cityGen/tile';
import { type WholeMapOptions, planWholeMap, tileOnMap } from '@world/cityGen/wholeMap';
import { greenCity, layCity, widenCityFootways, zoneCity } from './cityGenerator';
import { type GrownChoice, LOT_PLAN_VERSION, growOnLot } from '@world/growth/zoning';
import { packGrown } from '@world/growth/grownRows';

/** ONE TILE OF THE WORLD BUILT (`world/cityGen/tile.ts`), in a worker of the job pool (`cityTile.worker.ts`): the steps a generated city takes on the page (`main.ts` `generateCity`) - its roads, footways, lots, squares, power lines, furniture, names, zones and every building grown (`growOnLot`, as `growthReplica.ts` grows them) - taken here on the tile alone, on the flat ground a new map has. Handed back as the streamed world's tile (`buildStreamTile`, `world/tiles.ts`). A pure function of the options and the tile's place: the same tile comes out the same in any worker, at any time. */

/** The seed the buildings' streams are drawn from, as the page grows a city (`main.ts` `askCity`). */
const GROWTH_SEED = 0x5eed;

/** Where a lot's key says its land lies (`lots.ts` keys: `b:` a block's middle, `s:` a strip's, in steps of 4 m). */
function keyPlace(key: string): Vec2 | null {
  const [x, y] = key.slice(2).split(',').map(Number);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: x! * m(4), y: y! * m(4) } : null;
}

/** Tile (i, j) built whole: its plan, its document as a saved map holds it (ids the document's own; the neighbours' gate pieces and border corners in it too) and what makes each building grown again (`replayOnLot`, by the document's id), on the flat ground it was grown on. */
export function buildTileMap(options: WholeMapOptions, i: number, j: number): { tile: TilePlan; data: SerializedDoc; choices: Map<number, GrownChoice>; ms: number } {
  const started = performance.now();
  const tile = planTile(planWholeMap(options), i, j);
  const doc = layCity(tile.city);
  // Read once as text (`toJSON`) and thrown away: its buildings are not interned here (`BuildingStore.intern`), the tile's reader does.
  doc.buildings.intern = false;
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
  const choices = new Map<number, GrownChoice>();
  for (let guard = 0; guard < open * 3 + 50; guard++) {
    const choice: { value?: GrownChoice } = {};
    const id = growOnLot({ doc, net, groundAt: ground, pavedAt }, refused, GROWTH_SEED, choice);
    if (id !== null) {
      choices.set(id, choice.value!);
      // Stamped as the page stamps a building grown (`main.ts` `growthAnswered`), at the city's first minute.
      const fresh = doc.buildings.get(id as BuildingId)!;
      doc.buildings.put({ ...fresh, builtAt: 0, decay: 0, lotPlan: LOT_PLAN_VERSION });
    } else if (doc.openLots.count(refused) === 0) break;
  }
  return { tile, data: doc.toJSON(), choices, ms: performance.now() - started };
}

/** A tile with nothing on it: past the map's edge (`tileOnMap`). */
export function emptyTileRecords(key: number): TileRecords {
  const base = tileIdBase(key);
  return {
    key, version: 0, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
    landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

/** Builds tile (i, j) as the tile store keeps it (`tiles.ts` `TileRecords`): what it owns, ids in its own range, the buildings it grew as rows (`grown`); a tile past the map's edge is empty (`tileOnMap`: no road, no lot). */
export function buildStreamTile(options: WholeMapOptions, i: number, j: number): TileRecords {
  return buildStreamTilePair(options, i, j).records;
}

/** Tile (i, j) as stored (its grown buildings as rows) and whole (every building a record as it was just grown: for the write's bakes and the page, without making them again). */
export function buildStreamTilePair(options: WholeMapOptions, i: number, j: number): { readonly records: TileRecords; readonly full: TileRecords } {
  if (!tileOnMap(i, j)) {
    const empty = emptyTileRecords(tileKey(i, j));
    return { records: empty, full: empty };
  }
  const built = buildTileMap(options, i, j);
  return tileRecordsOf(tileKey(i, j), built.data, built.choices);
}

type NodeRecord = SerializedDoc['nodes'][number];
type Counted = keyof TileRecords['next'];

/** A tile's document made the tile store's record of tile `key` (`tiles.ts`): every record the tile OWNS (`OWNER`), the foreign ends of its roads as borrowed nodes, and every id remapped - a node on a tile edge to `edgeNodeId` (the neighbour that lays it names it alike), every other record to the tile's range counted per kind, and every reference with it. */
function tileRecordsOf(key: number, data: SerializedDoc, choices: ReadonlyMap<number, GrownChoice>): { readonly records: TileRecords; readonly full: TileRecords } {
  const base = tileIdBase(key);
  const counts: Record<Counted, number> = { node: 0, segment: 0, pole: 0, span: 0, building: 0, lot: 0, landscape: 0, barrier: 0 };
  const take = (kind: Counted): number => {
    if (counts[kind] >= TILE_COUNTED) throw new Error(`tile ${key}: more than ${TILE_COUNTED} ${kind} records`);
    return base + counts[kind]++;
  };
  const mine = (p: { readonly x: number; readonly y: number }): boolean => OWNER.at(p) === key;

  // ---- the nodes: an edge's by its place, the others counted; two nodes one edge id is two tiles disagreeing, never let through
  const nodeOf = new Map<number, NodeRecord>(data.nodes.map((n) => [n.id, n]));
  const nodeId = new Map<number, number>();
  const edgeOwner = new Map<number, number>();
  const name = (n: NodeRecord, own: boolean): number => {
    const had = nodeId.get(n.id);
    if (had !== undefined) return had;
    const edge = edgeNodeId(n.x, n.y);
    if (edge === null && !own) throw new Error(`tile ${key}: a road ends at (${n.x}, ${n.y}) in another tile off its edge`);
    if (edge !== null) {
      const other = edgeOwner.get(edge);
      if (other !== undefined && other !== n.id) throw new Error(`tile ${key}: two nodes on an edge at (${n.x}, ${n.y}) within a centimetre`);
      edgeOwner.set(edge, n.id);
    }
    const id = edge ?? take('node');
    nodeId.set(n.id, id);
    return id;
  };
  const ownedNodes = data.nodes.filter((n) => OWNER.node(n) === key);
  for (const n of ownedNodes) name(n, true);

  // ---- the roads by the middle of their ends; a foreign end kept as a borrowed node (always on an edge: the generator's roads cross tiles only at its gates)
  const segmentId = new Map<number, number>();
  const borrowed = new Map<number, NodeRecord>();
  const segments = data.segments.flatMap((s) => {
    const a = nodeOf.get(s.a), b = nodeOf.get(s.b);
    if (!a || !b || OWNER.segment(a, b) !== key) return [];
    for (const end of [a, b]) {
      if (OWNER.node(end) === key) continue;
      const id = name(end, false);
      // As the tile saw it: its place and height; the junction's rules are its own tile's to keep.
      if (!borrowed.has(id)) {
        borrowed.set(id, { id, x: end.x, y: end.y, ...(end.heightOffset !== undefined ? { heightOffset: end.heightOffset } : {}), ...(end.smooth !== undefined ? { smooth: end.smooth } : {}) });
      }
    }
    const id = take('segment');
    segmentId.set(s.id, id);
    return [{ ...s, id, a: nodeId.get(s.a)!, b: nodeId.get(s.b)! }];
  });

  // ---- a node's references to roads: the tile's own roads remapped, any other dropped (a neighbour's road has no id here)
  const seg = (old: number): number | undefined => segmentId.get(old);
  const nodes = ownedNodes.map((n): NodeRecord => {
    const { crossing, laneLinks, approachRules, uturn, blockedMovements, ...rest } = n;
    const out: NodeRecord = { ...rest, id: nodeId.get(n.id)! };
    if (blockedMovements) {
      out.blockedMovements = blockedMovements.flatMap((movement) => {
        const cut = movement.indexOf('>');
        const from = seg(Number(movement.slice(0, cut))), to = seg(Number(movement.slice(cut + 1)));
        return from !== undefined && to !== undefined ? [movementKey(asSegmentId(from), asSegmentId(to))] : [];
      });
    }
    const crossed = crossing ? seg(crossing.segment) : undefined;
    if (crossing && crossed !== undefined) out.crossing = { kind: crossing.kind, segment: crossed };
    if (laneLinks) {
      const links = laneLinks.flatMap((l) => {
        const from = seg(l.from), to = seg(l.to);
        return from !== undefined && to !== undefined ? [{ ...l, from, to }] : [];
      });
      if (links.length) out.laneLinks = links;
    }
    if (approachRules) {
      const rules = approachRules.flatMap((r) => { const s = seg(r.segment); return s !== undefined ? [{ ...r, segment: s }] : []; });
      if (rules.length) out.approachRules = rules;
    }
    const turned = uturn !== undefined ? seg(uturn) : undefined;
    if (turned !== undefined) out.uturn = turned;
    return out;
  });

  // ---- buildings by their anchor, then the lots (by their middle, as the tile cut them) naming them
  const buildingId = new Map<number, number>();
  /** Each building's choices (`GrownChoice`), by its id here. */
  const choiceOf = new Map<number, GrownChoice>();
  const buildings = (data.buildings ?? []).filter((b) => mine(b)).map((b) => {
    const id = take('building');
    buildingId.set(b.id, id);
    const choice = choices.get(b.id);
    if (choice) choiceOf.set(id, choice);
    // Built at a minute of its own (`generatedBuiltAt`), by its id in the tile, as a building made again from its row is.
    return { ...b, id, builtAt: generatedBuiltAt(id) };
  });
  const lots = (data.lots ?? []).filter((l) => mine(lotCentre(l))).map((l): Lot => {
    const { building: on, ...rest } = l;
    const id = take('lot');
    const stands = on !== undefined ? buildingId.get(on) : undefined;
    return stands !== undefined ? { ...rest, id, building: stands } : { ...rest, id };
  });

  // ---- the utility network: poles by their place; a span only between two of the tile's poles (a neighbour's pole has no id here)
  const poleId = new Map<number, number>();
  const poles = (data.poles ?? []).filter((p) => mine(p)).map((p) => {
    const id = take('pole');
    poleId.set(p.id, id);
    return { ...p, id };
  });
  const poleSpans = (data.poleSpans ?? []).flatMap((s) => {
    const a = poleId.get(s.a), b = poleId.get(s.b);
    return a !== undefined && b !== undefined ? [{ ...s, id: take('span'), a, b }] : [];
  });

  // ---- what stands on the land, by its anchor
  const landscape = (data.landscape ?? []).filter((item) => mine(item)).map((item) => ({ ...item, id: take('landscape') }));
  const barriers = (data.barriers ?? []).filter((w) => w.points.length > 0 && mine(w.points[0]!)).map((w) => ({ ...w, id: take('barrier') }));
  const placed = (item: unknown): boolean => mine(item as Vec2);

  // ---- the buildings it grew on its own lots kept as rows (`growth/rows.ts`), made again where they are read; any other building a record
  const lotOf = new Map<number, number>();
  for (const l of lots) if (l.building !== undefined) lotOf.set(l.building, l.id);
  const rows: { id: number; lot: number; choice: GrownChoice }[] = [];
  const records = buildings.filter((b) => {
    const choice = choiceOf.get(b.id), lot = lotOf.get(b.id);
    if (!choice || lot === undefined) return true;
    rows.push({ id: b.id, lot, choice });
    return false;
  });

  const next = {} as Record<Counted, number>;
  for (const kind of Object.keys(counts) as Counted[]) next[kind] = base + counts[kind];
  const full: TileRecords = {
    key, version: 1,
    nodes, borrowedNodes: [...borrowed.values()], segments,
    poles, borrowedPoles: [], poleSpans,
    buildings, lots,
    // What its streets' parking keeps clear of, kept with its roads (`TileRecords.gates`).
    gates: gatesOf(buildings as unknown as readonly Building[]),
    lotKeys: (data.lotKeys ?? []).filter((k) => { const p = keyPlace(k); return p !== null && mine(p); }),
    landscape, barriers,
    paint: (data.paint ?? []).filter((dab) => mine(dab)),
    trees: (data.trees ?? []).filter(placed),
    elements: (data.elements ?? []).filter(placed),
    next,
  };
  return { records: rows.length ? { ...full, buildings: records, grown: packGrown(rows) } : full, full };
}
