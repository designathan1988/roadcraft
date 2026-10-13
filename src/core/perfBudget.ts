/**
 * THE PERFORMANCE BUDGETS: one table for the game's own watch (the F9 monitor,
 * `ui/healthWatch.ts`), the specs (`tests/perf/budgets.spec.ts`, run by
 * `npm run check`).
 *
 * A ratchet: each number is what the game does now with a margin, and may
 * only go DOWN. Raising one needs the player's yes (CLAUDE.md, "Performance
 * budgets"). A floor (`min`) guards the picture: a change that "speeds up" by
 * dropping detail fails as surely as one that slows down.
 *
 * As mature projects keep performance from rotting: limits measured and
 * enforced in the build (web.dev, "Performance budgets 101"); assertions that
 * fail the run at `error` and only report at `warn`, on the median of several
 * runs (Lighthouse CI); and counts of work rather than wall time where a
 * check must be stable from run to run (Iai/Bencher instruction counts) -
 * the specs count, the browser gate times.
 */

export interface Budget {
  /** The most it may be. */
  readonly max: number;
  /** The least it may be (a floor on the picture's detail). */
  readonly min?: number;
  /** `error` fails the check or the gate; `warn` is only reported. */
  readonly level: 'error' | 'warn';
  /** What it guards, and what it was when set. */
  readonly why: string;
}

/**
 * A step the game measures (`performance.measure('hitch:<name>')`), ms of one
 * occurrence, keyed by the name up to its first space. Over it, the F9 monitor
 * writes a warning with the step and its time. Measured 2026-10-11 on the
 * player's map and a generated town (CPU, headless).
 */
export const STEP_BUDGETS: Readonly<Record<string, Budget>> = {
  'mutate/edit+after': { max: 150, level: 'warn', why: 'o clique de uma edição: commit e texto do desfazer (65-112 ms)' },
  'mutate/after edit': { max: 150, level: 'warn', why: 'o clique de uma edição, com a rede refeita (65-112 ms)' },
  'road-edit/utilities': { max: 120, level: 'warn', why: 'postes e fios refeitos numa edição (68-86 ms)' },
  'road-edit/world rebuilt': { max: 2500, level: 'warn', why: 'uma edição de via inteira, fatiada (0,3-1,6 s)' },
  'commit/stations': { max: 120, level: 'warn', why: 'estações e pontos no commit (55-58 ms)' },
  'elevation/full': { max: 120, level: 'warn', why: 'alturas das vias refeitas (54-56 ms)' },
  'network/rebuild': { max: 60, level: 'warn', why: 'a rede refeita (até 12 ms)' },
  'draw/Rebuild': { max: 200, level: 'warn', why: 'reconstrução dentro de um quadro (até 187 ms)' },
  'draw/Pump': { max: 120, level: 'warn', why: 'fatia de trabalho de um quadro (até 100 ms)' },
  'draw/Render': { max: 100, level: 'warn', why: 'desenho de um quadro, CPU (até 83 ms)' },
};

/** The step a measure's name budgets, by its name up to the first space; null when none does. */
export function stepBudget(name: string): { readonly key: string; readonly budget: Budget } | null {
  const bare = name.startsWith('hitch:') ? name.slice(6) : name;
  const space = bare.indexOf(' ');
  const key = space < 0 ? bare : bare.slice(0, space);
  const budget = STEP_BUDGETS[key];
  return budget ? { key, budget } : null;
}

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
