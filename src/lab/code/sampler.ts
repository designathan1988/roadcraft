import type { LabContext } from '../labTypes';
import { addTrace, createAggregate, type Aggregate, type ProfilerTrace } from './aggregate';

/** THE PAGE SAMPLING ITS OWN JAVASCRIPT (JS Self-Profiling API, `new Profiler`; the dev server sends `Document-Policy: js-profiling`): back-to-back windows of a few seconds, each folded into the last window's, the session's and, while recording, the recording's sums. Chrome samples no finer than 16 ms on Windows, 10 ms elsewhere (`profiler.sampleInterval` says the interval it took). Only the page's main thread: the workers are not sampled. */

interface JsProfiler extends EventTarget {
  readonly sampleInterval: number;
  readonly stopped: boolean;
  stop(): Promise<ProfilerTrace>;
}
type ProfilerCtor = new (options: { sampleInterval: number; maxBufferSize: number }) => JsProfiler;

export type SampleView = 'last' | 'session' | 'recording';

export interface CodeSampler {
  /** The API there and allowed (the document policy). */
  readonly supported: boolean;
  /** Why not, when it is not, or the last failure. */
  readonly problem: string | null;
  readonly running: boolean;
  readonly recording: boolean;
  /** The interval the browser took for the running window (ms), or the one asked. */
  readonly actualIntervalMs: number;
  windowMs: number;
  intervalMs: number;
  /** Sampling while the tab is shown. */
  setLive(on: boolean): void;
  /** A recording begun (its sums emptied) or ended. */
  setRecording(on: boolean): void;
  aggregate(view: SampleView): Aggregate;
  resetSession(): void;
  /** Told after each window is folded in. */
  onWindow(listener: () => void): () => void;
}

export function createCodeSampler(ctx: LabContext): CodeSampler {
  const Ctor = (globalThis as { Profiler?: ProfilerCtor }).Profiler;
  let problem: string | null = Ctor ? null : 'API Profiler ausente: só no Chrome/Edge, com o cabeçalho Document-Policy: js-profiling (vite.config.ts).';
  let live = false;
  let recording = false;
  let current: JsProfiler | null = null;
  let timer: number | null = null;
  let frames = 0;
  let stopFrames: (() => void) | null = null;
  let actual = 0;
  let last = createAggregate();
  let session = createAggregate();
  let recordingAgg = createAggregate();
  const listeners: (() => void)[] = [];

  const wanted = (): boolean => (live || recording) && !!Ctor;

  function begin(): void {
    if (current || !Ctor || !wanted()) return;
    const maxBufferSize = Math.ceil(sampler.windowMs / Math.max(1, sampler.intervalMs)) * 2 + 200;
    try {
      current = new Ctor({ sampleInterval: sampler.intervalMs, maxBufferSize });
    } catch (error) {
      console.warn('lab code: Profiler not started', error);
      problem = `Profiler recusado: ${String(error)}`;
      live = recording = false;
      return;
    }
    problem = null;
    actual = current.sampleInterval;
    const profiler = current;
    profiler.addEventListener('samplebufferfull', () => { if (current === profiler) void end(); });
    frames = 0;
    stopFrames ??= ctx.onFrame(() => { frames++; });
    timer = window.setTimeout(() => void end(), sampler.windowMs);
  }

  async function end(): Promise<void> {
    const profiler = current;
    if (!profiler) return;
    current = null;
    if (timer !== null) window.clearTimeout(timer);
    timer = null;
    const windowFrames = frames;
    try {
      const trace = await profiler.stop();
      const interval = profiler.sampleInterval || sampler.intervalMs;
      last = createAggregate();
      addTrace(last, trace, interval, windowFrames);
      addTrace(session, trace, interval, windowFrames);
      if (recording) addTrace(recordingAgg, trace, interval, windowFrames);
      for (const listener of listeners) listener();
    } catch (error) {
      console.warn('lab code: profile window lost', error);
      problem = `Janela perdida: ${String(error)}`;
    }
    if (wanted()) begin();
    else { stopFrames?.(); stopFrames = null; }
  }

  const sampler: CodeSampler = {
    get supported() { return !!Ctor; },
    get problem() { return problem; },
    get running() { return current !== null; },
    get recording() { return recording; },
    get actualIntervalMs() { return current ? actual : sampler.intervalMs; },
    windowMs: 3000,
    intervalMs: 10,
    setLive(on) {
      live = on;
      if (wanted()) begin();
    },
    setRecording(on) {
      if (on && !recording) recordingAgg = createAggregate();
      recording = on;
      ctx.emit(on ? 'code.record' : 'code.recordEnd', on ? 'gravação do perfil de código iniciada' : 'gravação do perfil de código terminada');
      if (wanted()) begin();
      // Ended: the running window folded in now, so the recording holds every sample up to the click.
      else if (!on && current) void end();
    },
    aggregate(view) {
      return view === 'last' ? last : view === 'session' ? session : recordingAgg;
    },
    resetSession() {
      session = createAggregate();
      last = createAggregate();
    },
    onWindow(listener) {
      listeners.push(listener);
      return () => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); };
    },
  };
  return sampler;
}
