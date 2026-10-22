import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { TILE, edgeNodeId, tileIdBase, tileKey } from '@world/tiles';
import type { TileRecords } from '@world/doc';
import { m } from '@world/units';
import { SimWorld } from '@sim/world';
import { Meso } from '@sim/meso/meso';
import { type TileLinks, bakeTileLinks, linkId } from '@sim/meso/tileLinks';

/** THE FAR TILES' LINK TABLES: baked from a tile's records as the meso reads the same tile's lane graph, joined to their neighbours at the edge nodes, handed to and from the lane graph without losing a vehicle */

type Node = TileRecords['nodes'][number];
type Segment = TileRecords['segments'][number];

/** A tile's records with these roads (urban, two-way). */
function records(i: number, j: number, nodes: Node[], borrowedNodes: Node[], segments: Segment[]): TileRecords {
  const key = tileKey(i, j), base = tileIdBase(key);
  return {
    key, version: 1, nodes, borrowedNodes, segments, poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [], lotKeys: [],
    landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base + 100, segment: base + 2000, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}
const road = (id: number, a: number, b: number): Segment => ({ id, a, b, type: 1, curve: null });

/** The node on tile (0, 0)'s east edge at y = 500 m: tile (1, 0)'s (a point on an edge is the tile's whose low edge it is). */
const EAST = edgeNodeId(TILE, m(500))!;
/** The node on tile (0, 0)'s south edge at x = 500 m: its own. */
const SOUTH = edgeNodeId(m(500), 0)!;

/** Tile (0, 0): a 3 x 3 grid of streets 300 m apart, a street out of each of two edges. */
function west(): TileRecords {
  const base = tileIdBase(tileKey(0, 0));
  const nodes: Node[] = [];
  const at = (gx: number, gy: number): number => base + gx * 3 + gy;
  for (let gx = 0; gx < 3; gx++) for (let gy = 0; gy < 3; gy++) nodes.push({ id: at(gx, gy), x: m(200 + 300 * gx), y: m(200 + 300 * gy) });
  nodes.push({ id: SOUTH, x: m(500), y: 0 });
  const segments: Segment[] = [];
  let s = base + 1000;
  for (let gx = 0; gx < 3; gx++) {
    for (let gy = 0; gy < 3; gy++) {
      if (gx < 2) segments.push(road(s++, at(gx, gy), at(gx + 1, gy)));
      if (gy < 2) segments.push(road(s++, at(gx, gy), at(gx, gy + 1)));
    }
  }
  segments.push(road(s++, at(2, 1), EAST));
  segments.push(road(s++, at(1, 0), SOUTH));
  return records(0, 0, nodes, [{ id: EAST, x: TILE, y: m(500) }], segments);
}

/** Tile (1, 0): the street from the west tile's east edge on to a dead end 300 m further. */
function east(): TileRecords {
  const base = tileIdBase(tileKey(1, 0));
  return records(1, 0, [{ id: EAST, x: TILE, y: m(500) }, { id: base, x: TILE + m(300), y: m(500) }], [], [road(base + 1000, EAST, base)]);
}

/** The simulation over a document holding `tiles`, its lane graph built. */
function world(...tiles: TileRecords[]): { doc: RoadDoc; net: Network; w: SimWorld; meso: Meso } {
  const doc = new RoadDoc();
  for (const t of tiles) doc.loadTile(t);
  const net = new Network(doc);
  net.rebuild();
  const w = new SimWorld(doc, net, 0x7117);
  w.rebuildTopology();
  const meso = new Meso();
  w.meso = meso;
  return { doc, net, w, meso };
}

/** The links a table's link `k` turns onto. */
const tableTurns = (t: TileLinks, k: number): number[] => {
  const out: number[] = [];
  for (let n = t.turnStart[k]!; n < t.turnStart[k + 1]!; n++) out.push(t.link[t.turnTo[n]!]!);
  return out.sort((a, b) => a - b);
};

describe('a tile\'s link table', () => {
  it('matches the links the meso builds from the same tile\'s lane graph', () => {
    const tile = west();
    const table = bakeTileLinks(tile);
    const { w, meso } = world(tile);
    meso.step(w, true);
    let present = 0;
    for (let slot = 0; slot < meso.model.slots; slot++) if (meso.model.has(slot)) present++;
    // 12 grid streets and 2 out of the tile, both ways.
    expect(table.count).toBe(28);
    expect(present).toBe(table.count);
    const degree = new Map<number, number>();
    table.nodes.forEach((id, k) => degree.set(id, table.nodeDegree[k]!));
    for (let k = 0; k < table.count; k++) {
      const slot = meso.slotOfLink(table.link[k]!);
      expect(slot, `link ${table.link[k]}`).toBeDefined();
      expect(meso.model.lanesAt(slot!)).toBe(table.lanes[k]);
      expect(meso.model.freeSpeedAt(slot!)).toBeCloseTo(table.vFree[k]!, 3);
      expect(meso.model.capacityAt(slot!)).toBeCloseTo(table.capacity[k]!, 4);
      expect(meso.model.toAt(slot!)).toBe(table.to[k]);
      // The lane graph's link ends at the stop lines: shorter than the centreline, never longer.
      expect(meso.model.lengthAt(slot!)).toBeLessThanOrEqual(table.length[k]! + m(1));
      expect(meso.model.lengthAt(slot!)).toBeGreaterThan(table.length[k]! * 0.6);
      // At a junction every movement but back the way it came, as the lane graph's connectors give them.
      if ((degree.get(table.to[k]!) ?? 0) < 3) continue;
      const live = meso.model.turnsAt(slot!).map((j) => meso.linkOfSlot(j)).sort((a, b) => a - b);
      expect(live, `turns of link ${table.link[k]}`).toEqual(tableTurns(table, k));
    }
  });

  it('joins its neighbour\'s table on the nodes of their common edge', () => {
    const tileA = west(), tileB = east();
    const a = bakeTileLinks(tileA), b = bakeTileLinks(tileB);
    const into = linkId(tileA.segments.at(-2)!.id, 0), onward = linkId(tileB.segments[0]!.id, 0);
    const back = linkId(tileB.segments[0]!.id, 1), out = linkId(tileA.segments.at(-2)!.id, 1);
    expect(a.to[[...a.link].indexOf(into)]).toBe(EAST);
    expect(b.from[[...b.link].indexOf(onward)]).toBe(EAST);
    // Neither tile has the page: the meso over both tables only.
    const { w, meso } = world();
    meso.offerTable(a);
    meso.offerTable(b);
    meso.step(w, true);
    const slot = (link: number): number => meso.slotOfLink(link)!;
    expect(meso.model.turnsAt(slot(into))).toEqual([slot(onward)]);
    expect(meso.model.turnsAt(slot(back))).toEqual([slot(out)]);
    expect([...meso.model.inLinks(EAST)].sort((p, q) => p - q)).toEqual([slot(into), slot(back)].sort((p, q) => p - q));
  });

  it('keeps every vehicle when its tile is loaded into the page and let go again', () => {
    const tile = west();
    const table = bakeTileLinks(tile);
    const { doc, net, w, meso } = world();
    meso.offerTable(table);
    meso.step(w, true);
    const slots = [...table.link].map((link) => meso.slotOfLink(link)!);
    for (const slot of slots) meso.model.seed(slot, 3);
    const before = meso.model.vehicles();
    expect(before).toBeCloseTo(3 * table.count, 6);

    // Loaded: the lane graph's links take the same slots, and their vehicles.
    meso.tileEvent('loaded', tile.key, tile.version);
    doc.loadTile(tile);
    net.rebuild();
    w.rebuildTopology();
    meso.step(w, true);
    expect([...table.link].map((link) => meso.slotOfLink(link))).toEqual(slots);
    for (const slot of slots) expect(laneOf(w, meso, slot), `slot ${slot} on the lane graph`).not.toBe('');
    expect(meso.model.vehicles()).toBeCloseTo(before, 6);

    // Let go: the links held as they were until the table comes, then the table's; not a vehicle lost.
    meso.tileEvent('letGo', tile.key, 0);
    doc.unloadTile(tile.key);
    net.rebuild();
    w.rebuildTopology();
    meso.step(w, true);
    expect(meso.model.vehicles()).toBeCloseTo(before, 6);
    meso.offerTable(table);
    meso.step(w, true);
    expect([...table.link].map((link) => meso.slotOfLink(link))).toEqual(slots);
    expect(meso.model.vehicles()).toBeCloseTo(before, 6);
  });

});

/** A link lane of the slot in the lane graph. */
function laneOf(w: SimWorld, meso: Meso, slot: number): string {
  for (const id of w.graph.lanelets.keys()) if (meso.slotOfLane(id) === slot) return id;
  return '';
}
