/** The tower kinds: the buildings drawn by parts of their own */

export const TOWER_KINDS = [
  'balconyMid', 'glassOffice', 'glassBalcony', 'beigeClassic', 'darkGlass',
  'whiteBalcony', 'brickFrame', 'roundGlass', 'darkGrid', 'artDeco',
  // The second set: each a different form, balcony, window and colour.
  'twistGreen', 'hexTerracotta', 'stepGarden', 'waveWhite', 'cubeBalcony',
  'twinNavy', 'octCopper', 'stackedBlocks', 'pinkCorner', 'triangleDark',
  // The city's buildings: town halls, hospitals, a church, a school, services, a cemetery.
  'cityHallBrick', 'decoSpire', 'hospitalA', 'loftBrick', 'cityHallWhite', 'forum', 'church', 'bank', 'school',
  'fireStation', 'police', 'hospitalB', 'cemetery',
  // The landmarks (2026-10-09): built from the facade kit's modules (`render/buildings/landmarks.ts`).
  'beauxArts', 'decoTower', 'modernOffice', 'residentialTerrace', 'glassSpire',
] as const;
export type TowerKind = (typeof TOWER_KINDS)[number];

/** The signature a building is drawn with, or null for the shared facade kit. */
export function signatureKind(b: { readonly blueprint?: string }): TowerKind | null {
  const kind = b.blueprint?.startsWith('signature:') ? b.blueprint.slice(10) : null;
  return kind && (TOWER_KINDS as readonly string[]).includes(kind) ? kind as TowerKind : null;
}
