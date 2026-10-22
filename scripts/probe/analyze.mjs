// THE ANALYSER (PLANO-SONDA.md §3 [C], stage 0): over what `run.mjs` wrote under `<out>/raw/`, resolves every stack to the source's
// file:line (Vite's inline maps), runs the rules stage 0 can run - stall, leak, dead-code, large-clone, idle-running - deduplicates
// the findings by the line of the cause, orders them by the cost the clean pass measured, and writes `report.md`, `findings.json`,
// `counters.json` and `dead-code.md`. Nothing here judges intent: a finding is a counted fact with the counter its fix must zero.
// Usage: node --max-old-space-size=8192 scripts/probe/analyze.mjs <out> [--no-knip]
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sources, shortPath } from './sources.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..', '..');
const OUT = resolve(process.argv[2] ?? '');
if (!OUT || !existsSync(join(OUT, 'raw', 'meta.json'))) { console.error('usage: node scripts/probe/analyze.mjs <run folder>'); process.exit(2); }
const NO_KNIP = process.argv.includes('--no-knip');
const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const v = (k) => (typeof cfg[k] === 'object' && cfg[k] !== null && 'value' in cfg[k] ? cfg[k].value : cfg[k]);
const RAW = join(OUT, 'raw');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const meta = readJson(join(RAW, 'meta.json'));
const sources = new Sources(existsSync(join(RAW, 'sources.json')) ? readJson(join(RAW, 'sources.json')) : {});
const limits = [];
const limit = (text) => { if (!limits.includes(text)) limits.push(text); };

/** The scenes of a pass, by number, as `run.mjs` wrote them. */
function scenesOf(pass) {
  const out = new Map();
  for (const f of readdirSync(RAW)) {
    const m = f.match(new RegExp(`^scene(\\d+)-${pass}\\.json$`));
    if (m) out.set(Number(m[1]), readJson(join(RAW, f)));
  }
  return out;
}
const counting = scenesOf('counting');
const clean = scenesOf('clean');
if (!counting.size) limit('no counting pass: coverage, allocations, heap snapshots and messages were not read');
if (!clean.size) limit('no clean pass: no time, profile or trace');
const sceneName = (n) => (clean.get(n) ?? counting.get(n))?.name ?? `scene ${n}`;

// ------------------------------------------------------------------ findings and counters
/** A finding: the rule, the cause's line, the counted evidence, the measured cost (clean pass) and the counter its fix must zero. */
const findings = [];
function finding(f) {
  findings.push({ costMs: 0, costBytes: 0, costCount: 0, scenes: [], ...f });
}
const counters = { byScene: {}, rules: {} };
const fmtMs = (ms) => (ms >= 100 ? `${Math.round(ms)} ms` : `${Math.round(ms * 10) / 10} ms`);
const fmtMB = (b) => `${Math.round(b / 1e5) / 10} MB`;
const fmtKB = (b) => (b >= 1e6 ? fmtMB(b) : `${Math.round(b / 1e2) / 10} kB`);
const fmtNum = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 1 });

// ------------------------------------------------------------------ the profiles' functions resolved
/** A `.cpuprofile`: self and total ms per function, the function's line resolved, and each sample's time (µs, the trace's clock) with its node. */
function readProfile(file) {
  const p = readJson(file);
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = (n) => {
    const f = n.callFrame;
    if (!f.url) return `${f.functionName || '(anonymous)'} ${f.url === '' && /^\(/.test(f.functionName) ? '' : '(native)'}`.trim();
    return `${f.functionName || '(anonymous)'} @ ${sources.original(f.url, f.lineNumber + 1, f.columnNumber + 1)}`;
  };
  const keys = new Map();
  const key = (id) => { let k = keys.get(id); if (!k) { k = keyOf(byId.get(id)); keys.set(id, k); } return k; };
  const self = new Map(), total = new Map();
  const times = new Float64Array(p.samples.length);
  let t = p.startTime, ms = 0;
  for (let s = 0; s < p.samples.length; s++) {
    t += p.timeDeltas[s] ?? 0;
    times[s] = t;
    const dt = (p.timeDeltas[s] ?? 0) / 1000;
    ms += dt;
    const id = p.samples[s];
    const k = key(id);
    self.set(k, (self.get(k) ?? 0) + dt);
    const seen = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) { const kk = key(x); if (!seen.has(kk)) { seen.add(kk); total.set(kk, (total.get(kk) ?? 0) + dt); } }
  }
  /** The first of the game's own frames (src/) up the stack of a sample's node: who of ours was running. */
  const ours = (id) => { for (let x = id; x !== undefined; x = parent.get(x)) { const n = byId.get(x); if (String(n.callFrame.url).includes('/src/')) return key(x); } return null; };
  return { profile: p, byId, parent, key, self, total, times, ms, ours, startTime: p.startTime, endTime: p.endTime };
}
const IDLE = /^\((idle|program|garbage collector|root)\)/;

/** An allocation profile: self bytes per site (the function's line) and per nearest frame of ours. */
function readAllocations(file) {
  const p = readJson(file);
  const sites = new Map(), ours = new Map();
  let bytes = 0;
  (function walk(n, owner) {
    const f = n.callFrame;
    const here = f.url ? `${f.functionName || '(anonymous)'} @ ${sources.original(f.url, f.lineNumber + 1, f.columnNumber + 1)}` : `${f.functionName || '(native)'}`;
    const mine = String(f.url).includes('/src/') ? here : owner;
    if (n.selfSize) {
      bytes += n.selfSize;
      sites.set(here, (sites.get(here) ?? 0) + n.selfSize);
      ours.set(mine ?? '(outside src)', (ours.get(mine ?? '(outside src)') ?? 0) + n.selfSize);
    }
    for (const c of n.children ?? []) walk(c, mine);
  })(p.head, null);
  const rank = (m, k = 12) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k);
  return { bytes, sites: rank(sites), ours: rank(ours), allOurs: ours };
}

/** Functions the probe itself calls in a window (run.mjs `since`), and what they call. */
const PROBE_CALLS = /window\.__gpu @|^shadowStats @|^takeStats @|@ src\/core\/sampleRing\.ts:/;

/** The trace's events the rules use, read line by line: the scenes' marks, the postMessage counts' events (name and time), and the complete
 *  events of tasks of 1 ms or more, of the GC, and of the entries a task dispatches (1 ms or more). `.total` every event seen. */
const TASK_NAMES = new Set(['RunTask', 'ThreadControllerImpl::RunTask']);
const ENTRY_NAMES = new Set(['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'XHRReadyStateChange', 'RunMicrotasks', 'HandlePostMessage', 'v8.callFunction', 'ResourceReceivedData', 'ParseHTML', 'UpdateLayoutTree', 'Layout', 'Paint', 'v8.compile', 'v8.compileModule', 'EvaluateScript']);
const isGc = (e) => (e.cat ?? '').includes('v8.gc') || e.name === 'MinorGC' || e.name === 'MajorGC' || /^V8\.GC/.test(e.name) || /BlinkGC/.test(e.name);
async function readTrace(file) {
  const { createReadStream } = await import('node:fs');
  const { createInterface } = await import('node:readline');
  const kept = [];
  let total = 0;
  for await (const raw of createInterface({ input: createReadStream(file, { encoding: 'utf8', highWaterMark: 1 << 22 }), crlfDelay: Infinity })) {
    const line = raw.endsWith(',') ? raw.slice(0, -1) : raw;
    if (!line.startsWith('{"')) continue;
    // Cheap tests on the text before parsing: most lines are none of these.
    const mark = line.includes('probe:scene:'), post = line.includes('PostMessage"'), complete = line.includes('"ph":"X"');
    if (!mark && !post && !complete) { total++; continue; }
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    total++;
    if (typeof e.name !== 'string') continue;
    if (e.name.startsWith('probe:scene:')) kept.push(e);
    else if (e.name === 'SchedulePostMessage' || e.name === 'HandlePostMessage') { kept.push({ name: e.name, ts: e.ts, ph: e.ph, pid: e.pid, tid: e.tid, dur: e.dur }); }
    else if (e.ph === 'X' && typeof e.dur === 'number' && ((TASK_NAMES.has(e.name) && e.dur >= 1000) || isGc(e) || (ENTRY_NAMES.has(e.name) && e.dur >= 1000))) kept.push(e);
  }
  kept.total = total;
  kept.bytes = statSync(file).size;
  return kept;
}

// ------------------------------------------------------------------ per-scene counters (both passes)
for (const n of new Set([...counting.keys(), ...clean.keys()])) {
  const c = counting.get(n), l = clean.get(n);
  const r = (l ?? c).readings ?? {};
  const row = {
    name: sceneName(n), budget: (l ?? c).budget,
    wallS: { counting: c ? Math.round(c.wallMs / 1000) : null, clean: l ? Math.round(l.wallMs / 1000) : null },
    settle: (l ?? c).notes?.settle ?? null,
    framesDrawn: { counting: c?.readings?.framesDrawn ?? null, clean: l?.readings?.framesDrawn ?? null },
    frames: l?.readings?.frames ? { n: l.readings.frames.frames, long: l.readings.frames.long, p50: l.readings.frames.total?.p50, p95: l.readings.frames.total?.p95, max: l.readings.frames.total?.max, systems: l.readings.frames.systems } : null,
    gpu: l?.readings?.gpu ? { p50: l.readings.gpu.p50, p95: l.readings.gpu.p95, n: l.readings.gpu.n, disjoint: l.readings.gpu.disjoint } : null,
    drawCalls: r.memory?.drawCalls ?? null, builtTriangles: r.memory?.builtTriangles ?? r.memory?.triangles ?? null, drawnTriangles: r.gl?.render?.triangles ?? null, programs: r.memory?.programs ?? null,
    memoryMB: r.memory ? { heap: r.memory.heapMB, geometry: r.memory.geometryMB, geometryCpu: r.memory.geometryCpuMB, texture: r.memory.textureMB, target: r.memory.targetMB, buildingDetail: r.memory.buildingDetailMB } : null,
    heapAfterGcMB: c?.heapAfterGc ? Math.round(c.heapAfterGc.usedBytes / 1e6) : null,
    uaMemoryMB: c?.uaMemory?.bytes ? Math.round(c.uaMemory.bytes / 1e6) : (c?.uaMemory?.error ?? null),
    uaBreakdown: c?.uaMemory?.breakdown?.map((b) => ({ mb: Math.round(b.bytes / 1e6), scope: b.attribution?.[0]?.scope ?? '?', url: shortPath(b.attribution?.[0]?.url ?? '') })) ?? null,
    shadow: r.shadowStats ?? null, levels: r.buildingLevels ?? null, sim: r.sim ?? null, doc: r.doc ?? null,
    budgetOver: Array.isArray(r.budget) ? r.budget.filter((b) => b.status && /over/i.test(String(b.status))).map((b) => `${b.item}: ${b.measured} / ${b.budget}`) : null,
    loaf: l?.readings?.loaf?.length ?? c?.readings?.loaf?.length ?? 0,
    notes: { ...(c?.notes ?? {}), ...(l?.notes ?? {}) },
    workers: (c ?? l)?.workers ?? null,
    allocBytes: c?.allocations?.bytes ?? null,
    snapshots: c?.snapshots ?? null,
  };
  counters.byScene[n] = row;
}

// ------------------------------------------------------------------ RULE stall: the trace's long tasks and GC pauses (clean pass)
/** Each scene's WINDOW profile (after `since`; the whole scene when it has none), and every profile of it with its preparation's (`-prep`). */
const profiles = new Map(), allProfiles = new Map();
for (const [n, s] of clean) {
  const list = [];
  for (const p of [s.profilePrep, s.profile]) if (p?.file && existsSync(p.file)) list.push(readProfile(p.file));
  if (s.profile?.file && existsSync(s.profile.file)) profiles.set(n, list.at(-1));
  allProfiles.set(n, list);
}
const traceFile = join(RAW, 'clean.trace.json');
let traceInfo = null;
/** Each scene's start mark in the trace's clock (µs ticks, the profile's too). */
const markTicks = new Map();
if (existsSync(traceFile)) {
  {
    // Read line by line (Chrome writes one event a line): a trace of the whole script is near 1 GB, past the longest string V8 makes
    // (v0's first analysis left it unread). Only what the rules use is kept.
    const events = await readTrace(traceFile);
    // The page's main thread: where the script's own marks (`probe:scene:N:start`) are.
    const marks = events.filter((e) => typeof e.name === 'string' && e.name.startsWith('probe:scene:') && (e.ph === 'R' || e.ph === 'I' || e.ph === 'i' || e.ph === 'n'));
    if (!marks.length) limit('the trace lacks the scenes\' marks (blink.user_timing): the trace\'s long frames and GC have no scene');
    const lastWhole = Math.max(0, ...[...clean.keys()].filter((n) => marks.some((m) => m.name === `probe:scene:${n}:end`)));
    const missing = [...clean.keys()].filter((n) => n > lastWhole);
    if (missing.length) limit(`the trace covers scenes 1 to ${lastWhole} only: Chrome's buffer filled (${fmtMB(statSync(traceFile).size)}) and stopped recording; in scenes ${missing.join(', ')} the long tasks and the GC come from the LoAF and the CPU profile alone (next run: one trace per scene)`);
    const main = marks.length ? { pid: marks[0].pid, tid: marks[0].tid } : null;
    const bounds = new Map();
    for (const m of marks) {
      const mm = m.name.match(/^probe:scene:(\d+):(start|end)$/);
      if (!mm) continue;
      const b = bounds.get(Number(mm[1])) ?? {};
      b[mm[2]] = m.ts;
      if (mm[2] === 'start') markTicks.set(Number(mm[1]), m.ts);
      bounds.set(Number(mm[1]), b);
    }
    const sceneAt = (ts) => { for (const [n, b] of bounds) if (b.start !== undefined && ts >= b.start && ts <= (b.end ?? Infinity)) return n; return null; };
    const firstMark = Math.min(...[...bounds.values()].map((b) => b.start ?? Infinity));
    const markOffset = (() => { for (const [n, b] of bounds) { const p = clean.get(n)?.pageT0; if (b.start !== undefined && p !== undefined) return b.start - p * 1000; } return null; })();
    /** The part of the scene a time falls in: its window (after `since`), or its preparation. */
    const phaseAt = (n, ts) => { const w = clean.get(n)?.windowT0; return w === undefined || markOffset === null ? 'whole scene' : ts >= w * 1000 + markOffset ? 'window' : 'preparation'; };
    const whereOf = (n, ts) => n !== null ? `scene ${n} (${sceneName(n)}), ${phaseAt(n, ts)}` : ts < firstMark ? 'before scene 1 (the page loading the game)' : 'between scenes (the probe reading the counters)';
    const onMain = (e) => main && e.pid === main.pid && e.tid === main.tid && e.ph === 'X' && typeof e.dur === 'number';
    const tasks = [], gcs = [], posts = new Map();
    let mainEvents = 0;
    for (const e of events) {
      if (e.name === 'SchedulePostMessage' || e.name === 'HandlePostMessage') { const n = sceneAt(e.ts) ?? 0; const k = `${n}:${e.name}`; posts.set(k, (posts.get(k) ?? 0) + 1); }
      if (!onMain(e)) continue;
      mainEvents++;
      if (e.name === 'RunTask' || e.name === 'ThreadControllerImpl::RunTask') tasks.push(e);
      else if ((e.cat ?? '').includes('v8.gc') || e.name === 'MinorGC' || e.name === 'MajorGC' || /^V8\.GC/.test(e.name) || /BlinkGC/.test(e.name)) gcs.push(e);
    }
    // One task once: Chrome writes `ThreadControllerImpl::RunTask` inside `RunTask` (v0 counted each long task twice). The outermost kept.
    tasks.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    { let end = -1; const outer = []; for (const t of tasks) { if (t.ts + t.dur <= end) continue; outer.push(t); end = t.ts + t.dur; } tasks.length = 0; tasks.push(...outer); }
    traceInfo = { events: events.total, mainEvents, tasks: tasks.length, gcs: gcs.length, posts: Object.fromEntries(posts), bytes: events.bytes };
    for (const [k, c] of posts) { const [n, name] = k.split(':'); (counters.byScene[n] ??= {}).postMessages ??= {}; counters.byScene[n].postMessages[name] = c; }
    // Long tasks: the entry events inside (what the browser dispatched) and the profile's samples inside (who of ours ran).
    const threshold = v('longFrameMs') * 1000;
    const entryNames = new Set(['FunctionCall', 'TimerFire', 'FireAnimationFrame', 'EventDispatch', 'XHRReadyStateChange', 'RunMicrotasks', 'HandlePostMessage', 'v8.callFunction', 'ResourceReceivedData', 'ParseHTML', 'UpdateLayoutTree', 'Layout', 'Paint']);
    const mainX = events.filter((e) => onMain(e) && entryNames.has(e.name)).sort((a, b) => a.ts - b.ts);
    const byCause = new Map();
    for (const t of tasks) {
      if (t.dur < threshold) continue;
      const n = sceneAt(t.ts);
      const prof = n !== null ? (allProfiles.get(n) ?? []).find((p) => t.ts >= p.startTime && t.ts <= p.endTime) ?? null : null;
      let cause = null, top = [];
      if (prof) {
        const t0 = t.ts, t1 = t.ts + t.dur;
        const self = new Map(), oursMs = new Map();
        let inside = 0;
        for (let s = 0; s < prof.times.length; s++) {
          const ts = prof.times[s];
          if (ts < t0 || ts > t1) continue;
          inside++;
          const dt = (prof.profile.timeDeltas[s] ?? 0) / 1000;
          const k = prof.key(prof.profile.samples[s]);
          self.set(k, (self.get(k) ?? 0) + dt);
          const o = prof.ours(prof.profile.samples[s]);
          if (o) oursMs.set(o, (oursMs.get(o) ?? 0) + dt);
        }
        top = [...self].filter(([k]) => !IDLE.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 5);
        const ours = [...oursMs].sort((a, b) => b[1] - a[1]);
        cause = ours[0]?.[0] ?? top[0]?.[0] ?? null;
        if (!inside) cause = null;
      }
      if (!cause) {
        const inside = mainX.filter((e) => e.ts >= t.ts && e.ts + (e.dur ?? 0) <= t.ts + t.dur && e.args?.data);
        const longest = inside.sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))[0];
        const d = longest?.args?.data;
        cause = d ? `${longest.name}${d.functionName ? ` ${d.functionName}` : ''}${d.url ? ` @ ${sources.original(d.url, (d.lineNumber ?? 0) + 1, (d.columnNumber ?? 0) + 1)}` : d.type ? ` (${d.type})` : ''}` : `(task with no attributed entry: ${t.name})`;
      }
      const where = whereOf(n, t.ts);
      const key = `${cause}|${where}`;
      const row = byCause.get(key) ?? { n, cause, where, count: 0, ms: 0, worst: 0, top: new Map() };
      row.count++; row.ms += t.dur / 1000; row.worst = Math.max(row.worst, t.dur / 1000);
      for (const [k, ms] of top) row.top.set(k, (row.top.get(k) ?? 0) + ms);
      byCause.set(key, row);
    }
    for (const row of byCause.values()) {
      const top = [...row.top].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, ms]) => `${fmtMs(ms)} ${k}`).join('; ');
      finding({
        rule: 'stall', kind: `task > ${v('longFrameMs')} ms (trace)`, cause: row.cause, scenes: [row.n ?? 0],
        evidence: `${row.count} long task(s): ${row.where}; worst ${fmtMs(row.worst)}${top ? `; stack (self time): ${top}` : ''}${row.n === 1 ? ' — opening (load)' : ''}`,
        costMs: row.ms, costCount: row.count, proof: `frame.long → 0 outside the opening (threshold ${v('longFrameMs')} ms)`,
      });
    }
    // GC pauses: the top-level GC events (one inside another counted once), over the threshold, with the scene's allocation sites.
    gcs.sort((a, b) => a.ts - b.ts || b.dur - a.dur);
    const topLevel = [];
    let end = -1;
    for (const g of gcs) { if (g.ts < end) continue; topLevel.push(g); end = g.ts + g.dur; }
    const gcByScene = new Map();
    for (const g of topLevel) {
      const n = sceneAt(g.ts) ?? 0;
      const row = gcByScene.get(n) ?? { count: 0, ms: 0, long: 0, longMs: 0, worst: 0, names: new Map() };
      row.count++; row.ms += g.dur / 1000; row.worst = Math.max(row.worst, g.dur / 1000);
      if (g.dur / 1000 > v('longGcMs')) { row.long++; row.longMs += g.dur / 1000; row.names.set(g.name, (row.names.get(g.name) ?? 0) + 1); }
      gcByScene.set(n, row);
    }
    for (const [n, row] of gcByScene) {
      counters.byScene[n] ??= {};
      counters.byScene[n].gc = { pauses: row.count, ms: Math.round(row.ms), worstMs: Math.round(row.worst * 10) / 10, overThreshold: row.long, overThresholdMs: Math.round(row.longMs) };
      if (!row.long) continue;
      const c = counting.get(n);
      const alloc = c?.allocations?.file && existsSync(c.allocations.file) ? readAllocations(c.allocations.file) : null;
      const sites = alloc ? alloc.ours.filter(([k]) => k !== '(outside src)' && !PROBE_CALLS.test(k)).slice(0, 5) : [];
      finding({
        rule: 'stall', kind: `GC > ${v('longGcMs')} ms`, cause: sites[0]?.[0] ?? `(no counting pass: allocation sites unknown) scene ${n}`, scenes: [n],
        evidence: `${row.long} GC pause(s) over ${v('longGcMs')} ms in scene ${n} (${sceneName(n)}), ${fmtMs(row.longMs)} in all, worst ${fmtMs(row.worst)} (${[...row.names].map(([k, c]) => `${k} ×${c}`).join(', ')}); who allocated most in the scene (counting pass): ${sites.map(([k, b]) => `${fmtKB(b)} ${k}`).join('; ') || '—'}`,
        costMs: row.longMs, costCount: row.long, proof: `gc.pausesOver${v('longGcMs')}ms → 0 outside the opening`,
      });
    }
  }
} else limit('no trace from the clean pass: long tasks and GC pauses not counted');

// ------------------------------------------------------------------ RULE stall: long animation frames (clean pass)
for (const [n, s] of clean) {
  const entries = s.readings?.loaf ?? [];
  const byCause = new Map();
  // The page's clock (ms since its origin) to the profile's and the trace's (µs ticks), by the scene's start mark seen in both.
  // The page is the same the whole pass, so the two clocks differ by one constant: any scene whose mark the trace kept gives it.
  const anchor = [...markTicks].find(([m]) => clean.get(m)?.pageT0 !== undefined);
  const offset = anchor ? anchor[1] - clean.get(anchor[0]).pageT0 * 1000 : null;
  for (const e of entries) {
    const scripts = (e.scripts ?? []).slice().sort((a, b) => b.duration - a.duration);
    const top = scripts[0];
    let cause = top ? `${top.sourceFunctionName || '(anonymous)'} @ ${top.sourceURL ? sources.atOffset(top.sourceURL, top.sourceCharPosition ?? 0) : '(no url)'}${top.invoker ? ` ← ${top.invoker}` : ''}` : `(no script listed: ${Math.round(e.renderStart - e.startTime)} ms until render, ${Math.round(e.duration - (e.renderStart - e.startTime))} ms of render/layout)`;
    // An entry with no script URL (a callback through a wrapper without a source, the probe's own frame counter among them): who of ours the
    // profile saw running inside the frame's span, the most time first.
    let profiled = '';
    if (offset !== null) {
      const t0 = e.startTime * 1000 + offset, t1 = t0 + e.duration * 1000;
      const ours = new Map(), selfIn = new Map();
      for (const prof of allProfiles.get(n) ?? []) {
        if (t1 < prof.startTime || t0 > prof.endTime) continue;
        for (let k = 0; k < prof.times.length; k++) {
          if (prof.times[k] < t0 || prof.times[k] > t1) continue;
          const o = prof.ours(prof.profile.samples[k]) ?? prof.key(prof.profile.samples[k]);
          const dt = (prof.profile.timeDeltas[k] ?? 0) / 1000, own = prof.key(prof.profile.samples[k]);
          if (!IDLE.test(own)) selfIn.set(own, (selfIn.get(own) ?? 0) + dt);
          if (IDLE.test(o)) continue;
          ours.set(o, (ours.get(o) ?? 0) + dt);
        }
      }
      const ranked = [...ours].sort((a, b) => b[1] - a[1]);
      if (ranked.length) {
        const own = [...selfIn].sort((a, b) => b[1] - a[1]).slice(0, 4);
        profiled = `; in the profile, inside the frame: ${ranked.slice(0, 3).map(([k, ms]) => `${fmtMs(ms)} ${k}`).join('; ')}; self time: ${own.map(([k, ms]) => `${fmtMs(ms)} ${k}`).join('; ')}`;
        if (!top || !top.sourceURL) cause = ranked[0][0];
      }
    }
    const row = byCause.get(cause) ?? { count: 0, ms: 0, worst: 0, blocking: 0, scriptsMs: 0, profiled: '' };
    if (e.duration >= row.worst) row.profiled = profiled;
    row.count++; row.ms += e.duration; row.worst = Math.max(row.worst, e.duration); row.blocking += e.blockingDuration ?? 0;
    row.scriptsMs += scripts.reduce((a, sc) => a + sc.duration, 0);
    byCause.set(cause, row);
  }
  for (const [cause, row] of byCause) {
    finding({
      rule: 'stall', kind: 'long-frame (LoAF ≥ 50 ms)', cause, scenes: [n],
      evidence: `${row.count} long frame(s) in scene ${n} (${sceneName(n)}); worst ${fmtMs(row.worst)}; blocking ${fmtMs(row.blocking)}; scripts listed ${fmtMs(row.scriptsMs)} of ${fmtMs(row.ms)}${row.profiled ? ` (worst frame${row.profiled})` : ''}${n === 1 ? ' — opening (expected load; counts as opening time)' : ''}`,
      costMs: row.ms, costCount: row.count, proof: 'frame.long → 0 outside the opening (scene 1)',
    });
  }
}


// ------------------------------------------------------------------ RULE idle-running (scene 2: the player's pause, the camera still)
{
  const n = cfg.idleScene;
  const c = counting.get(n), l = clean.get(n);
  const idle = { frames: l?.readings?.framesDrawn ?? c?.readings?.framesDrawn ?? null, drawCallsPerFrame: (l ?? c)?.readings?.memory?.drawCalls ?? null, shadowPasses: (l ?? c)?.readings?.shadowStats?.passes ?? null, allocBytes: c?.allocations?.bytes ?? null, functionsRun: 0, callsTotal: 0, workerMessages: null, selfMsOurs: 0 };
  // What ran (counting pass): every function of ours with calls in the idle scene.
  const ran = new Map();
  if (c) {
    const cov = existsSync(join(RAW, `scene${String(n).padStart(2, '0')}-coverage.json`)) ? readJson(join(RAW, `scene${String(n).padStart(2, '0')}-coverage.json`)) : null;
    if (cov) for (const script of cov.ours) for (const fn of script.functions) {
      const count = fn.ranges[0]?.count ?? 0;
      if (count <= 0) continue;
      const key = `${fn.functionName || '(anonymous)'} @ ${sources.atOffset(script.url, fn.ranges[0].startOffset)}`;
      ran.set(key, (ran.get(key) ?? 0) + count);
    }
    idle.functionsRun = ran.size;
    idle.callsTotal = [...ran.values()].reduce((a, b) => a + b, 0);
    const prev = c.msgsAtWindow ?? counting.get(n - 1)?.readings?.msgs?.byWorker ?? {}, now = c.readings?.msgs?.byWorker ?? {};
    idle.workerMessages = Object.fromEntries(Object.entries(now).map(([w, r]) => [w, { to: r.out - (prev[w]?.out ?? 0), from: r.in - (prev[w]?.in ?? 0), toBytes: r.outBytes - (prev[w]?.outBytes ?? 0), fromBytes: r.inBytes - (prev[w]?.inBytes ?? 0) }]));
  }
  // What it cost (clean pass): self time per function of ours in the idle scene.
  const cost = new Map();
  const prof = profiles.get(n);
  if (prof) {
    for (const [k, ms] of prof.self) if (k.includes('@ src/')) cost.set(k, ms);
    idle.selfMsOurs = Math.round([...cost.values()].reduce((a, b) => a + b, 0) * 10) / 10;
    idle.profiledMs = Math.round(prof.ms);
    idle.selfMsAll = Object.fromEntries([...prof.self].filter(([k]) => !IDLE.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, ms]) => [k, Math.round(ms * 10) / 10]));
  }
  const alloc = c?.allocations?.file && existsSync(c.allocations.file) ? readAllocations(c.allocations.file) : null;
  if (alloc) idle.allocTop = alloc.ours.slice(0, 10).map(([k, b]) => [k, b]);
  counters.rules.idle = idle;
  const keys = new Set([...ran.keys(), ...cost.keys()]);
  for (const k of keys) {
    const calls = ran.get(k) ?? 0, ms = cost.get(k) ?? 0;
    if (calls === 0 && ms < 0.5) continue;
    // The probe's own reads at the window's start (`__gpu(true)` reads and clears the GPU samples' ring, `shadowStats` zeroes the sun's count): not the game's.
    if (PROBE_CALLS.test(k)) { (idle.probeCalls ??= []).push([k, calls]); continue; }
    const bytes = alloc?.allocOurs?.get?.(k) ?? alloc?.allOurs?.get(k) ?? 0;
    finding({
      rule: 'idle-running', kind: 'ran with the game paused and the camera still', cause: k, scenes: [n],
      evidence: `${calls ? `${fmtNum(calls)} call(s)` : 'not counted (profile only)'} in ${idle.frames ?? '?'} frame(s) drawn in the ${v('holdMs') / 1000} still seconds${ms ? `; ${fmtMs(ms)} of self time in the clean pass` : ''}${bytes ? `; ${fmtKB(bytes)} allocated` : ''}`,
      costMs: ms, costCount: calls, costBytes: bytes, proof: 'idle.workItems → empty list (one present per requested frame, nothing more)',
    });
  }
}

// ------------------------------------------------------------------ RULE large-clone (counting pass hooks; the trace's postMessage counts above)
{
  const last = [...counting.values()].sort((a, b) => b.n - a.n)[0];
  const msgs = last?.readings?.msgs;
  if (msgs) {
    counters.rules.messages = { byWorker: msgs.byWorker, ports: msgs.ports, large: msgs.large.length };
    const byCause = new Map();
    for (const m of msgs.large) {
      const site = m.site ? sources.original(...(() => { const mm = m.site.match(/^(.*):(\d+):(\d+)$/); return mm ? [mm[1], Number(mm[2]), Number(mm[3])] : [m.site, 1, 1]; })()) : `(received from ${m.worker})`;
      const scene = [...counting.values()].find((s) => m.at >= s.pageT0 && m.at <= s.pageT1)?.n ?? 0;
      const key = `${site}|${m.kind}|${m.dir}`;
      const row = byCause.get(key) ?? { site, kind: m.kind, dir: m.dir, worker: m.worker, count: 0, bytes: 0, max: 0, scenes: new Set() };
      row.count++; row.bytes += m.bytes; row.max = Math.max(row.max, m.bytes); row.scenes.add(scene);
      byCause.set(key, row);
    }
    for (const row of byCause.values()) finding({
      rule: 'large-clone', kind: `message ≥ ${fmtMB(v('largeMessageBytes'))}`, cause: row.site, scenes: [...row.scenes],
      evidence: `${row.count} message(s) ${row.dir === 'to' ? 'to' : row.dir === 'from' ? 'from' : 'through a port,'} ${row.worker}${row.kind ? ` (${row.kind})` : ''}, ${fmtMB(row.bytes)} in all, largest ${fmtMB(row.max)} (bytes estimated by the probe: exact for buffers and strings, approximate for objects)`,
      costBytes: row.bytes, costCount: row.count, proof: 'msg.largeClones → 0 (or transferred, not copied)',
    });
  } else limit('no message counters (counting pass missing): large-clone from the trace\'s counts alone');
}

/** V8's own: compiled code and its metadata (more functions compiled as the script goes on), and the precise coverage's bookkeeping (CoverageInfo, DebugInfo: made by the probe). Shown in the tables, never a finding. */
const V8_INTERNAL = /^code:|^native:system \/ (CoverageInfo|DebugInfo|FunctionTemplateInfo|WeakArrayList)|^object shape:/;

// ------------------------------------------------------------------ RULE leak (heap snapshots before/after scenes 7 and 9; heap after GC along the script)
{
  const heapLine = [...counting.values()].sort((a, b) => a.n - b.n).map((s) => ({ n: s.n, mb: s.heapAfterGc ? Math.round(s.heapAfterGc.usedBytes / 1e6) : null }));
  counters.rules.heapAfterGcMB = heapLine;
  for (const [n, s] of counting) {
    const a = s.snapshots?.before, d = s.snapshots?.after;
    if (!a && !d) continue;
    if (!a?.file || !d?.file) {
      const why = a?.skipped ?? d?.skipped ?? 'snapshot missing';
      finding({ rule: 'leak', kind: 'no snapshot', cause: `scene ${n} (${sceneName(n)})`, scenes: [n], evidence: `snapshots not taken: ${why}; heap after GC before ${a?.usedBytes ? fmtMB(a.usedBytes) : '?'} → after ${d?.usedBytes ? fmtMB(d.usedBytes) : '?'}`, costBytes: Math.max(0, (d?.usedBytes ?? 0) - (a?.usedBytes ?? 0)), proof: 'heap.growthPerCycle → 0' });
      continue;
    }
    const before = summariseSnapshot(a.file), after = summariseSnapshot(d.file);
    const grown = [];
    for (const [k, x] of after.byName) {
      const y = before.byName.get(k) ?? { count: 0, size: 0 };
      const dc = x.count - y.count, ds = x.size - y.size;
      if (dc > 0 && ds > 0) grown.push({ name: k, count: dc, size: ds, countAfter: x.count });
    }
    grown.sort((x, y) => y.size - x.size);
    counters.rules[`snapshot${n}`] = { before: { nodes: before.nodes, bytes: before.bytes }, after: { nodes: after.nodes, bytes: after.bytes }, grown: grown.slice(0, 40) };
    const removal = n === 9;
    for (const g of grown.filter((x) => !V8_INTERNAL.test(x.name)).slice(0, 25)) {
      if (g.size < 64 * 1024) break;
      finding({
        rule: 'leak', kind: removal ? 'grew in a scene that only removes' : 'grew between the scene\'s before and after', cause: g.name, scenes: [n],
        evidence: `${fmtNum(g.count)} more object(s) (${fmtNum(g.countAfter)} at the end), ${fmtKB(g.size)} more, in scene ${n} (${sceneName(n)})${removal ? ' — after removing buildings and roads nothing of this type should be left over' : ' — what the edit created and did not release, or kept on purpose (a human decision)'}; total heap ${fmtMB(before.bytes)} → ${fmtMB(after.bytes)}`,
        costBytes: g.size, costCount: g.count, proof: 'heap.growthPerCycle → 0 for this constructor (repeat the scene N times and see the counter stop)',
      });
    }
  }
}


/** A `.heapsnapshot` summed by (type, constructor name): count and self size. Read in blocks, never whole: a heap of 800 MB writes a file past
 *  the 2 GB `readFileSync` takes, and its strings array past the longest string V8 makes. The nodes come before the strings in the file, so the
 *  names wanted are known when the strings are scanned; only those are decoded. Strings themselves are summed under their type alone. */
function summariseSnapshot(file) {
  const fd = openSync(file, 'r');
  const CHUNK = 1 << 26;
  const buf = Buffer.allocUnsafe(CHUNK);
  let head = '', meta = null, F = 0, iType = 0, iName = 0, iSize = 0, types = [];
  let phase = 'head', cur = -1, field = 0, nodes = 0, bytes = 0;
  const row = [];
  const acc = new Map();
  const STRINGY = new Set(['string', 'concatenated string', 'sliced string', 'number', 'heap number']);
  // The strings' scan: which top-level string of the array we are in, inside it or not, its raw bytes when wanted.
  let pending = '', strIndex = -1, inStr = false, esc = false, raw = null;
  const wanted = new Set(), names = new Map();
  for (;;) {
    const n = readSync(fd, buf, 0, CHUNK, null);
    if (n <= 0) break;
    let i = 0;
    if (phase === 'head') {
      head += buf.toString('latin1', 0, n);
      const at = head.indexOf('"nodes":[');
      if (at < 0) continue;
      meta = JSON.parse(head.slice(0, at).replace(/,\s*$/, '') + '}').snapshot.meta;
      F = meta.node_fields.length; iType = meta.node_fields.indexOf('type'); iName = meta.node_fields.indexOf('name'); iSize = meta.node_fields.indexOf('self_size');
      types = meta.node_types[0];
      // Where the nodes start, in this block.
      i = n - (head.length - (at + 9));
      head = '';
      phase = 'nodes';
    }
    for (; i < n; i++) {
      const ch = buf[i];
      if (phase === 'nodes') {
        if (ch >= 48 && ch <= 57) { cur = cur < 0 ? ch - 48 : cur * 10 + (ch - 48); continue; }
        if (cur >= 0) {
          row[field++] = cur; cur = -1;
          if (field === F) {
            field = 0; nodes++;
            const type = types[row[iType]] ?? String(row[iType]);
            const key = STRINGY.has(type) ? `${type}:` : `${type}:#${row[iName]}`;
            if (!STRINGY.has(type)) wanted.add(row[iName]);
            const e = acc.get(key);
            if (e) { e.count++; e.size += row[iSize]; } else acc.set(key, { count: 1, size: row[iSize] });
            bytes += row[iSize];
          }
        }
        if (ch === 93) phase = 'seek';
      } else if (phase === 'seek') {
        pending = (pending + String.fromCharCode(ch)).slice(-11);
        if (pending === '"strings":[') phase = 'strings';
      } else if (phase === 'strings') {
        if (inStr) {
          if (esc) { esc = false; if (raw) raw.push(ch); continue; }
          if (ch === 92) { esc = true; if (raw) raw.push(ch); continue; }
          if (ch === 34) { inStr = false; if (raw) { names.set(strIndex, JSON.parse(`"${Buffer.from(raw).toString('utf8')}"`)); raw = null; } continue; }
          if (raw) raw.push(ch);
        } else if (ch === 34) { inStr = true; strIndex++; raw = wanted.has(strIndex) ? [] : null; }
        else if (ch === 93) { phase = 'done'; break; }
      }
    }
    if (phase === 'done') break;
  }
  closeSync(fd);
  const byName = new Map();
  for (const [key, e] of acc) {
    const [type, idx] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
    const name = idx.startsWith('#') ? `${type}:${names.get(Number(idx.slice(1))) ?? idx}` : `${type}:(all)`;
    const was = byName.get(name);
    if (was) { was.count += e.count; was.size += e.size; } else byName.set(name, { ...e });
  }
  return { nodes, bytes, byName };
}

// ------------------------------------------------------------------ RULE dead-code (coverage over the whole script × knip)
// Only with the counting pass: without coverage every file looks unloaded and every unused export dead (the fast mode's first test: 62 false findings).
if (!counting.size) limit('no counting pass: without coverage the dead-code rule does not run');
else {
  const total = new Map(), fnMeta = new Map();
  for (const [n] of counting) {
    for (const part of ['coverage-prep', 'coverage']) {
    const f = join(RAW, `scene${String(n).padStart(2, '0')}-${part}.json`);
    if (!existsSync(f)) continue;
    const cov = readJson(f);
    for (const script of cov.ours) for (const fn of script.functions) {
      const key = `${script.url}@${fn.ranges[0].startOffset}`;
      total.set(key, (total.get(key) ?? 0) + (fn.ranges[0]?.count ?? 0));
      if (!fnMeta.has(key)) fnMeta.set(key, { url: script.url, offset: fn.ranges[0].startOffset, end: fn.ranges[0].endOffset, name: fn.functionName || '(anonymous)' });
    }
    }
  }
  const dead = [], live = [];
  for (const [key, count] of total) {
    const m = fnMeta.get(key);
    const at = sources.atOffset(m.url, m.offset);
    (count === 0 ? dead : live).push({ name: m.name, at, file: at.replace(/:\d+$/, ''), chars: m.end - m.offset, calls: count });
  }
  const files = new Map();
  for (const d of dead) { const r = files.get(d.file) ?? { dead: 0, live: 0, chars: 0 }; r.dead++; r.chars += d.chars; files.set(d.file, r); }
  for (const d of live) { const r = files.get(d.file) ?? { dead: 0, live: 0, chars: 0 }; r.live++; files.set(d.file, r); }
  // knip: what can never be reached (unused files and exports), run here when installed (offline: the package is in node_modules).
  let knip = null;
  const knipBin = join(ROOT, 'node_modules', 'knip', 'bin', 'knip.js');
  if (!NO_KNIP && existsSync(knipBin)) {
    const run = spawnSync(process.execPath, [knipBin, '--reporter', 'json', '--no-progress'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 27 });
    const text = run.stdout?.trim() ?? '';
    const start = text.indexOf('{');
    if (start >= 0) {
      try {
        const j = JSON.parse(text.slice(start));
        knip = { files: j.files ?? [], exports: [] };
        for (const issue of j.issues ?? []) for (const type of ['exports', 'types', 'nsExports', 'nsTypes', 'classMembers', 'enumMembers']) for (const item of issue[type] ?? []) knip.exports.push({ file: String(issue.file).replace(/\\/g, '/'), name: item.name, line: item.line, type });
      } catch (e) { limit(`knip ran but its output is not JSON (${String(e.message).slice(0, 80)})`); }
    } else limit(`knip did not run (${(run.stderr ?? '').split('\n')[0].slice(0, 160) || `code ${run.status}`})`);
  } else if (!NO_KNIP) limit('knip is not in node_modules: no static half of the dead code');
  const loadedFiles = new Set([...files.keys()]);
  const unusedFiles = (knip?.files ?? []).map((f) => String(f).replace(/\\/g, '/').replace(/^.*?\/src\//, 'src/')).filter((f) => f.startsWith('src/'));
  const neverLoaded = unusedFiles.filter((f) => !loadedFiles.has(f));
  const confirmed = [];
  if (knip) {
    const byFileName = new Map();
    for (const e of knip.exports) byFileName.set(`${e.file.replace(/^.*?\/src\//, 'src/')}|${e.name}`, e);
    for (const d of dead) { const k = byFileName.get(`${d.file}|${d.name}`); if (k) confirmed.push({ ...d, knip: k.type }); }
  }
  // An unused export (knip) in a file of src/ the browser never loaded in the whole script: no coverage can say it ran; both sources agree it is unreached.
  const unloadedExports = (knip?.exports ?? []).map((e) => ({ ...e, file: e.file.replace(/^.*?\/src\//, 'src/') })).filter((e) => e.file.startsWith('src/') && !loadedFiles.has(e.file) && !/^(types|nsTypes)$/.test(e.type));
  counters.rules.deadCode = { functionsSeen: total.size, neverCalled: dead.length, filesLoaded: loadedFiles.size, knipUnusedFiles: unusedFiles.length, knipUnusedExports: knip?.exports.length ?? null, confirmed: confirmed.length, neverLoadedAndUnused: neverLoaded.length, unusedExportsInUnloadedFiles: unloadedExports.length };
  const lines = [`# Dead code — ${meta.date ?? ''}`, '', `Dynamic: ${dead.length} of ${total.size} loaded \`src/\` functions never ran in the whole plan (9 scenes). Static (knip): ${knip ? `${unusedFiles.length} file(s) with no importer, ${knip.exports.length} unused export(s)/member(s)` : 'did not run'}.`, '', '"Not called in the plan" is not "dead": the plan covers what §5 of the plan covers. Dead is what knip says nobody imports AND the coverage confirms; the rest is a human decision.', ''];
  lines.push('## Confirmed by both sources (unused export that also never ran)', '');
  for (const c of confirmed.sort((a, b) => a.at.localeCompare(b.at))) lines.push(`- ${c.at} \`${c.name}\` (${c.knip})`);
  if (!confirmed.length) lines.push('- (none)');
  lines.push('', '## Unused exports (knip) in files the page never loaded', '', 'This stage covers the page alone: a file used only inside a worker shows here without being dead. Types are left out (they vanish from the served JavaScript).', '');
  for (const e of unloadedExports.sort((a, b) => a.file.localeCompare(b.file))) lines.push(`- ${e.file}${e.line ? `:${e.line}` : ''} \`${e.name}\` (${e.type})`);
  if (!unloadedExports.length) lines.push('- (none)');
  lines.push('', '## Files of src/ knip says have no importer and the plan never loaded', '');
  for (const f of neverLoaded) lines.push(`- ${f}`);
  if (!neverLoaded.length) lines.push('- (none)');
  lines.push('', '## Per file: functions that never ran in the plan (dead, chars) × that ran', '', '| file | never ran | ran | chars never run |', '|---|---:|---:|---:|');
  for (const [f, r] of [...files].sort((a, b) => b[1].chars - a[1].chars)) lines.push(`| ${f} | ${r.dead} | ${r.live} | ${fmtNum(r.chars)} |`);
  lines.push('', '## Every function that never ran (file:line, name, chars)', '');
  for (const d of dead.sort((a, b) => a.at.localeCompare(b.at, undefined, { numeric: true }))) lines.push(`- ${d.at} \`${d.name}\` (${d.chars})`);
  writeFileSync(join(OUT, 'dead-code.md'), lines.join('\n') + '\n');
  for (const c of confirmed) finding({ rule: 'dead-code', kind: 'unused export (knip) and 0 runs in the plan', cause: `${c.name} @ ${c.at}`, scenes: [], evidence: `knip: ${c.knip} unused; coverage: 0 calls in 9 scenes; ${fmtNum(c.chars)} chars`, costCount: c.chars, proof: 'list (human decision): delete or cover in the plan' });
  for (const e of unloadedExports) finding({ rule: 'dead-code', kind: 'unused export (knip) in a file the page did not load', cause: `${e.name} @ ${e.file}${e.line ? `:${e.line}` : ''}`, scenes: [], evidence: `knip: ${e.type} with no importer; the page did not load ${e.file} in 9 scenes (if the file runs only in a worker, this stage's coverage does not see it)`, costCount: 1, proof: 'list (human decision)' });
  for (const f of neverLoaded) finding({ rule: 'dead-code', kind: 'file with no importer (knip) and never loaded', cause: f, scenes: [], evidence: 'knip: no module imports it; coverage: Vite never served it in 9 scenes', costCount: 1, proof: 'list (human decision)' });
  counters.rules.deadCodeTopFiles = [...files].sort((a, b) => b[1].chars - a[1].chars).slice(0, 25).map(([f, r]) => ({ file: f, dead: r.dead, live: r.live, chars: r.chars }));
}

// ------------------------------------------------------------------ image guard (v0: the two passes' pictures of a paused scene byte-equal?)
{
  const imgs = join(OUT, 'images');
  const guard = [];
  if (existsSync(imgs)) {
    // Each picture's hash, kept as the reference the next run is compared with. The two passes are NOT compared with each other: two Chromes
    // run the simulation apart (other vehicles, other people, other frames), so their pictures differ with nothing wrong (v0: all 15 differed).
    const { createHash } = await import('node:crypto');
    for (const f of readdirSync(imgs).sort()) guard.push({ image: f, sha1: createHash('sha1').update(readFileSync(join(imgs, f))).digest('hex').slice(0, 12) });
  }
  counters.rules.imageGuard = guard;
  limit('image guard: this run only records each image\'s hash as a reference; a pixel-by-pixel comparison with the previous run needs a deterministic scene (fixed-step simulation, item 12 of the list for src/)');
}

// ------------------------------------------------------------------ dedup by cause line, order by measured cost
const merged = new Map();
for (const f of findings) {
  const key = `${f.rule}|${f.cause}`;
  const m = merged.get(key);
  if (!m) { merged.set(key, { ...f, scenes: [...new Set(f.scenes)], evidences: [f.evidence] }); continue; }
  m.costMs += f.costMs; m.costBytes += f.costBytes; m.costCount += f.costCount;
  m.scenes = [...new Set([...m.scenes, ...f.scenes])].sort((a, b) => a - b);
  m.evidences.push(f.evidence);
}
const ordered = [...merged.values()].map((f) => ({ ...f, evidence: f.evidences.join(' | ') })).sort((a, b) => b.costMs - a.costMs || b.costBytes - a.costBytes || b.costCount - a.costCount);
for (const f of ordered) delete f.evidences;
writeFileSync(join(OUT, 'findings.json'), JSON.stringify({ meta: { date: meta.date, commit: meta.commit, chrome: meta.chrome, gpu: meta.gpu, busy: meta.busy, busyAccepted: meta.busyAccepted, out: OUT }, findings: ordered, limits }, null, 1));
writeFileSync(join(OUT, 'counters.json'), JSON.stringify(counters, null, 1));

// ------------------------------------------------------------------ the report
const L = [];
const scenes = Object.entries(counters.byScene).filter(([, r]) => r.name).sort((a, b) => Number(a[0]) - Number(b[0]));
const noisy = meta.busyAccepted && (meta.busy?.gpu?.length || meta.busy?.cpu?.length);
L.push(`# Roadcraft probe — report v0 (stage 0) — ${new Date(meta.date).toLocaleString('en-GB')}`, '');
L.push(`Target: commit \`${meta.commit}\` (${meta.branch}${meta.dirty ? `, ${meta.dirty} file(s) changed outside test-results` : ''}) · Chrome ${meta.chrome} · GPU ${meta.gpu} · Node ${meta.node} · Playwright ${meta.playwright} · plan: city seed ${cfg.seed}, ${cfg.viewport.join('×')}, ${meta.scenes ? `scenes ${meta.scenes.join(', ')}` : '9 scenes'} (§5 of the plan)${meta.fast ? ' — FAST MODE: the clean pass alone, no trace' : ''}.`);
L.push(`Passes: ${Object.entries(meta.passes ?? {}).map(([p, s]) => `${p} ${s.error ? `FAILED (${String(s.error).split('\n')[0].slice(0, 120)})` : `${s.seconds} s`}`).join(' · ')}.`);
L.push(noisy ? `**BUSY MACHINE during the run** (GPU: ${meta.busy.gpu.map((b) => `${b.name} ${b.percent}%`).join(', ') || '—'}; CPU: ${meta.busy.cpu.map((b) => `${b.name} ${b.cores} core(s)`).join(', ') || '—'}): **every time below is noisy**; the counts hold.` : `Machine free at the start of the run (GPU and CPU with no other process over the threshold; ${meta.busy?.freeGB ?? '?'} GB free).`);
L.push('', 'How to read it: **counts** come from the counting pass (hooks, coverage, allocations: slower, never timed); **times** come from the clean pass (sampling profile, trace, LoAF). Both run the same plan in separate Chromes.', '');

L.push('## 1. The plan, scene by scene', '', '| # | scene | view | settled (ms) | frames drawn (clean / counting) | frames in __frames (the last 240) | CPU p50/p95/max ms | GPU p50/p95 ms | draw calls | tri built | heap MB (after GC) | tab memory MB | LoAF | GC pauses (>threshold) | notes |', '|---|---|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---|');
for (const [n, r] of scenes) {
  const notes = [];
  if (r.notes?.shownMs) notes.push(`city shown in ${fmtNum(r.notes.shownMs / 1000)} s, settled in ${fmtNum(r.notes.settledMs / 1000)} s`);
  if (r.notes?.edited) notes.push(`roads ${r.notes.edited.before.segments}→${r.notes.edited.after.segments}, buildings ${r.notes.edited.before.buildings}→${r.notes.edited.after.buildings}, stamps ${r.notes.edited.before.stamps}→${r.notes.edited.after.stamps}`);
  if (r.notes?.roadSettleMs !== undefined) notes.push(`road settled in ${r.notes.roadSettleMs} ms, terrain in ${r.notes.terrainSettleMs} ms; growth: ${r.notes.growth?.demolishedAfterClicks ? (r.notes.growth.grewBackMs !== null ? `one building demolished and put back by the worker in ${fmtNum(r.notes.growth.grewBackMs / 1000)} s` : 'one building demolished and NOT put back in 60 s') : 'no building demolished to grow (clicks missed)'}`);
  if (r.notes?.removed) notes.push(`removed: ${r.notes.removed.buildings} buildings, ${r.notes.removed.segments} roads, ${r.notes.removed.poles} poles (settled in ${r.notes.removeSettleMs} ms; ${r.notes.removed.clicks} clicks on buildings, ${r.notes.removed.roadClicks} on roads)`);
  if (r.notes?.orbitFrames) notes.push(`orbit: ${r.notes.orbitFrames} frames in 6 s`);
  if (r.notes?.quality) notes.push(`quality ${r.notes.quality}`);
  if (r.settle && !r.settle.settled) notes.push(`DID NOT SETTLE in ${r.settle.ms} ms`);
  if (r.budgetOver?.length) notes.push(`budget exceeded: ${r.budgetOver.join('; ')}`);
  if (r.shadow) notes.push(`shadow: ${r.shadow.passes} passes${r.shadow.whole ? `, whole ${r.shadow.whole.join('/')}` : ''}${r.shadow.why ? `, by ${Object.entries(r.shadow.why).filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(' ') || '—'}` : ''}`);
  L.push(`| ${n} | ${r.name} | ${r.budget} | ${r.settle?.ms ?? '—'} | ${r.framesDrawn?.clean ?? '—'} / ${r.framesDrawn?.counting ?? '—'} | ${r.frames ? `${r.frames.n} (${r.frames.long} long)` : '—'} | ${r.frames ? `${r.frames.p50}/${r.frames.p95}/${r.frames.max}` : '—'} | ${r.gpu ? `${r.gpu.p50}/${r.gpu.p95}${r.gpu.disjoint ? ` (disjoint ${r.gpu.disjoint})` : ''}` : '—'} | ${r.drawCalls ?? '—'} | ${r.builtTriangles ? fmtNum(r.builtTriangles) : '—'} | ${r.memoryMB?.heap ?? '—'} (${r.heapAfterGcMB ?? '—'}) | ${typeof r.uaMemoryMB === 'number' ? r.uaMemoryMB : '—'} | ${r.loaf} | ${r.gc ? `${r.gc.pauses} (${r.gc.overThreshold})` : '—'} | ${notes.join('; ')} |`);
}
L.push('', `Scene memory (MB, \`__roadcraft.memory\`, the game's own reading: see UI-15/TST-09 on what it does not count): ${scenes.map(([n, r]) => r.memoryMB ? `scene ${n}: geometry ${r.memoryMB.geometry}, cpu ${r.memoryMB.geometryCpu}, textures ${r.memoryMB.texture}, targets ${r.memoryMB.target}, detail ${r.memoryMB.buildingDetail}` : null).filter(Boolean).join(' · ')}.`);
const ua = scenes.find(([, r]) => r.uaBreakdown)?.[1];
if (ua?.uaBreakdown) L.push('', `Tab memory per scope (measureUserAgentSpecificMemory, scene ${scenes.find(([, r]) => r.uaBreakdown)[0]}): ${ua.uaBreakdown.sort((a, b) => b.mb - a.mb).map((b) => `${b.mb} MB ${b.scope}${b.url ? ` ${b.url}` : ''}`).join(' · ')}.`);
const workersRow = scenes.at(-1)?.[1]?.workers;
if (workersRow?.length) L.push('', `The page's workers at the end (${workersRow.length}; workers of workers do not show): ${workersRow.map((w) => `${w.url}${w.closed ? ' (closed)' : ''}${w.heapBytes ? ` heap ${Math.round(w.heapBytes / 1e6)} MB` : ''}${w.counters ? ` msgs in ${w.counters.in} (${fmtKB(w.counters.inBytes)}) out ${w.counters.out} (${fmtKB(w.counters.outBytes)}) ports in ${w.counters.portIn} out ${w.counters.portOut}` : ''}`).join(' · ')}.`);

L.push('', `## 2. Findings (${ordered.length}, deduplicated by the cause's line, by measured cost)`, '');
const byRule = new Map();
for (const f of ordered) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
L.push(`By rule: ${[...byRule].map(([r, c]) => `${r} ${c}`).join(' · ')}.`, '');
L.push('| # | rule | cause (file:line of who did it) | counted evidence | measured cost | scenes | proof counter |', '|---|---|---|---|---|---|---|');
const cost = (f) => [f.costMs ? fmtMs(f.costMs) : null, f.costBytes ? fmtKB(f.costBytes) : null, f.costCount && !f.costMs && !f.costBytes ? `${fmtNum(f.costCount)}×` : null].filter(Boolean).join(', ') || '—';
const MAX_ROWS = { 'idle-running': 40, 'dead-code': 15, leak: 30 };
const shown = new Map();
let k = 0;
for (const f of ordered) {
  const max = MAX_ROWS[f.rule] ?? 60;
  const c = shown.get(f.rule) ?? 0;
  if (c >= max) continue;
  shown.set(f.rule, c + 1);
  L.push(`| ${++k} | ${f.rule} (${f.kind}) | \`${f.cause.replace(/\|/g, '\\|')}\` | ${f.evidence.replace(/\|/g, '\\|')} | ${cost(f)} | ${f.scenes.join(', ') || '—'} | ${f.proof} |`);
}
for (const [r, c] of byRule) if (c > (shown.get(r) ?? 0)) L.push(`| … | ${r} | (${c - (shown.get(r) ?? 0)} more in findings.json) | | | | |`);

const idle = counters.rules.idle;
if (idle) {
  L.push('', `## 3. Scene ${cfg.idleScene} still (game paused by the player, camera still, ${v('holdMs') / 1000} s): what still ran`, '');
  L.push(`- Frames drawn: **${idle.frames ?? '?'}** (the minimum for "nothing changed" is 0 beyond the first); draw calls in the last frame: ${idle.drawCallsPerFrame ?? '?'}; shadow passes in the scene: ${idle.shadowPasses ?? '?'}.`);
  L.push(`- Functions of \`src/\` that ran: **${idle.functionsRun}**, ${fmtNum(idle.callsTotal)} calls in all (V8's exact coverage, counting pass).`);
  L.push(`- Self time in our code in the clean pass: ${idle.selfMsOurs ?? '?'} ms of ${idle.profiledMs ?? '?'} ms profiled.`);
  if (idle.allocBytes != null) L.push(`- Allocated in the scene: ${fmtMB(idle.allocBytes)}${idle.allocTop?.length ? `; who: ${idle.allocTop.slice(0, 5).map(([k, b]) => `${fmtKB(b)} ${k}`).join('; ')}` : ''}.`);
  if (idle.workerMessages) L.push(`- Messages with the workers in the scene: ${Object.entries(idle.workerMessages).map(([w, m]) => `${w}: ${m.to}→ (${fmtKB(m.toBytes)}) ${m.from}← (${fmtKB(m.fromBytes)})`).join(' · ') || 'none'}.`);
  if (idle.probeCalls?.length) L.push(`- The probe's own calls at the window's start, left out of the findings: ${idle.probeCalls.map(([k, c]) => `${k} ×${fmtNum(c)}`).join('; ')}.`);
  if (idle.selfMsAll) L.push(`- Self time, everything (top 15): ${Object.entries(idle.selfMsAll).map(([k, ms]) => `${ms} ms ${k}`).join('; ')}.`);
}

if (counters.rules.heapAfterGcMB) L.push('', '## 4. Heap after GC along the plan (counting pass)', '', counters.rules.heapAfterGcMB.map((h) => `scene ${h.n}: ${h.mb ?? '?'} MB`).join(' → '));
for (const n of [7, 9]) {
  const s = counters.rules[`snapshot${n}`];
  if (!s) continue;
  L.push('', `### Snapshots of scene ${n} (${sceneName(n)}): ${fmtNum(s.before.nodes)} objects / ${fmtMB(s.before.bytes)} before → ${fmtNum(s.after.nodes)} / ${fmtMB(s.after.bytes)} after`, '', '| constructor | more objects | more bytes | objects at the end |', '|---|---:|---:|---:|');
  for (const g of s.grown.slice(0, 20)) L.push(`| ${g.name} | ${fmtNum(g.count)} | ${fmtKB(g.size)} | ${fmtNum(g.countAfter)} |`);
}

const dc = counters.rules.deadCode;
if (dc) {
  L.push('', '## 5. Dead code (coverage of the whole plan × knip)', '', `${dc.neverCalled} of ${dc.functionsSeen} loaded \`src/\` functions (${dc.filesLoaded} files) never ran in 9 scenes. knip: ${dc.knipUnusedFiles} file(s) with no importer${dc.knipUnusedExports != null ? `, ${dc.knipUnusedExports} unused export(s)/member(s)` : ' (did not run)'}. Confirmed by both sources: **${dc.confirmed}**; files with no importer and never loaded: **${dc.neverLoadedAndUnused}**. Full list in \`dead-code.md\`.`, '', '| file | never ran | ran | chars never run |', '|---|---:|---:|---:|');
  for (const f of counters.rules.deadCodeTopFiles ?? []) L.push(`| ${f.file} | ${f.dead} | ${f.live} | ${fmtNum(f.chars)} |`);
}

if (counters.rules.messages) {
  const m = counters.rules.messages;
  L.push('', '## 6. Messages with the workers (counting pass, page side, the whole plan)', '', '| worker | created at | to it | bytes | from it | bytes |', '|---|---|---:|---:|---:|---:|');
  for (const [w, r] of Object.entries(m.byWorker).sort((a, b) => b[1].inBytes + b[1].outBytes - a[1].inBytes - a[1].outBytes)) L.push(`| ${w} | ${r.made && r.made !== '?' ? sources.original(...(() => { const mm = r.made.match(/^(.*):(\d+):(\d+)$/); return mm ? [mm[1], Number(mm[2]), Number(mm[3])] : [r.made, 1, 1]; })()) : '?'} | ${fmtNum(r.out)} | ${fmtKB(r.outBytes)} | ${fmtNum(r.in)} | ${fmtKB(r.inBytes)} |`);
  L.push(`| (MessagePort ports) | — | ${fmtNum(m.ports.n)} | ${fmtKB(m.ports.bytes)} | | |`, '', `Messages ≥ ${fmtMB(v('largeMessageBytes'))}: ${m.large}.`);
}
if (traceInfo) L.push('', `Clean pass trace (${fmtMB(traceInfo.bytes)}, streamed): ${fmtNum(traceInfo.events)} events, ${fmtNum(traceInfo.mainEvents)} kept from the page's main thread, ${fmtNum(traceInfo.tasks)} tasks of 1 ms or more, ${fmtNum(traceInfo.gcs)} GC events; postMessage per scene: ${Object.entries(traceInfo.posts).map(([k, c]) => `${k} ${c}`).join(', ') || '—'}.`);

const guard = counters.rules.imageGuard ?? [];
if (guard.length) L.push('', '## 7. Images and image guard', '', 'Each image\'s hash, the reference for the next run. The two passes are not compared with each other: they run the simulation in separate Chromes, with other vehicles and people.', '', guard.map((g) => `- ${g.image}: \`${g.sha1}\``).join('\n'));

L.push('', '## 8. Limits of this run (what stage 0 does not see, and why)', '');
limit('the run is a single one: with no "before" beside it, no time here says better or worse; the comparison with the previous run belongs to stage 1');
limit('scene 8 uses `__roadcraft` calls (setQuality, setWeather, setSkyMode) where no player gesture exists that the probe can replay without the panel\'s DOM; scenes 2, 3 and 9 pause and release the game through setTraffic, as the pause button does');
limit('workers: only those the page creates (workers of workers do not show in `page.workers()`); the counters inside them hold from the hook on (earlier messages do not count); their heap comes from measureUserAgentSpecificMemory alone');
limit('no hooks in WebGL nor in three\'s constructors (stage 1): off-camera, hidden, same-upload, duplicate, zombie, orphan-hook and the like do not run yet');
limit('the GPU time is the game\'s (`__gpu`, EXT_disjoint_timer_query of the whole frame); per draw only in stage 2');
for (const l of limits) L.push(`- ${l}`);

const next = join(here, 'NEXT-STEPS.md');
if (existsSync(next)) L.push('', readFileSync(next, 'utf8').trim());
L.push('', `Files: \`findings.json\` (every finding), \`counters.json\` (counters per scene and per rule), \`dead-code.md\`, \`images/\` (one or two per view and pass), \`raw/\` (coverage, allocations, .cpuprofile profiles, trace, snapshots, readings).`);
writeFileSync(join(OUT, 'report.md'), L.join('\n') + '\n');
console.log(`report.md: ${ordered.length} findings (${[...byRule].map(([r, c]) => `${r} ${c}`).join(', ')}); limits: ${limits.length}`);
