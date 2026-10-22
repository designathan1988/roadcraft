// THE ANALYSER (PLANO-SONDA.md §3 [C], Etapa 0): over what `rodar.mjs` wrote under `<out>/bruto/`, resolves every stack to the source's
// file:line (Vite's inline maps), runs the rules Etapa 0 can run - trava, vazamento, codigo-morto, clone-grande, parado-rodando - deduplicates
// the findings by the line of the cause, orders them by the cost the clean pass measured, and writes `relatorio.md`, `achados.json`,
// `contadores.json` and `codigo-morto.md`. Nothing here judges intent: a finding is a counted fact with the counter its fix must zero.
// Usage: node --max-old-space-size=8192 scripts/sonda/analisar.mjs <out> [--sem-knip]
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Sources, shortPath } from './fontes.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(here, '..', '..');
const OUT = resolve(process.argv[2] ?? '');
if (!OUT || !existsSync(join(OUT, 'bruto', 'meta.json'))) { console.error('usage: node scripts/sonda/analisar.mjs <pasta da rodada>'); process.exit(2); }
const NO_KNIP = process.argv.includes('--sem-knip');
const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const v = (k) => (typeof cfg[k] === 'object' && cfg[k] !== null && 'value' in cfg[k] ? cfg[k].value : cfg[k]);
const BRUTO = join(OUT, 'bruto');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));
const meta = readJson(join(BRUTO, 'meta.json'));
const sources = new Sources(existsSync(join(BRUTO, 'fontes.json')) ? readJson(join(BRUTO, 'fontes.json')) : {});
const limits = [];
const limit = (text) => { if (!limits.includes(text)) limits.push(text); };

/** The scenes of a pass, by number, as `rodar.mjs` wrote them. */
function scenesOf(pass) {
  const out = new Map();
  for (const f of readdirSync(BRUTO)) {
    const m = f.match(new RegExp(`^cena(\\d+)-${pass}\\.json$`));
    if (m) out.set(Number(m[1]), readJson(join(BRUTO, f)));
  }
  return out;
}
const counting = scenesOf('contagem');
const clean = scenesOf('limpa');
if (!counting.size) limit('sem passe de contagem: cobertura, alocações, instantâneos do heap e mensagens não foram lidos');
if (!clean.size) limit('sem passe limpo: nenhum tempo, perfil ou trace');
const sceneName = (n) => (clean.get(n) ?? counting.get(n))?.name ?? `cena ${n}`;

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
const pt = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

// ------------------------------------------------------------------ the profiles' functions resolved
/** A `.cpuprofile`: self and total ms per function, the function's line resolved, and each sample's time (µs, the trace's clock) with its node. */
function readProfile(file) {
  const p = readJson(file);
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keyOf = (n) => {
    const f = n.callFrame;
    if (!f.url) return `${f.functionName || '(anônima)'} ${f.url === '' && /^\(/.test(f.functionName) ? '' : '(nativo)'}`.trim();
    return `${f.functionName || '(anônima)'} @ ${sources.original(f.url, f.lineNumber + 1, f.columnNumber + 1)}`;
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
    const here = f.url ? `${f.functionName || '(anônima)'} @ ${sources.original(f.url, f.lineNumber + 1, f.columnNumber + 1)}` : `${f.functionName || '(nativo)'}`;
    const mine = String(f.url).includes('/src/') ? here : owner;
    if (n.selfSize) {
      bytes += n.selfSize;
      sites.set(here, (sites.get(here) ?? 0) + n.selfSize);
      ours.set(mine ?? '(fora do src)', (ours.get(mine ?? '(fora do src)') ?? 0) + n.selfSize);
    }
    for (const c of n.children ?? []) walk(c, mine);
  })(p.head, null);
  const rank = (m, k = 12) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k);
  return { bytes, sites: rank(sites), ours: rank(ours), allOurs: ours };
}

/** Functions the probe itself calls in a window (rodar.mjs `since`), and what they call. */
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
    const mark = line.includes('sonda:cena:'), post = line.includes('PostMessage"'), complete = line.includes('"ph":"X"');
    if (!mark && !post && !complete) { total++; continue; }
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    total++;
    if (typeof e.name !== 'string') continue;
    if (e.name.startsWith('sonda:cena:')) kept.push(e);
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
    wallS: { contagem: c ? Math.round(c.wallMs / 1000) : null, limpa: l ? Math.round(l.wallMs / 1000) : null },
    settle: (l ?? c).notes?.settle ?? null,
    framesDrawn: { contagem: c?.readings?.framesDrawn ?? null, limpa: l?.readings?.framesDrawn ?? null },
    frames: l?.readings?.frames ? { n: l.readings.frames.frames, long: l.readings.frames.long, p50: l.readings.frames.total?.p50, p95: l.readings.frames.total?.p95, max: l.readings.frames.total?.max, systems: l.readings.frames.systems } : null,
    gpu: l?.readings?.gpu ? { p50: l.readings.gpu.p50, p95: l.readings.gpu.p95, n: l.readings.gpu.n, disjoint: l.readings.gpu.disjoint } : null,
    drawCalls: r.memory?.drawCalls ?? null, builtTriangles: r.memory?.builtTriangles ?? r.memory?.triangles ?? null, drawnTriangles: r.gl?.render?.triangles ?? null, programs: r.memory?.programs ?? null,
    memoryMB: r.memory ? { heap: r.memory.heapMB, geometry: r.memory.geometryMB, geometryCpu: r.memory.geometryCpuMB, texture: r.memory.textureMB, target: r.memory.targetMB, buildingDetail: r.memory.buildingDetailMB } : null,
    heapAfterGcMB: c?.heapAfterGc ? Math.round(c.heapAfterGc.usedBytes / 1e6) : null,
    uaMemoryMB: c?.uaMemory?.bytes ? Math.round(c.uaMemory.bytes / 1e6) : (c?.uaMemory?.error ?? null),
    uaBreakdown: c?.uaMemory?.breakdown?.map((b) => ({ mb: Math.round(b.bytes / 1e6), scope: b.attribution?.[0]?.scope ?? '?', url: shortPath(b.attribution?.[0]?.url ?? '') })) ?? null,
    shadow: r.shadowStats ?? null, levels: r.buildingLevels ?? null, sim: r.sim ?? null, doc: r.doc ?? null,
    budgetOver: Array.isArray(r.budget) ? r.budget.filter((b) => b.status && /over|acima|estour/i.test(String(b.status))).map((b) => `${b.item}: ${b.measured} / ${b.budget}`) : null,
    loaf: l?.readings?.loaf?.length ?? c?.readings?.loaf?.length ?? 0,
    notes: { ...(c?.notes ?? {}), ...(l?.notes ?? {}) },
    workers: (c ?? l)?.workers ?? null,
    allocBytes: c?.allocations?.bytes ?? null,
    snapshots: c?.snapshots ?? null,
  };
  counters.byScene[n] = row;
}

// ------------------------------------------------------------------ RULE trava: the trace's long tasks and GC pauses (clean pass)
/** Each scene's WINDOW profile (after `since`; the whole scene when it has none), and every profile of it with its preparation's (`-preparo`). */
const profiles = new Map(), allProfiles = new Map();
for (const [n, s] of clean) {
  const list = [];
  for (const p of [s.profilePrep, s.profile]) if (p?.file && existsSync(p.file)) list.push(readProfile(p.file));
  if (s.profile?.file && existsSync(s.profile.file)) profiles.set(n, list.at(-1));
  allProfiles.set(n, list);
}
const traceFile = join(BRUTO, 'limpa.trace.json');
let traceInfo = null;
/** Each scene's start mark in the trace's clock (µs ticks, the profile's too). */
const markTicks = new Map();
if (existsSync(traceFile)) {
  {
    // Read line by line (Chrome writes one event a line): a trace of the whole script is near 1 GB, past the longest string V8 makes
    // (v0's first analysis left it unread). Only what the rules use is kept.
    const events = await readTrace(traceFile);
    // The page's main thread: where the script's own marks (`sonda:cena:N:inicio`) are.
    const marks = events.filter((e) => typeof e.name === 'string' && e.name.startsWith('sonda:cena:') && (e.ph === 'R' || e.ph === 'I' || e.ph === 'i' || e.ph === 'n'));
    if (!marks.length) limit('o trace não tem as marcas das cenas (blink.user_timing): quadros longos e GC do trace sem cena');
    const lastWhole = Math.max(0, ...[...clean.keys()].filter((n) => marks.some((m) => m.name === `sonda:cena:${n}:fim`)));
    const missing = [...clean.keys()].filter((n) => n > lastWhole);
    if (missing.length) limit(`o trace cobre só as cenas 1 a ${lastWhole}: o buffer do Chrome encheu (${fmtMB(statSync(traceFile).size)}) e parou de gravar; nas cenas ${missing.join(', ')} as tarefas longas e o GC vêm só do LoAF e do perfil de CPU (próxima rodada: um trace por cena)`);
    const main = marks.length ? { pid: marks[0].pid, tid: marks[0].tid } : null;
    const bounds = new Map();
    for (const m of marks) {
      const mm = m.name.match(/^sonda:cena:(\d+):(inicio|fim)$/);
      if (!mm) continue;
      const b = bounds.get(Number(mm[1])) ?? {};
      b[mm[2]] = m.ts;
      if (mm[2] === 'inicio') markTicks.set(Number(mm[1]), m.ts);
      bounds.set(Number(mm[1]), b);
    }
    const sceneAt = (ts) => { for (const [n, b] of bounds) if (b.inicio !== undefined && ts >= b.inicio && ts <= (b.fim ?? Infinity)) return n; return null; };
    const firstMark = Math.min(...[...bounds.values()].map((b) => b.inicio ?? Infinity));
    const markOffset = (() => { for (const [n, b] of bounds) { const p = clean.get(n)?.pageT0; if (b.inicio !== undefined && p !== undefined) return b.inicio - p * 1000; } return null; })();
    /** The part of the scene a time falls in: its window (after `since`), or its preparation. */
    const phaseAt = (n, ts) => { const w = clean.get(n)?.windowT0; return w === undefined || markOffset === null ? 'cena inteira' : ts >= w * 1000 + markOffset ? 'janela' : 'preparação'; };
    const whereOf = (n, ts) => n !== null ? `cena ${n} (${sceneName(n)}), ${phaseAt(n, ts)}` : ts < firstMark ? 'antes da cena 1 (a página carregando o jogo)' : 'entre cenas (a sonda lendo os contadores)';
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
        cause = d ? `${longest.name}${d.functionName ? ` ${d.functionName}` : ''}${d.url ? ` @ ${sources.original(d.url, (d.lineNumber ?? 0) + 1, (d.columnNumber ?? 0) + 1)}` : d.type ? ` (${d.type})` : ''}` : `(tarefa sem entrada atribuída: ${t.name})`;
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
        rule: 'trava', kind: `tarefa > ${v('longFrameMs')} ms (trace)`, cause: row.cause, scenes: [row.n ?? 0],
        evidence: `${row.count} tarefa(s) longa(s): ${row.where}; pior ${fmtMs(row.worst)}${top ? `; pilha (tempo próprio): ${top}` : ''}${row.n === 1 ? ' — abertura (carga)' : ''}`,
        costMs: row.ms, costCount: row.count, proof: `frame.long → 0 fora da abertura (limiar ${v('longFrameMs')} ms)`,
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
      const sites = alloc ? alloc.ours.filter(([k]) => k !== '(fora do src)' && !PROBE_CALLS.test(k)).slice(0, 5) : [];
      finding({
        rule: 'trava', kind: `GC > ${v('longGcMs')} ms`, cause: sites[0]?.[0] ?? `(sem passe de contagem: sítios de alocação desconhecidos) cena ${n}`, scenes: [n],
        evidence: `${row.long} pausa(s) de GC acima de ${v('longGcMs')} ms na cena ${n} (${sceneName(n)}), ${fmtMs(row.longMs)} ao todo, pior ${fmtMs(row.worst)} (${[...row.names].map(([k, c]) => `${k} ×${c}`).join(', ')}); quem mais alocou na cena (passe de contagem): ${sites.map(([k, b]) => `${fmtKB(b)} ${k}`).join('; ') || '—'}`,
        costMs: row.longMs, costCount: row.long, proof: `gc.pausesOver${v('longGcMs')}ms → 0 fora da abertura`,
      });
    }
  }
} else limit('sem trace do passe limpo: tarefas longas e pausas de GC não contadas');

// ------------------------------------------------------------------ RULE trava: long animation frames (clean pass)
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
    let cause = top ? `${top.sourceFunctionName || '(anônima)'} @ ${top.sourceURL ? sources.atOffset(top.sourceURL, top.sourceCharPosition ?? 0) : '(sem url)'}${top.invoker ? ` ← ${top.invoker}` : ''}` : `(sem script listado: ${Math.round(e.renderStart - e.startTime)} ms até o render, ${Math.round(e.duration - (e.renderStart - e.startTime))} ms de render/layout)`;
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
        profiled = `; no perfil, dentro do quadro: ${ranked.slice(0, 3).map(([k, ms]) => `${fmtMs(ms)} ${k}`).join('; ')}; tempo próprio: ${own.map(([k, ms]) => `${fmtMs(ms)} ${k}`).join('; ')}`;
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
      rule: 'trava', kind: 'quadro-longo (LoAF ≥ 50 ms)', cause, scenes: [n],
      evidence: `${row.count} quadro(s) longo(s) na cena ${n} (${sceneName(n)}); pior ${fmtMs(row.worst)}; bloqueio ${fmtMs(row.blocking)}; scripts listados ${fmtMs(row.scriptsMs)} de ${fmtMs(row.ms)}${row.profiled ? ` (pior quadro${row.profiled})` : ''}${n === 1 ? ' — abertura (carga esperada; conta como tempo de abertura)' : ''}`,
      costMs: row.ms, costCount: row.count, proof: 'frame.long → 0 fora da abertura (cena 1)',
    });
  }
}


// ------------------------------------------------------------------ RULE parado-rodando (scene 2: the player's pause, the camera still)
{
  const n = cfg.idleScene;
  const c = counting.get(n), l = clean.get(n);
  const idle = { frames: l?.readings?.framesDrawn ?? c?.readings?.framesDrawn ?? null, drawCallsPerFrame: (l ?? c)?.readings?.memory?.drawCalls ?? null, shadowPasses: (l ?? c)?.readings?.shadowStats?.passes ?? null, allocBytes: c?.allocations?.bytes ?? null, functionsRun: 0, callsTotal: 0, workerMessages: null, selfMsOurs: 0 };
  // What ran (counting pass): every function of ours with calls in the idle scene.
  const ran = new Map();
  if (c) {
    const cov = existsSync(join(BRUTO, `cena${String(n).padStart(2, '0')}-cobertura.json`)) ? readJson(join(BRUTO, `cena${String(n).padStart(2, '0')}-cobertura.json`)) : null;
    if (cov) for (const script of cov.ours) for (const fn of script.functions) {
      const count = fn.ranges[0]?.count ?? 0;
      if (count <= 0) continue;
      const key = `${fn.functionName || '(anônima)'} @ ${sources.atOffset(script.url, fn.ranges[0].startOffset)}`;
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
      rule: 'parado-rodando', kind: 'rodou com o jogo pausado e a câmera parada', cause: k, scenes: [n],
      evidence: `${calls ? `${pt(calls)} chamada(s)` : 'não contada (só no perfil)'} em ${idle.frames ?? '?'} quadro(s) desenhados nos ${v('holdMs') / 1000} s parados${ms ? `; ${fmtMs(ms)} de tempo próprio no passe limpo` : ''}${bytes ? `; ${fmtKB(bytes)} alocados` : ''}`,
      costMs: ms, costCount: calls, costBytes: bytes, proof: 'idle.workItems → lista vazia (um present por quadro pedido, nada mais)',
    });
  }
}

// ------------------------------------------------------------------ RULE clone-grande (counting pass hooks; the trace's postMessage counts above)
{
  const last = [...counting.values()].sort((a, b) => b.n - a.n)[0];
  const msgs = last?.readings?.msgs;
  if (msgs) {
    counters.rules.messages = { byWorker: msgs.byWorker, ports: msgs.ports, large: msgs.large.length };
    const byCause = new Map();
    for (const m of msgs.large) {
      const site = m.site ? sources.original(...(() => { const mm = m.site.match(/^(.*):(\d+):(\d+)$/); return mm ? [mm[1], Number(mm[2]), Number(mm[3])] : [m.site, 1, 1]; })()) : `(recebida de ${m.worker})`;
      const scene = [...counting.values()].find((s) => m.at >= s.pageT0 && m.at <= s.pageT1)?.n ?? 0;
      const key = `${site}|${m.kind}|${m.dir}`;
      const row = byCause.get(key) ?? { site, kind: m.kind, dir: m.dir, worker: m.worker, count: 0, bytes: 0, max: 0, scenes: new Set() };
      row.count++; row.bytes += m.bytes; row.max = Math.max(row.max, m.bytes); row.scenes.add(scene);
      byCause.set(key, row);
    }
    for (const row of byCause.values()) finding({
      rule: 'clone-grande', kind: `mensagem ≥ ${fmtMB(v('largeMessageBytes'))}`, cause: row.site, scenes: [...row.scenes],
      evidence: `${row.count} mensagem(ns) ${row.dir === 'to' ? 'para' : row.dir === 'from' ? 'vinda(s) de' : 'por porta,'} ${row.worker}${row.kind ? ` (${row.kind})` : ''}, ${fmtMB(row.bytes)} ao todo, maior ${fmtMB(row.max)} (bytes estimados pela sonda: exatos para buffers e strings, aproximados para objetos)`,
      costBytes: row.bytes, costCount: row.count, proof: 'msg.largeClones → 0 (ou transferido, não copiado)',
    });
  } else limit('sem contadores de mensagens (passe de contagem ausente): clone-grande só pelas contagens do trace');
}

/** V8's own: compiled code and its metadata (more functions compiled as the script goes on), and the precise coverage's bookkeeping (CoverageInfo, DebugInfo: made by the probe). Shown in the tables, never a finding. */
const V8_INTERNAL = /^code:|^native:system \/ (CoverageInfo|DebugInfo|FunctionTemplateInfo|WeakArrayList)|^object shape:/;

// ------------------------------------------------------------------ RULE vazamento (heap snapshots before/after scenes 7 and 9; heap after GC along the script)
{
  const heapLine = [...counting.values()].sort((a, b) => a.n - b.n).map((s) => ({ n: s.n, mb: s.heapAfterGc ? Math.round(s.heapAfterGc.usedBytes / 1e6) : null }));
  counters.rules.heapAfterGcMB = heapLine;
  for (const [n, s] of counting) {
    const a = s.snapshots?.antes, d = s.snapshots?.depois;
    if (!a && !d) continue;
    if (!a?.file || !d?.file) {
      const why = a?.skipped ?? d?.skipped ?? 'instantâneo ausente';
      finding({ rule: 'vazamento', kind: 'sem instantâneo', cause: `cena ${n} (${sceneName(n)})`, scenes: [n], evidence: `instantâneos não tirados: ${why}; heap após GC antes ${a?.usedBytes ? fmtMB(a.usedBytes) : '?'} → depois ${d?.usedBytes ? fmtMB(d.usedBytes) : '?'}`, costBytes: Math.max(0, (d?.usedBytes ?? 0) - (a?.usedBytes ?? 0)), proof: 'heap.growthPerCycle → 0' });
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
        rule: 'vazamento', kind: removal ? 'cresceu numa cena que só remove' : 'cresceu entre o antes e o depois da cena', cause: g.name, scenes: [n],
        evidence: `${pt(g.count)} objeto(s) a mais (${pt(g.countAfter)} no fim), ${fmtKB(g.size)} a mais, na cena ${n} (${sceneName(n)})${removal ? ' — depois de remover prédios e vias nada deste tipo devia sobrar a mais' : ' — o que a edição criou e não soltou, ou guardou de propósito (decisão humana)'}; heap total ${fmtMB(before.bytes)} → ${fmtMB(after.bytes)}`,
        costBytes: g.size, costCount: g.count, proof: 'heap.growthPerCycle → 0 para este construtor (repetir a cena N vezes e ver o contador parar)',
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
    const name = idx.startsWith('#') ? `${type}:${names.get(Number(idx.slice(1))) ?? idx}` : `${type}:(todos)`;
    const was = byName.get(name);
    if (was) { was.count += e.count; was.size += e.size; } else byName.set(name, { ...e });
  }
  return { nodes, bytes, byName };
}

// ------------------------------------------------------------------ RULE codigo-morto (coverage over the whole script × knip)
// Only with the counting pass: without coverage every file looks unloaded and every unused export dead (the fast mode's first test: 62 false findings).
if (!counting.size) limit('sem passe de contagem: sem cobertura, a regra de código morto não roda');
else {
  const total = new Map(), fnMeta = new Map();
  for (const [n] of counting) {
    for (const part of ['cobertura-preparo', 'cobertura']) {
    const f = join(BRUTO, `cena${String(n).padStart(2, '0')}-${part}.json`);
    if (!existsSync(f)) continue;
    const cov = readJson(f);
    for (const script of cov.ours) for (const fn of script.functions) {
      const key = `${script.url}@${fn.ranges[0].startOffset}`;
      total.set(key, (total.get(key) ?? 0) + (fn.ranges[0]?.count ?? 0));
      if (!fnMeta.has(key)) fnMeta.set(key, { url: script.url, offset: fn.ranges[0].startOffset, end: fn.ranges[0].endOffset, name: fn.functionName || '(anônima)' });
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
      } catch (e) { limit(`knip rodou mas a saída não é JSON (${String(e.message).slice(0, 80)})`); }
    } else limit(`knip não rodou (${(run.stderr ?? '').split('\n')[0].slice(0, 160) || `código ${run.status}`})`);
  } else if (!NO_KNIP) limit('knip não está em node_modules: sem a parte estática do código morto');
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
  const lines = [`# Código morto — ${meta.date ?? ''}`, '', `Dinâmico: ${dead.length} de ${total.size} funções de \`src/\` carregadas nunca rodaram em todo o roteiro (9 cenas). Estático (knip): ${knip ? `${unusedFiles.length} arquivo(s) sem importador, ${knip.exports.length} export(s)/membro(s) sem uso` : 'não rodou'}.`, '', '"Não chamado no roteiro" não é "morto": o roteiro cobre o que o §5 do plano cobre. Morto é o que o knip diz que ninguém importa E a cobertura confirma; o resto é decisão humana.', ''];
  lines.push('## Confirmado pelas duas fontes (export sem uso que também nunca rodou)', '');
  for (const c of confirmed.sort((a, b) => a.at.localeCompare(b.at))) lines.push(`- ${c.at} \`${c.name}\` (${c.knip})`);
  if (!confirmed.length) lines.push('- (nenhum)');
  lines.push('', '## Exports sem uso (knip) em arquivos que a página nunca carregou', '', 'A cobertura desta etapa é só da página: um arquivo usado apenas dentro de um worker aparece aqui sem estar morto. Os tipos ficam de fora (somem no JavaScript servido).', '');
  for (const e of unloadedExports.sort((a, b) => a.file.localeCompare(b.file))) lines.push(`- ${e.file}${e.line ? `:${e.line}` : ''} \`${e.name}\` (${e.type})`);
  if (!unloadedExports.length) lines.push('- (nenhum)');
  lines.push('', '## Arquivos de src/ que o knip diz sem importador e que o roteiro nunca carregou', '');
  for (const f of neverLoaded) lines.push(`- ${f}`);
  if (!neverLoaded.length) lines.push('- (nenhum)');
  lines.push('', '## Por arquivo: funções que nunca rodaram no roteiro (mortas, chars) × que rodaram', '', '| arquivo | nunca rodaram | rodaram | chars nunca rodados |', '|---|---:|---:|---:|');
  for (const [f, r] of [...files].sort((a, b) => b[1].chars - a[1].chars)) lines.push(`| ${f} | ${r.dead} | ${r.live} | ${pt(r.chars)} |`);
  lines.push('', '## Todas as funções que nunca rodaram (arquivo:linha, nome, chars)', '');
  for (const d of dead.sort((a, b) => a.at.localeCompare(b.at, undefined, { numeric: true }))) lines.push(`- ${d.at} \`${d.name}\` (${d.chars})`);
  writeFileSync(join(OUT, 'codigo-morto.md'), lines.join('\n') + '\n');
  for (const c of confirmed) finding({ rule: 'codigo-morto', kind: 'export sem uso (knip) e 0 execuções no roteiro', cause: `${c.name} @ ${c.at}`, scenes: [], evidence: `knip: ${c.knip} sem uso; cobertura: 0 chamadas em 9 cenas; ${pt(c.chars)} chars`, costCount: c.chars, proof: 'lista (decisão humana): apagar ou cobrir no roteiro' });
  for (const e of unloadedExports) finding({ rule: 'codigo-morto', kind: 'export sem uso (knip) num arquivo que a página não carregou', cause: `${e.name} @ ${e.file}${e.line ? `:${e.line}` : ''}`, scenes: [], evidence: `knip: ${e.type} sem importador; a página não carregou ${e.file} em 9 cenas (se o arquivo roda só num worker, a cobertura desta etapa não o vê)`, costCount: 1, proof: 'lista (decisão humana)' });
  for (const f of neverLoaded) finding({ rule: 'codigo-morto', kind: 'arquivo sem importador (knip) e nunca carregado', cause: f, scenes: [], evidence: 'knip: nenhum módulo importa; cobertura: o Vite nunca o serviu em 9 cenas', costCount: 1, proof: 'lista (decisão humana)' });
  counters.rules.deadCodeTopFiles = [...files].sort((a, b) => b[1].chars - a[1].chars).slice(0, 25).map(([f, r]) => ({ file: f, dead: r.dead, live: r.live, chars: r.chars }));
}

// ------------------------------------------------------------------ image guard (v0: the two passes' pictures of a paused scene byte-equal?)
{
  const imgs = join(OUT, 'imagens');
  const guard = [];
  if (existsSync(imgs)) {
    // Each picture's hash, kept as the reference the next run is compared with. The two passes are NOT compared with each other: two Chromes
    // run the simulation apart (other vehicles, other people, other frames), so their pictures differ with nothing wrong (v0: all 15 differed).
    const { createHash } = await import('node:crypto');
    for (const f of readdirSync(imgs).sort()) guard.push({ image: f, sha1: createHash('sha1').update(readFileSync(join(imgs, f))).digest('hex').slice(0, 12) });
  }
  counters.rules.imageGuard = guard;
  limit('guarda de imagem: esta rodada só grava o hash de cada imagem como referência; a comparação pixel a pixel com a rodada anterior precisa de uma cena determinística (simulação de passo fixo, item 12 da lista para src/)');
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
writeFileSync(join(OUT, 'achados.json'), JSON.stringify({ meta: { date: meta.date, commit: meta.commit, chrome: meta.chrome, gpu: meta.gpu, busy: meta.busy, busyAccepted: meta.busyAccepted, out: OUT }, findings: ordered, limits }, null, 1));
writeFileSync(join(OUT, 'contadores.json'), JSON.stringify(counters, null, 1));

// ------------------------------------------------------------------ the report
const L = [];
const scenes = Object.entries(counters.byScene).filter(([, r]) => r.name).sort((a, b) => Number(a[0]) - Number(b[0]));
const noisy = meta.busyAccepted && (meta.busy?.gpu?.length || meta.busy?.cpu?.length);
L.push(`# Sonda do Roadcraft — relatório v0 (Etapa 0) — ${new Date(meta.date).toLocaleString('pt-BR')}`, '');
L.push(`Alvo: commit \`${meta.commit}\` (${meta.branch}${meta.dirty ? `, ${meta.dirty} arquivo(s) alterado(s) fora de test-results` : ''}) · Chrome ${meta.chrome} · GPU ${meta.gpu} · Node ${meta.node} · Playwright ${meta.playwright} · roteiro: cidade semente ${cfg.seed}, ${cfg.viewport.join('×')}, ${meta.scenes ? `cenas ${meta.scenes.join(', ')}` : '9 cenas'} (§5 do plano)${meta.fast ? ' — MODO RÁPIDO: só o passe limpo, sem trace' : ''}.`);
L.push(`Passes: ${Object.entries(meta.passes ?? {}).map(([p, s]) => `${p} ${s.error ? `FALHOU (${String(s.error).split('\n')[0].slice(0, 120)})` : `${s.seconds} s`}`).join(' · ')}.`);
L.push(noisy ? `**MÁQUINA OCUPADA durante a rodada** (GPU: ${meta.busy.gpu.map((b) => `${b.name} ${b.percent}%`).join(', ') || '—'}; CPU: ${meta.busy.cpu.map((b) => `${b.name} ${b.cores} núcleo(s)`).join(', ') || '—'}): **todo tempo abaixo tem ruído**; as contagens valem.` : `Máquina livre no início da rodada (GPU e CPU sem outro processo acima do limiar; ${meta.busy?.freeGB ?? '?'} GB livres).`);
L.push('', 'Regra de leitura: **contagens** vêm do passe de contagem (ganchos, cobertura, alocações: mais lento, nunca cronometrado); **tempos** vêm do passe limpo (perfil por amostragem, trace, LoAF). Os dois correm o mesmo roteiro em Chromes separados.', '');

L.push('## 1. O roteiro, cena a cena', '', '| # | cena | vista | assentou (ms) | quadros desenhados (limpa / contagem) | quadros no __frames (os últimos 240) | CPU p50/p95/máx ms | GPU p50/p95 ms | chamadas | tri construídos | heap MB (após GC) | memória da aba MB | LoAF | GC pausas (>limiar) | observações |', '|---|---|---|---:|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---|');
for (const [n, r] of scenes) {
  const notes = [];
  if (r.notes?.shownMs) notes.push(`cidade mostrada em ${pt(r.notes.shownMs / 1000)} s, assentada em ${pt(r.notes.settledMs / 1000)} s`);
  if (r.notes?.edited) notes.push(`vias ${r.notes.edited.before.segments}→${r.notes.edited.after.segments}, prédios ${r.notes.edited.before.buildings}→${r.notes.edited.after.buildings}, carimbos ${r.notes.edited.before.stamps}→${r.notes.edited.after.stamps}`);
  if (r.notes?.roadSettleMs !== undefined) notes.push(`via assentou em ${r.notes.roadSettleMs} ms, terreno em ${r.notes.terrainSettleMs} ms; crescimento: ${r.notes.growth?.demolishedAfterClicks ? (r.notes.growth.grewBackMs !== null ? `um prédio demolido e reposto pelo worker em ${pt(r.notes.growth.grewBackMs / 1000)} s` : 'um prédio demolido e NÃO reposto em 60 s') : 'nenhum prédio demolido para crescer (cliques sem acerto)'}`);
  if (r.notes?.removed) notes.push(`removidos: ${r.notes.removed.buildings} prédios, ${r.notes.removed.segments} vias, ${r.notes.removed.poles} postes (assentou em ${r.notes.removeSettleMs} ms; ${r.notes.removed.clicks} cliques nos prédios, ${r.notes.removed.roadClicks} nas vias)`);
  if (r.notes?.orbitFrames) notes.push(`giro: ${r.notes.orbitFrames} quadros em 6 s`);
  if (r.notes?.quality) notes.push(`qualidade ${r.notes.quality}`);
  if (r.settle && !r.settle.settled) notes.push(`NÃO ASSENTOU em ${r.settle.ms} ms`);
  if (r.budgetOver?.length) notes.push(`orçamento estourado: ${r.budgetOver.join('; ')}`);
  if (r.shadow) notes.push(`sombra: ${r.shadow.passes} passes${r.shadow.whole ? `, inteiras ${r.shadow.whole.join('/')}` : ''}${r.shadow.why ? `, por ${Object.entries(r.shadow.why).filter(([, c]) => c).map(([k, c]) => `${k} ${c}`).join(' ') || '—'}` : ''}`);
  L.push(`| ${n} | ${r.name} | ${r.budget} | ${r.settle?.ms ?? '—'} | ${r.framesDrawn?.limpa ?? '—'} / ${r.framesDrawn?.contagem ?? '—'} | ${r.frames ? `${r.frames.n} (${r.frames.long} longos)` : '—'} | ${r.frames ? `${r.frames.p50}/${r.frames.p95}/${r.frames.max}` : '—'} | ${r.gpu ? `${r.gpu.p50}/${r.gpu.p95}${r.gpu.disjoint ? ` (disjoint ${r.gpu.disjoint})` : ''}` : '—'} | ${r.drawCalls ?? '—'} | ${r.builtTriangles ? pt(r.builtTriangles) : '—'} | ${r.memoryMB?.heap ?? '—'} (${r.heapAfterGcMB ?? '—'}) | ${typeof r.uaMemoryMB === 'number' ? r.uaMemoryMB : '—'} | ${r.loaf} | ${r.gc ? `${r.gc.pauses} (${r.gc.overThreshold})` : '—'} | ${notes.join('; ')} |`);
}
L.push('', `Memória da cena (MB, \`__roadcraft.memory\`, leitura do jogo: ver UI-15/TST-09 sobre o que ela não conta): ${scenes.map(([n, r]) => r.memoryMB ? `cena ${n}: geometria ${r.memoryMB.geometry}, cpu ${r.memoryMB.geometryCpu}, texturas ${r.memoryMB.texture}, alvos ${r.memoryMB.target}, detalhe ${r.memoryMB.buildingDetail}` : null).filter(Boolean).join(' · ')}.`);
const ua = scenes.find(([, r]) => r.uaBreakdown)?.[1];
if (ua?.uaBreakdown) L.push('', `Memória da aba por escopo (measureUserAgentSpecificMemory, cena ${scenes.find(([, r]) => r.uaBreakdown)[0]}): ${ua.uaBreakdown.sort((a, b) => b.mb - a.mb).map((b) => `${b.mb} MB ${b.scope}${b.url ? ` ${b.url}` : ''}`).join(' · ')}.`);
const workersRow = scenes.at(-1)?.[1]?.workers;
if (workersRow?.length) L.push('', `Workers da página no fim (${workersRow.length}; os workers de workers não aparecem): ${workersRow.map((w) => `${w.url}${w.closed ? ' (fechado)' : ''}${w.heapBytes ? ` heap ${Math.round(w.heapBytes / 1e6)} MB` : ''}${w.counters ? ` msgs in ${w.counters.in} (${fmtKB(w.counters.inBytes)}) out ${w.counters.out} (${fmtKB(w.counters.outBytes)}) portas in ${w.counters.portIn} out ${w.counters.portOut}` : ''}`).join(' · ')}.`);

L.push('', `## 2. Achados (${ordered.length}, deduplicados pela linha da causa, por custo medido)`, '');
const byRule = new Map();
for (const f of ordered) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
L.push(`Por regra: ${[...byRule].map(([r, c]) => `${r} ${c}`).join(' · ')}.`, '');
L.push('| # | regra | causa (arquivo:linha de quem fez) | evidência contada | custo medido | cenas | contador de prova |', '|---|---|---|---|---|---|---|');
const cost = (f) => [f.costMs ? fmtMs(f.costMs) : null, f.costBytes ? fmtKB(f.costBytes) : null, f.costCount && !f.costMs && !f.costBytes ? `${pt(f.costCount)}×` : null].filter(Boolean).join(', ') || '—';
const MAX_ROWS = { 'parado-rodando': 40, 'codigo-morto': 15, vazamento: 30 };
const shown = new Map();
let k = 0;
for (const f of ordered) {
  const max = MAX_ROWS[f.rule] ?? 60;
  const c = shown.get(f.rule) ?? 0;
  if (c >= max) continue;
  shown.set(f.rule, c + 1);
  L.push(`| ${++k} | ${f.rule} (${f.kind}) | \`${f.cause.replace(/\|/g, '\\|')}\` | ${f.evidence.replace(/\|/g, '\\|')} | ${cost(f)} | ${f.scenes.join(', ') || '—'} | ${f.proof} |`);
}
for (const [r, c] of byRule) if (c > (shown.get(r) ?? 0)) L.push(`| … | ${r} | (${c - (shown.get(r) ?? 0)} a mais em achados.json) | | | | |`);

const idle = counters.rules.idle;
if (idle) {
  L.push('', `## 3. Cena ${cfg.idleScene} parada (jogo pausado pelo jogador, câmera parada, ${v('holdMs') / 1000} s): o que ainda rodou`, '');
  L.push(`- Quadros desenhados: **${idle.frames ?? '?'}** (o mínimo para "nada mudou" é 0 além do primeiro); chamadas de desenho no último quadro: ${idle.drawCallsPerFrame ?? '?'}; passes de sombra na cena: ${idle.shadowPasses ?? '?'}.`);
  L.push(`- Funções de \`src/\` que rodaram: **${idle.functionsRun}**, ${pt(idle.callsTotal)} chamadas ao todo (cobertura exata do V8, passe de contagem).`);
  L.push(`- Tempo próprio em código nosso no passe limpo: ${idle.selfMsOurs ?? '?'} ms de ${idle.profiledMs ?? '?'} ms perfilados.`);
  if (idle.allocBytes != null) L.push(`- Alocado na cena: ${fmtMB(idle.allocBytes)}${idle.allocTop?.length ? `; quem: ${idle.allocTop.slice(0, 5).map(([k, b]) => `${fmtKB(b)} ${k}`).join('; ')}` : ''}.`);
  if (idle.workerMessages) L.push(`- Mensagens com os workers na cena: ${Object.entries(idle.workerMessages).map(([w, m]) => `${w}: ${m.to}→ (${fmtKB(m.toBytes)}) ${m.from}← (${fmtKB(m.fromBytes)})`).join(' · ') || 'nenhuma'}.`);
  if (idle.probeCalls?.length) L.push(`- Chamadas da própria sonda no início da janela, fora dos achados: ${idle.probeCalls.map(([k, c]) => `${k} ×${pt(c)}`).join('; ')}.`);
  if (idle.selfMsAll) L.push(`- Tempo próprio, tudo (top 15): ${Object.entries(idle.selfMsAll).map(([k, ms]) => `${ms} ms ${k}`).join('; ')}.`);
}

if (counters.rules.heapAfterGcMB) L.push('', '## 4. Heap após GC ao longo do roteiro (passe de contagem)', '', counters.rules.heapAfterGcMB.map((h) => `cena ${h.n}: ${h.mb ?? '?'} MB`).join(' → '));
for (const n of [7, 9]) {
  const s = counters.rules[`snapshot${n}`];
  if (!s) continue;
  L.push('', `### Instantâneos da cena ${n} (${sceneName(n)}): ${pt(s.before.nodes)} objetos / ${fmtMB(s.before.bytes)} antes → ${pt(s.after.nodes)} / ${fmtMB(s.after.bytes)} depois`, '', '| construtor | objetos a mais | bytes a mais | objetos no fim |', '|---|---:|---:|---:|');
  for (const g of s.grown.slice(0, 20)) L.push(`| ${g.name} | ${pt(g.count)} | ${fmtKB(g.size)} | ${pt(g.countAfter)} |`);
}

const dc = counters.rules.deadCode;
if (dc) {
  L.push('', '## 5. Código morto (cobertura de todo o roteiro × knip)', '', `${dc.neverCalled} de ${dc.functionsSeen} funções de \`src/\` carregadas (${dc.filesLoaded} arquivos) nunca rodaram em 9 cenas. knip: ${dc.knipUnusedFiles} arquivo(s) sem importador${dc.knipUnusedExports != null ? `, ${dc.knipUnusedExports} export(s)/membro(s) sem uso` : ' (não rodou)'}. Confirmados pelas duas fontes: **${dc.confirmed}**; arquivos sem importador e nunca carregados: **${dc.neverLoadedAndUnused}**. Lista inteira em \`codigo-morto.md\`.`, '', '| arquivo | nunca rodaram | rodaram | chars nunca rodados |', '|---|---:|---:|---:|');
  for (const f of counters.rules.deadCodeTopFiles ?? []) L.push(`| ${f.file} | ${f.dead} | ${f.live} | ${pt(f.chars)} |`);
}

if (counters.rules.messages) {
  const m = counters.rules.messages;
  L.push('', '## 6. Mensagens com os workers (passe de contagem, lado da página, todo o roteiro)', '', '| worker | criado em | para ele | bytes | dele | bytes |', '|---|---|---:|---:|---:|---:|');
  for (const [w, r] of Object.entries(m.byWorker).sort((a, b) => b[1].inBytes + b[1].outBytes - a[1].inBytes - a[1].outBytes)) L.push(`| ${w} | ${r.made && r.made !== '?' ? sources.original(...(() => { const mm = r.made.match(/^(.*):(\d+):(\d+)$/); return mm ? [mm[1], Number(mm[2]), Number(mm[3])] : [r.made, 1, 1]; })()) : '?'} | ${pt(r.out)} | ${fmtKB(r.outBytes)} | ${pt(r.in)} | ${fmtKB(r.inBytes)} |`);
  L.push(`| (portas MessagePort) | — | ${pt(m.ports.n)} | ${fmtKB(m.ports.bytes)} | | |`, '', `Mensagens ≥ ${fmtMB(v('largeMessageBytes'))}: ${m.large}.`);
}
if (traceInfo) L.push('', `Trace do passe limpo (${fmtMB(traceInfo.bytes)}, lido em fluxo): ${pt(traceInfo.events)} eventos, ${pt(traceInfo.mainEvents)} guardados da thread principal da página, ${pt(traceInfo.tasks)} tarefas de 1 ms ou mais,${pt(traceInfo.gcs)} eventos de GC; postMessage por cena: ${Object.entries(traceInfo.posts).map(([k, c]) => `${k} ${c}`).join(', ') || '—'}.`);

const guard = counters.rules.imageGuard ?? [];
if (guard.length) L.push('', '## 7. Imagens e guarda de imagem', '', 'Hash de cada imagem, referência para a próxima rodada. Os dois passes não são comparados entre si: rodam a simulação em Chromes separados, com outros veículos e pessoas.', '', guard.map((g) => `- ${g.image}: \`${g.sha1}\``).join('\n'));

L.push('', '## 8. Limites desta rodada (o que a Etapa 0 não vê, e por quê)', '');
limit('a rodada é uma: sem "antes" ao lado, nenhum tempo aqui diz melhora ou piora; a comparação com a rodada anterior é da Etapa 1');
limit('a cena 8 usa chamadas do `__roadcraft` (setQuality, setWeather, setSkyMode) onde não há gesto do jogador que a sonda reproduza sem o DOM do painel; as cenas 2, 3 e 9 pausam e soltam o jogo por setTraffic, como o botão de pausa faz');
limit('workers: só os que a página cria (os workers de workers não aparecem em `page.workers()`); os contadores dentro deles valem a partir do gancho (mensagens anteriores não contam); o heap deles vem só de measureUserAgentSpecificMemory');
limit('sem ganchos no WebGL nem nos construtores do three (Etapa 1): fora-da-camera, oculto, upload-igual, duplicado, zumbi, gancho-orfao e companhia ainda não rodam');
limit('o tempo de GPU é o do jogo (`__gpu`, EXT_disjoint_timer_query do quadro inteiro); por desenho só na Etapa 2');
for (const l of limits) L.push(`- ${l}`);

const next = join(here, 'PROXIMOS-PASSOS.md');
if (existsSync(next)) L.push('', readFileSync(next, 'utf8').trim());
L.push('', `Arquivos: \`achados.json\` (todos os achados), \`contadores.json\` (contadores por cena e por regra), \`codigo-morto.md\`, \`imagens/\` (uma ou duas por vista e passe), \`bruto/\` (cobertura, alocações, perfis .cpuprofile, trace, instantâneos, leituras).`);
writeFileSync(join(OUT, 'relatorio.md'), L.join('\n') + '\n');
console.log(`relatorio.md: ${ordered.length} achados (${[...byRule].map(([r, c]) => `${r} ${c}`).join(', ')}); limites: ${limits.length}`);
