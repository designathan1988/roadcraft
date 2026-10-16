import { describe, expect, it } from 'vitest';
import { packArrays, packedArray, packedNumber, unpackArrays } from '@core/arrayPack';

/** THE ARRAY PACK (`arrayPack.ts`): numbers and typed arrays in one buffer, read back as views on it. */
describe('an array pack', () => {
  it('reads back every number and array, each of its kind, as views on the one buffer', () => {
    const f64 = Float64Array.from([1.5, -(2 ** 40), 3]);
    const u8 = Uint8Array.from([1, 2, 3, 4, 5]);
    const f32 = Float32Array.from([0.25, 7]);
    const u32 = Uint32Array.from([0, 4_000_000_000]);
    const bytes = packArrays({ key: -12, version: 3 }, { f64, u8, f32, u32, none: new Uint16Array(0) });
    const pack = unpackArrays(bytes.buffer);
    expect(packedNumber(pack, 'key')).toBe(-12);
    expect(packedNumber(pack, 'version')).toBe(3);
    expect([...packedArray(pack, 'f64', Float64Array)]).toEqual([...f64]);
    expect([...packedArray(pack, 'u8', Uint8Array)]).toEqual([...u8]);
    expect([...packedArray(pack, 'f32', Float32Array)]).toEqual([...f32]);
    expect([...packedArray(pack, 'u32', Uint32Array)]).toEqual([...u32]);
    expect(packedArray(pack, 'none', Uint16Array)).toHaveLength(0);
    // Views, not copies: every array on the pack's buffer, 8-byte aligned.
    for (const array of Object.values(pack.arrays)) {
      expect(array.buffer).toBe(bytes.buffer);
      expect(array.byteOffset % 8).toBe(0);
    }
  });

  it('packs a view of a larger buffer by its own bytes only', () => {
    const big = Float32Array.from([9, 8, 7, 6]);
    const pack = unpackArrays(packArrays({}, { part: big.subarray(1, 3) }).buffer);
    expect([...packedArray(pack, 'part', Float32Array)]).toEqual([8, 7]);
  });

  it('refuses an array of another kind or a missing name', () => {
    const pack = unpackArrays(packArrays({ n: 1 }, { a: new Uint8Array(2) }).buffer);
    expect(() => packedArray(pack, 'a', Float64Array)).toThrow();
    expect(() => packedArray(pack, 'b', Uint8Array)).toThrow();
    expect(() => packedNumber(pack, 'm')).toThrow();
  });
});
