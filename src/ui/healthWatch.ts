import { type FrameTimer, type HealthEntry, type HealthLog, LONG_FRAME_MS, systemKey, systemsOf } from '@core/health';
import { stepBudget } from '@core/perfBudget';
import { t } from './i18n';

/** DO NOT write a message's text here: they were Portuguese in the code, and an English player read a Portuguese "error with no message". */
/** A frame system's name in the game's language (`health.system.<id>`, `core/health.ts` `FrameSystem`) */
export function systemName(system: string): string {
  const key = systemKey(system);
  const name = t(key);
  return name === key ? system : name;
}

export interface HealthWatch {
  /** Whether the browser reports long frames itself; if not, the frame loop does (`frameEnded`). */
  readonly longFrames: boolean;
  /** For browsers without long-frame reports: a frame of the loop ended. */
  frameEnded(start: number, end: number): void;
}

const KEPT_KEY = 'roadcraft.health.v1';

/** A long animation frame as the browser reports it (MDN, PerformanceLongAnimationFrameTiming). */
export interface LongFrameEntry {
  readonly startTime: number;
  readonly duration: number;
  readonly blockingDuration?: number;
  readonly renderStart?: number;
  readonly scripts?: readonly { readonly duration: number }[];
}

/** The work in a long frame, ms: its scripts and its rendering
 *  DO NOT take the listed scripts alone: the browser lists only scripts over 5 ms, and a frame of 30 callbacks of 4 ms reported only its render
 *  (report TST-09). The game's own steps measured inside the frame (`stepsMs`) count, and with no script listed the time before the render
 *  (`renderStart - startTime`) is where the unlisted ones ran. */
export function longFrameWork(entry: LongFrameEntry, stepsMs = 0): number {
  const listed = entry.scripts ?? [];
  const scripts = listed.reduce((sum, s) => sum + s.duration, 0);
  const beforeRender = !listed.length && entry.renderStart ? entry.renderStart - entry.startTime : 0;
  const work = Math.max(scripts, stepsMs, beforeRender);
  const render = entry.renderStart ? entry.startTime + entry.duration - entry.renderStart : 0;
  return Math.max(Math.min(entry.duration, work + render), entry.blockingDuration ?? 0);
}

/** The code's measured steps that ran IN a frame: begun and ended within it, as a synchronous step does. */
export function stepsWithin<T extends { readonly start: number; readonly end: number }>(steps: readonly T[], start: number, end: number): T[] {
  return steps.filter((h) => h.start >= start - 1 && h.end <= end + 1);
}

/** Text of console arguments, short. */
function textOf(args: readonly unknown[]): string {
  return args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === 'string' ? a : safeJSON(a))).join(' ').slice(0, 400);
}
function safeJSON(value: unknown): string {
  try { return JSON.stringify(value)?.slice(0, 200) ?? String(value); } catch { return String(value); }
}
function stackOf(args: readonly unknown[]): string | undefined {
  const error = args.find((a): a is Error => a instanceof Error);
  return error?.stack?.slice(0, 2000);
}

export function watchHealth(options: {
  readonly log: HealthLog;
  readonly frames: FrameTimer;
  readonly canvas: HTMLCanvasElement;
  /** What the player is doing now, for each entry. */
  readonly context: () => string;
}): HealthWatch {
  const { log, frames, canvas, context } = options;
  const write = (kind: Parameters<HealthLog['record']>[0], severity: Parameters<HealthLog['record']>[1], message: string, detail?: string): void => {
    let where = '';
    try { where = context(); } catch { /* the context itself failed: the entry without it */ }
    log.record(kind, severity, message, { ...(detail ? { detail } : {}), ...(where ? { context: where } : {}) });
  };

  // Entries of the session before this one.
  try {
    const kept = JSON.parse(localStorage.getItem(KEPT_KEY) ?? '[]') as HealthEntry[];
    if (Array.isArray(kept)) log.restore(kept);
  } catch { /* nothing kept, or storage blocked */ }
  let saved = log.changes;
  const save = (): void => {
    if (log.changes === saved) return;
    saved = log.changes;
    try { localStorage.setItem(KEPT_KEY, JSON.stringify(log.toJSON())); } catch { /* storage full or blocked: kept in memory */ }
  };
  setInterval(save, 5000);
  window.addEventListener('pagehide', save);

  // A worker's error, once told by the worker's own listener below, is also passed on to the window by the browser
  let workerError: { message: string; at: number } | null = null;
  window.addEventListener('error', (event) => {
    if (workerError && workerError.message === event.message && performance.now() - workerError.at < 1000) return;
    write('error', 'broken', event.message || t('health.msg.noMessage'), (event.error as Error | undefined)?.stack ?? `${event.filename}:${event.lineno}:${event.colno}`);
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    write('rejection', 'broken', reason instanceof Error ? `${reason.name}: ${reason.message}` : t('health.msg.rejected', { reason: safeJSON(reason) }), reason instanceof Error ? reason.stack : undefined);
  });

  const consoleError = console.error.bind(console);
  let inside = false;
  console.error = (...args: unknown[]): void => {
    consoleError(...args);
    if (inside) return;
    inside = true;
    // three.js reports a shader that does not link through `console.error`
    const text = textOf(args);
    const kind = text.startsWith('THREE.WebGLProgram: Shader Error') ? 'shader' : 'console';
    try { write(kind, 'broken', kind === 'shader' ? text.split('\n')[0]! : text, kind === 'shader' ? text.slice(0, 2000) : stackOf(args)); } finally { inside = false; }
  };

  const NativeWorker = window.Worker;
  class WatchedWorker extends NativeWorker {
    constructor(url: string | URL, init?: WorkerOptions) {
      super(url, init);
      const name = String(url).split('/').pop()?.split('?')[0] ?? 'worker';
      this.addEventListener('error', (event) => {
        workerError = { message: event.message, at: performance.now() };
        write('worker', 'broken', event.message ? t('health.msg.workerError', { name, message: event.message }) : t('health.msg.workerFailed', { name }), `${event.filename}:${event.lineno}:${event.colno}`);
      });
      this.addEventListener('messageerror', () => write('worker', 'broken', t('health.msg.workerUnreadable', { name })));
    }
  }
  window.Worker = WatchedWorker;

  canvas.addEventListener('webglcontextlost', () => write('webgl', 'broken', t('health.msg.webglLost')));
  canvas.addEventListener('webglcontextrestored', () => write('webgl', 'warning', t('health.msg.webglRestored')));

  // The code's own measured steps (`performance.measure('hitch:...')`), kept to explain a long frame.
  const hitches: { name: string; start: number; end: number }[] = [];
  // The browser's buffer of measures has no limit
  let buffered = 0;
  try {
    new PerformanceObserver((list) => {
      buffered += list.getEntries().length;
      if (buffered > 4000) { performance.clearMeasures(); buffered = 0; }
      for (const m of list.getEntries()) {
        if (!m.name.startsWith('hitch:')) continue;
        hitches.push({ name: m.name.slice(6), start: m.startTime, end: m.startTime + m.duration });
        if (hitches.length > 300) hitches.shift();
        // Over its performance budget (`core/perfBudget.ts`): told in the monitor as it happens, with the step and its time
        const over = stepBudget(m.name);
        if (over && m.duration > over.budget.max) {
          log.record('budget', 'warning', t('health.msg.budget', { step: over.key }), {
            ms: Math.round(m.duration), detail: `${Math.round(m.duration)} ms > ${over.budget.max} ms — ${over.budget.why}`,
          });
        }
      }
    }).observe({ type: 'measure', buffered: false });
  } catch { /* no measure entries in this browser */ }

  const slowFrame = (start: number, end: number, scripts: string[], work = end - start): void => {
    const systems = systemsOf(frames.between(start, end));
    const steps = stepsWithin(hitches, start, end).filter((h) => h.end - h.start >= 2)
      .sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, 5)
      .map((h) => `${h.name} ${Math.round(h.end - h.start)} ms`);
    const top = systems[0];
    const message = top ? t('health.msg.slowFrame', { what: systemName(top[0]) }) : steps[0] ? t('health.msg.slowFrame', { what: steps[0].replace(/ \d+ ms$/, '') }) : t('health.msg.slowFrameOutside');
    let where = '';
    try { where = context(); } catch { /* without it */ }
    const detail = [...(steps.length ? [t('health.msg.steps', { list: steps.join(' · ') })] : []), ...(scripts.length ? [t('health.msg.scripts', { list: scripts.join(' · ') })] : [])].join('\n');
    log.record('slow-frame', 'slow', message, {
      ms: Math.round(work), systems, ...(detail ? { detail } : {}), ...(where ? { context: where } : {}),
    });
  };

  let longFrames = false;
  try {
    if (PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) {
      longFrames = true;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_FRAME_MS) continue;
          const loaf = entry as PerformanceEntry & LongFrameEntry & { scripts?: readonly { duration: number; invoker?: string; sourceFunctionName?: string; sourceURL?: string }[] };
          // Long by the clock with no work in it is the browser idle, not a hitch.
          const stepsMs = stepsWithin(hitches, entry.startTime, entry.startTime + entry.duration).reduce((sum, h) => sum + (h.end - h.start), 0);
          const work = longFrameWork(loaf, stepsMs);
          if (work < LONG_FRAME_MS) continue;
          const scripts = [...(loaf.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 3)
            .filter((s) => s.duration >= 5)
            .map((s) => `${s.sourceFunctionName || s.invoker || s.sourceURL?.split('/').pop() || '?'} ${Math.round(s.duration)} ms`);
          slowFrame(entry.startTime, entry.startTime + entry.duration, scripts, work);
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    }
  } catch { longFrames = false; }
  // A hidden page draws no frames, so no long frame is reported for it; a task over 50 ms still is (MDN, Long Tasks)
  try {
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
      new PerformanceObserver((list) => {
        if (longFrames && !document.hidden) return;
        for (const entry of list.getEntries()) slowFrame(entry.startTime, entry.startTime + entry.duration, []);
      }).observe({ type: 'longtask', buffered: false });
    }
  } catch { /* no long tasks in this browser */ }

  return {
    longFrames,
    frameEnded(start: number, end: number): void {
      if (!longFrames && end - start >= LONG_FRAME_MS) slowFrame(start, end, []);
    },
  };
}
