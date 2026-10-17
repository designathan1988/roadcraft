import { serialize } from 'node:v8';
import { describe, expect, it } from 'vitest';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building, BuildingElement } from '@world/buildings/types';
import { RoadDoc } from '@world/doc';
import { TILE, tileKey } from '@world/tiles';
import { bytesOf } from '@core/derivedCache';
import { buildingStage, stagePlants } from '@render/nearBuildings';
import { m } from '@world/units';
import type { Pack } from '@render/cellInstances';
import { gardenPack, gardenPlants } from '@render/gardens';
import type { GardenBake } from '@render/gardenTiles';
import { bakeEveryTile } from '../support/nearTileBakes';

/** A TILE'S GARDENS BAKED IN A WORKER (`gardenTiles.ts`): every tile's bake together is what the page's gardens place for the whole map */

/** Packs' instances as sorted rows, by kind. */
function rows(all: readonly ReadonlyMap<number, Pack>[]): string[] {
  const out: string[] = [];
  for (const packs of all) {
    for (const [kind, pack] of packs) {
      for (let i = 0; i < pack.count; i++) out.push([kind, ...pack.data.subarray(i * 7, i * 7 + 7), ...(pack.colours?.subarray(i * 3, i * 3 + 3) ?? []), pack.scales[i]!].map((v) => v.toFixed(3)).join(','));
    }
  }
  return out.sort();
}

describe('a tile\'s buildings kept for the near bakes', () => {
  it('keeps the gardens\' plants packed: read back as the gardens make them, in a fraction of the bytes the store clones, all of them counted by the write budget', () => {
    const doc = new RoadDoc();
    const kinds: readonly BuildingElement['kind'][] = ['tree', 'shrub', 'hedge', 'flowers'];
    // A dense tile: every building with its four plants.
    for (let i = 0; i < 400; i++) {
      const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
      const b = { ...JSON.parse(JSON.stringify(bp.body)), x: m(20) + (i % 20) * m(49), y: m(20) + Math.floor(i / 20) * m(49), rotation: (i % 4) * 0.4 } as Omit<Building, 'id'>;
      const plants: BuildingElement[] = kinds.map((kind, k) => ({ id: 9_000 + i * 4 + k, kind, x: m(2) + k * m(3), y: m(4), facing: k % 4, w: m(3), d: m(1.2), z: 0, h: m(kind === 'tree' ? 7 : 1.2) }) as BuildingElement);
      doc.buildings.add({ ...b, elements: [...(b.elements ?? []), ...plants] });
    }
    const records = doc.tileRecords(tileKey(0, 0), 1);
    const stage = buildingStage(records, 1);
    const plants = gardenPlants(doc.buildings.all(), () => 0);
    expect(plants.length).toBeGreaterThan(1000);
    expect(stagePlants(stage)).toEqual(plants);
    // What the store clones and holds until the write commits (the structured clone, as `v8.serialize` writes it): the plants as objects, and packed.
    const asObjects = serialize({ ...stage, plants }).byteLength, packed = serialize(stage).byteLength;
    expect(packed).toBeLessThan(asObjects * 0.7);
    // The write budget counts what is cloned (`derivedCache.ts` bytesOf): the arrays' bytes, nothing left uncounted.
    expect(bytesOf(stage)).toBeGreaterThan(packed * 0.9);
  });
});

describe('a tile\'s gardens baked in a worker', () => {
  it('every tile\'s bake together is the page\'s gardens: each building\'s plants once, in its own tile', async () => {
    const doc = new RoadDoc();
    const kinds: readonly BuildingElement['kind'][] = ['tree', 'shrub', 'hedge', 'flowers'];
    for (let i = 0; i < 48; i++) {
      const bp = BLUEPRINTS[i % BLUEPRINTS.length]!;
      const b = { ...JSON.parse(JSON.stringify(bp.body)), x: -TILE / 2 + (i % 8) * m(140), y: -TILE / 2 + Math.floor(i / 8) * m(170), rotation: (i % 4) * 0.4 } as Omit<Building, 'id'>;
      const plants: BuildingElement[] = kinds.map((kind, k) => ({ id: 9_000 + i * 4 + k, kind, x: m(2) + k * m(3), y: m(4), facing: k % 4, w: m(3), d: m(1.2), z: 0, h: m(kind === 'tree' ? 7 : 1.2) }) as BuildingElement);
      doc.buildings.add({ ...b, elements: [...(b.elements ?? []), ...plants] });
    }
    const flat = (): number => 0;
    const want = rows([gardenPack(gardenPlants(doc.buildings.all(), flat))]);
    expect(want.length).toBeGreaterThan(200);
    const bakes = await bakeEveryTile(doc, [-TILE, -TILE, TILE, TILE], 'gardens', undefined, ['buildings']) as GardenBake[];
    expect(bakes.length).toBeGreaterThan(1);
    expect(rows(bakes.map((b) => b.packs))).toEqual(want);
  });
});
