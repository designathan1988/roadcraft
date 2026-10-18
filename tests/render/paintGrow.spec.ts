import { describe, expect, it, vi } from 'vitest';
import { CompressedTexture, type DataArrayTexture } from 'three';

// The baked surfaces stand in for the cooked ones (`surfaceTextures.ts`): what is tested is the paint array's own texels.
vi.mock('@render/surfaceTextures', async (load) => {
  const real = await load<typeof import('@render/surfaceTextures')>();
  const texture = (): CompressedTexture => {
    const t = new CompressedTexture([{ data: new Uint8Array(4).fill(128), width: 1, height: 1 }], 1, 1);
    return t;
  };
  return { ...real, surfaceTexture: () => texture(), surfaceMaps: () => undefined };
});

import { createTerrainSurface } from '@render/terrain';
import { RoadDoc } from '@world/doc';
import { m } from '@world/units';

/** THE PAINTED GROUND'S ARRAY GROWN WHILE ITS SMALLER ONE WAITS TO BE SENT (`terrain.ts` growPaint): each array's texels at its own side, the smaller one out of the uploads' queue */

describe('the painted ground grown', () => {
  it('fills an array still to be sent at its own side, not at the side the plate grew to', () => {
    const surface = createTerrainSurface(1, { x: 0, y: 0 }, 0);
    const small = surface.textures()[1] as DataArrayTexture;
    expect(small.image.width).toBe(512);
    // A world opened with its ground already painted: the array grows to 1024 at the load, before the first send.
    const doc = new RoadDoc();
    doc.addPaintDab({ kind: 'sand', x: m(10), y: m(-20), radius: m(30), strength: 1 } as never);
    surface.updatePaint(doc as never, false);
    const grown = surface.textures()[1] as DataArrayTexture;
    expect(grown.image.width).toBe(1024);
    // The smaller array's texels read as three reads them at its send (`stagedTexels.ts`): before, filled at 1024's rows past its end (RangeError).
    expect(() => (small.image as { data: Uint8Array }).data).not.toThrow();
    expect(() => (grown.image as { data: Uint8Array }).data).not.toThrow();
    expect((grown.image as { data: Uint8Array }).data.length).toBe(1024 * 1024 * 4 * 3);
    surface.dispose();
  });
});
