import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunzipBytes, gzipBytes } from '@editor/tileBlob';

/** THE TILE'S GZIP MAKES NO BLOB BUT ITS RESULT (`tileBlob.ts` gzipBytes): a Blob is native memory the V8 does not count, and a worker whose heap is quiet never collects them (~2.9 GB outside the JS heap while the map was made) */

afterEach(() => { vi.unstubAllGlobals(); });

describe("a tile's part compressed", () => {
  it('hands Blobs only its compressed bytes, never the input, tile after tile', async () => {
    const Real = Blob;
    let given = 0;
    // A counter on the constructor: the bytes every Blob made from script is given.
    vi.stubGlobal('Blob', class extends Real {
      constructor(parts?: BlobPart[], options?: BlobPropertyBag) {
        super(parts, options);
        for (const p of parts ?? []) given += typeof p === 'string' ? p.length : p instanceof Real ? p.size : (p as ArrayBufferView).byteLength;
      }
    });
    const text = new TextEncoder().encode('{"buildings":[' + '{"id":1,"x":10,"y":20,"floors":3},'.repeat(30_000) + '{}]}') as Uint8Array<ArrayBuffer>;
    expect(text.byteLength).toBeGreaterThan(1_000_000);
    let out = 0;
    for (let tile = 0; tile < 10; tile++) {
      const blob = await gzipBytes(text);
      out += blob.size;
      if (tile === 0) expect(await gunzipBytes(blob)).toEqual(text);
    }
    // Ten tiles: no more given to Blobs than their compressed outputs - none of the ten megabytes of input.
    expect(given).toBe(out);
    expect(given).toBeLessThan(text.byteLength);
  });
});
