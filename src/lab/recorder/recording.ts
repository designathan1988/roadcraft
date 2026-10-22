import type { LabContext, LabEvent, LabSample } from '../labTypes';

/** ONE RECORDING: every frame the lab sees, every event, the camera, the simulation's counts and the settings at each change, kept from Start to Stop. Times are ms since the recording began (page clock). */

export interface RecEvent {
  readonly t: number;
  readonly kind: string;
  readonly detail: string;
  readonly data?: unknown;
  /** A change that cuts the recording into a new stretch (`analysis.ts`). */
  readonly split: boolean;
}

/** The frames as columns (one array a measure): compact in memory and in the JSON. */
export interface FrameColumns {
  readonly t: number[];
  readonly interval: number[];
  readonly cpu: number[];
  readonly gpu: (number | null)[];
  readonly calls: number[];
  readonly tris: number[];
  readonly heap: (number | null)[];
  readonly ratio: number[];
  /** The frame's interval spans a pause: not the game's. */
  readonly gap: boolean[];
  /** Each system's ms, aligned with `t` (0 where the frame did not run it). */
  readonly systems: Map<string, number[]>;
}

export interface ViewSample {
  readonly t: number;
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  readonly azimuth: number;
  readonly elevation: number;
}

export interface SimSample {
  readonly t: number;
  readonly vehicles: number | null;
  readonly people: number | null;
  readonly stepMs: number | null;
  /** The renderer's compiled programs: a rise after a change is a recompile. */
  readonly programs: number | null;
}

export interface SettingsSnapshot {
  readonly t: number;
  readonly cause: string;
  readonly effects: Readonly<Record<string, unknown>>;
  readonly optimizations: unknown;
}

export type RecState = 'recording' | 'paused' | 'stopped';

export interface Recording {
  readonly startedAt: string;
  readonly t0: number;
  readonly frames: FrameColumns;
  readonly events: RecEvent[];
  readonly views: ViewSample[];
  readonly sim: SimSample[];
  readonly settings: SettingsSnapshot[];
  readonly limitMs: number | null;
  readonly state: RecState;
  /** ms since the start, at the stop (or now). */
  readonly endMs: number;
  /** ms recorded, the pauses left out. */
  readonly activeMs: number;
  /** Why it stopped: the button, the duration reached, the frames' limit. */
  readonly stopReason: string;
}

export interface RecordingHandle {
  readonly recording: Recording;
  pause(): void;
  resume(): void;
  stop(reason: string): void;
  /** A note at this moment; it cuts the recording as a change does. */
  mark(name: string): void;
}

/** Events that cut the recording: the switches, the optimisations, the quality, the Inspector's edits, a marker, a resumption. */
const SPLITS = /^(switch|opt|quality|edit)\.|^rec\.(marker|resume)$/;
/** Settings read again after these. */
const SETTING_CHANGE = /^(switch|opt|quality|edit)\./;
/** About an hour at 60 Hz: past it the recording stops itself. */
export const MAX_FRAMES = 216_000;
const VIEW_EVERY_MS = 250;
const SIM_EVERY_MS = 1000;
/** A view still this long, then moved, is a new camera move (one event). */
const VIEW_STILL_MS = 1000;

const round = (v: number, digits = 100): number => Math.round(v * digits) / digits;

function readOptimizations(): unknown {
  const opt = (window as unknown as { __labOpt?: { list?: () => unknown } }).__labOpt;
  if (!opt?.list) return null;
  try {
    return opt.list();
  } catch (error) {
    console.warn('lab recorder: optimisations unreadable', error);
    return { error: String(error) };
  }
}

/** Starts a recording now; `onStop` told once, whatever stopped it. */
export function startRecording(ctx: LabContext, limitMs: number | null, onStop: (rec: Recording) => void): RecordingHandle {
  const t0 = performance.now();
  const frames: FrameColumns = { t: [], interval: [], cpu: [], gpu: [], calls: [], tris: [], heap: [], ratio: [], gap: [], systems: new Map() };
  const events: RecEvent[] = [];
  const views: ViewSample[] = [];
  const sim: SimSample[] = [];
  const settings: SettingsSnapshot[] = [];
  let state: RecState = 'recording';
  let pausedSince = 0, pausedTotal = 0, endMs = 0, stopReason = '';
  // The CPU profile recorded with it (`lab/code`, JS Self-Profiling): the report says which functions the frames spent their time in.
  const code = (window as unknown as { __labCode?: { record(on: boolean): void } }).__labCode;
  code?.record(true);
  let nextGap = false, lastView = -Infinity, lastSim = -Infinity, viewMovedAt = -Infinity;
  const now = (): number => performance.now() - t0;
  const snapshot = (cause: string): void => {
    settings.push({ t: round(now()), cause, effects: ctx.effects.snapshot(), optimizations: readOptimizations() });
  };

  const onFrame = (sample: LabSample): void => {
    if (state !== 'recording') return;
    const t = sample.t - t0;
    const n = frames.t.length;
    frames.t.push(round(t));
    frames.interval.push(round(sample.intervalMs));
    frames.cpu.push(round(sample.cpuMs));
    frames.gpu.push(sample.gpuMs === null ? null : round(sample.gpuMs));
    frames.calls.push(sample.drawCalls);
    frames.tris.push(sample.triangles);
    frames.heap.push(sample.heapMB === null ? null : round(sample.heapMB, 10));
    frames.ratio.push(sample.pixelRatio);
    frames.gap.push(nextGap || n === 0);
    nextGap = false;
    for (const [name, ms] of sample.systems) {
      let column = frames.systems.get(name);
      if (!column) { column = new Array<number>(n).fill(0); frames.systems.set(name, column); }
      column.push(round(ms));
    }
    for (const column of frames.systems.values()) if (column.length === n) column.push(0);

    if (t - lastView >= VIEW_EVERY_MS) {
      lastView = t;
      const v = ctx.scene.viewport;
      const prev = views[views.length - 1];
      const moved = !prev || prev.kind !== v.kind || Math.abs(v.zoom - prev.zoom) / Math.max(1e-6, prev.zoom) > 0.01
        || Math.hypot(v.centre.x - prev.x, v.centre.y - prev.y) * v.zoom > 20 || Math.abs(v.azimuth - prev.azimuth) > 0.01 || Math.abs(v.elevation - prev.elevation) > 0.01;
      if (moved) {
        const view: ViewSample = { t: round(t), kind: v.kind, x: round(v.centre.x), y: round(v.centre.y), zoom: round(v.zoom, 10000), azimuth: round(v.azimuth, 1000), elevation: round(v.elevation, 1000) };
        if (prev && t - viewMovedAt > VIEW_STILL_MS) {
          events.push({ t: round(t), kind: 'view.move', detail: `camera moved: zoom ${prev.zoom} → ${view.zoom}, centre (${Math.round(view.x)}, ${Math.round(view.y)})`, split: false });
        }
        viewMovedAt = t;
        views.push(view);
      }
    }
    if (t - lastSim >= SIM_EVERY_MS) {
      lastSim = t;
      const stats = ctx.sim.stats;
      sim.push({ t: round(t), vehicles: stats?.vehicles ?? null, people: stats?.people ?? null, stepMs: stats ? round(stats.stepMs) : null, programs: ctx.scene.gl.info.programs?.length ?? null });
    }
    if (frames.t.length >= MAX_FRAMES) handle.stop(`${MAX_FRAMES} frame limit`);
    else if (limitMs !== null && t - pausedTotal >= limitMs) handle.stop('duration reached');
  };

  const onEvent = (event: LabEvent): void => {
    if (state === 'stopped') return;
    events.push({ t: round(event.t - t0), kind: event.kind, detail: event.detail, ...(event.data === undefined ? {} : { data: event.data }), split: SPLITS.test(event.kind) });
    if (SETTING_CHANGE.test(event.kind)) snapshot(event.kind);
  };

  // Long tasks (W3C Long Tasks API: a main-thread task over 50 ms), kept in this recording only.
  const longTasks = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes.includes('longtask')
    ? new PerformanceObserver((list) => {
      if (state === 'stopped') return;
      for (const entry of list.getEntries()) events.push({ t: round(entry.startTime - t0), kind: 'longtask', detail: `long task of ${Math.round(entry.duration)} ms`, data: { duration: round(entry.duration) }, split: false });
    })
    : null;
  longTasks?.observe({ type: 'longtask', buffered: false });

  const stopFrames = ctx.onFrame(onFrame);
  const stopEvents = ctx.onEvent(onEvent);
  snapshot('start');

  const recording: Recording = {
    startedAt: new Date().toISOString(),
    t0,
    frames,
    events,
    views,
    sim,
    settings,
    limitMs,
    get state() { return state; },
    get endMs() { return state === 'stopped' ? endMs : now(); },
    get activeMs() { return (state === 'stopped' ? endMs : now()) - pausedTotal - (state === 'paused' ? now() - pausedSince : 0); },
    get stopReason() { return stopReason; },
  };

  const handle: RecordingHandle = {
    recording,
    pause() {
      if (state !== 'recording') return;
      ctx.emit('rec.pause', 'recording paused');
      state = 'paused';
      pausedSince = now();
    },
    resume() {
      if (state !== 'paused') return;
      pausedTotal += now() - pausedSince;
      state = 'recording';
      nextGap = true;
      ctx.emit('rec.resume', 'recording resumed');
    },
    stop(reason) {
      if (state === 'stopped') return;
      if (state === 'paused') pausedTotal += now() - pausedSince;
      ctx.emit('rec.stop', `recording stopped (${reason})`);
      endMs = round(now());
      stopReason = reason;
      state = 'stopped';
      stopFrames();
      stopEvents();
      longTasks?.disconnect();
      // The profile's running window folded in first (the Profiler's stop is asynchronous), then the report made with it.
      code?.record(false);
      if (code) window.setTimeout(() => onStop(recording), 600); else onStop(recording);
    },
    mark(name) {
      ctx.emit('rec.marker', name.trim() || 'marker');
    },
  };
  return handle;
}
