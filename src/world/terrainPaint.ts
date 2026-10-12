/**
 * Ground the player paints over the terrain: sand, soil, meadow, snow,
 * gravel, asphalt, concrete - and grass, which paints the others away - and
 * the COVERS, painted as a density and planted by the renderer
 * (`render/terrain.ts` keeps it, `render/renderer.ts` plants it): forest
 * (trees with an understorey), scrub (low bush), flowers and rocks - and the
 * GEOLOGY: which rock the land is made of where it breaks out on a slope
 * (granite, sandstone, basalt; granite where nothing was painted). A biome
 * layer of a terrain auto-material: painted once, every cliff in it takes
 * that rock (Brushify's biome layers; Terrain3D's per-vertex texture id).
 *
 * Texture splatting, as engines store painted terrain layers: a weight per
 * layer per texel, four layers to an RGBA texture, the weights summing to at
 * most one and the terrain's own grass showing through the rest
 * (https://en.wikipedia.org/wiki/Texture_splatting). The document keeps the
 * DABS (where, how wide, how strong, which layer), so a painted map saves,
 * loads and undoes like the land stamps; the renderer rasterises them into
 * the weight textures (`render/terrain.ts`). Painting moves no height, so it
 * re-solves no road.
 */

/**
 * The paintable layers, in channel order: two RGBA textures, then grass, then
 * the covers. New kinds go on the END: a saved map stores kinds by name, but
 * the first eight are texture channels by their place in this list.
 */
export const PAINT_KINDS = ['sand', 'soil', 'meadow', 'snow', 'gravel', 'asphalt', 'concrete', 'grass', 'forest', 'scrub', 'flowers', 'rocks', 'granite', 'sandstone', 'basalt',
  'cerrado', 'atlantic', 'amazon', 'caatinga', 'pampa', 'pantanal'] as const;
export type PaintKind = (typeof PAINT_KINDS)[number];

/** The kinds painted as a density of things standing on the ground. */
export const COVER_KINDS = ['forest', 'scrub', 'flowers', 'rocks'] as const;
export type CoverKind = (typeof COVER_KINDS)[number];
export const isCoverKind = (kind: PaintKind): kind is CoverKind => (COVER_KINDS as readonly string[]).includes(kind);

/**
 * The rocks the land can be made of, in the terrain shader's layer order.
 * Painting one moves no ground and paints no surface: it sets which rock the
 * cliffs, outcrops and soil of that area are (`render/terrain.ts`).
 */
export const GEOLOGY_KINDS = ['granite', 'sandstone', 'basalt'] as const;
export type GeologyKind = (typeof GEOLOGY_KINDS)[number];
export const isGeologyKind = (kind: PaintKind): kind is GeologyKind => (GEOLOGY_KINDS as readonly string[]).includes(kind);

/**
 * The BIOMES (`world/ecology.ts`): painting one makes that ground the biome's
 * own country - its plant communities chosen by the land, as the map's
 * region does everywhere else. Moves no ground and paints no surface.
 */
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
