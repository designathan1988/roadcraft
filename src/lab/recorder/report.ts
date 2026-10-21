import { formatBuildStamp } from '@ui/buildStamp';
import type { LabContext } from '../labTypes';
import { SETTLE_MS, compareAll, describeChange, describeDelta, fmtNum, segment, type Comparison, type Dist, type Segment } from './analysis';
import type { Recording } from './recording';

/** THE RECORDING'S REPORT, written for an AI to read: the JSON with everything, and a Markdown that says what was changed, what it did, and how sure it is. */

export const REPORT_FORMAT = 'roadcraft-lab-recording/1';

export interface Anomaly {
  readonly kind: 'hitch' | 'settle' | 'heap' | 'recompile' | 'longtask';
  readonly t: number;
  readonly detail: string;
}

export interface LabReport {
  /** File name stem: `rec-2026-10-19T12-30-05`. */
  readonly stamp: string;
  readonly json: Record<string, unknown>;
  readonly md: string;
  readonly segments: readonly Segment[];
  readonly comparisons: readonly Comparison[];
  readonly anomalies: readonly Anomaly[];
  /** One line for lists. */
  readonly summary: string;
}

function gpuName(ctx: LabContext): string {
  try {
    const gl = ctx.scene.gl.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  } catch (error) {
    console.warn('lab recorder: GPU name unreadable', error);
    return 'unknown';
  }
}

const s = (ms: number): string => `${fmtNum(ms / 1000, 1)} s`;
const ms = (v: number | undefined | null): string => (v === undefined || v === null ? '—' : fmtNum(v, 2));
const int = (v: number | undefined | null): string => (v === undefined || v === null ? '—' : Math.round(v).toLocaleString('en-US'));

/** The frames before the first of each segment's settled frames: what is left out. */
function anomaliesOf(rec: Recording, segments: readonly Segment[]): Anomaly[] {
  const out: Anomaly[] = [];
  const f = rec.frames;
  const settleEnds = segments.slice(1).map((sg) => [sg.startMs, sg.startMs + (sg.settle?.ms ?? SETTLE_MS)] as const);
  const settling = (t: number): boolean => settleEnds.some(([a, b]) => t >= a && t < b);
  const hitches: { t: number; v: number }[] = [];
  for (let i = 0; i < f.t.length; i++) if (!f.gap[i] && f.interval[i]! > 50 && !settling(f.t[i]!)) hitches.push({ t: f.t[i]!, v: f.interval[i]! });
  hitches.sort((a, b) => b.v - a.v);
  const before = (t: number): string => {
    const e = [...rec.events].reverse().find((x) => x.t <= t && x.t > t - 2000 && x.kind !== 'rec.stop');
    return e ? ` (${Math.round(t - e.t)} ms after ${e.kind}: ${e.detail})` : '';
  };
  for (const h of hitches.slice(0, 12)) out.push({ kind: 'hitch', t: h.t, detail: `${fmtNum(h.v, 1)} ms frame at ${s(h.t)}${before(h.t)}` });
  if (hitches.length > 12) out.push({ kind: 'hitch', t: hitches[12]!.t, detail: `and ${hitches.length - 12} more frames over 50 ms` });
  for (const sg of segments) {
    if (sg.settle && (sg.settle.maxIntervalMs > 50 || sg.settle.maxCpuMs > 33)) {
      out.push({ kind: 'settle', t: sg.startMs, detail: `spike right after "${sg.label}": max interval ${fmtNum(sg.settle.maxIntervalMs, 1)} ms, max CPU ${fmtNum(sg.settle.maxCpuMs, 1)} ms in the first ${Math.round(sg.settle.ms)} ms (${sg.settle.frames} frames)${sg.settle.never ? ' — **did not settle** before the next change/20 s: the segment\'s statistics stay empty' : ''} — likely shader compilation/target creation` });
    }
    if (sg.heapSlopeMBps !== null && sg.endMs - sg.startMs >= 5000 && sg.heapSlopeMBps > 0.5) {
      out.push({ kind: 'heap', t: sg.startMs, detail: `heap grows ${fmtNum(sg.heapSlopeMBps, 2)} MB/s in segment ${sg.index} ("${sg.label}") — possible leak or garbage piling up` });
    }
  }
  for (let i = 1; i < rec.sim.length; i++) {
    const a = rec.sim[i - 1]!.programs, b = rec.sim[i]!.programs;
    if (a !== null && b !== null && b > a) out.push({ kind: 'recompile', t: rec.sim[i]!.t, detail: `shader programs ${a} → ${b} around ${s(rec.sim[i]!.t)}${before(rec.sim[i]!.t)}` });
  }
  const long = rec.events.filter((e) => e.kind === 'longtask');
  if (long.length) {
    const total = long.reduce((sum, e) => sum + ((e.data as { duration?: number } | undefined)?.duration ?? 0), 0);
    out.push({ kind: 'longtask', t: long[0]!.t, detail: `${long.length} long tasks (>50 ms) totalling ${Math.round(total)} ms; the longest: ${Math.round(Math.max(...long.map((e) => (e.data as { duration?: number } | undefined)?.duration ?? 0)))} ms` });
  }
  return out;
}

/** The other areas' sections, a few lines each: a summary string if they have one, else their costliest rows. */
function suspectsOf(sections: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const COSTLY = /ms|bytes|mb|kb|count|cost|time|calls|tri|gpu|cpu|share|total/i;
  for (const [name, value] of Object.entries(sections)) {
    if (name === 'recording' || name === 'inspector' || value === null || value === undefined) continue;
    const v = value as Record<string, unknown>;
    if (typeof v['summary'] === 'string') { lines.push(`- **${name}**: ${v['summary']}`); continue; }
    const rows = Array.isArray(value) ? value : Object.values(v).find((x) => Array.isArray(x) && x.length && typeof x[0] === 'object');
    if (Array.isArray(rows) && rows.length && rows[0] && typeof rows[0] === 'object') {
      const first = rows[0] as Record<string, unknown>;
      const key = Object.keys(first).find((k) => typeof first[k] === 'number' && COSTLY.test(k)) ?? Object.keys(first).find((k) => typeof first[k] === 'number');
      const sorted = key ? [...rows as Record<string, unknown>[]].sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0)) : rows as Record<string, unknown>[];
      lines.push(`- **${name}** (${rows.length} rows${key ? `, largest by \`${key}\`` : ''}):`);
      for (const r of sorted.slice(0, 5)) lines.push(`  - ${JSON.stringify(r).slice(0, 240)}`);
      continue;
    }
    lines.push(`- **${name}**: \`${JSON.stringify(value).slice(0, 400)}\``);
  }
  return lines;
}

const distJson = (d: Dist | null): unknown => (d ? Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) : null);

export function buildReport(ctx: LabContext, rec: Recording): LabReport {
  const stamp = `rec-${rec.startedAt.slice(0, 19).replace(/:/g, '-')}`;
  const segments = segment(rec.frames, rec.events, rec.endMs);
  const comparisons = compareAll(segments);
  const anomalies = anomaliesOf(rec, segments);
  const sections = Object.fromEntries(Object.entries(ctx.collectReport()).filter(([name]) => name !== 'recording'));
  const build = formatBuildStamp();
  const gpu = gpuName(ctx);
  const startSettings = rec.settings[0]?.effects ?? {};
  const meta = {
    format: REPORT_FORMAT,
    date: rec.startedAt,
    stoppedBy: rec.stopReason,
    durationMs: rec.endMs,
    activeMs: Math.round(rec.activeMs),
    frames: rec.frames.t.length,
    gpu,
    gpuTimer: ctx.scene.gpu.supported,
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height, devicePixelRatio: window.devicePixelRatio, canvas: [ctx.scene.gl.domElement.width, ctx.scene.gl.domElement.height] },
    crossOriginIsolated: window.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    build,
    url: location.href,
    settleMs: SETTLE_MS,
  };
  const json: Record<string, unknown> = {
    meta,
    settingsAtStart: rec.settings[0] ?? null,
    settingsChanges: rec.settings.slice(1),
    segments: segments.map((sg) => ({ ...sg, causes: sg.causes.map((c) => ({ t: c.t, kind: c.kind, detail: c.detail, data: c.data })), interval: distJson(sg.interval), cpu: distJson(sg.cpu), gpu: distJson(sg.gpu), drawCalls: distJson(sg.drawCalls), triangles: distJson(sg.triangles) })),
    comparisons,
    anomalies,
    events: rec.events,
    view: rec.views,
    sim: rec.sim,
    frames: { ...rec.frames, systems: Object.fromEntries(rec.frames.systems), gap: rec.frames.gap.map((g) => (g ? 1 : 0)) },
    sections,
  };

  // ---- the Markdown
  const md: string[] = [];
  const previous = new Map(comparisons.filter((c) => c.kind === 'previous').map((c) => [c.segment, c]));
  const baseline = new Map(comparisons.filter((c) => c.kind === 'baseline').map((c) => [c.segment, c]));
  md.push(`# Performance recording — Roadcraft`, '');
  md.push(`Report made by the debug lab (F7, Recording tab), to be read by an AI or a person. Format \`${REPORT_FORMAT}\`; the sibling JSON (\`${stamp}.json\`) has every frame.`, '');
  md.push('## Context', '');
  md.push(`- Date: ${rec.startedAt} · duration ${s(rec.endMs)} (recording ${s(rec.activeMs)}) · ${rec.frames.t.length.toLocaleString('en-US')} frames · stopped by: ${rec.stopReason}`);
  md.push(`- GPU: ${gpu} · GPU timer: ${ctx.scene.gpu.supported ? 'yes' : 'no (GPU columns empty)'}`);
  md.push(`- Screen: ${screen.width}×${screen.height} @${window.devicePixelRatio} · canvas ${ctx.scene.gl.domElement.width}×${ctx.scene.gl.domElement.height} · crossOriginIsolated: ${String(window.crossOriginIsolated)} · cores: ${navigator.hardwareConcurrency}`);
  md.push(`- Build: ${build} · ${location.href}`);
  md.push(`- Browser: ${navigator.userAgent}`);
  const lastSim = rec.sim[rec.sim.length - 1];
  if (lastSim) md.push(`- Simulation (end): ${int(lastSim.vehicles)} vehicles, ${int(lastSim.people)} people, step ${ms(lastSim.stepMs)} ms, ${int(lastSim.programs)} shader programs`);
  const v0 = rec.views[0], vN = rec.views[rec.views.length - 1];
  if (v0 && vN) md.push(`- Camera: ${v0.kind}, zoom ${v0.zoom} → ${vN.zoom}; ${rec.views.length} distinct positions logged, ${rec.events.filter((e) => e.kind === 'view.move').length} moves`);
  if (startSettings['onDemand'] === true) md.push(`- **Warning**: \`onDemand\` on — the game only draws when something changes; the intervals include idle waiting. Compare CPU/GPU, not the interval.`);
  const off = Object.entries(startSettings).filter(([, v]) => v === false).map(([k]) => k);
  const valued = Object.entries(startSettings).filter(([, v]) => typeof v !== 'boolean').map(([k, v]) => `${k}=${String(v)}`);
  md.push(`- Settings at start: off: ${off.length ? off.join(', ') : 'none'}; values: ${valued.join(', ') || '—'}`, '');

  md.push('## What changed and when', '');
  const changes = rec.events.filter((e) => e.split);
  if (!changes.length) md.push('Nothing changed during the recording: a single segment.');
  for (const e of changes) md.push(`- ${s(e.t)} — \`${e.kind}\`: ${describeChange(e)}`);
  md.push('');

  md.push('## Segments', '');
  md.push(`Each segment runs from one change to the next; the settling after each change (≥ ${SETTLE_MS} ms, until the game calms down) is left out of the statistics. Times in ms; Δ against the previous segment.`, '');
  md.push('| # | start | dur. | frames | change | interval p50/p95/p99 | CPU p50/p95/p99 | GPU p50/p95/p99 | >25/>50 ms | draw calls | triangles | heap MB/s | Δ vs previous | Δ vs baseline |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const sg of segments) {
    const tri = (d: Dist | null): string => (d ? `${ms(d.p50)} / ${ms(d.p95)} / ${ms(d.p99)}` : '—');
    const p = previous.get(sg.index), b = baseline.get(sg.index);
    const deltaText = (c: Comparison | undefined): string => (c ? c.effect : '—');
    md.push(`| ${sg.index} | ${s(sg.startMs)} | ${s(sg.endMs - sg.startMs)} | ${sg.cpu?.n ?? 0} | ${sg.label} | ${tri(sg.interval)} | ${tri(sg.cpu)} | ${tri(sg.gpu)} | ${sg.hitches25}/${sg.hitches50} | ${int(sg.drawCalls?.mean)} | ${int(sg.triangles?.mean)} | ${sg.heapSlopeMBps === null ? '—' : fmtNum(sg.heapSlopeMBps, 2)} | ${deltaText(p)} | ${deltaText(b)} |`);
  }
  md.push('');

  md.push('## Effect of each change', '');
  if (!comparisons.length) md.push('No changes: nothing to compare.');
  for (const c of comparisons.filter((x) => x.kind === 'previous')) {
    const sg = segments[c.segment]!;
    md.push(`### Segment ${c.segment}: ${sg.label}`, '');
    md.push(`- Summary: **${c.summary}**`);
    for (const d of c.deltas) md.push(`  - ${describeDelta(d)} — ${fmtNum(d.from, 2)} → ${fmtNum(d.to, 2)}, noise ±${fmtNum(d.noise, 2)} → ${d.verdict}`);
    const bc = baseline.get(c.segment);
    if (bc) md.push(`- Against the baseline: ${bc.effect}`);
    const before = segments[c.segment - 1];
    if (before && sg.systems.length) {
      const moved = sg.systems.map((x) => ({ name: x.name, d: x.meanMs - (before.systems.find((y) => y.name === x.name)?.meanMs ?? 0) })).filter((x) => Math.abs(x.d) >= 0.05).sort((a, b2) => Math.abs(b2.d) - Math.abs(a.d)).slice(0, 5);
      if (moved.length) md.push(`- CPU systems that changed most (mean ms/frame): ${moved.map((x) => `${x.name} ${x.d > 0 ? '+' : ''}${fmtNum(x.d, 2)}`).join(', ')}`);
    }
    if (sg.settle) md.push(`- Settling (${Math.round(sg.settle.ms)} ms${sg.settle.never ? ', did not settle' : ''}, ${sg.settle.frames} frames discarded): max interval ${ms(sg.settle.maxIntervalMs)}, max CPU ${ms(sg.settle.maxCpuMs)}, max GPU ${ms(sg.settle.maxGpuMs)}`);
    md.push('');
  }

  const base = segments[0];
  if (base?.systems.length) {
    md.push('## Biggest CPU consumers (baseline)', '');
    for (const x of base.systems.slice(0, 8)) md.push(`- ${x.name}: ${fmtNum(x.meanMs, 2)} ms/frame`);
    md.push('');
  }
  // The CPU profile recorded with it (`lab/code`): which functions, in which file and line, the main thread spent its time in.
  const code = sections['code'] as { windows?: number; samples?: number; spanMs?: number; busyMs?: number; gcMs?: number;
    top?: { name: string; where: string; category: string; selfMs: number; totalMs: number; selfPct: number }[];
    recursion?: { name: string; where: string; depth: number; ms: number }[]; suspects?: { kind: string; name: string; where: string; value: number; detail: string }[] } | undefined;
  md.push('## Functions that spent the most CPU (profile recorded alongside)', '');
  if (!code?.top?.length) md.push('The CPU profile had no samples (JS Self-Profiling unavailable or recording too short).', '');
  else {
    md.push(`${code.samples ?? 0} samples in ${code.windows ?? 0} windows · busy ${fmtNum((code.busyMs ?? 0) / 1000, 1)} s of ${fmtNum((code.spanMs ?? 0) / 1000, 1)} s · garbage collection ${fmtNum((code.gcMs ?? 0) / 1000, 1)} s. "Self": the function on top of the stack; "total": with what it calls.`, '');
    md.push('| function | where | category | self ms | total ms | % self |', '|---|---|---|---|---|---|');
    for (const f of code.top.slice(0, 25)) md.push(`| ${f.name || '(anonymous)'} | ${f.where} | ${f.category} | ${fmtNum(f.selfMs, 1)} | ${fmtNum(f.totalMs, 1)} | ${fmtNum(f.selfPct, 1)} |`);
    md.push('');
    if (code.suspects?.length) {
      md.push('Profile suspects:', '');
      for (const x of code.suspects.slice(0, 15)) md.push(`- **${x.kind}** — ${x.name || '(anonymous)'} in ${x.where}: ${x.detail}`);
      md.push('');
    }
    if (code.recursion?.length) {
      md.push('Recursion:', '');
      for (const x of code.recursion.slice(0, 8)) md.push(`- ${x.name || '(anonymous)'} in ${x.where}: up to ${x.depth}× on the same stack, ${fmtNum(x.ms, 1)} ms`);
      md.push('');
    }
  }
  const edits = rec.events.filter((e) => e.kind.startsWith('edit.'));
  if (edits.length || sections['inspector'] !== undefined) {
    md.push('## Edits made through the Inspector', '');
    for (const e of edits) md.push(`- ${s(e.t)} — \`${e.kind}\`: ${e.detail}${e.data === undefined ? '' : ` \`${JSON.stringify(e.data).slice(0, 300)}\``}`);
    if (!edits.length) md.push('No edits during the recording.');
    if (sections['inspector'] !== undefined) md.push('', `Section \`inspector\` (state at the end): \`${JSON.stringify(sections['inspector']).slice(0, 1500)}\``);
    md.push('');
  }
  const suspects = suspectsOf(sections);
  md.push('## Suspects from the lab\'s other areas', '');
  md.push(...(suspects.length ? suspects : ['No other area registered a report section.']), '');

  md.push('## Anomalies', '');
  md.push(...(anomalies.length ? anomalies.map((a) => `- [${a.kind}] ${a.detail}`) : ['None: no frames over 50 ms outside settling, no heap growth, no recompiles observed.']), '');
  const markers = rec.events.filter((e) => e.kind === 'rec.marker');
  if (markers.length) {
    md.push('## Markers', '');
    for (const m of markers) md.push(`- ${s(m.t)}: ${m.detail}`);
    md.push('');
  }

  md.push('## How to read', '');
  md.push('- **interval**: time from the start of one frame to the start of the next — what the player waits (16.7 ms = 60 Hz). Includes the vsync wait.');
  md.push('- **CPU**: the frame\'s own work on the main thread (`FrameTimer`). **GPU**: GPU time measured by a timer query (arrives a few frames late; repeats the last value until another arrives).');
  md.push('- **p50/p95/p99**: median and percentiles; **>25/>50 ms**: frames whose interval went past that (hitches).');
  md.push(`- **settling**: after each change, at least ${SETTLE_MS} ms and until 10 calm frames in a row (interval and CPU < 50 ms) — shader compilation, target creation; left out of the statistics, its spike reported apart. "Did not settle": the game did not calm down before the next change.`);
  md.push('- **noise**: 2 × the standard error of the difference, with each segment\'s robust spread (MAD×1.4826) and its frame count divided by 5 (neighbouring frames are not independent). p95 uses a larger error. A difference smaller than that is "within noise": conclude nothing from it.');
  md.push('- **Δ vs previous** attributes the difference to the change(s) that opened the segment; **Δ vs baseline** compares with the first segment (everything as it was at the start).');
  md.push('- **heap MB/s**: slope of the JS heap over the segment (least squares); positive and persistent suggests a leak — but GC is sawtooth-shaped: only long segments say anything.');
  md.push('- The GPU may be shared with other processes; repeat the recording before claiming a small gain.');
  md.push('');

  const real = comparisons.filter((c) => c.kind === 'previous').map((c) => c.summary);
  const summary = `${s(rec.endMs)}, ${segments.length} segments${real.length ? `: ${real.slice(0, 3).join('; ')}` : ''}`;
  return { stamp, json, md: md.join('\n'), segments, comparisons, anomalies, summary };
}
