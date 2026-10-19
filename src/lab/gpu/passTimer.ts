import type { WebGLRenderer } from 'three';

/** THE GPU TIME OF EACH PASS (the lab's per-pass mode): the frame cut into segments one after another, each a TIME_ELAPSED query of its own.
 * Khronos EXT_disjoint_timer_query(_webgl2): only ONE query of a target is active at a time (beginQuery on an active target is INVALID_OPERATION) - a pass inside another (the shadows inside the scene's) ends the outer's segment and starts it again after; results come in frames later (`QUERY_RESULT_AVAILABLE`, never before control is back to the browser); `GPU_DISJOINT_EXT` read non-zero makes every time filled since its last read undefined: thrown away. The whole-frame timer (`render/gpuTimer.ts`) is paused meanwhile. */

interface TimerExtension {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** One frame's GPU ms by pass. */
export type PassFrame = ReadonlyMap<string, number>;

export interface PassTimer {
  readonly supported: boolean;
  /** Frames measured whole and kept, newest last (the last `keep`). */
  readonly frames: readonly PassFrame[];
  /** Segments not measured (no free query): their frames thrown away. */
  readonly skipped: number;
  /** Frames thrown away because the GPU was disjoint. */
  readonly disjoint: number;
  /** A pass begins (nested: the outer's segment closed, resumed at `pop`). */
  push(label: string): void;
  pop(): void;
  /** The frame drawn: its segments make one frame. */
  frameEnded(): void;
  /** Reads what came in. */
  poll(): void;
  /** Every query let go, results dropped. */
  reset(): void;
  dispose(): void;
}

interface Issued { query: WebGLQuery; label: string; frame: number }

export function createPassTimer(renderer: WebGLRenderer, keep = 240, size = 512): PassTimer {
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExtension | null;
  const frames: PassFrame[] = [];
  if (!ext) {
    return { supported: false, frames, skipped: 0, disjoint: 0, push() {}, pop() {}, frameEnded() {}, poll() {}, reset() {}, dispose() {} };
  }
  const free: WebGLQuery[] = [];
  const issued: Issued[] = [];
  const stack: string[] = [];
  let open: Issued | null = null;
  let frame = 0;
  /** Frames with a segment left out: not kept. */
  const broken = new Set<number>();
  let partial: { frame: number; times: Map<string, number> } | null = null;
  let lost = false;
  const counts = { skipped: 0, disjoint: 0 };
  const canvas = renderer.domElement;
  const onLost = (): void => { lost = true; free.length = 0; issued.length = 0; stack.length = 0; open = null; partial = null; };
  const onRestored = (): void => { lost = false; gl.getParameter(ext.GPU_DISJOINT_EXT); };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  // The disjoint state cleared before the first query (the spec's example).
  gl.getParameter(ext.GPU_DISJOINT_EXT);

  const begin = (label: string): void => {
    if (lost) return;
    if (free.length === 0 && issued.length + 1 >= size) { counts.skipped++; broken.add(frame); return; }
    const query = free.pop() ?? gl.createQuery();
    if (!query) { broken.add(frame); return; }
    gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
    open = { query, label, frame };
  };
  const end = (): void => {
    if (!open) return;
    gl.endQuery(ext.TIME_ELAPSED_EXT);
    issued.push(open);
    open = null;
  };
  const flush = (): void => {
    if (!partial) return;
    if (!broken.has(partial.frame)) {
      frames.push(partial.times);
      if (frames.length > keep) frames.splice(0, frames.length - keep);
    }
    broken.delete(partial.frame);
    partial = null;
  };

  const timer: PassTimer = {
    supported: true,
    frames,
    get skipped() { return counts.skipped; },
    get disjoint() { return counts.disjoint; },
    push(label) {
      end();
      stack.push(label);
      begin(label);
    },
    pop() {
      end();
      stack.pop();
      const outer = stack[stack.length - 1];
      if (outer !== undefined) begin(outer);
    },
    frameEnded() {
      end();
      stack.length = 0;
      frame++;
    },
    poll() {
      if (lost) return;
      const read: [Issued, number][] = [];
      while (read.length < issued.length) {
        const q = issued[read.length]!;
        if (!gl.getQueryParameter(q.query, gl.QUERY_RESULT_AVAILABLE)) break;
        read.push([q, (gl.getQueryParameter(q.query, gl.QUERY_RESULT) as number) / 1e6]);
      }
      if (read.length === 0) return;
      issued.splice(0, read.length);
      for (const [q] of read) free.push(q.query);
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
        // Every time since the last read undefined: the frames they belong to dropped whole.
        const dropped = new Set(read.map(([q]) => q.frame));
        if (partial) dropped.add(partial.frame);
        for (const f of dropped) broken.add(f);
        counts.disjoint += dropped.size;
      }
      for (const [q, ms] of read) {
        if (partial && partial.frame !== q.frame) flush();
        partial ??= { frame: q.frame, times: new Map() };
        partial.times.set(q.label, (partial.times.get(q.label) ?? 0) + ms);
      }
      // The partial frame is whole once no query of it is still waiting (nor the frame still being drawn).
      if (partial && partial.frame < frame && !issued.some((q) => q.frame === partial!.frame)) flush();
    },
    reset() {
      end();
      stack.length = 0;
      for (const q of issued) free.push(q.query);
      issued.length = 0;
      partial = null;
      broken.clear();
      frames.length = 0;
    },
    dispose() {
      timer.reset();
      for (const q of free) gl.deleteQuery(q);
      free.length = 0;
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    },
  };
  return timer;
}

/** avg, p95 and max of a list of ms. */
export function spread(values: readonly number[]): { avg: number; p95: number; max: number } {
  if (!values.length) return { avg: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return { avg: sum / sorted.length, p95: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!, max: sorted[sorted.length - 1]! };
}
