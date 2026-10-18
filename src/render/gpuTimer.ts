import { WEAK_MACHINE } from '@core/weakMachine';
import type { WebGLRenderer } from 'three';
import { SampleRing } from '@core/sampleRing';

/** THE GPU TIME OF A FRAME */
export interface GpuTimer {
  /** Whether the extension is there (Chrome/Edge on desktop; not every browser). */
  readonly supported: boolean;
  /** The GPU drawing, as the driver names it (`WEBGL_debug_renderer_info`). */
  readonly label: string;
  /** GPU ms of the frames measured, the last 2 400 (40 s at 60 Hz). */
  readonly samples: SampleRing;
  /** Frames not measured: no free query. */
  readonly skipped: number;
  /** Results thrown away: the GPU was disjoint (a clock change, a context loss). */
  readonly disjoint: number;
  begin(): void;
  end(): void;
  /** Reads what came in; once a frame, before `begin`. */
  poll(): void;
}

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

export function createGpuTimer(renderer: WebGLRenderer, size = 16): GpuTimer {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const timerExtension = (): TimerExtension | null =>
    (typeof gl.getExtension === 'function' ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null) as TimerExtension | null;
  let ext = timerExtension();
  const info = typeof gl.getExtension === 'function' ? gl.getExtension('WEBGL_debug_renderer_info') : null;
  // A run playing a weaker machine names its GPU (`core/weakMachine.ts`).
  const label = WEAK_MACHINE.gpu ?? (info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown');
  const samples = new SampleRing(2400);
  if (!ext || typeof gl.createQuery !== 'function') {
    return { supported: false, label, samples, skipped: 0, disjoint: 0, begin() {}, end() {}, poll() {} };
  }
  const queries: WebGLQuery[] = [];
  for (let i = 0; i < size; i++) queries.push(gl.createQuery()!);
  /** Issued queries waiting for their result: `first` the oldest, `waiting` how many. */
  let first = 0, waiting = 0, running = false;
  /** DO NOT keep a query or the extension across a context loss. */
  let lost = false;
  const canvas = renderer.domElement;
  canvas.addEventListener('webglcontextlost', () => { lost = true; running = false; first = 0; waiting = 0; });
  canvas.addEventListener('webglcontextrestored', () => {
    ext = timerExtension();
    for (let i = 0; i < size; i++) queries[i] = gl.createQuery()!;
    lost = ext === null;
  });
  const round = new Float64Array(size);
  const timer = {
    supported: true,
    label,
    samples,
    skipped: 0,
    disjoint: 0,
    begin(): void {
      if (lost || !ext) return;
      if (running || waiting >= size) { timer.skipped++; return; }
      gl.beginQuery(ext.TIME_ELAPSED_EXT, queries[(first + waiting) % size]!);
      running = true;
    },
    end(): void {
      if (!running || !ext) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      running = false;
      waiting++;
    },
    poll(): void {
      if (lost || !ext) return;
      let n = 0;
      while (n < waiting) {
        const q = queries[(first + n) % size]!;
        if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
        round[n++] = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
      }
      if (n === 0) return;
      first = (first + n) % size;
      waiting -= n;
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { timer.disjoint += n; return; }
      for (let i = 0; i < n; i++) samples.push(round[i]!);
    },
  };
  return timer;
}
