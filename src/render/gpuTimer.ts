import type { WebGLRenderer } from 'three';
import { SampleRing } from '@core/sampleRing';

/**
 * THE GPU TIME OF A FRAME (docs/pesquisa/fase-0-medida.md 3.1): one
 * `TIME_ELAPSED` query of `EXT_disjoint_timer_query_webgl2` round what the
 * game draws once a frame (the shadow, the scene and every pass of the post
 * chain, `PostChain.render`). Built for the frame loop, so nothing is made
 * per frame:
 * - a ring of queries made once; a frame with no free query (or one already
 *   running) is not measured, and counted (`skipped`), never waited for;
 * - only the oldest query is asked whether its result is in: results come in
 *   order (Khronos), so when it is not, none is;
 * - `GPU_DISJOINT_EXT` read once a round, AFTER the results it vouches for:
 *   set, the whole round is thrown away (`disjoint`). three r186's own pool
 *   handed back its last value on a disjoint; stats-gl read the flag per
 *   query, and the second read no longer sees the event.
 * The renderer's name goes with the numbers: the headless Chrome draws on the
 * Intel iGPU, about 5x slower than the player's RTX 3060, and the two are
 * never compared (CLAUDE.md).
 */
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
  const ext = (typeof gl.getExtension === 'function' ? gl.getExtension('EXT_disjoint_timer_query_webgl2') : null) as TimerExtension | null;
  const info = typeof gl.getExtension === 'function' ? gl.getExtension('WEBGL_debug_renderer_info') : null;
  const label = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  const samples = new SampleRing(2400);
  if (!ext || typeof gl.createQuery !== 'function') {
    return { supported: false, label, samples, skipped: 0, disjoint: 0, begin() {}, end() {}, poll() {} };
  }
  const queries: WebGLQuery[] = [];
  for (let i = 0; i < size; i++) queries.push(gl.createQuery()!);
  /** Issued queries waiting for their result: `first` the oldest, `waiting` how many. */
  let first = 0, waiting = 0, running = false;
  const round = new Float64Array(size);
  const timer = {
    supported: true,
    label,
    samples,
    skipped: 0,
    disjoint: 0,
    begin(): void {
      if (running || waiting >= size) { timer.skipped++; return; }
      gl.beginQuery(ext.TIME_ELAPSED_EXT, queries[(first + waiting) % size]!);
      running = true;
    },
    end(): void {
      if (!running) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      running = false;
      waiting++;
    },
    poll(): void {
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
