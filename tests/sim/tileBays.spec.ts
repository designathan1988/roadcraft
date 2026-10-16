import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { packArrays } from '@core/arrayPack';
import { RoadDoc, type SerializedDoc, type TileRecords } from '@world/doc';
import { Network } from '@world/network';
import { OWNER, tileIdBase, tileKey } from '@world/tiles';
import { METERS_PER_UNIT } from '@world/units';
import { SimWorld } from '@sim/world';
import { type Bay, bayWork } from '@sim/agents/bay';
import { collectBays, tileBaysGone, tileBaysRead, tileBaysWanted } from '@sim/agents/parking';
import { type TrafficBuilding, TrafficBuildingTable } from '@sim/agents/trafficBuildings';
import { BAYS_SECTION, type TileBays, unpackTileBays } from '@sim/tileBays';
import { TRAFFIC_SECTION, bakeTileSections, trafficOfSection } from '@sim/tileSections';

/** A TILE'S BAYS BAKED WHERE IT IS WRITTEN (`sim/tileBays.ts`) ARE THE ONES THE SIMULATION WORKS OUT FROM THE SAME TILE, AND IT TAKES THEM INSTEAD OF WORKING THEM OUT. */

/** The parking town as one tile (ids as the fixture has them). */
function townTile(): TileRecords {
  const town = JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')) as SerializedDoc;
  const key = tileKey(0, 0), base = tileIdBase(key);
  return {
    key, version: 4, nodes: town.nodes, borrowedNodes: [], segments: town.segments, poles: [], borrowedPoles: [], poleSpans: [],
    buildings: town.buildings ?? [], lots: [], lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

/** A section as the tile store keeps it: a JSON part made text and read back, a binary part's bytes in a buffer of their own. */
const jsonBack = (value: unknown): unknown => JSON.parse(JSON.stringify(value)) as unknown;
const bytesBack = (bytes: Uint8Array): ArrayBuffer => new Uint8Array(bytes).buffer;

/** The tile, its sections baked once, its buildings as the simulation's worker reads them back. */
let baked: { tile: TileRecords; sections: ReturnType<typeof bakeTileSections>; traffic: TrafficBuilding[] } | null = null;
function bake(): NonNullable<typeof baked> {
  if (!baked) {
    const tile = townTile();
    const sections = bakeTileSections(tile);
    baked = { tile, sections, traffic: trafficOfSection(jsonBack((sections[TRAFFIC_SECTION] as { json: unknown }).json))! };
  }
  return baked;
}
const tileBays = (): TileBays => unpackTileBays(bytesBack((bake().sections[BAYS_SECTION] as { bin: Uint8Array }).bin))!;

/** The simulation's worker over the tile: its roads as the page sends them, its buildings as its traffic section reads back (`simHost.ts`). */
function worldOf(segments?: TileRecords['segments'], buildings?: readonly TrafficBuilding[]): { w: SimWorld; table: TrafficBuildingTable } {
  const { tile, traffic } = bake();
  const doc = RoadDoc.fromJSON({ version: 1, unit: METERS_PER_UNIT, nodes: tile.nodes, segments: segments ?? tile.segments }, { repair: false });
  const net = new Network(doc);
  net.rebuild();
  const table = new TrafficBuildingTable(doc.changes);
  table.load(buildings ?? traffic);
  const w = new SimWorld(doc, net, 7, table);
  w.rebuildTopology();
  return { w, table };
}

/** The lots worked out (or asked of the workers) and the streets laid out while `run` runs. */
function worked(run: () => void): { lots: number; kerbs: number } {
  const lots = bayWork.lots, kerbs = bayWork.kerbs;
  run();
  return { lots: bayWork.lots - lots, kerbs: bayWork.kerbs - kerbs };
}

/** The town's bays as the simulation works them out with no bake. */
let live: { bays: Bay[]; work: { lots: number; kerbs: number } } | null = null;
function liveBays(): NonNullable<typeof live> {
  if (!live) {
    const { w } = worldOf();
    let bays: Bay[] = [];
    const work = worked(() => { bays = collectBays(w); });
    live = { bays, work };
  }
  return live;
}

/** The tiles the town's streets belong to (`OWNER`: by the middle of their ends). */
function streetTiles(): Set<number> {
  const { tile } = bake();
  const at = new Map(tile.nodes.map((n) => [n.id, n]));
  const out = new Set<number>();
  for (const s of tile.segments) {
    const a = at.get(s.a), b = at.get(s.b);
    if (a && b) out.add(OWNER.segment(a, b));
  }
  return out;
}

describe('a tile\'s baked bays', () => {
  it('are the bays the simulation works out from the same tile, and are taken without working out a lot or a street', () => {
    const { bays: want, work } = liveBays();
    expect(work.lots, 'lots the simulation works out').toBeGreaterThan(5);
    expect(work.kerbs, 'streets it lays out').toBeGreaterThan(10);
    expect(want.filter((bay) => !bay.kerb && bay.via.length > 0).length, 'stalls driven out of their lots').toBeGreaterThan(10);
    expect(want.filter((bay) => bay.kerb).length, 'bays along the kerbs').toBeGreaterThan(20);
    const bays = tileBays();
    expect(bays.key).toBe(bake().tile.key);
    expect(bays.version).toBe(4);
    const { w } = worldOf();
    tileBaysWanted(w, bays.key, 1);
    tileBaysRead(w, bays.key, 1, bays);
    let got: Bay[] = [];
    expect(worked(() => { got = collectBays(w); })).toEqual({ lots: 0, kerbs: 0 });
    expect(got).toEqual(want);
  });

  it('are not taken for a lot or a street that reads what the bake did not have: worked out where the tile is loaded', () => {
    const { tile } = bake();
    // A street of the bake gone where the tile is loaded (as a neighbour's road is there and not in the tile's records).
    const gone = tile.segments.find((s) => (s as { parking?: unknown }).parking)!;
    const segments = tile.segments.filter((s) => s !== gone);
    const fresh = worldOf(segments).w;
    let want: Bay[] = [];
    const all = worked(() => { want = collectBays(fresh); });
    const { w } = worldOf(segments);
    tileBaysWanted(w, tile.key, 1);
    tileBaysRead(w, tile.key, 1, tileBays());
    let got: Bay[] = [];
    const work = worked(() => { got = collectBays(w); });
    expect(got).toEqual(want);
    expect(work.lots + work.kerbs, 'worked out: what reads near the street gone').toBeGreaterThan(0);
    expect(work.lots + work.kerbs, 'taken: the rest').toBeLessThan(all.lots + all.kerbs);
  });

  it('keep their streets waiting until they land, then the streets and the lots put with them take them', () => {
    const { traffic } = bake();
    const { bays: want } = liveBays();
    // The roads first, as the page sends them; the buildings come with the read (`simHost.ts` tileBuildings).
    const { w, table } = worldOf(undefined, []);
    const tiles = [...streetTiles()];
    expect(tiles.length).toBeGreaterThan(0);
    for (const t of tiles) tileBaysWanted(w, t, 1);
    let before: Bay[] = [];
    expect(worked(() => { before = collectBays(w); }), 'nothing laid out while they are read').toEqual({ lots: 0, kerbs: 0 });
    expect(before).toEqual([]);
    // The read lands: the bays offered, then the buildings put.
    tileBaysRead(w, tiles[0]!, 1, tileBays());
    for (const t of tiles.slice(1)) tileBaysRead(w, t, 1, null);
    table.apply(traffic.map((t) => ({ id: t.id, value: t })));
    let got: Bay[] = [];
    expect(worked(() => { got = collectBays(w); })).toEqual({ lots: 0, kerbs: 0 });
    expect(got).toEqual(want);
  });

  it('of an older read of the tile, or of another format, are not taken', () => {
    expect(unpackTileBays(bytesBack(packArrays({ key: 0, version: 0, format: 999, lots: 0, kerbs: 0 }, {})))).toBeNull();
    const { w } = worldOf();
    const key = bake().tile.key;
    tileBaysWanted(w, key, 2);
    tileBaysRead(w, key, 1, tileBays());
    expect(worked(() => collectBays(w)).lots, 'lots worked out: nothing taken').toBe(liveBays().work.lots);
    // Let go: its streets wait no more.
    tileBaysGone(w, key);
    expect(collectBays(w)).toEqual(liveBays().bays);
  });
});
