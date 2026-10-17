import { describe, expect, it } from 'vitest';
import { packArrays, packArraysBlob } from '@core/arrayPack';
import { LINKS_SECTION, bakeTileSections, packLinks } from '@sim/tileSections';
import { bakeTileLinks } from '@sim/meso/tileLinks';
import { buildStreamTile } from '@editor/wholeMapTile';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { WHOLE_MAP_DEFAULTS, type WholeMapOptions } from '@world/cityGen/wholeMap';

/** A pack written straight into a Blob holds the very bytes of the packed buffer (`packArraysBlob`) */

const bytes = async (blob: Blob): Promise<number[]> => [...new Uint8Array(await blob.arrayBuffer())];

describe('a pack as a Blob', () => {
  it('is packArrays byte for byte, whatever the arrays and their alignment', async () => {
    const sub = new Float32Array([9, 8, 7, 6, 5]).subarray(1, 4);
    const arrays = { a: new Uint8Array([1, 2, 3]), b: new Float64Array([0.5, -0, Number.NaN]), c: sub, d: new Int16Array(0), e: new Uint32Array([7]) };
    expect(await bytes(packArraysBlob({ n: 3, m: -1.25 }, arrays))).toEqual([...packArrays({ n: 3, m: -1.25 }, arrays)]);
    expect(await bytes(packArraysBlob({}, {}))).toEqual([...packArrays({}, {})]);
  });

  it("gives a tile's link section the bytes its packed table has", async () => {
    const { size: _size, radius: _radius, ...base } = DEFAULT_CITY;
    const options: WholeMapOptions = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 1 };
    const records = buildStreamTile(options, 0, 0);
    const section = bakeTileSections(records, false)[LINKS_SECTION] as { blob: Blob };
    expect(await bytes(section.blob)).toEqual([...packLinks(bakeTileLinks(records))]);
  });
});
