import { Color, type MeshStandardMaterial, type Texture } from 'three';
import { texturedGarments } from '@render/people/garmentSlots';
import type { PersonSpec } from '@people/spec';
import { applySkinAppearance, loadSkinAppearance, type PersonLayers, type SkinAppearance } from '@render/people/skinAppearance';
import type { BuiltPerson } from './build';
import { evenHairSheen, paintedSkin, polishPerson, sharpEyes } from './polish';
import { ATELIER, GROOM, PROC_PREFIX } from './record';

/** A BUILT PERSON DRESSED AS THE LAB DRAWS THEM: the lab's finish (`polish.ts`), then the game's textures (skin, irises, fabrics, `skinAppearance.ts`) with the lab's changes */

/** `painted`: painted skins by their source texture, kept by the caller (each made once). */
export async function dressPerson(person: BuiltPerson, spec: PersonSpec, layers: PersonLayers, painted: WeakMap<Texture, Texture>, sculpted = false, garmentColour: number | null = null): Promise<SkinAppearance> {
  polishPerson(person.meshes, spec.look, sculpted);
  // A grown hairstyle is no catalogue file: its card texture is not loaded (the lab draws hair solid anyway).
  // Made items have no catalogue texture: the skin is loaded without them.
  const own = spec.look.hairCut?.startsWith(PROC_PREFIX) || spec.look.hairCut === GROOM;
  const skin = await loadSkinAppearance({ ...spec, look: { ...spec.look, ...(own ? { hairCut: 'none' } : {}), extras: (spec.look.extras ?? []).filter((x) => x !== ATELIER) } });
  // The atelier's garment drawn in its own colour: its vertices out of the textured garment slots.
  const slotOf = texturedGarments(spec.look).indexOf(ATELIER) + 1;
  if (slotOf > 0 && garmentColour !== null) for (const m of person.meshes) {
    const slot = m.geometry.getAttribute('garmentSlot'), colour = m.geometry.getAttribute('color');
    if (!slot || !colour) continue;
    const c = new Color(garmentColour);
    for (let i = 0; i < slot.count; i++) if (Math.round(slot.getX(i)) === slotOf) { slot.setX(i, 0); colour.setXYZ(i, c.r, c.g, c.b); }
    slot.needsUpdate = true; colour.needsUpdate = true;
  }
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
