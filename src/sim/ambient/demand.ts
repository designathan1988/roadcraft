import type { Building } from '@world/buildings/types';

/**
 * What the land use asks of the streets at each hour: how busy each kind of
 * place is, how many go in and come out of it, how many people and cars a
 * street of it carries. Read by the scenery's people (`ambient.ts`) and by
 * the cars of the lots (`agents/lotTraffic.ts`), so both follow one clock.
 */

/** What kind of place the view is on: shares of each, from the buildings round it. */
export interface Mix { readonly home: number; readonly shop: number; readonly work: number; readonly civic: number }

/** How busy each kind of place is at an hour (0..1): bumps at the hours people go out (GTA's day of the popcycle). */
export function busy(kind: keyof Mix, hour: number): number {
  const bump = (at: number, width: number): number => {
    const d = ((hour - at + 36) % 24) - 12;
    return Math.exp(-(d * d) / (2 * width * width));
  };
  // A street is never empty by day: the peaks on a floor of half (a quarter by night).
  const day = 0.25 + 0.25 * bump(13, 4.5);
  switch (kind) {
    case 'home': return Math.min(1, day + 0.5 * bump(8, 1.3) + 0.3 * bump(13, 3) + 0.6 * bump(18.5, 2));
    case 'shop': return Math.min(1, day + 0.35 * bump(9, 1.5) + 0.6 * bump(13, 2.5) + 0.6 * bump(18, 2.5));
    case 'work': return Math.min(1, day + 0.6 * bump(7.5, 1) + 0.3 * bump(12.5, 1.5) + 0.6 * bump(17.5, 1.2));
    case 'civic': return Math.min(1, day + 0.5 * bump(11, 3) + 0.4 * bump(16, 2));
  }
}
/**
 * Percent of people (15 and over) working, and purchasing goods and services,
 * at each hour of the day from midnight: the American Time Use Survey, table
 * A-3, 2009-13 averages (bls.gov/tus/tables/a3_0913.htm).
 */
const WORKING = [2.3, 1.8, 1.5, 1.5, 2.2, 3.6, 7.5, 15.7, 24.8, 28.8, 29.9, 30.3, 23.8, 27.5, 29.6, 28.7, 25.8, 19.2, 12.0, 8.4, 6.8, 5.8, 4.7, 3.4];
const PURCHASING = [0.2, 0.1, 0.1, 0.1, 0.1, 0.2, 0.4, 0.9, 2.0, 3.8, 5.8, 7.1, 7.8, 7.6, 7.3, 7.1, 6.9, 6.5, 5.2, 4.1, 2.9, 1.7, 0.8, 0.4];
/** How long a stay lasts, hours: a working day, an errand. */
const WORK_STAY = 8;
const ERRAND_STAY = 0.5;
/** A table of the hours at `hour` (fractional, wrapping round midnight). */
function atHour(table: readonly number[], hour: number): number {
  const h = ((hour % 24) + 24) % 24, i = Math.floor(h), u = h - i;
  return table[i]! * (1 - u) + table[(i + 1) % 24]! * u;
}
/**
 * People going in at and coming out of a kind of place at an hour (shares of
 * everybody, an hour): from how many are there (`WORKING`, `PURCHASING`),
 * the arrivals are its rise and the departures its fall, and each also the
 * stays ending and begun (as many as are there over how long a stay lasts).
 * The home's are the others' the other way round: out to work and errands,
 * back from them. A shop's errands come and go all day; a works fills in the
 * morning and empties in the evening; a home empties in the morning.
 */
export function flows(kind: keyof Mix, hour: number): { in: number; out: number } {
  if (kind === 'home') {
    const work = flows('work', hour), shop = flows('shop', hour);
    return { in: work.out + shop.out, out: work.in + shop.in };
  }
  const table = kind === 'work' ? WORKING : PURCHASING;
  const stay = kind === 'work' ? WORK_STAY : ERRAND_STAY;
  const there = atHour(table, hour), rise = atHour(table, hour + 0.5) - atHour(table, hour - 0.5);
  return { in: Math.max(0, rise) + there / stay, out: Math.max(0, -rise) + there / stay };
}
/** Share of the walks at a kind of place, at an hour, that come out of it (the rest go in). */
export function outShare(kind: keyof Mix, hour: number): number {
  const f = flows(kind, hour);
  return f.in + f.out > 0 ? f.out / (f.in + f.out) : 0.5;
}
/**
 * People per 100 m of street at full bustle, and cars: a shopping street as a
 * GTA street is, a body every few metres of pavement; a residential one quieter.
 */
export const PEOPLE: Mix = { home: 7, shop: 24, work: 9, civic: 15 };
export const CARS: Mix = { home: 2.6, shop: 6, work: 4.8, civic: 3.6 };

/** What kind of place a building is, from its function or its zone. */
export function kindOf(b: Building): keyof Mix {
  const fn = b.function ?? '';
  if (/house|apartment|residential|townhouse|flat/i.test(fn)) return 'home';
  if (/shop|market|mall|restaurant|cafe|bar|bakery|pharmacy|bank|hotel|cinema/i.test(fn)) return 'shop';
  if (/factory|warehouse|industrial|works|office/i.test(fn)) return 'work';
  if (fn) return 'civic';
  return b.use === 'commercial' ? 'shop' : b.use === 'industrial' ? 'work' : b.use === 'residential' ? 'home' : 'civic';
}
