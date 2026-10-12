/**
 * The world unit (`core/units.ts`), where `world`, `sim`, `editor`, `render`
 * and `ui` have always imported it from. It lives in `core` so that `view`
 * (which may import only `core`) writes its camera figures in metres too.
 */
export { METERS_PER_UNIT, TUNED_UNIT, UNITS_PER_METER, kmh, m, perM, stepsIn } from '@core/units';
