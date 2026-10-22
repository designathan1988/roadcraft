import { VIEW_BUDGETS } from '@core/perfBudget';
import type { LabContext } from '../labTypes';
import { labOpt } from './items';
import {
  type Cancel, Cancelled, HITCH_MS, type Holdings, type ViewId, cameraAt, check, collectFrames, goToView, holdScene, holdings, probe,
  programs, restoreCamera, round, settle, slope, sleep, windowStats,
} from './measure';

/** THE BENCHMARKS: the standard views against the plan's budgets (`VIEW_BUDGETS`, `__roadcraft.budget`), the simulation pushed (its speed,
 *  its traffic and people), the leak test (the camera moved for a while: the heap and the GPU's objects must not climb), the shaders' hitches
 *  (switches that compile programs flipped: the hitches and the programs counted) and a long run with the game going. */

export type BenchmarkKind = 'views' | 'stress' | 'leak' | 'hitch' | 'longrun';
export const BENCHMARK_LABELS: Readonly<Record<BenchmarkKind, string>> = {
  views: 'View route × budget', stress: 'Simulation stress', leak: 'Leak (camera moving)',
  hitch: 'Shaders and hitches', longrun: 'Long stability',
};

export interface BenchmarkOptions {
  readonly frames?: number;
  /** Seconds (leak, long run). */
  readonly seconds?: number;
  readonly origin?: boolean;
}

/** One line of a benchmark: what was looked at, the figure, its budget or reference, a status. */
export interface BenchRow {
  readonly bench: BenchmarkKind;
  readonly case: string;
  readonly metric: string;
  readonly value: number | null;
  readonly unit: string;
  readonly reference: string;
  readonly status: 'ok' | 'over' | 'grows' | 'info' | 'hitch';
}

export interface BenchmarkResult {
  readonly kind: 'benchmark';
  readonly bench: BenchmarkKind;
  readonly startedAt: string;
  readonly ms: number;
  readonly cancelled: boolean;
  readonly warnings: readonly string[];
  readonly rows: readonly BenchRow[];
}

export async function runBenchmark(ctx: LabContext, bench: BenchmarkKind, options: BenchmarkOptions, cancel: Cancel, progress: (line: string) => void): Promise<BenchmarkResult> {
  const t0 = performance.now();
  const rows: BenchRow[] = [];
  const warnings: string[] = [];
  const camera = cameraAt();
  let cancelled = false;
  ctx.emit(`test.bench.${bench}.start`, `${BENCHMARK_LABELS[bench]}: start`, options);
  try {
    if (bench === 'views') await views(ctx, options, cancel, progress, rows, warnings);
    else if (bench === 'stress') await stress(ctx, options, cancel, progress, rows);
    else if (bench === 'leak') await track(ctx, options, cancel, progress, rows, true);
    else if (bench === 'longrun') await track(ctx, options, cancel, progress, rows, false);
    else await hitch(ctx, cancel, progress, rows, warnings);
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    cancelled = true;
    warnings.push('cancelled');
  } finally {
    restoreCamera(camera);
  }
  const ms = Math.round(performance.now() - t0);
  ctx.emit(`test.bench.${bench}.end`, `${BENCHMARK_LABELS[bench]}: ${rows.length} rows in ${Math.round(ms / 1000)} s${cancelled ? ' (cancelled)' : ''}`, { rows: rows.length });
  return { kind: 'benchmark', bench, startedAt: new Date(Date.now() - ms).toISOString(), ms, cancelled, warnings, rows };
}

const cap = (value: number | null, max: number): BenchRow['status'] => (value === null ? 'info' : value > max ? 'over' : 'ok');

/** Each standard view: settled with the clock held, a window measured, the plan's table read (`__roadcraft.budget`). */
async function views(ctx: LabContext, options: BenchmarkOptions, cancel: Cancel, progress: (l: string) => void, rows: BenchRow[], warnings: string[]): Promise<void> {
  const hold = holdScene(ctx, 'held');
  try {
    for (const view of ['map', 'district', 'street'] as const satisfies readonly ViewId[]) {
      check(cancel);
      progress(`view ${view}: settling`);
      if (!goToView(view, options.origin ? { x: 0, y: 0 } : null)) { warnings.push('no __roadcraft.lookAt: current view only'); }
      const settled = await settle(ctx, cancel);
      if (settled.unsettled) warnings.push(`view ${view}: the scene did not settle in ${Math.round(settled.ms / 1000)} s`);
      progress(`view ${view}: measuring`);
      const w = windowStats(await collectFrames(ctx, options.frames ?? 120, cancel));
      const b = VIEW_BUDGETS[view];
      const fps = w.frameP50 ? 1000 / w.frameP50 : null;
      const add = (metric: string, value: number | null, unit: string, reference: string, status: BenchRow['status']): void => {
        rows.push({ bench: 'views', case: view, metric, value: round(value), unit, reference, status });
      };
      add('GPU p50', w.gpuP50, 'ms', '', 'info');
      add('GPU p95', w.gpuP95, 'ms', `≤ ${b.gpuMs}`, cap(w.gpuP95, b.gpuMs));
      add('CPU p50', w.cpuP50, 'ms', '', 'info');
      add('frame p50', w.frameP50, 'ms', '', 'info');
      add('fps', fps, '', `≥ ${b.fps}`, fps === null ? 'info' : fps < b.fps ? 'over' : 'ok');
      add('draw calls', w.calls, '', `≤ ${b.drawCalls}`, cap(w.calls, b.drawCalls));
      add('triangles', w.triangles, '', `≤ ${b.triangles.toLocaleString('en-US')}`, cap(w.triangles, b.triangles));
      add('hitches', w.hitches, '', `> ${HITCH_MS} ms`, w.hitches ? 'hitch' : 'ok');
      // The plan's whole table (memory by group too), from the game's own probe.
      const budget = probe()?.budget;
      if (budget) {
        try {
          for (const r of budget(view)) {
            if (r.status !== 'over') continue;
            // '1,234.5 MB (names...)': the number and its unit (the probe's text is en-US).
            const m = /^([\d,.]+)\s*(\S*)/.exec(r.measured);
            rows.push({ bench: 'views', case: view, metric: r.item, value: m ? round(Number(m[1]!.replace(/,/g, ''))) : null, unit: m ? m[2]! : r.measured, reference: r.budget, status: 'over' });
          }
        } catch (error) { console.warn(`lab tests: __roadcraft.budget(${view}) failed`, error); warnings.push(`__roadcraft.budget(${view}) failed: ${String(error)}`); }
      }
    }
  } finally {
    hold.release();
  }
}

/** The simulation pushed: its speed 1, 2, 4×, then its traffic and people at the most (`MAX_INTENSITY` 3×), each a while on the fixed step. */
async function stress(ctx: LabContext, options: BenchmarkOptions, cancel: Cancel, progress: (l: string) => void, rows: BenchRow[]): Promise<void> {
  const sim = ctx.sim;
  const was = { speed: sim.clock.speed, paused: sim.clock.paused, traffic: sim.trafficIntensity, people: sim.pedestrianIntensity };
  const hold = holdScene(ctx, 'running');
  const cases: { name: string; speed: number; intensity: number }[] = [
    { name: 'speed 1×', speed: 1, intensity: was.traffic }, { name: 'speed 2×', speed: 2, intensity: was.traffic },
    { name: 'speed 4×', speed: 4, intensity: was.traffic }, { name: 'traffic and people 3×, 1×', speed: 1, intensity: 3 },
  ];
  try {
    for (const c of cases) {
      check(cancel);
      progress(`${c.name}: warming up`);
      sim.clock.speed = c.speed;
      sim.trafficIntensity = c.intensity;
      sim.pedestrianIntensity = c.intensity === was.traffic ? was.people : c.intensity;
      await sleep(3000);
      progress(`${c.name}: measuring`);
      const w = windowStats(await collectFrames(ctx, options.frames ?? 180, cancel));
      const add = (metric: string, value: number | null, unit: string, status: BenchRow['status'] = 'info', reference = ''): void => {
        rows.push({ bench: 'stress', case: c.name, metric, value: round(value), unit, reference, status });
      };
      add('frame p50', w.frameP50, 'ms');
      add('frame p95', w.frameP95, 'ms');
      add('CPU p50', w.cpuP50, 'ms');
      add('GPU p50', w.gpuP50, 'ms');
      add('simulation step', sim.stats?.stepMs ?? null, 'ms');
      add('vehicles', sim.vehicles.size, '');
      add('people', sim.pedViews.length, '');
      add('hitches', w.hitches, '', w.hitches ? 'hitch' : 'ok', `> ${HITCH_MS} ms`);
    }
  } finally {
    sim.clock.speed = was.speed;
    sim.trafficIntensity = was.traffic;
    sim.pedestrianIntensity = was.people;
    hold.release();
    sim.clock.paused = was.paused;
  }
}

/** A reading a second for `seconds`: the camera circled and turned round where it was (`moving`), or still with the game running. Then,
 *  moving, the camera back where it began and the scene settled: what it holds then against what it held at first is what stayed. */
async function track(ctx: LabContext, options: BenchmarkOptions, cancel: Cancel, progress: (l: string) => void, rows: BenchRow[], moving: boolean): Promise<void> {
  const bench: BenchmarkKind = moving ? 'leak' : 'longrun';
  const seconds = Math.max(5, options.seconds ?? (moving ? 30 : 60));
  const r = probe();
  const at = cameraAt();
  const orbit = r?.view?.();
  const orbit0 = orbit ? { azimuth: orbit.azimuth, elevation: orbit.elevation } : null;
  const hold = holdScene(ctx, moving ? 'held' : 'running');
  const times: number[] = [];
  const readings: Holdings[] = [];
  const intervals: number[] = [];
  const stopFrames = ctx.onFrame((s) => { if (s.intervalMs > 0) intervals.push(s.intervalMs); });
  try {
    if (moving && (!r?.lookAt || !at)) throw new Error('no __roadcraft.lookAt/camera probe: the leak test moves the camera through it');
    const start = holdings(ctx);
    const t0 = performance.now();
    while (performance.now() - t0 < seconds * 1000) {
      check(cancel);
      const s = (performance.now() - t0) / 1000;
      if (moving && at) {
        // A circle of a few screens round the start, and the orbit turning: new ground and new angles every second.
        const radius = 1600 / Math.max(0.05, at.zoom);
        r!.lookAt!(at.x + radius * Math.cos(s * 0.6), at.y + radius * Math.sin(s * 0.6), at.zoom);
        if (orbit && orbit0) orbit.setOrbit(orbit0.azimuth + s * 0.4, orbit0.elevation);
      }
      if (times.length === 0 || s - times[times.length - 1]! >= 1) {
        times.push(s);
        readings.push(holdings(ctx));
        progress(`${BENCHMARK_LABELS[bench]}: ${Math.round(s)} / ${seconds} s`);
      }
      await sleep(moving ? 50 : 250);
    }
    let back: Holdings | null = null;
    if (moving && at) {
      progress('back to the start: settling');
      r!.lookAt!(at.x, at.y, at.zoom);
      if (orbit && orbit0) orbit.setOrbit(orbit0.azimuth, orbit0.elevation);
      await settle(ctx, cancel);
      back = holdings(ctx);
    }
    const metrics: { key: keyof Holdings; label: string; unit: string; grows: number }[] = [
      { key: 'heapMB', label: 'heap JS', unit: 'MB', grows: 5 }, { key: 'geometries', label: 'geometries', unit: '', grows: 20 },
      { key: 'textures', label: 'textures', unit: '', grows: 2 }, { key: 'programs', label: 'programs', unit: '', grows: 1 },
      { key: 'ledgerMB', label: 'GPU ledger (gpuLedger)', unit: 'MB', grows: 5 },
    ];
    for (const m of metrics) {
      const ys = readings.map((x) => x[m.key]).filter((v): v is number => v !== null);
      if (!ys.length) { rows.push({ bench, case: m.label, metric: 'no reading', value: null, unit: m.unit, reference: '', status: 'info' }); continue; }
      const perMin = slope(times.slice(0, ys.length), ys);
      const v0 = start[m.key], v1 = back ? back[m.key] : ys[ys.length - 1]!;
      const kept = v0 === null || v1 === null ? null : v1 - v0;
      rows.push({ bench, case: m.label, metric: 'start', value: round(v0), unit: m.unit, reference: '', status: 'info' });
      rows.push({ bench, case: m.label, metric: 'max', value: round(Math.max(...ys)), unit: m.unit, reference: '', status: 'info' });
      rows.push({ bench, case: m.label, metric: 'slope per minute', value: round(perMin === null ? null : perMin * 60), unit: `${m.unit}/min`, reference: `≤ ${m.grows}`, status: perMin !== null && perMin * 60 > m.grows ? 'grows' : 'ok' });
      rows.push({ bench, case: m.label, metric: back ? 'retained (back at start)' : 'end − start', value: round(kept), unit: m.unit, reference: `≤ ${m.grows}`, status: kept !== null && kept > m.grows ? 'grows' : 'ok' });
    }
    const hitches = intervals.filter((i) => i > HITCH_MS).length;
    const sorted = [...intervals].sort((a, b) => a - b);
    rows.push({ bench, case: 'frames', metric: 'frames', value: intervals.length, unit: '', reference: '', status: 'info' });
    rows.push({ bench, case: 'frames', metric: 'frame p95', value: round(sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null), unit: 'ms', reference: '', status: 'info' });
    rows.push({ bench, case: 'frames', metric: 'hitches', value: hitches, unit: '', reference: `> ${HITCH_MS} ms`, status: hitches ? 'hitch' : 'ok' });
  } finally {
    stopFrames();
    hold.release();
    if (orbit && orbit0) orbit.setOrbit(orbit0.azimuth, orbit0.elevation);
  }
}

/** The flips that compile programs: a quality option of the optimisations' area when it has one, else the switches whose shaders differ.
 *  Each flipped and back, two seconds of frames after each: the hitches, the longest frame and the programs made. */
async function hitch(ctx: LabContext, cancel: Cancel, progress: (l: string) => void, rows: BenchRow[], warnings: string[]): Promise<void> {
  const flips: { name: string; get(): unknown; set(v: unknown): void; values: unknown[] }[] = [];
  const opt = labOpt();
  if (opt) {
    let list: unknown = [];
    try { list = opt.list(); } catch (error) { console.warn('lab tests: __labOpt.list failed', error); warnings.push(`__labOpt.list failed: ${String(error)}`); }
    for (const raw of Array.isArray(list) ? list : []) {
      const e = raw as { id?: unknown; values?: unknown[]; choices?: unknown[] };
      if (typeof e?.id !== 'string' || !/quality|preset/i.test(e.id)) continue;
      const id = e.id, values = e.values ?? e.choices ?? [];
      if (values.length > 1) flips.push({ name: `opt.${id}`, get: () => opt.get(id), set: (v) => opt.set(id, v), values });
    }
  }
  // The presets themselves, as the menu picks them (`LabContext.quality`).
  flips.push({ name: 'quality.preset', get: () => ctx.quality.level(), set: (v) => ctx.quality.setPreset(String(v)), values: [...ctx.quality.levels] });
  const snap = (key: string): unknown => ctx.effects.snapshot()[key];
  for (const key of ['shadows', 'ambientOcclusion', 'bloom', 'environmentMap', 'surfaceDetail']) {
    flips.push({ name: `switch.${key}`, get: () => snap(key), set: (v) => ctx.effects.setMany({ [key]: v as boolean }), values: [false, true] });
  }
  flips.push({ name: 'switch.bMaterial', get: () => snap('buildings.material'), set: (v) => ctx.effects.setMany({ bMaterial: v as string }), values: ['lambert', 'basic', 'normal'] });
  const hold = holdScene(ctx, 'held');
  try {
    await settle(ctx, cancel);
    for (const f of flips) {
      const was = f.get();
      try {
        for (const value of [...f.values.filter((v) => v !== was), was]) {
          check(cancel);
          progress(`${f.name} = ${String(value)}`);
          const p0 = programs(ctx);
          ctx.emit('test.bench.hitch.flip', `${f.name} = ${String(value)}`, { item: f.name, value });
          f.set(value);
          const w = await collectFrames(ctx, 100000, cancel, 2000);
          const intervals = w.samples.map((s) => s.intervalMs);
          const made = programs(ctx) - p0;
          const caseName = `${f.name} = ${String(value)}`;
          rows.push({ bench: 'hitch', case: caseName, metric: 'new programs', value: made, unit: '', reference: '', status: 'info' });
          rows.push({ bench: 'hitch', case: caseName, metric: 'hitches', value: intervals.filter((i) => i > HITCH_MS).length, unit: '', reference: `> ${HITCH_MS} ms`, status: intervals.some((i) => i > HITCH_MS) ? 'hitch' : 'ok' });
          rows.push({ bench: 'hitch', case: caseName, metric: 'longest frame', value: round(intervals.length ? Math.max(...intervals) : null), unit: 'ms', reference: '', status: 'info' });
        }
      } finally {
        if (f.get() !== was) f.set(was);
      }
    }
  } finally {
    hold.release();
  }
}
