import { afterAll, describe, expect, it } from 'vitest';
import { CompressedArrayTexture, CompressedTexture, type CompressedPixelFormat, type Material, RGBAFormat, UnsignedByteType } from 'three';

import { disposeSurfaceTextures, primeSurfaceTextures } from '@render/surfaceTextures';
import { farLandMaterial } from '@render/terrain';
import { MAX_UNITS, listed, textureUnits, total } from './_textureUnits';

const format = RGBAFormat as unknown as CompressedPixelFormat;
/** The grass map: two mip levels, the last one texel of sRGB 128, 64, 32. */
const grass = (): CompressedTexture => new CompressedTexture([
  { data: new Uint8Array(2 * 2 * 4).fill(200), width: 2, height: 2 },
  { data: Uint8Array.of(128, 64, 32, 255), width: 1, height: 1 },
], 2, 2, format, UnsignedByteType);
const layers = (): CompressedArrayTexture => new CompressedArrayTexture([{ data: new Uint8Array(4 * 9), width: 1, height: 1 }], 1, 1, 9, format, UnsignedByteType);

/** THE LAND'S MATERIAL (`terrain.ts`): its texture units and the grass's mean read from its last mip level */
describe('the land material', () => {
  primeSurfaceTextures(new Map<string, CompressedTexture>([
    ['terrain-grass:map', grass()], ['terrain-grass:normal', grass()], ['terrain-land:map', layers()], ['terrain-land:normal', layers()],
  ]), () => {});
  afterAll(() => disposeSurfaceTextures());
  const far = farLandMaterial(1);
  afterAll(() => far.dispose());
  const uniforms = (material: Material): Record<string, { value: unknown }> => (material.userData['terrainUniforms'] as Record<string, { value: unknown }>);

  it('takes the grass map\'s mean luma from its last mip level, linear, as the shader read it at a bias of 14', () => {
    const linear = (c: number): number => ((c / 255 + 0.055) / 1.055) ** 2.4;
    expect(uniforms(far.material)['uGrassMean']!.value as number).toBeCloseTo(linear(128) * 0.3 + linear(64) * 0.6 + linear(32) * 0.1, 6);
  });

  it('reads the ecology from the corner layer of the paint array: no unit of its own', () => {
    const units = textureUnits(far.material, { instanceColor: false, morph: false, instanced: false });
    // 11 with the 3 cascades (its normal map and a plate's \`uLand\` make 13 of ANGLE's 16, uncounted here)
    expect(total(units), listed(units)).toBeLessThanOrEqual(Math.min(MAX_UNITS, 11));
    expect(units.has('uPaint') && units.has('uShore'), listed(units)).toBe(true);
  });
});
