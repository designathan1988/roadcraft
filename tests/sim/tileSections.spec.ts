import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SerializedDoc, TileRecords } from '@world/doc';
import { tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';
import { bakeTileLinks } from '@sim/meso/tileLinks';
import { LINKS_SECTION, NETWORK_SECTION, TRAFFIC_SECTION, bakeTileSections, networkOfSection, tileTraffic, trafficOfSection, unpackLinks } from '@sim/tileSections';
import { tileNetworkBake } from '@world/tileNetwork';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { METERS_PER_UNIT } from '@world/units';

/** A TILE'S SIMULATION SECTIONS (`sim/tileSections.ts`): baked once where the tile is written, read back as the simulation derives them from the records. */

/** A tile holding the parking town's roads and buildings (ids as the fixture has them: the bakes read them as they are). */
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

describe('a tile\'s simulation sections', () => {
  it('the link table read back is the one baked from the records', () => {
    const tile = townTile();
    expect(tile.segments.length).toBeGreaterThan(0);
    const section = bakeTileSections(tile)[LINKS_SECTION]!;
    expect('bin' in section).toBe(true);
    const links = unpackLinks(bytesBack((section as { bin: Uint8Array }).bin))!;
    const baked = bakeTileLinks(tile);
    expect(links.key).toBe(tile.key);
    expect(links.version).toBe(4);
    expect(links.count).toBe(baked.count);
    for (const name of ['link', 'from', 'to', 'length', 'lanes', 'vFree', 'capacity', 'flags', 'shape', 'turnStart', 'turnTo', 'turnWeight', 'nodes', 'nodeFlags', 'nodeDegree', 'cells'] as const) {
      expect([...links[name]]).toEqual([...baked[name]]);
      expect(links[name].constructor).toBe(baked[name].constructor);
    }
  });

  it('the buildings as traffic reads them read back from JSON as worked out from the records', () => {
    const tile = townTile();
    expect(tile.buildings.length).toBeGreaterThan(0);
    const section = bakeTileSections(tile)[TRAFFIC_SECTION]!;
    expect('json' in section).toBe(true);
    const read = trafficOfSection(jsonBack((section as { json: unknown }).json))!;
    expect(read).toEqual(tileTraffic(tile.buildings));
  });

  it('an empty box comes back infinite, as `buildingBounds` leaves it (JSON writes null)', () => {
    const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const one = { id: 1, x: m(1), y: m(2), rotation: 0, use: 'residential', volumes: [], bounds: box, reach: box, footprints: [], doors: [], docks: [], entrances: [] };
    const read = trafficOfSection(jsonBack({ format: 1, buildings: [one] }))!;
    expect(read[0]!.bounds).toEqual(box);
    expect(read[0]!.reach).toEqual(box);
  });

  it('a section of another format is not read (derived again from the records)', () => {
    expect(trafficOfSection({ format: 999, buildings: [] })).toBeNull();
    expect(trafficOfSection(null)).toBeNull();
  });

  it("the network read back is the tile's bake as the page posts it (its maps and arrays too), and a network takes it as it takes the page's", () => {
    const tile = townTile();
    const section = bakeTileSections(tile)[NETWORK_SECTION] as { json: unknown };
    const read = networkOfSection(jsonBack(section.json))!;
    expect(read).toEqual(structuredClone(tileNetworkBake(tile)));
    // A copy of the tile's roads given the read bake builds the same ribbons as one given the posted bake.
    const built = (bake: ReturnType<typeof tileNetworkBake>): string[] => {
      const doc = RoadDoc.fromJSON({ version: 1, unit: METERS_PER_UNIT, nodes: tile.nodes, segments: tile.segments }, { repair: false });
      const net = new Network(doc);
      net.offerBake(bake);
      net.rebuild();
      return [...doc.segments.keys()].map((id) => { const r = net.ribbons.get(id as never); return JSON.stringify(r ? Array.from(r.full.xy) : null); });
    };
    expect(built(read)).toEqual(built(structuredClone(tileNetworkBake(tile))));
    // A tile made ahead has none (`bays` false): it takes it when it is loaded.
    expect(bakeTileSections(tile, false)[NETWORK_SECTION]).toBeUndefined();
  });
});
