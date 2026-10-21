import type { Budget } from '@core/perfBudget';
import type { QualityLevel } from '@render/quality';

/** The specs' counts: exact, the same on every run (`tests/perf`). */
export const COUNT_BUDGETS = {
  /** Rings measured per corner of the ground graded to the default town's 761 buildings (7.59): the nearest-ring pruning (`pads.ts`). */
  padRingsPerCorner: { max: 9.5, level: 'error', why: 'the platforms pruning (7.59; without it ~tens)' },
  /** Kerb edges walked per `kerbward` ask over the default town (208.6): its pruning (`poleLines.ts`). */
  kerbEdgesPerAsk: { max: 260, level: 'error', why: 'the kerb pruning (208.6; without it the whole city)' },
  /** Cells of the default town's crossing surface (21 297). */
  townWalkableCells: { max: 30_000, level: 'error', why: 'crossing grids of the default town (21 297)' },
  /** Triangles of the road surfaces of `tests/fixtures/grid-and-bends.json` (275 691): neither bloated nor stripped of detail. */
  fixtureRoadTriangles: { min: 120_000, max: 150_000, level: 'error', why: 'road surfaces of the fixed scene (133 500, the same since this budget was moved in 22248754: the 275 691 it was set to was never what this scene draws)' },
  /** Meshes (draw calls) of the same surfaces (134). */
  fixtureRoadMeshes: { max: 160, level: 'error', why: 'surface meshes of the fixed scene (134)' },
} as const satisfies Readonly<Record<string, Budget>>;

/** Whether a value keeps its budget. */
export function withinBudget(value: number, budget: Budget): boolean {
  return value <= budget.max && (budget.min === undefined || value >= budget.min);
}

/** The views the tiers are counted at (`tests/support/sceneHarness.ts`: the photographs' map, district and street). */
export type TierView = 'map' | 'district' | 'street';

/** What three issued for a view standing still (`settled`) and at most in one frame on the way there (`peak`: the frame that drew the sun's cascades whole over the colour pass). */
export interface TierViewCounts {
  readonly draws: number;
  readonly triangles: number;
  readonly peakDraws: number;
  readonly peakTriangles: number;
}

/** The share over today's counts a tier's budget allows: past it, something draws more than it did and the commit says why. */
export const TIER_MARGIN = 0.1;
/** The share over today's retained heap the city may hold on a tier (the heap moves by ~0.2 % between runs; the counts never). */
export const TIER_HEAP_MARGIN = 0.15;

/**
 * TODAY'S COUNTS OF THE SMALL CITY OF SEED 7 ON EACH TIER (`tests/perf/budgets.spec.ts`), exact on every run: the city opened on `low`
 * (the weak machine's tier) and raised a tier at a time on the same scene (`setQuality`, as `graphicsWiring.ts` applies a tier), each
 * view settled. Budget: each count times 1 + `TIER_MARGIN`. A change made on purpose updates them in the same commit, and says why.
 * `heapMB`: the JS heap the opened city keeps on that tier after a full collection, over the heap before it was opened.
 */
export const TIER_COUNTS: Readonly<Record<QualityLevel, { readonly views: Readonly<Record<TierView, TierViewCounts>>; readonly heapMB: number }>> = {
  low: {
    views: {
      map: { draws: 216, triangles: 1_937_803, peakDraws: 216, peakTriangles: 1_937_803 },
      district: { draws: 234, triangles: 4_391_460, peakDraws: 234, peakTriangles: 4_391_460 },
      street: { draws: 306, triangles: 4_349_604, peakDraws: 396, peakTriangles: 7_884_909 },
    },
    heapMB: 140,
  },
  medium: {
    views: {
      map: { draws: 262, triangles: 2_418_649, peakDraws: 526, peakTriangles: 3_917_989 },
      district: { draws: 240, triangles: 4_484_404, peakDraws: 456, peakTriangles: 7_882_209 },
      street: { draws: 353, triangles: 4_692_185, peakDraws: 712, peakTriangles: 12_402_144 },
    },
    heapMB: 146.3,
  },
  high: {
    views: {
      map: { draws: 270, triangles: 2_418_657, peakDraws: 523, peakTriangles: 3_937_481 },
      district: { draws: 248, triangles: 4_484_412, peakDraws: 495, peakTriangles: 8_360_571 },
      street: { draws: 361, triangles: 4_692_193, peakDraws: 758, peakTriangles: 10_589_682 },
    },
    heapMB: 148,
  },
  ultra: {
    views: {
      map: { draws: 281, triangles: 2_751_151, peakDraws: 558, peakTriangles: 5_285_751 },
      district: { draws: 248, triangles: 4_484_412, peakDraws: 496, peakTriangles: 8_371_803 },
      street: { draws: 361, triangles: 4_692_193, peakDraws: 760, peakTriangles: 10_598_811 },
    },
    heapMB: 148.7,
  },
};
