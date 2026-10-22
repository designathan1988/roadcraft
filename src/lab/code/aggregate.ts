/** THE PROFILES SUMMED: each trace of the JS Self-Profiling API (WICG, `ProfilerTrace`) folded into per-function self and total time, the caller-callee edges, the hot stacks, recursion and depth. */

/** The trace `Profiler.stop()` gives (https://wicg.github.io/js-self-profiling/#the-profilertrace-dictionary). */
export interface ProfilerTrace {
  readonly resources: readonly string[];
  readonly frames: readonly { readonly name: string; readonly resourceId?: number; readonly line?: number; readonly column?: number }[];
  readonly stacks: readonly { readonly parentId?: number; readonly frameId: number }[];
  /** `marker`: Chrome's proposed sample markers (gc, style, layout, paint, script, other), when it sends them. */
  readonly samples: readonly { readonly timestamp: number; readonly stackId?: number; readonly marker?: string }[];
}

/** A function as the profiler names it: its script, the 1-based line and column it is defined at, its name. */
export interface FunctionId {
  readonly key: string;
  readonly url: string;
  readonly line: number;
  readonly column: number;
  readonly name: string;
}

export interface FunctionStat {
  readonly id: FunctionId;
  selfMs: number;
  totalMs: number;
  selfSamples: number;
  totalSamples: number;
  /** Windows it was sampled in, of the aggregate's `windows`. */
  windowsSeen: number;
  lastWindow: number;
  /** The most times it stood in one stack (1: never recursive) and the ms of the samples where it stood more than once. */
  recursionDepth: number;
  recursionMs: number;
  /** Seen directly calling itself (caller and callee the same). */
  direct: boolean;
}

export interface EdgeStat {
  readonly caller: string;
  readonly callee: string;
  ms: number;
  samples: number;
}

export interface StackStat {
  /** Leaf first. */
  readonly keys: readonly string[];
  readonly depth: number;
  ms: number;
  samples: number;
}

export interface Aggregate {
  readonly functions: Map<string, FunctionStat>;
  readonly edges: Map<string, EdgeStat>;
  readonly stacks: Map<string, StackStat>;
  /** ms with JavaScript on the stack, with nothing (idle or the browser's own work), in garbage collection. */
  busyMs: number;
  idleMs: number;
  gcMs: number;
  samples: number;
  windows: number;
  frames: number;
  /** The session's wall time sampled. */
  spanMs: number;
  maxDepth: number;
  deepest: readonly string[];
  /** Requested and actual sample interval of the last window. */
  intervalMs: number;
  startedAt: number;
  /** Bumped on every trace added (redraws only when it moves). */
  version: number;
}

/** Stacks kept at most (the rest summed as dropped). */
const STACKS_KEPT = 20_000;
/** Frames of a stack that make its key (the leaf's nearest). */
const STACK_KEY_DEPTH = 24;
const GC_NAME = /garbage collector|\(gc\)|^gc$/i;

export function createAggregate(): Aggregate {
  return {
    functions: new Map(), edges: new Map(), stacks: new Map(),
    busyMs: 0, idleMs: 0, gcMs: 0, samples: 0, windows: 0, frames: 0, spanMs: 0, maxDepth: 0, deepest: [],
    intervalMs: 0, startedAt: performance.now(), version: 0,
  };
}

/** `trace` folded into `agg`: each sample weighs the time to the next (at most twice the interval), the last the interval. `frames`: the game's frames drawn in the window. */
export function addTrace(agg: Aggregate, trace: ProfilerTrace, intervalMs: number, frames: number): void {
  agg.windows++;
  agg.frames += frames;
  agg.intervalMs = intervalMs;
  agg.version++;
  const window = agg.windows;
  const ids: FunctionId[] = trace.frames.map((f) => {
    const url = f.resourceId !== undefined ? (trace.resources[f.resourceId] ?? '') : '';
    const line = f.line ?? 0, column = f.column ?? 0;
    const name = f.name || '(anonymous)';
    return { key: `${name}@${url}:${line}:${column}`, url, line, column, name };
  });
  // Each stack's frames, leaf first, memoised through the parents.
  const chains: (readonly number[] | undefined)[] = new Array(trace.stacks.length);
  const chain = (id: number): readonly number[] => {
    const known = chains[id];
    if (known) return known;
    // Walked iteratively: stacks can be thousands deep.
    const path: number[] = [];
    let at: number | undefined = id;
    while (at !== undefined && !chains[at]) { path.push(at); at = trace.stacks[at]?.parentId; }
    let tail: readonly number[] = at !== undefined ? chains[at]! : [];
    for (let k = path.length - 1; k >= 0; k--) {
      const s = path[k]!;
      tail = [trace.stacks[s]!.frameId, ...tail];
      chains[s] = tail;
    }
    return chains[id]!;
  };
  const samples = trace.samples;
  if (samples.length) agg.spanMs += samples[samples.length - 1]!.timestamp - samples[0]!.timestamp + intervalMs;
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const next = samples[i + 1];
    const ms = next ? Math.min(next.timestamp - s.timestamp, intervalMs * 2) : intervalMs;
    agg.samples++;
    if (s.marker === 'gc') agg.gcMs += ms;
    if (s.stackId === undefined) { agg.idleMs += ms; continue; }
    const frameIds = chain(s.stackId);
    if (!frameIds.length) { agg.idleMs += ms; continue; }
    agg.busyMs += ms;
    const keys = frameIds.map((f) => ids[f]!.key);
    if (s.marker !== 'gc' && GC_NAME.test(ids[frameIds[0]!]!.name)) agg.gcMs += ms;
    // Self: the leaf.
    const counts = new Map<string, number>();
    for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    keys.forEach((key, depth) => {
      let stat = agg.functions.get(key);
      const n = counts.get(key)!;
      if (!stat) {
        const id = ids[frameIds[depth]!]!;
        stat = { id, selfMs: 0, totalMs: 0, selfSamples: 0, totalSamples: 0, windowsSeen: 0, lastWindow: 0, recursionDepth: 1, recursionMs: 0, direct: false };
        agg.functions.set(key, stat);
      }
      if (depth === 0) { stat.selfMs += ms; stat.selfSamples++; }
      // Total once a sample however often it stands in the stack: the outermost occurrence counts.
      if (n > 0) {
        counts.set(key, -n);
        stat.totalMs += ms;
        stat.totalSamples++;
        if (stat.lastWindow !== window) { stat.lastWindow = window; stat.windowsSeen++; }
        if (n > 1) {
          stat.recursionMs += ms;
          if (n > stat.recursionDepth) stat.recursionDepth = n;
        }
      }
    });
    // Edges: each caller > callee pair once a sample.
    const pairs = new Set<string>();
    for (let d = 0; d + 1 < keys.length; d++) {
      const callee = keys[d]!, caller = keys[d + 1]!;
      if (callee === caller) agg.functions.get(callee)!.direct = true;
      const k = `${caller}\n${callee}`;
      if (pairs.has(k)) continue;
      pairs.add(k);
      let edge = agg.edges.get(k);
      if (!edge) { edge = { caller, callee, ms: 0, samples: 0 }; agg.edges.set(k, edge); }
      edge.ms += ms;
      edge.samples++;
    }
    // The stack, by its nearest frames.
    const top = keys.length > STACK_KEY_DEPTH ? keys.slice(0, STACK_KEY_DEPTH) : keys;
    const sk = top.join('\n');
    let stack = agg.stacks.get(sk);
    if (!stack && agg.stacks.size < STACKS_KEPT) { stack = { keys: top, depth: keys.length, ms: 0, samples: 0 }; agg.stacks.set(sk, stack); }
    if (stack) { stack.ms += ms; stack.samples++; }
    if (keys.length > agg.maxDepth) { agg.maxDepth = keys.length; agg.deepest = keys; }
  }
}
