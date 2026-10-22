import type { Aggregate, FunctionId, FunctionStat } from './aggregate';
import type { SourceLocation } from './sourceMap';
import type { SourceStore } from './sourceStore';

/** WHAT THE SUMS SAY: each function placed in its TypeScript file and given a category; the recursion, the deep stacks and the suspects read off them. */

/** `lab`: the debugging lab's own code (this sampler among it), apart so it can be filtered out. */
export type Category = 'jogo' | 'lab' | 'three' | 'deps' | 'vite' | 'wasm' | 'navegador' | 'motor' | 'worker' | 'outro';

export interface FunctionRow {
  readonly stat: FunctionStat;
  readonly loc: SourceLocation | null;
  readonly category: Category;
  /** `src/x.ts:12` (original) or the script's path and generated line. */
  readonly where: string;
  readonly selfPct: number;
  readonly totalPct: number;
  /** ms per frame drawn in the sums' windows. */
  readonly msPerFrame: number;
  /** Of the windows sampled, the share it was seen in. */
  readonly presence: number;
}

export interface Suspect {
  readonly kind: string;
  readonly key: string;
  readonly name: string;
  readonly where: string;
  readonly value: number;
  readonly detail: string;
}

/** A number as the lab shows them (pt-BR). */
const num = (v: number, digits: number): string => v.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** The category of a script by its URL (and a native frame by its name). */
export function categoryOf(id: FunctionId): Category {
  if (!id.url) return id.name.startsWith('(') ? 'motor' : 'navegador';
  if (id.url.startsWith('wasm:')) return 'wasm';
  let path: string;
  try { path = new URL(id.url).pathname; } catch (error) { console.warn('lab code: bad script url', id.url, error); return 'outro'; }
  if (/worker/i.test(path) || id.url.startsWith('blob:')) return 'worker';
  if (path.startsWith('/src/lab/')) return 'lab';
  if (path.startsWith('/src/')) return 'jogo';
  if (/\/node_modules\/(\.vite\/deps\/)?three/.test(path)) return 'three';
  if (path.startsWith('/node_modules/')) return 'deps';
  if (path.startsWith('/@')) return 'vite';
  return 'outro';
}

/** A server path short: no origin, no leading slash, no Vite query. */
export const shortPath = (url: string): string => url.replace(/^[a-z]+:\/\/[^/]+\//i, '').replace(/\?.*$/, '');

export function whereOf(id: FunctionId, loc: SourceLocation | null): string {
  if (loc) return `${loc.file.replace(/^\//, '')}:${loc.line}`;
  // A script with no map (a prebundled dependency): its name alone, the line generated.
  return id.url ? `${shortPath(id.url).split('/').pop()}:${id.line} (gerado)` : '(nativo)';
}

/** Every function of `agg` as a row, placed through `store` (null places until its map is in). */
export function functionRows(agg: Aggregate, store: SourceStore): FunctionRow[] {
  const busy = Math.max(agg.busyMs + agg.idleMs, 1e-9);
  const frames = Math.max(agg.frames, 1);
  const rows: FunctionRow[] = [];
  for (const stat of agg.functions.values()) {
    const loc = store.locate(stat.id.url, stat.id.line, stat.id.column);
    rows.push({
      stat, loc, category: categoryOf(stat.id), where: whereOf(stat.id, loc),
      selfPct: (100 * stat.selfMs) / busy, totalPct: (100 * stat.totalMs) / busy,
      msPerFrame: stat.totalMs / frames, presence: agg.windows ? stat.windowsSeen / agg.windows : 0,
    });
  }
  return rows;
}

/** The functions found more than once in a stack. */
export function recursionRows(rows: readonly FunctionRow[]): FunctionRow[] {
  return rows.filter((r) => r.stat.recursionDepth > 1).sort((a, b) => b.stat.recursionMs - a.stat.recursionMs);
}

/** What deserves a look: hot leaves, recursion, deep stacks, the garbage collector, code always present for nothing, the engine's idle products, costly library calls by their game caller. */
export function suspects(agg: Aggregate, rows: readonly FunctionRow[], idleProducts: ReadonlyMap<string, { refreshes: number; idle: number; ms: number }>): Suspect[] {
  const out: Suspect[] = [];
  const span = Math.max(agg.busyMs + agg.idleMs, 1e-9);
  const byKey = new Map(rows.map((r) => [r.stat.id.key, r]));
  for (const r of rows) {
    const s = r.stat;
    if (r.category === 'motor') continue;
    if (r.selfPct >= 3 && s.selfMs >= 0.8 * s.totalMs && s.selfSamples >= 5)
      out.push({ kind: 'folha quente', key: s.id.key, name: s.id.name, where: r.where, value: s.selfMs, detail: `${num(r.selfPct, 1)}% do tempo amostrado no próprio corpo` });
    if (r.selfPct >= 1 && s.id.name === '(anônima)')
      out.push({ kind: 'anônima quente', key: s.id.key, name: s.id.name, where: r.where, value: s.selfMs, detail: 'função sem nome com custo: dê um nome para achá-la nos perfis' });
    if (s.recursionDepth > 1)
      out.push({ kind: s.direct ? 'recursão direta' : 'recursão', key: s.id.key, name: s.id.name, where: r.where, value: s.recursionMs, detail: `até ${s.recursionDepth}× na mesma pilha` });
    if (agg.windows >= 5 && r.presence >= 0.9 && r.totalPct < 0.5 && r.category === 'jogo')
      out.push({ kind: 'sempre presente, pouco faz', key: s.id.key, name: s.id.name, where: r.where, value: s.totalMs, detail: `vista em ${Math.round(r.presence * 100)}% das janelas com ${num(r.totalPct, 2)}% do tempo: sondagem a cada quadro?` });
    if (r.category === 'jogo' && r.msPerFrame >= 2)
      out.push({ kind: 'caminho quente', key: s.id.key, name: s.id.name, where: r.where, value: s.totalMs, detail: `${num(r.msPerFrame, 2)} ms por quadro (total com chamadas)` });
  }
  if (agg.maxDepth >= 60) {
    const leaf = agg.deepest[0] ?? '';
    const r = byKey.get(leaf);
    out.push({ kind: 'pilha profunda', key: leaf, name: r?.stat.id.name ?? leaf, where: r?.where ?? '', value: agg.maxDepth, detail: `${agg.maxDepth} quadros na pilha mais funda` });
  }
  if (agg.gcMs > 0)
    out.push({ kind: 'coleta de lixo', key: '', name: '(garbage collector)', where: '', value: agg.gcMs, detail: `${num((100 * agg.gcMs) / span, 1)}% do tempo amostrado` });
  // A library's time (three, deps) charged to the nearest game function calling into it.
  const charged = new Map<string, number>();
  for (const e of agg.edges.values()) {
    const callee = byKey.get(e.callee), caller = byKey.get(e.caller);
    if (!callee || !caller || caller.category !== 'jogo' || (callee.category !== 'three' && callee.category !== 'deps')) continue;
    charged.set(e.caller, (charged.get(e.caller) ?? 0) + e.ms);
  }
  for (const [key, ms] of charged) {
    if ((100 * ms) / span < 2) continue;
    const r = byKey.get(key)!;
    out.push({ kind: 'chamada cara a biblioteca', key, name: r.stat.id.name, where: r.where, value: ms, detail: `${num((100 * ms) / span, 1)}% do tempo em three/deps chamados daqui` });
  }
  for (const [name, p] of idleProducts) {
    if (p.refreshes >= 20 && p.idle / p.refreshes >= 0.9)
      out.push({ kind: 'produto refeito sem mudança', key: '', name, where: 'engine', value: p.ms, detail: `${p.idle} de ${p.refreshes} refeitos ociosos (Engine.onRefresh)` });
  }
  return out.sort((a, b) => b.value - a.value);
}

/** The report's section: the top functions, the recursion, the suspects. */
export function reportOf(agg: Aggregate, rows: readonly FunctionRow[], found: readonly Suspect[]): unknown {
  const top = [...rows].sort((a, b) => b.stat.selfMs - a.stat.selfMs).slice(0, 30);
  const round = (v: number): number => Math.round(v * 100) / 100;
  return {
    windows: agg.windows, samples: agg.samples, intervalMs: agg.intervalMs, spanMs: round(agg.spanMs),
    busyMs: round(agg.busyMs), idleMs: round(agg.idleMs), gcMs: round(agg.gcMs), frames: agg.frames, maxDepth: agg.maxDepth,
    top: top.map((r) => ({ name: r.stat.id.name, where: r.where, category: r.category, selfMs: round(r.stat.selfMs), totalMs: round(r.stat.totalMs), selfPct: round(r.selfPct), samples: r.stat.selfSamples })),
    recursion: recursionRows(rows).slice(0, 20).map((r) => ({ name: r.stat.id.name, where: r.where, depth: r.stat.recursionDepth, direct: r.stat.direct, ms: round(r.stat.recursionMs) })),
    suspects: found.slice(0, 40).map((s) => ({ kind: s.kind, name: s.name, where: s.where, value: round(s.value), detail: s.detail })),
  };
}
