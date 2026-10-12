/** Authored land-use area. Buildings generated from it remain ordinary editable buildings. */
export const ZONE_USES = ['residential', 'commercial', 'industrial'] as const;
export const ZONE_DENSITIES = ['low', 'medium', 'high'] as const;
export type ZoneUse = (typeof ZONE_USES)[number];
export type ZoneDensity = (typeof ZONE_DENSITIES)[number];

export interface Zone {
  readonly id: number;
  readonly use: ZoneUse;
  readonly density: ZoneDensity;
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly seed: number;
  readonly buildingIds: readonly number[];
}

export const isZoneUse = (value: unknown): value is ZoneUse => ZONE_USES.includes(value as ZoneUse);
export const isZoneDensity = (value: unknown): value is ZoneDensity => ZONE_DENSITIES.includes(value as ZoneDensity);

/**
 * One zoned cell of the street grid (`world/zoneGrid.ts`), stored by where it
 * stands so it survives the road being split or its ids changing: the cell
 * that stands within half a cell of it is the cell it marks.
 */
export interface ZoneMark {
  readonly x: number;
  readonly y: number;
  readonly use: ZoneUse;
  readonly density: ZoneDensity;
  /** The building that grew on it, while that building stands. */
  readonly building?: number;
}

export const isZoneMark = (raw: unknown): raw is ZoneMark => {
  const v = raw as Partial<ZoneMark> | null;
  return !!v && Number.isFinite(v.x) && Number.isFinite(v.y) && isZoneUse(v.use) && isZoneDensity(v.density) &&
    (v.building === undefined || Number.isInteger(v.building));
};
