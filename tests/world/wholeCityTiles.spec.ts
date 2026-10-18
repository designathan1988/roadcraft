import { buildTileMap } from '@editor/wholeMapTile';
import { buildStreamTilePair } from '@editor/wholeMapTile';
import { WHOLE_MAP_DEFAULTS } from '@world/cityGen/wholeMap';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { lotCentre } from '@world/lots';
import { footprintRects } from '@world/buildings/geometry';
import { touchesRoad } from '@world/buildings/validate';
import { m } from '@world/units';

// Tiles of the whole map built as a worker builds them (`wholeMapTile.ts`): the centre, a suburb, an edge and a corner.
const { size: _s, radius: _r, ...base } = DEFAULT_CITY;
const options = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 1 };
const PLACES: readonly [number, number][] = [[0, 0], [-3, 2], [4, 0], [-5, -5]];

describe('tiles of the whole map, built whole', () => {
  for (const [i, j] of PLACES) {
    it(`tile (${i}, ${j}): roads, lots zoned, and a building on nearly every zoned lot, none on a road`, () => {
      const built = buildTileMap(options, i, j);
      const doc = RoadDoc.fromJSON(built.data);
      const net = new Network(doc);
      net.rebuild();
      const own = doc.lots.filter((l) => built.tile.owns(lotCentre(l)));
      const zoned = own.filter((l) => l.use !== undefined);
      const standing = zoned.filter((l) => l.building !== undefined);
      console.log(`tile (${i},${j}) ${Math.round(built.ms)} ms: ${doc.segments.size} roads, ${own.length} lots, ${zoned.length} zoned, ${standing.length} built (${Math.round((100 * standing.length) / Math.max(1, zoned.length))} %)`);
      expect(doc.segments.size).toBeGreaterThan(100);
      expect(zoned.length).toBeGreaterThan(150);
      expect(standing.length / zoned.length).toBeGreaterThan(0.9);
      // No building's footprint over a road.
      const onRoad = [...doc.buildings.all()].filter((b) => built.tile.owns(b) && footprintRects(b, -m(0.05)).some((r) => touchesRoad(net, r)));
      expect(onRoad.map((b) => b.id)).toEqual([]);
      // The tile as the store keeps it: no record thrown out for an end off its edge.
      expect(() => buildStreamTilePair(options, i, j)).not.toThrow();
    }, 600_000);
  }
});
