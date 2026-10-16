/** THE PERFORMANCE BUDGETS: one table for the game's own watch (the F9 monitor, `ui/healthWatch.ts`), the specs */

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

/** A step the game measures (`performance.measure('hitch:<name>')`), ms of one occurrence */
const STEP_BUDGETS: Readonly<Record<string, Budget>> = {
  'mutate/edit+after': { max: 150, level: 'warn', why: 'the click of an edit: commit and the undo text (65-112 ms)' },
  'mutate/after edit': { max: 150, level: 'warn', why: 'the click of an edit, with the network rebuilt (65-112 ms)' },
  'road-edit/utilities': { max: 120, level: 'warn', why: 'poles and wires rebuilt in an edit (68-86 ms)' },
  'road-edit/world rebuilt': { max: 2500, level: 'warn', why: 'a whole road edit, sliced (0.3-1.6 s)' },
  'commit/stations': { max: 120, level: 'warn', why: 'stations and stops in the commit (55-58 ms)' },
  'elevation/full': { max: 120, level: 'warn', why: 'road heights rebuilt (54-56 ms)' },
  'network/rebuild': { max: 60, level: 'warn', why: 'the network rebuilt (up to 12 ms)' },
  'draw/Rebuild': { max: 200, level: 'warn', why: 'a rebuild inside a frame (up to 187 ms)' },
  'draw/Pump': { max: 120, level: 'warn', why: 'a frame slice of work (up to 100 ms)' },
  'draw/Render': { max: 100, level: 'warn', why: 'drawing one frame, CPU (up to 83 ms)' },
};

/** DO NOT cut at the space first: 'mutate/after edit' and 'road-edit/world rebuilt' became 'mutate/after' and */
export function stepBudget(name: string): { readonly key: string; readonly budget: Budget } | null {
  const bare = name.startsWith('hitch:') ? name.slice(6) : name;
  const whole = STEP_BUDGETS[bare];
  if (whole) return { key: bare, budget: whole };
  const space = bare.indexOf(' ');
  const key = space < 0 ? bare : bare.slice(0, space);
  const budget = STEP_BUDGETS[key];
  return budget ? { key, budget } : null;
}

/** THE CITY PLAN'S BUDGETS: what the whole-map city may cost, from the plan */
export type CityView = 'street' | 'district' | 'map';

/** Per view: triangles and draw calls (colour + shadow) of one frame, GPU ms (p95), fps (a floor). */
export const VIEW_BUDGETS: Readonly<Record<CityView, { readonly triangles: number; readonly drawCalls: number; readonly gpuMs: number; readonly fps: number }>> = {
  street: { triangles: 10_000_000, drawCalls: 700 + 300, gpuMs: 12, fps: 60 },
  district: { triangles: 8_000_000, drawCalls: 800 + 300, gpuMs: 12, fps: 60 },
  map: { triangles: 4_000_000, drawCalls: 300 + 100, gpuMs: 12, fps: 50 },
};

/** What holds geometry on the GPU, by the plan's levels (§8.3); `null` budget: the plan sets none. */
export type MemoryGroup = 'L0 shells' | 'L0 building parts' | 'L1 masses' | 'L2 tiles' | 'L3 plates' | 'roads' | 'poles and wires' | 'terrain' | 'vegetation' | 'people and vehicles' | 'other';

/** MB of GPU memory each group may hold (§8.6, a city of 80 000 buildings). */
const MEMORY_BUDGETS_MB: Readonly<Record<MemoryGroup, number | null>> = {
  'L0 shells': 300,
  'L0 building parts': 150,
  'L1 masses': 120,
  'L2 tiles': 60,
  'L3 plates': 15,
  roads: null,
  'poles and wires': null,
  terrain: null,
  vegetation: null,
  'people and vehicles': null,
  other: null,
};

/** Textures (600 MB) and the live JavaScript heap (1.5 GB, `CIDADE-10KM.md`). */
const TEXTURE_BUDGET_MB = 600;
const HEAP_BUDGET_MB = 1500;

/** The plan's group of a scene object, by its name (`mesh.name`, as `buildingMesh.ts` and the others set it). */
export function memoryGroup(name: string): MemoryGroup {
  if (name.startsWith('building-preview')) return 'other';
  if (name.startsWith('building-shell')) return 'L0 shells';
  if (name.startsWith('building-massing')) return 'L1 masses';
  if (name.startsWith('building-')) return 'L0 building parts';
  if (/^(asphalt|footway|kerb|verge|curb-ramp|median-|markings-|road)/.test(name)) return 'roads';
  if (name.startsWith('utility-')) return 'poles and wires';
  if (/^(terrain-|flat-world)/.test(name)) return 'terrain';
  if (/^(garden-|far-forest|forest|tree|grass|woods|far-woods)/.test(name)) return 'vegetation';
  if (/^(citizen-|car-|bus-|truck-|vehicle|male-|female-)/.test(name)) return 'people and vehicles';
  return 'other';
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
  readonly measured: string;
  readonly budget: string;
  /** `over` first: what to work on. */
  readonly status: 'over' | 'ok' | 'no budget in the plan' | 'not measured' | 'approximate';
  /** How far over (measured / budget); 0 when within, or not comparable. */
  readonly times: number;
}

const mb = (bytes: number): number => Math.round(bytes / 1e5) / 10;
const fmt = (n: number): string => n.toLocaleString('en-US');

/** The plan's budgets against a measure, the rows furthest over first. */
export function cityBudgetTable(m: CityMeasure): BudgetRow[] {
  const v = VIEW_BUDGETS[m.view];
  const rows: BudgetRow[] = [];
  const cap = (item: string, value: number | null, budget: number | null, unit: string): void => {
    if (value === null) { rows.push({ item, measured: '—', budget: budget === null ? '—' : `≤ ${fmt(budget)} ${unit}`, status: 'not measured', times: 0 }); return; }
    if (budget === null) { rows.push({ item, measured: `${fmt(value)} ${unit}`, budget: '—', status: 'no budget in the plan', times: 0 }); return; }
    const over = value > budget;
    rows.push({ item, measured: `${fmt(value)} ${unit}`, budget: `≤ ${fmt(budget)} ${unit}`, status: over ? 'over' : 'ok', times: over ? Math.round((value / budget) * 10) / 10 : 0 });
  };
  cap(`triangles drawn (${m.view})`, m.triangles, v.triangles, '');
  cap(`draw calls, colour + shadow (${m.view})`, m.drawCalls, v.drawCalls, '');
  cap(`GPU p95 (${m.view})`, m.gpuMs, v.gpuMs, 'ms');
  const slow = m.fps < v.fps;
  rows.push({ item: `fps (${m.view})`, measured: fmt(m.fps), budget: `≥ ${v.fps}`, status: slow ? 'over' : 'ok', times: slow && m.fps > 0 ? Math.round((v.fps / m.fps) * 10) / 10 : 0 });

  const groups = new Map<MemoryGroup, number>();
  for (const [name, bytes] of m.bytesByName) {
    const g = memoryGroup(name);
    groups.set(g, (groups.get(g) ?? 0) + bytes);
  }
  for (const g of Object.keys(MEMORY_BUDGETS_MB) as MemoryGroup[]) cap(`video memory: ${g}`, mb(groups.get(g) ?? 0), MEMORY_BUDGETS_MB[g], 'MB');
  cap('video memory: textures (no mipmaps)', mb(m.textureBytes), TEXTURE_BUDGET_MB, 'MB');
  cap('video memory: render targets and shadows', m.targetBytes == null ? null : mb(m.targetBytes), 300, 'MB');
  rows.push({ item: 'geometry held on the CPU (part of the heap)', measured: `${fmt(mb(m.geometryCpuBytes))} MB`, budget: '—', status: 'no budget in the plan', times: 0 });
  rows.push({
    item: 'JS heap (performance.memory: heap + arrays, rounded)',
    measured: m.heapBytes === null ? '—' : `${fmt(mb(m.heapBytes))} MB`,
    budget: `≤ ${fmt(HEAP_BUDGET_MB)} MB`,
    status: m.heapBytes === null ? 'not measured' : 'approximate',
    times: 0,
  });
  const order = { over: 0, ok: 1, approximate: 2, 'no budget in the plan': 3, 'not measured': 4 } as const;
  return rows.sort((a, b) => order[a.status] - order[b.status] || b.times - a.times);
}
