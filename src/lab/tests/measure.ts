import { gpuLedger } from '@render/gpuLedger';
import type { LabContext, LabSample } from '../labTypes';

/** THE TESTS' MEASURE: the scene held still (the simulation's clock held, a frame every refresh), settled, then a window of frames read -
 *  the same rules as `scripts/lib/measureCity.mjs`, in the page. DO NOT measure a scene still changing: the cells landing, a program compiling
 *  or the clock moving the sun made A/B rows "cheaper with more work" (measureCity, 2026-10-18). */

/** The console's probes the tests use when they are there (`main.ts`, development and the probe build). */
export interface RoadcraftProbe {
  measure?(on: boolean | 'running'): void;
  lookAt?(x: number, y: number, zoom?: number): void;
  camera?: { x: number; y: number; zoom: number };
  view?(): { azimuth: number; elevation: number; setOrbit(azimuth: number, elevation: number): void };
  budget?(view: string): readonly { item: string; measured: string; budget: string; status: string; times: number }[];
}

export const probe = (): RoadcraftProbe | null => (window as unknown as { __roadcraft?: RoadcraftProbe }).__roadcraft ?? null;

export const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** Asked to stop: every wait looks at it. */
export interface Cancel { stopped: boolean }

export class Cancelled extends Error {
  constructor() { super('test cancelled'); }
}
export const check = (cancel: Cancel): void => { if (cancel.stopped) throw new Cancelled(); };

// ---- statistics

export const median = (values: readonly number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
export const quantile = (values: readonly number[], q: number): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(s.length * q) - 1))]!;
};
/** The median absolute deviation scaled to a standard deviation (×1.4826, as robust regression detectors use it). */
export const robustSigma = (values: readonly number[]): number | null => {
  const m = median(values);
  if (m === null) return null;
  return 1.4826 * median(values.map((v) => Math.abs(v - m)))!;
};
/** The least-squares slope of y over x. */
export const slope = (xs: readonly number[], ys: readonly number[]): number | null => {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]!; sy += ys[i]!; }
  const mx = sx / n, my = sy / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i]! - mx) * (ys[i]! - my); den += (xs[i]! - mx) ** 2; }
  return den ? num / den : null;
};
export const round = (v: number | null, digits = 2): number | null => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** digits) / 10 ** digits);

// ---- the scene

/** What makes the scene the scene (measureCity's signature): the buildings' levels chosen and shown, the vehicles, the people, the programs. */
export interface SceneSign {
  readonly tri: number;
  readonly detail: number;
  readonly facade: number;
  readonly notLanded: number;
  readonly vehicles: number;
  readonly people: number;
  readonly programs: number;
}
export function sceneSign(ctx: LabContext): SceneSign {
  const lv = ctx.scene.buildingLevels();
  return {
    tri: lv['chosenTriangles'] ?? 0, detail: lv['shownDetail'] ?? 0, facade: lv['shownFacade'] ?? 0, notLanded: lv['notLanded'] ?? 0,
    vehicles: ctx.sim.vehicles.size, people: ctx.sim.pedViews.length, programs: programs(ctx),
  };
}
/** The signature as text; `withPrograms` false: a flip that compiled a program is still the same scene. */
export const signText = (s: SceneSign, withPrograms = true): string =>
  `${s.tri}|${s.detail}|${s.facade}|${s.vehicles}|${s.people}${withPrograms ? `|${s.programs}` : ''}`;
export const programs = (ctx: LabContext): number => ctx.scene.gl.info.programs?.length ?? 0;

/** What the GPU and the page hold now (the leak test's readings). */
export interface Holdings {
  readonly heapMB: number | null;
  readonly geometries: number;
  readonly textures: number;
  readonly programs: number;
  readonly ledgerMB: number;
}
export function holdings(ctx: LabContext): Holdings {
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  const info = ctx.scene.gl.info;
  return {
    heapMB: heap ? heap.usedJSHeapSize / 1048576 : null,
    geometries: info.memory.geometries, textures: info.memory.textures, programs: info.programs?.length ?? 0,
    ledgerMB: gpuLedger.bytes() / 1048576,
  };
}

// ---- holding the scene

/** A frame asked for every refresh while a test runs (the loop draws on demand), and the clock held (`__roadcraft.measure`) when asked. */
export interface Hold {
  release(): void;
}
export function holdScene(ctx: LabContext, clock: 'held' | 'running'): Hold {
  const r = probe();
  const wasPaused = ctx.sim.clock.paused;
  if (r?.measure) r.measure(clock === 'held' ? true : 'running');
  else if (clock === 'held') ctx.sim.clock.paused = true;
  let on = true;
  const pump = (): void => {
    if (!on) return;
    ctx.requestDraw();
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);
  return {
    release() {
      on = false;
      if (r?.measure) r.measure(false);
      else ctx.sim.clock.paused = wasPaused;
      ctx.requestDraw();
    },
  };
}

// ---- the views

export type ViewId = 'current' | 'map' | 'district' | 'street';
export const VIEW_LABELS: Readonly<Record<ViewId, string>> = { current: 'current', map: 'map', district: 'district', street: 'street' };
/** The zooms of the standard views (`scripts/look/views.json`: map 0.17, district 2.5, street 28). */
const VIEW_ZOOM: Readonly<Record<Exclude<ViewId, 'current'>, number>> = { map: 0.17, district: 2.5, street: 28 };

/** The budget's view (`VIEW_BUDGETS`) a zoom falls in. */
export const budgetView = (zoom: number): 'map' | 'district' | 'street' => (zoom < 1 ? 'map' : zoom < 10 ? 'district' : 'street');

export interface CameraAt { readonly x: number; readonly y: number; readonly zoom: number }
export const cameraAt = (): CameraAt | null => {
  const c = probe()?.camera;
  return c ? { x: c.x, y: c.y, zoom: c.zoom } : null;
};
/** The camera at a standard view round `centre` (the camera's own centre if none); false when the probe is not there (`current` always true). */
export function goToView(view: ViewId, centre: { x: number; y: number } | null): boolean {
  if (view === 'current') return true;
  const r = probe();
  const at = centre ?? cameraAt();
  if (!r?.lookAt || !at) return false;
  r.lookAt(at.x, at.y, VIEW_ZOOM[view]);
  return true;
}
export function restoreCamera(at: CameraAt | null): void {
  if (at) probe()?.lookAt?.(at.x, at.y, at.zoom);
}

// ---- frames

/** Every frame for `count` frames (or `maxMs`), the GPU's samples pushed meanwhile, the disjoint results thrown. */
export interface FrameWindow {
  readonly samples: readonly LabSample[];
  readonly gpu: readonly number[];
  readonly disjoint: number;
  readonly ms: number;
}
export function collectFrames(ctx: LabContext, count: number, cancel: Cancel, maxMs = Math.max(4000, count * 100)): Promise<FrameWindow> {
  const ring = ctx.scene.gpu.samples;
  const pushed0 = ring.pushed, disjoint0 = ctx.scene.gpu.disjoint, t0 = performance.now();
  const samples: LabSample[] = [];
  return new Promise((done) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stop();
      window.clearTimeout(timer);
      // The GPU's samples come a few frames late: the ones pushed during the window, newest last.
      const fresh = Math.min(ring.pushed - pushed0, ring.size);
      const gpu: number[] = [];
      for (let back = fresh - 1; back >= 0; back--) gpu.push(ring.newest(back));
      done({ samples, gpu, disjoint: ctx.scene.gpu.disjoint - disjoint0, ms: performance.now() - t0 });
    };
    const stop = ctx.onFrame((sample) => {
      // The first frame's interval spans the time before the window.
      if (sample.intervalMs > 0) samples.push(sample);
      if (samples.length >= count || cancel.stopped) finish();
    });
    const timer = window.setTimeout(finish, maxMs);
    ctx.requestDraw();
  });
}

/** A window's figures: medians of the GPU, the CPU and the frame; the means of draw calls and triangles; the robust spread of each median. */
export interface WindowStats {
  readonly n: number;
  readonly gpuP50: number | null;
  readonly gpuP95: number | null;
  readonly gpuSigma: number | null;
  readonly cpuP50: number | null;
  readonly cpuSigma: number | null;
  readonly frameP50: number | null;
  readonly frameP95: number | null;
  readonly calls: number;
  readonly triangles: number;
  readonly hitches: number;
  readonly disjoint: number;
}
/** A frame a player sees as a hitch, ms (two refreshes and more at 60 Hz). */
export const HITCH_MS = 50;
export function windowStats(w: FrameWindow): WindowStats {
  const cpu = w.samples.map((s) => s.cpuMs), frame = w.samples.map((s) => s.intervalMs);
  const mean = (a: readonly number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  // The standard error of a median (1.2533 σ / √n): what two windows' medians may differ by with nothing changed.
  const err = (a: readonly number[]): number | null => { const s = robustSigma(a); return s === null || !a.length ? null : (1.2533 * s) / Math.sqrt(a.length); };
  return {
    n: w.samples.length,
    gpuP50: median(w.gpu), gpuP95: quantile(w.gpu, 0.95), gpuSigma: err(w.gpu),
    cpuP50: median(cpu), cpuSigma: err(cpu),
    frameP50: median(frame), frameP95: quantile(frame, 0.95),
    calls: mean(w.samples.map((s) => s.drawCalls)), triangles: mean(w.samples.map((s) => s.triangles)),
    hitches: frame.filter((f) => f > HITCH_MS).length,
    disjoint: w.disjoint,
  };
}

/** Settled: nothing waiting to land, the scene's signature and its programs the same for `stableMs`, and the frames' times steady (two
 *  halves of the last frames within 20 %). Answers how long it took, and whether it gave up at `maxMs`. */
export async function settle(ctx: LabContext, cancel: Cancel, stableMs = 1500, maxMs = 20000): Promise<{ ms: number; unsettled: boolean; scene: string }> {
  const t0 = performance.now();
  let last = '', since = t0;
  const recent: number[] = [];
  const stop = ctx.onFrame((s) => { if (s.intervalMs > 0) { recent.push(s.cpuMs + (s.gpuMs ?? 0)); if (recent.length > 40) recent.shift(); } });
  try {
    while (performance.now() - t0 < maxMs) {
      check(cancel);
      ctx.requestDraw();
      const s = sceneSign(ctx), now = signText(s);
      const half = recent.length >> 1;
      const a = median(recent.slice(0, half)), b = median(recent.slice(half));
      const steady = recent.length >= 20 && a !== null && b !== null && Math.abs(a - b) <= Math.max(0.5, 0.2 * Math.max(a, b));
      if (now !== last || s.notLanded > 0) { last = now; since = performance.now(); }
      else if (performance.now() - since >= stableMs && steady) return { ms: Math.round(performance.now() - t0), unsettled: false, scene: now };
      await sleep(150);
    }
    return { ms: Math.round(maxMs), unsettled: true, scene: last };
  } finally {
    stop();
  }
}
