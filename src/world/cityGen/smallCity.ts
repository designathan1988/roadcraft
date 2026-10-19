import { DEFAULT_CITY, type CityPlan, planCity } from './plan';

/** THE SMALL CITY OF ROADCRAFT 2.0: one round city at the middle of the map, planned as 2.0 planned it (`planCity` with 2.0's defaults: the 'blocks' style, a straight rectangular grid, medium size). Everything follows from the seed. */

const plans = new Map<number, CityPlan>();

/** The city of a seed, planned once. */
export function smallCityPlan(seed: number): CityPlan {
  let plan = plans.get(seed);
  if (!plan) plans.set(seed, plan = planCity({ ...DEFAULT_CITY, seed }));
  return plan;
}
