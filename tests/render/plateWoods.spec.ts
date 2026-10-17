import { describe, expect, it } from 'vitest';
import { CompressedArrayTexture, CompressedTexture, type CompressedPixelFormat, RGBAFormat, UnsignedByteType } from 'three';
import { ChangeJournal } from '@world/changes';
import { RELIEF_NATURAL, type TerrainStamp } from '@world/terrain';
import { primeSurfaceTextures } from '@render/surfaceTextures';
import { type TerrainSource, createTerrainSurface, TERRAIN_HALF } from '@render/terrain';
import { woodsBase, woodsBaseInto } from '@render/woodsBase';

/** THE WOODS' DENSITY BUT THE ECOSYSTEM (`woodsBase.ts`): kept by the plate on its land, a stamp redoing its own cells (`terrain.ts`) */

const format = RGBAFormat as unknown as CompressedPixelFormat;
const one = (): CompressedTexture => new CompressedTexture([{ data: new Uint8Array(4).fill(128), width: 1, height: 1 }], 1, 1, format, UnsignedByteType);
const arr = (): CompressedArrayTexture => new CompressedArrayTexture([{ data: new Uint8Array(4 * 9), width: 1, height: 1 }], 1, 1, 9, format, UnsignedByteType);

describe('the woods\' base', () => {
  it('worked out again over a box is the base of the land as it is now', () => {
    const half = 512;
    const land = (x: number, y: number): number => Math.sin(x / 90) * 12 + Math.cos(y / 70) * 9;
    const base = woodsBase(land, half, 2048, -2048);
    // A hill raised inside a box: only the cells reading it redone.
    const box = [-100, 40, 60, 180] as const;
    const hill = (x: number, y: number): number => land(x, y) + (x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3] ? 25 * Math.sin((x - box[0]) / 50) : 0);
    woodsBaseInto(base, hill, half, 2048, -2048, box);
    expect(Array.from(base)).toEqual(Array.from(woodsBase(hill, half, 2048, -2048)));
  });

  it('is kept by the plate through a stamp of its land, and is the base of the land as drawn', () => {
    primeSurfaceTextures(new Map<string, CompressedTexture>([['terrain-grass:map', one()], ['terrain-grass:normal', one()], ['terrain-land:map', arr()], ['terrain-land:normal', arr()]]), () => {});
    const plate = createTerrainSurface(1, { x: 0, y: 0 }, 0);
    const source = {
      changes: new ChangeJournal(), terrainRevision: 1, terrainStamps: [] as TerrainStamp[], terrainRelief: RELIEF_NATURAL,
      natureRevision: 0, nature: null, paintRevision: 0, terrainPaint: [],
    } as unknown as TerrainSource & { terrainRevision: number; terrainStamps: TerrainStamp[] };
    plate.update(source);
    const first = plate.woodsRevision!;
    expect(plate.woodsBase!()).not.toBeNull();
    // A dab raised on the plate.
    source.terrainStamps = [{ id: 1, x: 120, y: -80, radius: 60, strength: 8, mode: 'raise' }];
    source.terrainRevision = 2;
    source.changes.record('terrain', [[60, -140, 180, -20]]);
    plate.update(source);
    expect(plate.woodsRevision).toBeGreaterThan(first);
    expect(Array.from(plate.woodsBase!()!)).toEqual(Array.from(woodsBase((x, y) => plate.naturalRenderedHeightAt(x, y), TERRAIN_HALF, 0, 0)));
    plate.dispose();
  });
});
