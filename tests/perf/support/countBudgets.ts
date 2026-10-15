import type { Budget } from '@core/perfBudget';

/**
 * The specs' counts: exact, the same on every run (`tests/perf`). Measured
 * 2026-10-11.
 */
export const COUNT_BUDGETS = {
  /** Rings measured per corner of the ground graded to the default town's 761 buildings (7.59): the nearest-ring pruning (`pads.ts`). */
  padRingsPerCorner: { max: 9.5, level: 'error', why: 'poda das plataformas (7,59; sem ela ~dezenas)' },
  /** Kerb edges walked per `kerbward` ask over the default town (208.6): its pruning (`poleLines.ts`). */
  kerbEdgesPerAsk: { max: 260, level: 'error', why: 'poda do meio-fio (208,6; sem ela a cidade inteira)' },
  /** Cells of the default town's crossing surface (21 297). */
  townWalkableCells: { max: 30_000, level: 'error', why: 'grades das travessias da cidade padrão (21 297)' },
  /** Triangles of the road surfaces of `tests/fixtures/grid-and-bends.json` (275 691): neither bloated nor stripped of detail. */
  fixtureRoadTriangles: { min: 220_000, max: 330_000, level: 'error', why: 'superfícies das vias da cena fixa (275 691)' },
  /** Meshes (draw calls) of the same surfaces (134). */
  fixtureRoadMeshes: { max: 160, level: 'error', why: 'malhas das superfícies da cena fixa (134)' },
} as const satisfies Readonly<Record<string, Budget>>;

/** Whether a value keeps its budget. */
export function withinBudget(value: number, budget: Budget): boolean {
  return value <= budget.max && (budget.min === undefined || value >= budget.min);
}
