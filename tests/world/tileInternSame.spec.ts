import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { WHOLE_MAP_DEFAULTS, type WholeMapOptions } from '@world/cityGen/wholeMap';
import { buildTileMap } from '@editor/wholeMapTile';

/** A TILE'S GENERATOR DOES NOT INTERN WHAT IT GROWS (`BuildingStore.internShared`): the tile it hands over is the same, byte for byte */

const { size: _size, radius: _radius, ...base } = DEFAULT_CITY;
const options: WholeMapOptions = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 1 };
const sha = (value: unknown): string => createHash('sha1').update(JSON.stringify(value)).digest('hex');

describe("a tile's generator without interning", () => {
  it('makes the very tile it makes interning', () => {
    const plain = buildTileMap(options, 0, 0), interned = buildTileMap(options, 0, 0, true);
    expect((plain.data.buildings ?? []).length).toBeGreaterThan(50);
    expect(sha(plain.data)).toBe(sha(interned.data));
    expect(sha([...plain.choices])).toBe(sha([...interned.choices]));
  });
});
