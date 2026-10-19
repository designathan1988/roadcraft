import { describe, expect, it } from 'vitest';
import { CompressedArrayTexture, CompressedTexture, type CompressedPixelFormat, DataTexture, FloatType, RGBAFormat, RGBAIntegerFormat, RedFormat, UnsignedByteType,
  UnsignedShortType } from 'three';
import { ChangeJournal } from '@world/changes';
import { RELIEF_NATURAL, type TerrainStamp } from '@world/terrain';
import { primeSurfaceTextures } from '@render/surfaceTextures';
import { type TerrainSource, createTerrainSurface } from '@render/terrain';

/** A PLATE'S CORNERS IN TWO TEXTURES (TER-07, 2026-10-19): the water's level a float, the covers two bytes a channel; 12 bytes a corner, not 16. */
const format = RGBAFormat as unknown as CompressedPixelFormat;
const one = (): CompressedTexture => new CompressedTexture([{ data: new Uint8Array(4).fill(128), width: 1, height: 1 }], 1, 1, format, UnsignedByteType);
const arr = (): CompressedArrayTexture => new CompressedArrayTexture([{ data: new Uint8Array(4 * 9), width: 1, height: 1 }], 1, 1, 9, format, UnsignedByteType);

describe('a plate\'s corner textures', () => {
  it('hold the water\'s level as R32F and the covers as RGBA16UI, each sent only when what it holds changes', () => {
    primeSurfaceTextures(new Map<string, CompressedTexture>([['terrain-grass:map', one()], ['terrain-grass:normal', one()], ['terrain-land:map', arr()], ['terrain-land:normal', arr()]]), () => {});
    const plate = createTerrainSurface(1, { x: 0, y: 0 }, 0);
    const source = {
      changes: new ChangeJournal(), terrainRevision: 1, terrainStamps: [] as TerrainStamp[], terrainRelief: RELIEF_NATURAL,
      natureRevision: 0, nature: null, paintRevision: 0, terrainPaint: [],
    } as unknown as TerrainSource & { terrainRevision: number; terrainStamps: TerrainStamp[]; paintRevision: number; terrainPaint: unknown[] };
    plate.update(source);
    const textures = plate.textures!().filter((t): t is DataTexture => (t as DataTexture).isDataTexture === true);
    const level = textures.find((t) => t.format === RedFormat && t.type === FloatType && t.internalFormat === 'R32F');
    const cover = textures.find((t) => t.format === RGBAIntegerFormat && t.type === UnsignedShortType && t.internalFormat === 'RGBA16UI');
    expect(level).toBeDefined();
    expect(cover).toBeDefined();
    // No RGBA float texture of the corners but the land's own (its heights and normals).
    expect(textures.filter((t) => t.format === RGBAFormat && t.type === FloatType)).toHaveLength(1);
    // A river dug: the level sent, the covers not.
    const levelSent = level!.version, coverSent = cover!.version;
    source.terrainStamps = [{ id: 1, x: -150, y: 100, radius: 50, strength: 10, mode: 'river' }];
    source.terrainRevision = 2;
    source.changes.record('terrain', [[-200, 50, -100, 150]]);
    plate.update(source);
    expect(level!.version).toBeGreaterThan(levelSent);
    expect(cover!.version).toBe(coverSent);
    // Flowers painted: the covers sent, the level not.
    const levelAfter = level!.version;
    source.terrainPaint = [{ x: 100, y: -100, radius: 40, kind: 'flowers', strength: 1 }];
    source.paintRevision = 1;
    plate.updatePaint(source);
    expect(cover!.version).toBeGreaterThan(coverSent);
    expect(level!.version).toBe(levelAfter);
    plate.dispose();
  });
});
