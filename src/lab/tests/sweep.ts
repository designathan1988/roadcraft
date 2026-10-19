import type { LabContext } from '../labTypes';
import { sweepItems, type SweepItem } from './items';
import {
  type Cancel, Cancelled, cameraAt, check, collectFrames, goToView, holdScene, median, programs, restoreCamera, round, sceneSign, settle,
  signText, type ViewId, type WindowStats, windowStats,
} from './measure';

/** THE A/B SWEEP: for each item, the scene settled, a window measured as it stands (A), the item flipped and the scene settled again (its
 *  programs compiled, the frames steady), a window (B), flipped back, a window again (A): A/B/A, so a scene drifting under the run shows as
 *  the two A windows apart. The simulation's clock held throughout (measureCity's rule: the sun, the population and the vehicles still). */

export interface SweepOptions {
  /** Item ids (`switch.bloom`, `opt.x`); none: every item of `groups`, or every item. */
  readonly items?: readonly string[];
  /** Groups (`interruptor: pós`...), matched by prefix. */
  readonly groups?: readonly string[];
  readonly view?: ViewId;
  /** The standard views round the city's centre (0, 0) instead of the camera's. */
  readonly origin?: boolean;
  /** Frames a window. */
  readonly frames?: number;
  readonly reps?: number;
  /** The most a settle may wait, ms. */
  readonly settleMaxMs?: number;
}

export type Verdict = 'ganho' | 'perda' | 'ruído';

export interface SweepRow {
  readonly item: string;
  readonly label: string;
  readonly group: string;
  readonly a: string;
  readonly b: string;
  readonly gpuA: number | null;
  readonly gpuB: number | null;
  readonly gpuDelta: number | null;
  readonly gpuDeltaPct: number | null;
  readonly cpuDelta: number | null;
  readonly frameDelta: number | null;
  readonly callsDelta: number;
  readonly trianglesDelta: number;
  /** What the delta must pass to count, ms: the A windows apart, the windows' own spread, the repetitions' spread. */
  readonly noise: number | null;
  /** The two A windows apart, ms. */
  readonly drift: number | null;
  readonly newPrograms: number;
  readonly settleMs: number;
  /** The scene of the A windows differed (cells landed, vehicles came): the row is not a measure. */
  readonly sceneChanged: boolean;
  readonly unsettled: boolean;
  /** On the GPU's time, or the frame's when the GPU has no timer. */
  readonly basis: 'gpu' | 'frame';
  readonly verdict: Verdict;
}

export interface SweepResult {
  readonly kind: 'sweep';
  readonly startedAt: string;
  readonly ms: number;
  readonly view: ViewId;
  readonly frames: number;
  readonly reps: number;
  readonly gpuLabel: string;
  readonly gpuTimer: boolean;
  readonly cancelled: boolean;
  readonly warnings: readonly string[];
  readonly rows: readonly SweepRow[];
}

interface Rep { a1: WindowStats; b: WindowStats; a2: WindowStats; sceneChanged: boolean; newPrograms: number; settleMs: number; unsettled: boolean }

const text = (v: unknown): string => (v === undefined ? '—' : String(v));

/** The items a sweep's options pick. */
export function pickItems(all: readonly SweepItem[], options: SweepOptions): SweepItem[] {
  if (options.items?.length) return all.filter((i) => options.items!.includes(i.id) || options.items!.includes(i.label));
  if (options.groups?.length) return all.filter((i) => options.groups!.some((g) => i.group.startsWith(g)));
  return [...all];
}

export async function runSweep(ctx: LabContext, options: SweepOptions, cancel: Cancel, progress: (line: string) => void): Promise<SweepResult> {
  const t0 = performance.now();
  const view = options.view ?? 'current';
  const frames = Math.max(10, Math.round(options.frames ?? 120));
  const reps = Math.max(1, Math.round(options.reps ?? 1));
  const settleMax = options.settleMaxMs ?? 20000;
  const items = pickItems(sweepItems(ctx), options);
  const warnings: string[] = [];
  const rows: SweepRow[] = [];
  const camera = cameraAt();
  const originals = new Map(items.map((i) => [i, i.get()] as const));
  const hold = holdScene(ctx, 'held');
  let cancelled = false;
  ctx.emit('test.sweep.start', `varredura A/B: ${items.length} itens, ${frames} quadros, ${reps} repetições, vista ${view}`, { items: items.map((i) => i.id), frames, reps, view });
  try {
    if (!ctx.scene.gpu.supported) warnings.push('sem timer de GPU (EXT_disjoint_timer_query_webgl2): o veredito usa o tempo do quadro');
    if (!goToView(view, options.origin ? { x: 0, y: 0 } : null)) warnings.push(`vista ${view} não posta: sem a sonda __roadcraft.lookAt; medida na vista atual`);
    for (const [n, item] of items.entries()) {
      check(cancel);
      const a = item.get(), b = item.flipped(a);
      if (b === null || b === undefined) { warnings.push(`${item.id}: valor ${text(a)} sem alternativa, pulado`); continue; }
      const runs: Rep[] = [];
      ctx.emit('test.sweep.item', `${item.id}: ${text(a)} → ${text(b)} (${n + 1}/${items.length})`, { item: item.id, a, b });
      for (let r = 0; r < reps; r++) {
        progress(`${n + 1}/${items.length} ${item.label} · rep ${r + 1}/${reps} · A`);
        const s0 = await settle(ctx, cancel, 1500, settleMax);
        const sign0 = sceneSign(ctx);
        const a1 = windowStats(await collectFrames(ctx, frames, cancel));
        check(cancel);
        progress(`${n + 1}/${items.length} ${item.label} · rep ${r + 1}/${reps} · B (${text(b)})`);
        const p0 = programs(ctx);
        ctx.emit('test.sweep.flip', `${item.id} = ${text(b)}`, { item: item.id, value: b });
        item.set(b);
        const s1 = await settle(ctx, cancel, 1500, settleMax);
        const newPrograms = programs(ctx) - p0;
        const bw = windowStats(await collectFrames(ctx, frames, cancel));
        progress(`${n + 1}/${items.length} ${item.label} · rep ${r + 1}/${reps} · A de novo`);
        ctx.emit('test.sweep.flip', `${item.id} = ${text(a)}`, { item: item.id, value: a });
        item.set(a);
        const s2 = await settle(ctx, cancel, 1500, settleMax);
        const a2 = windowStats(await collectFrames(ctx, frames, cancel));
        const sceneChanged = signText(sign0, false) !== signText(sceneSign(ctx), false);
        runs.push({ a1, b: bw, a2, sceneChanged, newPrograms, settleMs: s1.ms, unsettled: s0.unsettled || s1.unsettled || s2.unsettled });
      }
      const row = rowOf(item, a, b, runs);
      rows.push(row);
      ctx.emit('test.sweep.result', `${item.id}: ${row.verdict} (Δ ${row.gpuDelta ?? row.frameDelta ?? '—'} ms)`, row);
    }
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    cancelled = true;
    warnings.push('interrompido');
  } finally {
    for (const [item, value] of originals) if (item.get() !== value) item.set(value);
    hold.release();
    restoreCamera(camera);
  }
  const result: SweepResult = {
    kind: 'sweep', startedAt: new Date(Date.now() - (performance.now() - t0)).toISOString(), ms: Math.round(performance.now() - t0),
    view, frames, reps, gpuLabel: ctx.scene.gpu.label, gpuTimer: ctx.scene.gpu.supported, cancelled, warnings, rows,
  };
  ctx.emit('test.sweep.end', `varredura A/B: ${rows.length} linhas em ${Math.round(result.ms / 1000)} s${cancelled ? ' (interrompida)' : ''}`, { rows: rows.length });
  return result;
}

/** One item's row from its repetitions: the deltas are B against the mean of its two A windows, their median over the repetitions. */
function rowOf(item: SweepItem, a: unknown, b: unknown, runs: readonly Rep[]): SweepRow {
  const gpuOn = runs.every((r) => r.a1.gpuP50 !== null && r.b.gpuP50 !== null && r.a2.gpuP50 !== null);
  const basis = gpuOn ? 'gpu' : 'frame';
  const pick = (w: WindowStats): number => (basis === 'gpu' ? w.gpuP50! : w.frameP50 ?? 0);
  const sigma = (w: WindowStats): number => (basis === 'gpu' ? w.gpuSigma ?? 0 : 0);
  const aOf = (r: Rep): number => (pick(r.a1) + pick(r.a2)) / 2;
  const deltas = runs.map((r) => pick(r.b) - aOf(r));
  const delta = median(deltas);
  const aMid = median(runs.map(aOf));
  const drift = Math.max(...runs.map((r) => Math.abs(pick(r.a2) - pick(r.a1))));
  // The noise: the A windows apart, twice the medians' own error, half the repetitions' spread; at least 2 % of A and 0.05 ms.
  const ownError = Math.max(...runs.map((r) => 2 * Math.sqrt(sigma(r.a1) ** 2 + sigma(r.b) ** 2)));
  const spread = deltas.length > 1 ? (Math.max(...deltas) - Math.min(...deltas)) / 2 : 0;
  const noise = Math.max(drift, ownError, spread, 0.02 * (aMid ?? 0), 0.05);
  const verdict: Verdict = delta === null || Math.abs(delta) <= noise ? 'ruído' : delta < 0 ? 'ganho' : 'perda';
  const md = (f: (r: Rep) => number | null): number | null => median(runs.map(f).filter((v): v is number => v !== null));
  const both = (x: number | null, y: number | null, z: number | null): number | null => (x === null || y === null || z === null ? null : y - (x + z) / 2);
  return {
    item: item.id, label: item.label, group: item.group, a: text(a), b: text(b),
    gpuA: round(md((r) => (r.a1.gpuP50 === null || r.a2.gpuP50 === null ? null : (r.a1.gpuP50 + r.a2.gpuP50) / 2))),
    gpuB: round(md((r) => r.b.gpuP50)),
    gpuDelta: round(md((r) => both(r.a1.gpuP50, r.b.gpuP50, r.a2.gpuP50))),
    gpuDeltaPct: gpuOn && aMid ? round((100 * delta!) / aMid, 1) : null,
    cpuDelta: round(md((r) => both(r.a1.cpuP50, r.b.cpuP50, r.a2.cpuP50))),
    frameDelta: round(md((r) => both(r.a1.frameP50, r.b.frameP50, r.a2.frameP50))),
    callsDelta: Math.round(md((r) => r.b.calls - (r.a1.calls + r.a2.calls) / 2) ?? 0),
    trianglesDelta: Math.round(md((r) => r.b.triangles - (r.a1.triangles + r.a2.triangles) / 2) ?? 0),
    noise: round(noise), drift: round(drift),
    newPrograms: Math.max(...runs.map((r) => r.newPrograms)),
    settleMs: Math.max(...runs.map((r) => r.settleMs)),
    sceneChanged: runs.some((r) => r.sceneChanged),
    unsettled: runs.some((r) => r.unsettled),
    basis, verdict,
  };
}
