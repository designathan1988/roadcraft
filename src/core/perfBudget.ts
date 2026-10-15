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
const STEP_BUDGETS: Readonly<Record<string, Budget>> = {
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

/**
 * The step a measure's name budgets: by its whole name, else by its name up
 * to the first space (a step that adds a detail after it); null when none does.
 * DO NOT cut at the space first: 'mutate/after edit' and 'road-edit/world
 * rebuilt' became 'mutate/after' and 'road-edit/world', which no row holds, and
 * those two steps were never held to a budget.
 */
export function stepBudget(name: string): { readonly key: string; readonly budget: Budget } | null {
  const bare = name.startsWith('hitch:') ? name.slice(6) : name;
  const whole = STEP_BUDGETS[bare];
  if (whole) return { key: bare, budget: whole };
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

/**
 * THE CITY PLAN'S BUDGETS: what the whole-map city may cost, from the plan
 * (`docs/PESQUISA-CIDADE-10KM.md` §8.6, `docs/CIDADE-10KM.md`), for an RTX
 * 3060 at 1920×1080. `__roadcraft.budget(view)` measures the running game
 * against them (`cityBudgetTable`): performance work starts from the row
 * furthest over, and a change that mends one row by breaking another is
 * wrong. Change a number here only with the plan, and the plan only with the
 * player's yes.
 */
export type CityView = 'rua' | 'bairro' | 'mapa';

/** Per view: triangles and draw calls (colour + shadow) of one frame, GPU ms (p95), fps (a floor). */
export const VIEW_BUDGETS: Readonly<Record<CityView, { readonly triangles: number; readonly drawCalls: number; readonly gpuMs: number; readonly fps: number }>> = {
  rua: { triangles: 10_000_000, drawCalls: 700 + 300, gpuMs: 12, fps: 60 },
  bairro: { triangles: 8_000_000, drawCalls: 800 + 300, gpuMs: 12, fps: 60 },
  mapa: { triangles: 4_000_000, drawCalls: 300 + 100, gpuMs: 12, fps: 50 },
};

/** What holds geometry on the GPU, by the plan's levels (§8.3); `null` budget: the plan sets none. */
export type MemoryGroup = 'L0 cascas' | 'L0 peças dos prédios' | 'L1 massas' | 'L2 ladrilhos' | 'L3 placas' | 'vias' | 'postes e fios' | 'terreno' | 'vegetação' | 'pessoas e veículos' | 'outros';

/** MB of GPU memory each group may hold (§8.6, a city of 80 000 buildings). */
const MEMORY_BUDGETS_MB: Readonly<Record<MemoryGroup, number | null>> = {
  'L0 cascas': 300,
  'L0 peças dos prédios': 150,
  'L1 massas': 120,
  'L2 ladrilhos': 60,
  'L3 placas': 15,
  vias: null,
  'postes e fios': null,
  terreno: null,
  vegetação: null,
  'pessoas e veículos': null,
  outros: null,
};

/** Textures (600 MB) and the live JavaScript heap (1.5 GB, `CIDADE-10KM.md`). */
const TEXTURE_BUDGET_MB = 600;
const HEAP_BUDGET_MB = 1500;

/** The plan's group of a scene object, by its name (`mesh.name`, as `buildingMesh.ts` and the others set it). */
export function memoryGroup(name: string): MemoryGroup {
  if (name.startsWith('building-preview')) return 'outros';
  if (name.startsWith('building-shell-')) return 'L0 cascas';
  if (name.startsWith('building-massing')) return 'L1 massas';
  if (name.startsWith('building-')) return 'L0 peças dos prédios';
  if (/^(asphalt|footway|kerb|verge|curb-ramp|median-|markings-|road)/.test(name)) return 'vias';
  if (name.startsWith('utility-')) return 'postes e fios';
  if (/^(terrain-|flat-world)/.test(name)) return 'terreno';
  if (/^(garden-|far-forest|forest|tree|grass|woods|far-woods)/.test(name)) return 'vegetação';
  if (/^(citizen-|car-|bus-|truck-|vehicle|male-|female-)/.test(name)) return 'pessoas e veículos';
  return 'outros';
}

/** What `__roadcraft.budget` measured in the running game. */
export interface CityMeasure {
  readonly view: CityView;
  /** Of the last frame drawn, every pass (`renderer.info.render`). */
  readonly triangles: number;
  readonly drawCalls: number;
  /** p95 of the last frames' GPU time; null when the GPU timer is not there. */
  readonly gpuMs: number | null;
  readonly fps: number;
  /** GPU geometry bytes by object name (`render/memoryCounters.ts`). */
  readonly bytesByName: ReadonlyMap<string, number>;
  readonly textureBytes: number;
  /** The render targets and shadow maps (`render/targetBytes.ts`, an estimate); null where they are not counted. */
  readonly targetBytes?: number | null;
  /** Geometry still held by JavaScript arrays: exact, part of the heap. */
  readonly geometryCpuBytes: number;
  /** Chromium's `performance.memory.usedJSHeapSize`: V8 heap PLUS external memory (the arrays), bucketed; null elsewhere. */
  readonly heapBytes: number | null;
}

export interface BudgetRow {
  readonly item: string;
  readonly medido: string;
  readonly orçamento: string;
  /** `acima` first: what to work on. */
  readonly situação: 'acima' | 'ok' | 'sem orçamento no plano' | 'não medido' | 'aproximado';
  /** How far over (measured / budget); 0 when within, or not comparable. */
  readonly vezes: number;
}

const mb = (bytes: number): number => Math.round(bytes / 1e5) / 10;
const fmt = (n: number): string => n.toLocaleString('pt-BR');

/** The plan's budgets against a measure, the rows furthest over first. */
export function cityBudgetTable(m: CityMeasure): BudgetRow[] {
  const v = VIEW_BUDGETS[m.view];
  const rows: BudgetRow[] = [];
  const cap = (item: string, value: number | null, budget: number | null, unit: string): void => {
    if (value === null) { rows.push({ item, medido: '—', orçamento: budget === null ? '—' : `≤ ${fmt(budget)} ${unit}`, situação: 'não medido', vezes: 0 }); return; }
    if (budget === null) { rows.push({ item, medido: `${fmt(value)} ${unit}`, orçamento: '—', situação: 'sem orçamento no plano', vezes: 0 }); return; }
    const over = value > budget;
    rows.push({ item, medido: `${fmt(value)} ${unit}`, orçamento: `≤ ${fmt(budget)} ${unit}`, situação: over ? 'acima' : 'ok', vezes: over ? Math.round((value / budget) * 10) / 10 : 0 });
  };
  cap(`triângulos desenhados (${m.view})`, m.triangles, v.triangles, '');
  cap(`draw calls, cor + sombra (${m.view})`, m.drawCalls, v.drawCalls, '');
  cap(`GPU p95 (${m.view})`, m.gpuMs, v.gpuMs, 'ms');
  const slow = m.fps < v.fps;
  rows.push({ item: `fps (${m.view})`, medido: fmt(m.fps), orçamento: `≥ ${v.fps}`, situação: slow ? 'acima' : 'ok', vezes: slow && m.fps > 0 ? Math.round((v.fps / m.fps) * 10) / 10 : 0 });

  const groups = new Map<MemoryGroup, number>();
  for (const [name, bytes] of m.bytesByName) {
    const g = memoryGroup(name);
    groups.set(g, (groups.get(g) ?? 0) + bytes);
  }
  for (const g of Object.keys(MEMORY_BUDGETS_MB) as MemoryGroup[]) cap(`memória de vídeo: ${g}`, mb(groups.get(g) ?? 0), MEMORY_BUDGETS_MB[g], 'MB');
  cap('memória de vídeo: texturas (sem mipmaps)', mb(m.textureBytes), TEXTURE_BUDGET_MB, 'MB');
  cap('memória de vídeo: alvos de render e sombras', m.targetBytes == null ? null : mb(m.targetBytes), 300, 'MB');
  rows.push({ item: 'geometria presa na CPU (parte do heap)', medido: `${fmt(mb(m.geometryCpuBytes))} MB`, orçamento: '—', situação: 'sem orçamento no plano', vezes: 0 });
  rows.push({
    item: 'heap JS (performance.memory: heap + arrays, arredondado)',
    medido: m.heapBytes === null ? '—' : `${fmt(mb(m.heapBytes))} MB`,
    orçamento: `≤ ${fmt(HEAP_BUDGET_MB)} MB`,
    situação: m.heapBytes === null ? 'não medido' : 'aproximado',
    vezes: 0,
  });
  const order = { acima: 0, ok: 1, aproximado: 2, 'sem orçamento no plano': 3, 'não medido': 4 } as const;
  return rows.sort((a, b) => order[a.situação] - order[b.situação] || b.vezes - a.vezes);
}
