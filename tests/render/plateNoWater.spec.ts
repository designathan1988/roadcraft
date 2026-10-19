import { describe, expect, it, vi } from 'vitest';
import { CompressedArrayTexture, CompressedTexture, type CompressedPixelFormat, RGBAFormat, UnsignedByteType } from 'three';
import { ChangeJournal } from '@world/changes';
import { RELIEF_NATURAL, type TerrainStamp } from '@world/terrain';
import { primeSurfaceTextures } from '@render/surfaceTextures';
import { type TerrainSource, createTerrainSurface } from '@render/terrain';

/** A PLATE WITH NO RIVER MAKES NO WATER (TER-10, 2026-10-19): no mesh, no shore, no textures sent for a plate that had and has none. */
const seen = vi.hoisted(() => ({ shores: 0 }));
vi.mock('@render/landStroke', async (load) => {
  const real = await load<typeof import('@render/landStroke')>();
  return { ...real, shoreLevelsInto: (...args: Parameters<typeof real.shoreLevelsInto>) => { seen.shores++; return real.shoreLevelsInto(...args); } };
});

const format = RGBAFormat as unknown as CompressedPixelFormat;
const one = (): CompressedTexture => new CompressedTexture([{ data: new Uint8Array(4).fill(128), width: 1, height: 1 }], 1, 1, format, UnsignedByteType);
const arr = (): CompressedArrayTexture => new CompressedArrayTexture([{ data: new Uint8Array(4 * 9), width: 1, height: 1 }], 1, 1, 9, format, UnsignedByteType);

describe('a plate\'s water', () => {
  it('is not made for a plate with no river, and is for one with a river', () => {
    primeSurfaceTextures(new Map<string, CompressedTexture>([['terrain-grass:map', one()], ['terrain-grass:normal', one()], ['terrain-land:map', arr()], ['terrain-land:normal', arr()]]), () => {});
    const plate = createTerrainSurface(1, { x: 0, y: 0 }, 0);
    const source = {
      changes: new ChangeJournal(), terrainRevision: 1, terrainStamps: [] as TerrainStamp[], terrainRelief: RELIEF_NATURAL,
      natureRevision: 0, nature: null, paintRevision: 0, terrainPaint: [],
    } as unknown as TerrainSource & { terrainRevision: number; terrainStamps: TerrainStamp[] };
    // The first build, and a hill raised: no river anywhere, no water before or after.
    plate.update(source);
    source.terrainStamps = [{ id: 1, x: 120, y: -80, radius: 60, strength: 8, mode: 'raise' }];
    source.terrainRevision = 2;
    source.changes.record('terrain', [[60, -140, 180, -20]]);
    plate.update(source);
    expect(seen.shores).toBe(0);
    expect(plate.waterArea!()).toBeNull();
    // A river dug: its water made as before.
    source.terrainStamps = [...source.terrainStamps, { id: 2, x: -150, y: 100, radius: 50, strength: 10, mode: 'river' }];
    source.terrainRevision = 3;
    source.changes.record('terrain', [[-200, 50, -100, 150]]);
    plate.update(source);
    expect(seen.shores).toBe(1);
    expect(plate.waterArea!()).not.toBeNull();
    plate.dispose();
  });
});
