/** The engine has exactly ONE unit system: the world unit. */
export const METERS_PER_UNIT: number = 1;
export const UNITS_PER_METER = 1 / METERS_PER_UNIT;

/** Converts a real-world metre figure into world units. Build-time only. */
export const m = (metres: number): number => metres * UNITS_PER_METER;

/** Converts a figure PER METRE (a frequency, a texture's repeats, pixels a metre, a density along a road) into the same per */
export const perM = (perMetre: number): number => perMetre * METERS_PER_UNIT;

/** The world unit the game was drawn in until it moved to metres: 0.4 m. */
export const TUNED_UNIT = m(0.4);

/** How many steps of `stepMetres` a length in world units holds, read to a millionth of a step, so a count rounded */
export const stepsIn = (units: number, stepMetres: number): number =>
  Math.round((units * METERS_PER_UNIT / stepMetres) * 1e6) / 1e6;

/** Converts a km/h figure into world units per second. Build-time only. */
export const kmh = (kmPerHour: number): number => m((kmPerHour * 1000) / 3600);
