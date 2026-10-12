import type { LandscapeKind } from '../landscape';
import { BENCH_ZONE, LAMP_ZONE, TREE_KERB_SETBACK, TREE_PIT } from '../section';
import { m } from '../units';

/**
 * THE STREET FURNITURE CATALOGUE (docs/VIAS.md V7), by data: one entry per
 * piece the road system lays, with everything the sets, the rows dragged out
 * and the clear-walk rule read about it. The Etapa 5f catalogue of the main
 * session does not exist yet; when it does, these entries move into it.
 *
 * - `depth`: how far from the kerb face the piece reaches (`section.ts`
 *   zones), what NBR 9050's 1,20 m clear walk is measured behind.
 * - `every`/`first`: the spacing along a street and the first one past the
 *   corner, as Brazilian streets are laid (lamps 30 m, NBR 5101 urban
 *   lighting at 3-4 times an 8-10 m mounting height; hydrants 100 m, fire
 *   brigade rules of 60-120 m; trees 10 m; bins and benches 60 m).
 * - `rowEvery`: the spacing of a row dragged out with the landscaping tool.
 * - `sets`: the sets a new road is built with that include it; `rightOnly`
 *   for the pieces only one side of a street has.
 */
export interface FurnitureEntry {
  readonly kind: LandscapeKind;
  readonly nameKey: string;
  readonly depth: number;
  readonly every: number;
  readonly first: number;
  readonly rowEvery: number;
  readonly sets: readonly ('complete' | 'basic')[];
  readonly rightOnly?: true;
}

export const FURNITURE_CATALOG: readonly FurnitureEntry[] = [
  { kind: 'lamp', nameKey: 'streetscape.lamp', depth: LAMP_ZONE, every: m(30), first: m(6), rowEvery: m(30), sets: ['complete', 'basic'] },
  { kind: 'bin', nameKey: 'streetscape.bin', depth: BENCH_ZONE, every: m(60), first: m(9), rowEvery: m(30), sets: ['complete', 'basic'] },
  { kind: 'hydrant', nameKey: 'streetscape.hydrant', depth: LAMP_ZONE, every: m(100), first: m(20), rowEvery: m(100), sets: ['complete'], rightOnly: true },
  { kind: 'bench', nameKey: 'streetscape.bench', depth: BENCH_ZONE, every: m(60), first: m(24), rowEvery: m(20), sets: ['complete'] },
  { kind: 'tree', nameKey: 'streetscape.tree', depth: TREE_KERB_SETBACK + TREE_PIT, every: m(10), first: m(12), rowEvery: m(10), sets: ['complete'] },
  { kind: 'shrub', nameKey: 'streetscape.shrub', depth: BENCH_ZONE, every: m(3), first: m(4), rowEvery: m(3), sets: [] },
  { kind: 'postbox', nameKey: 'streetscape.postbox', depth: BENCH_ZONE, every: m(200), first: m(20), rowEvery: m(60), sets: [] },
  { kind: 'drain', nameKey: 'streetscape.drain', depth: m(0.1), every: m(30), first: m(10), rowEvery: m(30), sets: [] },
];

export const furnitureEntry = (kind: LandscapeKind): FurnitureEntry | undefined => FURNITURE_CATALOG.find((e) => e.kind === kind);
