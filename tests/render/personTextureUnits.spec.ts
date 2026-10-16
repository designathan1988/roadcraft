import { describe, expect, it } from 'vitest';
import {
  BufferAttribute, BufferGeometry, Color, DataTexture, Matrix4, MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking,
  Texture, type Mesh, type SkinnedMesh,
} from 'three';
import { skinMaterial } from '@render/riggedCitizens';
import { personProgramStandIns } from '@render/people/proceduralCrowd';
import { applySkinAppearance, createPersonLayers, type SkinAppearance } from '@render/people/skinAppearance';
import { cascadedSunChunks, SUN_CASCADES } from '@render/sunCascades';
import { MAX_UNITS, listed, textureUnits, total } from './_textureUnits';

/** THE PEOPLE'S PROGRAMS FIT 12 TEXTURE UNITS (`_textureUnits.ts`) */

/** A picture of `size` px already in a layer's bytes (as a padded garment is) */
function picture(size: number): Texture {
  return new DataTexture(new Uint8Array(size * size * 4), size, size);
}

/** A dressed body's geometry: its skin, and the cards, garments and eyes it has */
function bodyGeometry(hair: boolean, garments: boolean, eyes: boolean): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(9), 3));
  geometry.setAttribute('skinMask', new BufferAttribute(new Float32Array(3), 1));
  if (hair) geometry.setAttribute('hairMask', new BufferAttribute(new Float32Array(3), 1));
  if (garments) geometry.setAttribute('garmentSlot', new BufferAttribute(new Float32Array(3), 1));
  if (eyes) geometry.setAttribute('eyeMask', new BufferAttribute(new Float32Array(3), 1));
  return geometry;
}

describe('the people\'s texture units', () => {
  cascadedSunChunks();

  it('a rigged citizen, dressed and with a face\'s morphs, reads its pictures from two arrays', () => {
    const layers = createPersonLayers();
    const skin: SkinAppearance = { texture: picture(1024), eyeTexture: picture(256), tint: new Color(1, 1, 1), hair: new Color(0.2, 0.1, 0.05),
      hairTexture: picture(512), browTexture: picture(256), lashTexture: picture(256), beardTexture: picture(512),
      garments: [picture(512), picture(256), null, picture(512), null], outfitTint: null, beard: 0, makeup: 0 };
    const mesh = { bindMatrix: new Matrix4(), bindMatrixInverse: new Matrix4() } as unknown as SkinnedMesh;
    const bones = { value: new Texture() };
    for (const hair of [false, true]) for (const garments of [false, true]) for (const eyes of [false, true]) {
      const material = new MeshStandardMaterial({ vertexColors: true });
      skinMaterial(material, bones, mesh);
      applySkinAppearance(material, bodyGeometry(hair, garments, eyes), skin, layers);
      for (const morph of [false, true]) {
        const units = textureUnits(material, { instanceColor: true, morph });
        expect(total(units), `hair ${hair} garments ${garments} eyes ${eyes} morph ${morph}: ${listed(units)}`).toBeLessThanOrEqual(MAX_UNITS);
        if (hair && garments && eyes && morph) {
          // The counter sees what the game measured, less the pictures now in layers
          expect(listed(units).split(' ').sort()).toEqual([`directionalShadowMap[${SUN_CASCADES}]`, 'citizenBones', 'dfgLUT', 'envMap',
            'morphTargetsTexture', 'morphTexture', 'personLayersLarge', 'personLayersSmall', 'personSkin'].sort());
        }
      }
      const depth = new MeshDepthMaterial({ depthPacking: RGBADepthPacking });
      skinMaterial(depth, bones, mesh);
      for (const morph of [false, true]) expect(total(textureUnits(depth, { instanceColor: true, morph }))).toBeLessThanOrEqual(MAX_UNITS);
    }
    layers.dispose();
  });

  it('every procedural person\'s program, lit or cast into the shadow', () => {
    const { lit, shadow } = personProgramStandIns();
    let programs = 0;
    let widest = 0;
    for (const group of [lit, shadow]) {
      group.traverse((object) => {
        const mesh = object as Mesh;
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const units = textureUnits(material, { instanceColor: false, morph: false });
          programs++;
          widest = Math.max(widest, total(units));
          expect(total(units), `${material.customProgramCacheKey()}: ${listed(units)}`).toBeLessThanOrEqual(MAX_UNITS);
        }
      });
    }
    expect(programs).toBeGreaterThan(10);
    // The closest skin reads its bones, bodies, face, row, cover, skin, eyes, the sky, the DFG table and the cascades: the counter is not blind
    expect(widest).toBe(MAX_UNITS);
  });
});
