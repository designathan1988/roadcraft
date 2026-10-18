import { Color, DoubleSide, FrontSide, MeshStandardMaterial } from 'three';

import { disposeSurfaceTextures, requireSurfaceMaps, surfaceTexture, type SurfaceBake } from './surfaceTextures';
import { ASPHALT_TILE, DECK_TILE, FOOTWAY_TILE, KERB_TILE, VERGE_TILE } from './bake/roadRecipes';
import { applyDetail, detailSwitch } from './mesh/detailLayer';
import { applyRoadEdges } from './mesh/roadEdges';
import { applyLotOverlay } from './lotOverlay';

/** Every material the scene uses, its surfaces baked at build time (`bake/roadRecipes.ts`) and shared. */

export interface SceneMaterials {
  readonly asphalt: MeshStandardMaterial;
  readonly asphaltRaised: MeshStandardMaterial;
  readonly footway: MeshStandardMaterial;
  readonly kerb: MeshStandardMaterial;
  readonly verge: MeshStandardMaterial;
  readonly deck: MeshStandardMaterial;
  /** The deck's concrete again, for the parapets. */
  readonly parapet: MeshStandardMaterial;
  readonly concrete: MeshStandardMaterial;
  readonly steel: MeshStandardMaterial;
  /** World units one tile of each surface covers, for UV generation. */
  readonly scale: {
    readonly asphalt: number;
    readonly footway: number;
    readonly kerb: number;
    readonly verge: number;
    readonly deck: number;
  };
  /** Switches the close-zoom detail layer on every material that has one. */
  setDetail(enabled: boolean): void;
  dispose(): void;
}

export function createMaterials(anisotropy: number): SceneMaterials {
  const road = requireSurfaceMaps('asphalt', anisotropy);
  // The raised crossings' paler asphalt: its own colour on the road's normal and roughness.
  const raised: SurfaceBake = { ...road, map: surfaceTexture('asphalt-raised:map', anisotropy) };
  const footway = requireSurfaceMaps('footway', anisotropy);
  const kerb = requireSurfaceMaps('kerb', anisotropy);
  const verge = requireSurfaceMaps('verge', anisotropy);
  const deck = requireSurfaceMaps('deck', anisotropy);

  const surface = (
    bake: SurfaceBake,
    tint: number,
    roughness: number,
    metalness: number,
    normalScale: number,
    /** Whether the mesh's own `color` attribute multiplies this material. */
    vertexColors = false,
  ): MeshStandardMaterial => {
    const material = new MeshStandardMaterial({
      color: new Color(tint),
      map: bake.map,
      normalMap: bake.normalMap,
      roughnessMap: bake.roughnessMap,
      roughness,
      metalness,
      side: FrontSide,
      // Both sides into the shadow map.
      shadowSide: DoubleSide,
      envMapIntensity: 0.55,
      vertexColors,
    });
    material.normalScale.set(normalScale, normalScale);
    return material;
  };

  const materials: MeshStandardMaterial[] = [];
  const keep = <T extends MeshStandardMaterial>(value: T): T => {
    materials.push(value);
    return value;
  };

  const asphalt = keep(surface(road, 0xffffff, 1, 0.02, 1, true));
  const asphaltRaised = keep(surface(raised, 0xffffff, 1, 0.02, 0.9, true));
  // Per-vertex tone: a footway's material (`roadSurfaces.ts` `footwayTint`).
  const footwayMaterial = keep(surface(footway, 0xffffff, 1, 0, 1, true));
  const kerbMaterial = keep(surface(kerb, 0xffffff, 1, 0, 0.85));
  const vergeMaterial = keep(surface(verge, 0xffffff, 1, 0, 0.9));
  const deckMaterial = keep(surface(deck, 0xffffff, 1, 0.02, 1));
  const parapetMaterial = keep(surface(deck, 0xffffff, 1, 0.02, 1));

  // The close-zoom layer.
  applyDetail(asphalt, { kind: 'asphalt', macroTile: ASPHALT_TILE, albedo: 0.6, normal: 0.65, macroBlur: 1.6 }, anisotropy);
  applyDetail(asphaltRaised, { kind: 'asphalt', macroTile: ASPHALT_TILE, albedo: 0.6, normal: 0.65, macroBlur: 1.6 }, anisotropy);
  applyDetail(footwayMaterial, { kind: 'concrete', macroTile: FOOTWAY_TILE, albedo: 0.7, normal: 0.8, macroBlur: 0.6 }, anisotropy);
  // The marks of their use along their edges (`mesh/roadEdges.ts`).
  applyRoadEdges(asphalt, 'carriageway');
  applyRoadEdges(asphaltRaised, 'carriageway');
  applyRoadEdges(footwayMaterial, 'footway');
  applyDetail(kerbMaterial, { kind: 'concrete', macroTile: KERB_TILE, albedo: 0.55, normal: 0.7, macroBlur: 0.8 }, anisotropy);
  applyDetail(vergeMaterial, { kind: 'grass', macroTile: VERGE_TILE, albedo: 1, normal: 1.2, macroBlur: 2 }, anisotropy);
  applyDetail(deckMaterial, { kind: 'concrete', macroTile: DECK_TILE, albedo: 0.6, normal: 0.8, macroBlur: 1 }, anisotropy);
  applyDetail(parapetMaterial, { kind: 'concrete', macroTile: DECK_TILE, albedo: 0.6, normal: 0.8, macroBlur: 1 }, anisotropy);
  // The lots coloured into the street's own surfaces (`lotOverlay.ts`)
  applyLotOverlay(asphalt);
  applyLotOverlay(asphaltRaised);
  applyLotOverlay(footwayMaterial);
  applyLotOverlay(kerbMaterial);
  applyLotOverlay(vergeMaterial);
  applyLotOverlay(deckMaterial);

  return {
    asphalt,
    asphaltRaised,
    footway: footwayMaterial,
    kerb: kerbMaterial,
    verge: vergeMaterial,
    deck: deckMaterial,
    parapet: parapetMaterial,
    concrete: keep(
      new MeshStandardMaterial({
        color: 0x9fa4a2,
        map: deck.map,
        normalMap: deck.normalMap,
        roughnessMap: deck.roughnessMap,
        roughness: 1,
        metalness: 0.02,
        side: FrontSide,
      }),
    ),
    steel: keep(
      new MeshStandardMaterial({
        color: 0x8e979a,
        roughness: 0.42,
        metalness: 0.72,
        side: DoubleSide,
      }),
    ),
    scale: {
      asphalt: ASPHALT_TILE,
      footway: FOOTWAY_TILE,
      kerb: KERB_TILE,
      verge: VERGE_TILE,
      deck: DECK_TILE,
    },
    setDetail(enabled) {
      detailSwitch.value = enabled ? 1 : 0;
    },
    dispose() {
      for (const material of materials) material.dispose();
      // The baked textures (detail layers included) are shared and kept by name, so they are the material set's to release
      disposeSurfaceTextures();
    },
  };
}
