import { type MeshStandardMaterial, type Texture } from 'three';
import type { PersonSpec } from '@people/spec';
import { applySkinAppearance, loadSkinAppearance, type PersonLayers, type SkinAppearance } from '@render/people/skinAppearance';
import type { BuiltPerson } from './build';
import { evenHairSheen, paintedSkin, polishPerson, sharpEyes } from './polish';
import { GROOM, PROC_PREFIX } from './record';

/** A BUILT PERSON DRESSED AS THE LAB DRAWS THEM: the lab's finish (`polish.ts`), then the game's textures (skin, irises, fabrics, `skinAppearance.ts`) with the lab's changes */

/** `painted`: painted skins by their source texture, kept by the caller (each made once). */
export async function dressPerson(person: BuiltPerson, spec: PersonSpec, layers: PersonLayers, painted: WeakMap<Texture, Texture>, sculpted = false): Promise<SkinAppearance> {
  polishPerson(person.meshes, spec.look, sculpted);
  // A grown hairstyle is no catalogue file: its card texture is not loaded (the lab draws hair solid anyway).
  const own = spec.look.hairCut?.startsWith(PROC_PREFIX) || spec.look.hairCut === GROOM;
  const skin = await loadSkinAppearance({ ...spec, look: { ...spec.look, ...(own ? { hairCut: 'none' } : {}), } });
  let soft = painted.get(skin.texture);
  if (!soft) {
    soft = paintedSkin(skin.texture, 1) ?? skin.texture;
    painted.set(skin.texture, soft);
  }
  skin.texture = soft;
  // Solid hair, as The Sims draws it: one colour, shaded, no strand texture (its strands read as stripes up close).
  delete skin.hairTexture;
  for (const m of person.meshes) {
    const materials = (Array.isArray(m.material) ? m.material : [m.material]).map((source) => {
      const material = (source as MeshStandardMaterial).clone();
      material.color.setHex(0xffffff);
      material.roughness = 0.82;
      material.metalness = 0;
      applySkinAppearance(material, m.geometry, skin, layers);
      evenHairSheen(material);
      sharpEyes(material, skin.eyeTexture);
      return material;
    });
    m.material = Array.isArray(m.material) ? materials : materials[0]!;
  }
  for (const m of person.meshes) { m.castShadow = true; m.frustumCulled = false; }
  return skin;
}
