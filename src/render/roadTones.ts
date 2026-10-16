import type { CarriagewayMaterial, FootwayMaterial } from '@world/roadSection';

/** THE STREET SURFACES' TONES over their baked textures, one source for the near roads (`roadSurfaces.ts`, `roadSurfaceReads.ts`) and the far ones (`farRoadTiles.ts`) */

/** The colour the asphalt texture is authored against (sRGB): a class's colour (`RoadType.color`) over it is the tint its carriageway is drawn with. */
export const ASPHALT_REFERENCE = 0x3a3d3f;

/** A carriageway's colour by what it is paved with (sRGB); asphalt keeps its class's. */
export const CARRIAGEWAY_COLOUR: Readonly<Record<Exclude<CarriagewayMaterial, 'asphalt'>, number>> = {
  concrete: 0x8f8d88,
  cobble: 0x6a5f52,
};

/** A footway's tone over the baked pavers, by material, linear multipliers. */
export const FOOTWAY_TINT: Readonly<Record<FootwayMaterial, readonly [number, number, number]>> = {
  pavers: [1, 1, 1],
  concrete: [1.08, 1.08, 1.1],
  stone: [1, 0.84, 0.66],
};
