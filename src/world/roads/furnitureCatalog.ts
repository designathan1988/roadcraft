import type { LandscapeKind } from '../landscape';
import { BENCH_ZONE, LAMP_ZONE, TREE_KERB_SETBACK, TREE_PIT } from '../section';
import { m } from '../units';

/** THE STREET FURNITURE CATALOGUE, by data */
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
