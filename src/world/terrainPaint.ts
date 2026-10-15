/** Ground the player paints over the terrain: sand, soil, meadow, snow, gravel, asphalt, concrete */

/** The paintable layers, in channel order: two RGBA textures, then grass, then the covers. */
export const PAINT_KINDS = ['sand', 'soil', 'meadow', 'snow', 'gravel', 'asphalt', 'concrete', 'grass', 'forest', 'scrub', 'flowers', 'rocks', 'granite', 'sandstone', 'basalt',
  'cerrado', 'atlantic', 'amazon', 'caatinga', 'pampa', 'pantanal'] as const;
export type PaintKind = (typeof PAINT_KINDS)[number];

/** The kinds painted as a density of things standing on the ground. */
export const COVER_KINDS = ['forest', 'scrub', 'flowers', 'rocks'] as const;
export type CoverKind = (typeof COVER_KINDS)[number];
export const isCoverKind = (kind: PaintKind): kind is CoverKind => (COVER_KINDS as readonly string[]).includes(kind);

/** The rocks the land can be made of, in the terrain shader's layer order. */
const GEOLOGY_KINDS = ['granite', 'sandstone', 'basalt'] as const;
export type GeologyKind = (typeof GEOLOGY_KINDS)[number];
export const isGeologyKind = (kind: PaintKind): kind is GeologyKind => (GEOLOGY_KINDS as readonly string[]).includes(kind);

/** The BIOMES (`world/ecology.ts`): painting one makes that ground the biome's own country */
export const BIOME_KINDS = ['cerrado', 'atlantic', 'amazon', 'caatinga', 'pampa', 'pantanal'] as const;
export type BiomeKind = (typeof BIOME_KINDS)[number];
export const isBiomeKind = (kind: PaintKind): kind is BiomeKind => (BIOME_KINDS as readonly string[]).includes(kind);

export interface PaintDab {
  readonly kind: PaintKind;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** 0..1: how far one dab takes the ground to its layer at the centre. */
  readonly strength: number;
}

export function isPaintKind(value: unknown): value is PaintKind {
  return typeof value === 'string' && (PAINT_KINDS as readonly string[]).includes(value);
}

/** A map keeps at most this many dabs; the oldest go first. */
export const MAX_PAINT_DABS = 60_000;
