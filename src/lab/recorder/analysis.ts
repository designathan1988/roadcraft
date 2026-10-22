import type { FrameColumns, RecEvent } from './recording';

/** THE RECORDING CUT AT EVERY CHANGE: each stretch between two changes measured on its own (the first frames after a change left out: they compile and settle), then held against the one before and the first. */

/** After a change, this long is settling (programs compiled, targets made): its frames out of the stretch's figures, its worst reported apart. */
export const SETTLE_MS = 750;
/** Settling goes on past `SETTLE_MS` while the frames are still frozen (a burst of compiles can stop the game for seconds): it ends where this many frames in a row come in calm. */
const SETTLE_RUN = 10;
/** No calm run this long after the change: the stretch never settled (its figures left out, said so). */
const SETTLE_MAX_MS = 20_000;
/** Changes this close together (one `setMany`, a group switched) are one cut. */
const COALESCE_MS = 300;
/** Frames lean on the frames before them (a slow one delays the next): every this many count as one when the noise is guessed. */
const AUTOCORRELATION = 5;
/** Below this a difference in ms is nothing the timers can tell apart. */
const NOISE_FLOOR_MS = 0.1;

/** A distribution of one measure over a stretch's frames. */
export interface Dist {
  readonly n: number;
  readonly mean: number;
  readonly std: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  /** Median absolute deviation, scaled to a standard deviation (×1.4826): the spread, untouched by the hitches. */
  readonly spread: number;
}

export interface Settle {
  /** ms after the change the settling lasted (`SETTLE_MS` at least). */
  readonly ms: number;
  /** It never settled before the next change or `SETTLE_MAX_MS`. */
  readonly never: boolean;
  readonly frames: number;
  readonly maxIntervalMs: number;
  readonly maxCpuMs: number;
  readonly maxGpuMs: number | null;
}

export interface Segment {
  readonly index: number;
  readonly startMs: number;
  readonly endMs: number;
  /** What started it (none: the first, the baseline). */
  readonly causes: readonly RecEvent[];
  readonly label: string;
  readonly interval: Dist | null;
  readonly cpu: Dist | null;
  readonly gpu: Dist | null;
  readonly hitches25: number;
  readonly hitches50: number;
  readonly drawCalls: Dist | null;
  readonly triangles: Dist | null;
  /** MB a second the heap grew over the stretch (least squares), null without a heap reading. */
  readonly heapSlopeMBps: number | null;
  readonly heapMB: number | null;
  readonly settle: Settle | null;
  /** The frame's systems, mean ms, the costliest first. */
  readonly systems: readonly { readonly name: string; readonly meanMs: number }[];
}

export type Verdict = 'improved' | 'worse' | 'within noise';

export interface Delta {
  readonly metric: string;
  readonly from: number;
  readonly to: number;
  readonly delta: number;
  readonly pct: number | null;
  readonly noise: number;
  readonly verdict: Verdict;
}

export interface Comparison {
  readonly segment: number;
  readonly against: number;
  /** `previous` or `baseline`. */
  readonly kind: 'previous' | 'baseline';
  readonly deltas: readonly Delta[];
  /** The difference alone, said: the biggest real ones, or why there is none. */
  readonly effect: string;
  /** One line a reader takes in: the change, then `effect`. */
  readonly summary: string;
}

const quantile = (sorted: readonly number[], q: number): number => {
  if (!sorted.length) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at), hi = Math.ceil(at);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (at - lo);
};

export function distribution(values: readonly number[]): Dist | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((s, v) => s + v, 0) / n;
  const std = Math.sqrt(sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  const p50 = quantile(sorted, 0.5);
  const deviations = sorted.map((v) => Math.abs(v - p50)).sort((a, b) => a - b);
  return { n, mean, std, p50, p95: quantile(sorted, 0.95), p99: quantile(sorted, 0.99), max: sorted[n - 1]!, spread: 1.4826 * quantile(deviations, 0.5) };
}

/** Least squares slope of y over t (ms), per second. */
function slopePerSecond(ts: readonly number[], ys: readonly number[]): number | null {
  if (ts.length < 3) return null;
  const n = ts.length;
  const mt = ts.reduce((s, v) => s + v, 0) / n, my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (ts[i]! - mt) * (ys[i]! - my); den += (ts[i]! - mt) ** 2; }
  return den > 0 ? (num / den) * 1000 : null;
}

/** The cuts: every event that splits, those close together as one. */
export function boundaries(events: readonly RecEvent[]): { readonly t: number; readonly causes: RecEvent[] }[] {
  const out: { t: number; causes: RecEvent[] }[] = [];
  for (const e of events) {
    if (!e.split) continue;
    const last = out[out.length - 1];
    if (last && e.t - last.causes[last.causes.length - 1]!.t <= COALESCE_MS) last.causes.push(e);
    else out.push({ t: e.t, causes: [e] });
  }
  return out;
}

/** A change said as a person would: "turn off bShadows", "bTriangles = 0.5". */
export function describeChange(e: RecEvent): string {
  if (e.kind.startsWith('switch.')) {
    const data = e.data as { key?: string; value?: unknown } | undefined;
    const key = data?.key ?? e.kind.slice(7);
    const value = data?.value;
    if (typeof value === 'boolean') return `${value ? 'turn on' : 'turn off'} ${key}`;
    return `${key} = ${String(value)}`;
  }
  if (e.kind.startsWith('edit.')) return `Inspector edit: ${e.detail || e.kind.slice(5)}`;
  if (e.kind === 'rec.marker') return `marker "${e.detail}"`;
  if (e.kind === 'rec.resume') return 'resumed after pause';
  return e.detail || e.kind;
}

/** When the settling after a change at `startT` ends: the first run of `SETTLE_RUN` calm frames finishing past `SETTLE_MS` (calm: interval and CPU under 50 ms, or twice the stretch before's p95 on a machine that is slow anyway). */
function settleEnd(frames: FrameColumns, from: number, startT: number, end: number, before: Segment | undefined): { t: number; never: boolean } {
  const fixed = startT + SETTLE_MS;
  const calmInterval = Math.max(50, 2 * (before?.interval?.p95 ?? 0));
  const calmCpu = Math.max(50, 2 * (before?.cpu?.p95 ?? 0));
  let run = 0, runStart = fixed;
  for (let i = from; i < frames.t.length && frames.t[i]! < end; i++) {
    const t = frames.t[i]!;
    if (t - startT > SETTLE_MAX_MS) break;
    if (frames.interval[i]! > calmInterval || frames.cpu[i]! > calmCpu) { run = 0; continue; }
    if (run === 0) runStart = t;
    run++;
    if (run >= SETTLE_RUN && t >= fixed) return { t: Math.max(fixed, runStart), never: false };
  }
  return { t: Math.min(end, startT + SETTLE_MAX_MS), never: true };
}

export function segment(frames: FrameColumns, events: readonly RecEvent[], endMs: number): Segment[] {
  const cuts = boundaries(events);
  const starts = [{ t: 0, causes: [] as RecEvent[] }, ...cuts];
  const segments: Segment[] = [];
  let f = 0;
  for (let s = 0; s < starts.length; s++) {
    const start = starts[s]!;
    const end = starts[s + 1]?.t ?? endMs;
    while (f < frames.t.length && frames.t[f]! < start.t) f++;
    const settled = s === 0 ? { t: start.t, never: false } : settleEnd(frames, f, start.t, end, segments[s - 1]);
    const settleUntil = settled.t;
    const interval: number[] = [], cpu: number[] = [], gpu: number[] = [], calls: number[] = [], tris: number[] = [];
    const heapT: number[] = [], heapV: number[] = [];
    const systemSums = new Map<string, number>();
    let settleFrames = 0, sInt = 0, sCpu = 0, sGpu: number | null = null, hitches25 = 0, hitches50 = 0;
    // The first frame of all has no interval (`lab.ts`: 0).
    while (f < frames.t.length && frames.t[f]! < end) {
      const t = frames.t[f]!;
      if (t < start.t) { f++; continue; }
      const iv = frames.interval[f]!, c = frames.cpu[f]!, g = frames.gpu[f] ?? null;
      if (t < settleUntil) {
        settleFrames++;
        sInt = Math.max(sInt, iv);
        sCpu = Math.max(sCpu, c);
        if (g !== null) sGpu = Math.max(sGpu ?? 0, g);
      } else {
        if (iv > 0 && !frames.gap[f]) {
          interval.push(iv);
          if (iv > 25) hitches25++;
          if (iv > 50) hitches50++;
        }
        cpu.push(c);
        if (g !== null) gpu.push(g);
        calls.push(frames.calls[f]!);
        tris.push(frames.tris[f]!);
        const h = frames.heap[f] ?? null;
        if (h !== null) { heapT.push(t); heapV.push(h); }
        for (const [name, column] of frames.systems) systemSums.set(name, (systemSums.get(name) ?? 0) + (column[f] ?? 0));
      }
      f++;
    }
    const used = cpu.length;
    segments.push({
      index: s,
      startMs: start.t,
      endMs: end,
      causes: start.causes,
      label: s === 0 ? 'baseline' : start.causes.map(describeChange).join(' + '),
      interval: distribution(interval),
      cpu: distribution(cpu),
      gpu: distribution(gpu),
      hitches25,
      hitches50,
      drawCalls: distribution(calls),
      triangles: distribution(tris),
      heapSlopeMBps: slopePerSecond(heapT, heapV),
      heapMB: heapV.length ? heapV[heapV.length - 1]! : null,
      settle: s === 0 ? null : { ms: settled.t - start.t, never: settled.never, frames: settleFrames, maxIntervalMs: sInt, maxCpuMs: sCpu, maxGpuMs: sGpu },
      systems: used ? [...systemSums].map(([name, sum]) => ({ name, meanMs: sum / used })).sort((a, b) => b.meanMs - a.meanMs).slice(0, 12) : [],
    });
  }
  return segments;
}

/** How far a figure must move to be more than the noise: twice the standard error of the difference, the frames thinned for their dependence. The median's error is 1.253 σ/√n; the tail's (p95) taken as 2.5 σ/√n, a deliberate overestimate. */
function noiseOf(a: Dist, b: Dist, which: 'p50' | 'p95' | 'mean', floor: number): number {
  const factor = which === 'p50' ? 1.253 : which === 'p95' ? 2.5 : 1;
  const sigma = (d: Dist): number => (which === 'mean' ? d.std : Math.max(d.spread, d.std * 0.25));
  const se = (d: Dist): number => (factor * sigma(d)) / Math.sqrt(Math.max(1, d.n / AUTOCORRELATION));
  return Math.max(floor, 2 * Math.hypot(se(a), se(b)));
}

const METRICS: readonly { name: string; pick: (s: Segment) => Dist | null; which: 'p50' | 'p95' | 'mean'; floor: (v: number) => number }[] = [
  { name: 'GPU p50', pick: (s) => s.gpu, which: 'p50', floor: () => NOISE_FLOOR_MS },
  { name: 'GPU p95', pick: (s) => s.gpu, which: 'p95', floor: () => NOISE_FLOOR_MS },
  { name: 'CPU p50', pick: (s) => s.cpu, which: 'p50', floor: () => NOISE_FLOOR_MS },
  { name: 'CPU p95', pick: (s) => s.cpu, which: 'p95', floor: () => NOISE_FLOOR_MS },
  { name: 'Interval p50', pick: (s) => s.interval, which: 'p50', floor: () => NOISE_FLOOR_MS },
  { name: 'Interval p95', pick: (s) => s.interval, which: 'p95', floor: () => NOISE_FLOOR_MS },
  { name: 'Draw calls', pick: (s) => s.drawCalls, which: 'mean', floor: (v) => Math.max(0.5, v * 0.005) },
  { name: 'Triangles', pick: (s) => s.triangles, which: 'mean', floor: (v) => Math.max(1, v * 0.005) },
];

export const fmtNum = (v: number, digits = 1): string => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).replace('-', '−');
const signed = (v: number, digits = 1): string => (v > 0 ? '+' : '') + fmtNum(v, digits);
const unit = (metric: string): string => (metric.startsWith('Draw') || metric.startsWith('Tri') ? '' : ' ms');

export function describeDelta(d: Delta): string {
  const digits = unit(d.metric) ? 1 : 0;
  return `${d.metric} ${signed(d.delta, digits)}${unit(d.metric)}${d.pct === null ? '' : ` (${signed(d.pct, 0)}%)`}${d.verdict === 'within noise' ? ' — within noise' : ''}`;
}

export function compare(a: Segment, b: Segment, kind: 'previous' | 'baseline'): Comparison {
  const deltas: Delta[] = [];
  for (const m of METRICS) {
    const da = m.pick(a), db = m.pick(b);
    if (!da || !db || da.n < 10 || db.n < 10) continue;
    const from = m.which === 'mean' ? da.mean : da[m.which];
    const to = m.which === 'mean' ? db.mean : db[m.which];
    const delta = to - from;
    const noise = noiseOf(da, db, m.which, m.floor(Math.max(from, to)));
    deltas.push({ metric: m.name, from, to, delta, pct: from > 1e-9 ? (delta / from) * 100 : null, noise, verdict: Math.abs(delta) <= noise ? 'within noise' : delta < 0 ? 'improved' : 'worse' });
  }
  // The headline: the largest real move in ms, else the largest in count, else "nothing".
  const real = deltas.filter((d) => d.verdict !== 'within noise');
  // The GPU's and the CPU's own times first (the interval waits on vsync and, on demand, on nothing happening), the largest first; then the interval; then the counts.
  const rank = (d: Delta): number => (d.metric.startsWith('GPU') || d.metric.startsWith('CPU') ? 0 : unit(d.metric) ? 1 : 2);
  const ordered = [...real].sort((x, y) => rank(x) - rank(y) || Math.abs(y.delta) - Math.abs(x.delta));
  const gpu50 = deltas.find((d) => d.metric === 'GPU p50') ?? deltas.find((d) => d.metric === 'CPU p50');
  const few = (d: Dist | null): number => d?.n ?? 0;
  const said = ordered.length ? ordered.slice(0, 2).map(describeDelta).join('; ')
    : gpu50 ? describeDelta(gpu50)
      : `not enough measurements (${few(a.cpu)} → ${few(b.cpu)} settled frames; minimum 10)`;
  const effect = kind === 'previous' && a.index !== b.index - 1 ? `${said} (against segment ${a.index}: the ones between have no settled frames)` : said;
  return { segment: b.index, against: a.index, kind, deltas, effect, summary: `${b.label}: ${effect}` };
}

export function compareAll(segments: readonly Segment[]): Comparison[] {
  const out: Comparison[] = [];
  const base = segments[0];
  const enough = (sg: Segment): boolean => (sg.cpu?.n ?? 0) >= 10;
  for (let i = 1; i < segments.length; i++) {
    // Against the last stretch that has figures: one that never settled says nothing.
    let k = i - 1;
    while (k > 0 && !enough(segments[k]!)) k--;
    out.push(compare(segments[k]!, segments[i]!, 'previous'));
    if (base && i > 1) out.push(compare(base, segments[i]!, 'baseline'));
  }
  return out;
}
