import type { ProblemLog } from '@core/assert';
import type { SampleRing, SampleStats } from '@core/sampleRing';

/** FIELD PROBLEMS: what went wrong on the player's machine, told to the desktop shell's local log (`desktop/problems.cjs`, `<userData>/problems`)
 *  and to nothing else. In a browser there is no shell: the console only. Nothing leaves the machine.
 *  Every problem of the page passes through `fieldReport.report`, so a remote reporter (Sentry later) is plugged in at ONE place: `fieldReport.addSink`. */

export type ProblemKind = 'error' | 'rejection' | 'ensure' | 'webgl-lost' | 'webgl-restored' | 'shader' | 'session' | 'note';

export interface Problem {
  readonly kind: ProblemKind;
  readonly message: string;
  readonly detail?: string;
  /** Flat numbers and short strings (the session's summary). */
  readonly data?: Readonly<Record<string, number | string | boolean>>;
}

export type ProblemSink = (problem: Problem) => void;

/** The desktop shell's calls for problems (`desktop/preload.cjs`); absent in a browser. */
export interface ProblemBridge {
  reportProblem(problem: Problem): void;
  openProblems?(): Promise<string | null>;
}

/** The same problem told at most this many times a session: an error thrown every frame is one line, not thousands. */
const REPEATS = 3;

export class FieldReport {
  private readonly sinks: ProblemSink[] = [];
  private readonly seen = new Map<string, number>();
  /** Problems held back as repeats this session. */
  repeats = 0;

  /** A place problems go besides the others (the shell's log, the console, a remote reporter); returns its removal. */
  addSink(sink: ProblemSink): () => void {
    this.sinks.push(sink);
    return () => {
      const at = this.sinks.indexOf(sink);
      if (at >= 0) this.sinks.splice(at, 1);
    };
  }

  /** One problem handed to every sink; a sink that throws is said on the console and the others still told. */
  report(problem: Problem): void {
    if (problem.kind !== 'session') {
      const key = `${problem.kind}\u0000${problem.message}`;
      const count = (this.seen.get(key) ?? 0) + 1;
      this.seen.set(key, count);
      if (count > REPEATS) {
        this.repeats++;
        return;
      }
    }
    for (const sink of this.sinks) {
      try {
        sink(problem);
      } catch (error) {
        console.warn('[field] a problem sink failed', error);
      }
    }
  }
}

/** The page's one funnel of problems. */
export const fieldReport = new FieldReport();

/** The desktop shell's log as a sink. */
export const bridgeSink = (bridge: ProblemBridge): ProblemSink => (problem) => bridge.reportProblem(problem);

/** The browser's sink: the console, since there is no file to write. */
export const consoleSink: ProblemSink = (problem) => console.info(`[field] ${problem.kind}: ${problem.message}`, problem.data ?? '');

/** The shell's problem calls when the page runs inside it. */
export function problemBridge(host: unknown): ProblemBridge | null {
  const bridge = (host as { roadcraftDesktop?: Partial<ProblemBridge> } | null)?.roadcraftDesktop;
  return bridge && typeof bridge.reportProblem === 'function' ? (bridge as ProblemBridge) : null;
}

const textOf = (value: unknown): string => {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (error) {
    console.error('[field] a rejection reason not readable as JSON', error);
    return String(value);
  }
};

/** Start-up: the sink by where the page runs, failed `ensure`s, uncaught errors and unhandled rejections. */
export function wireFieldReport(options: {
  readonly page: EventTarget;
  readonly bridge: ProblemBridge | null;
  readonly problems: ProblemLog;
  readonly report?: FieldReport;
}): FieldReport {
  const report = options.report ?? fieldReport;
  report.addSink(options.bridge ? bridgeSink(options.bridge) : consoleSink);
  options.problems.setReporter((message) => report.report({ kind: 'ensure', message }));
  options.page.addEventListener('error', (event) => {
    const e = event as ErrorEvent;
    const error: unknown = e.error;
    report.report({
      kind: 'error',
      message: error instanceof Error ? `${error.name}: ${error.message}` : e.message || 'error with no message',
      detail: error instanceof Error && error.stack ? error.stack : `${e.filename ?? ''}:${e.lineno ?? 0}:${e.colno ?? 0}`,
    });
  });
  options.page.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = (event as PromiseRejectionEvent).reason;
    report.report({ kind: 'rejection', message: textOf(reason).slice(0, 500), ...(reason instanceof Error && reason.stack ? { detail: reason.stack } : {}) });
  });
  return report;
}

/** The WebGL context lost and given back (MDN `webglcontextlost`; `statusMessage` the browser's reason, when it gives one). */
export function watchContext(canvas: EventTarget, report: FieldReport = fieldReport): void {
  const status = (event: Event): string => (event as Event & { statusMessage?: string }).statusMessage ?? '';
  canvas.addEventListener('webglcontextlost', (event) => report.report({ kind: 'webgl-lost', message: 'WebGL context lost', ...(status(event) ? { detail: status(event) } : {}) }));
  canvas.addEventListener('webglcontextrestored', (event) => report.report({ kind: 'webgl-restored', message: 'WebGL context restored', ...(status(event) ? { detail: status(event) } : {}) }));
}

type ShaderErrorHook = (gl: WebGLRenderingContext, program: WebGLProgram, vertex: WebGLShader, fragment: WebGLShader) => void;

/** three's `renderer.debug.onShaderError` (three r186 WebGLRenderer docs: called only while `debug.checkShaderErrors` is on; assigning it turns
 *  three's own console report off). DO NOT drop the console line: it keeps three's own first words, which the F9 monitor reads (`healthWatch.ts`). */
export function shaderErrorHook(report: FieldReport = fieldReport): ShaderErrorHook {
  return (gl, program, vertex, fragment) => {
    const status = (shader: WebGLShader): string => (gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? '' : (gl.getShaderInfoLog(shader) ?? '').trim());
    const logs = [`program: ${(gl.getProgramInfoLog(program) ?? '').trim()}`, `vertex: ${status(vertex)}`, `fragment: ${status(fragment)}`].join('\n');
    const validate = gl.getProgramParameter(program, gl.VALIDATE_STATUS) as boolean;
    const message = `THREE.WebGLProgram: Shader Error ${gl.getError()} - VALIDATE_STATUS ${validate}`;
    console.error(`${message}\n\n${logs}`);
    report.report({ kind: 'shader', message, detail: logs });
  };
}

/** How often the session's heap and frames are looked at, ms (the ring holds 40 s, so no window is missed). */
const SAMPLE_EVERY_MS = 15_000;

/** One session's numbers, told as the page closes: the GPU, the quality tiers it ran at, the frames' times and the JS heap's peak. */
export class SessionSummary {
  private readonly started: number;
  private readonly levels: string[] = [];
  private peakHeap = 0;
  private worstP95 = 0;
  private sent = false;
  private due = 0;

  /** `frames` and `gpu` are read only when sampled or built: the frame ring and the renderer may come after the summary. */
  constructor(
    private readonly clock: () => number,
    private readonly frames: () => SampleRing,
    private readonly gpu: () => string,
  ) {
    this.started = clock();
    this.due = this.started + SAMPLE_EVERY_MS;
  }

  /** Each frame: a sample taken when one is due (every `SAMPLE_EVERY_MS`), nothing else. */
  tick(heapBytes: () => number | undefined): void {
    const now = this.clock();
    if (now < this.due) return;
    this.due = now + SAMPLE_EVERY_MS;
    this.sample(heapBytes());
  }

  /** The quality tier now in use, and who moved it (`auto`: the governor; otherwise the player). Kept: the last 40 moves. */
  level(level: string, by: 'auto' | 'player' | 'start'): void {
    this.levels.push(`${Math.round((this.clock() - this.started) / 1000)}s ${level} ${by}`);
    if (this.levels.length > 40) this.levels.splice(1, 1);
  }

  /** Every so often (seconds apart): the heap's size, and the frame ring's p95 (the ring holds the last 40 s; the session's worst window is kept). */
  sample(heapBytes: number | undefined): void {
    if (heapBytes !== undefined && heapBytes > this.peakHeap) this.peakHeap = heapBytes;
    const frames = this.frames();
    if (frames.size >= 60) this.worstP95 = Math.max(this.worstP95, frames.stats().p95);
  }

  /** The summary as a problem of kind `session`. */
  build(heapBytes?: number): Problem {
    this.sample(heapBytes);
    const s: SampleStats = this.frames().stats();
    return {
      kind: 'session',
      message: 'session summary',
      data: {
        minutes: Math.round((this.clock() - this.started) / 600) / 100,
        gpu: this.gpu() || 'unknown',
        levels: this.levels.join(' | '),
        frames: s.n,
        frameP50: s.p50,
        frameP95: s.p95,
        frameP99: s.p99,
        frameMax: s.max,
        worstP95: this.worstP95,
        peakHeapMb: Math.round(this.peakHeap / 1048576),
      },
    };
  }

  /** The summary told once (the page closing may say so twice: `pagehide` and `beforeunload`). */
  send(report: FieldReport, heapBytes?: number): void {
    if (this.sent) return;
    this.sent = true;
    report.report(this.build(heapBytes));
  }
}
