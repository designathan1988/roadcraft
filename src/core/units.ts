/**
 * The engine has exactly ONE unit system: the world unit.
 *
 * The V6 monolith mixed scales inside single expressions — a "sedan" of 9.6
 * against road widths of 15..46 and speeds of 28..54 — which is how the
 * downstream-storage formula came out negative for any block under ~32 units
 * (defect 2.2 of RELATORIO.md). Nothing in `src/world` or `src/sim` may convert
 * units; the constant below exists so that *derived* constants can be written
 * from real-world figures and checked, not so that runtime code can convert.
 *
 * One unit is one metre (since 2026-10-11, docs/ESCALA.md; the 0.4 m build of
 * before gone, the player, 2026-10-13): every length is written in metres
 * through `m()`, so the figures read as real carriageways (local 6.0 m,
 * street 8.8 m, avenue 13.6 m, boulevard 18.4 m). Maps saved at 0.4 m are
 * scaled on loading (`world/rescale.ts`).
 */
export const METERS_PER_UNIT: number = 1;
export const UNITS_PER_METER = 1 / METERS_PER_UNIT;

/** Converts a real-world metre figure into world units. Build-time only. */
export const m = (metres: number): number => metres * UNITS_PER_METER;

/**
 * Converts a figure PER METRE (a frequency, a texture's repeats, pixels a
 * metre, a density along a road) into the same per world unit. Build-time only.
 */
export const perM = (perMetre: number): number => perMetre * METERS_PER_UNIT;

/**
 * The world unit the game was drawn in until it moved to metres: 0.4 m.
 * Hand-tuned patterns with dozens of figures (the land's noise, the map
 * wall's strata) are read at this scale whatever the unit - one conversion at
 * their boundary, as a model's importer applies one scale factor (glTF 2.0
 * 3.4: lengths in metres; Unity's FBX "Scale Factor") - so they keep their
 * size in metres. Exactly 1 at 0.4 m a unit.
 */
export const TUNED_UNIT = m(0.4);

/**
 * How many steps of `stepMetres` a length in world units holds, read to a
 * millionth of a step, so a count rounded, floored or ceiled from it is the
 * same at any unit: a veranda 9.1 m wide holds 3.5 bays of 2.6 m, and its
 * width in units divided read 3.5000000000000004 at 0.4 m a unit and
 * 3.4999999999999996 at 1 - one post more or fewer.
 */
export const stepsIn = (units: number, stepMetres: number): number =>
  Math.round((units * METERS_PER_UNIT / stepMetres) * 1e6) / 1e6;

/** Converts a km/h figure into world units per second. Build-time only. */
export const kmh = (kmPerHour: number): number => m((kmPerHour * 1000) / 3600);
