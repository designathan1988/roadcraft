import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SerializedDoc, TileRecords } from '@world/doc';
import { tileIdBase, tileKey } from '@world/tiles';
import { migrateBuilding } from '@world/buildings/serialize';

/** A TILE'S BUILDINGS MIGRATED ONCE: a building already current is not made again (`migrateBuilding`) */

function townTile(): TileRecords {
  const town = JSON.parse(readFileSync('tests/fixtures/parking-town.json', 'utf8')) as SerializedDoc;
  const key = tileKey(0, 0), base = tileIdBase(key);
  return {
    key, version: 4, nodes: town.nodes, borrowedNodes: [], segments: town.segments, poles: [], borrowedPoles: [], poleSpans: [],
    buildings: town.buildings ?? [], lots: [], lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base, segment: base, pole: base, span: base, building: base, lot: base, landscape: base, barrier: base },
  };
}

const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (x instanceof Float32Array || x instanceof Uint32Array || x instanceof Int8Array ? Array.from(x) : x))) as unknown;

describe('a tile migrated once', () => {
  it('takes a building already current as it is, the same object', () => {
    const raw = townTile().buildings[0]!;
    const once = migrateBuilding(raw)!;
    expect(once).not.toBe(raw);
    expect(migrateBuilding(once)).toBe(once);
    // The same record as migrating the stored one again.
    expect(plain(migrateBuilding(structuredClone(raw)))).toEqual(plain(once));
  });
});
