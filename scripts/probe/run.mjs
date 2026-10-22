// THE PROBE'S PILOT (PLANO-SONDA.md §3 [B], stage 0): Playwright over the installed Chrome, one DevTools session, the fixed script of
// `plan.mjs` run twice - the COUNTING pass (coverage, allocation sampling, heap snapshots, worker hooks: what ran, allocated and was sent,
// never timed) and the CLEAN pass (CPU profile, trace, long frames, pictures: what it cost) - then `analyze.mjs` over both.
// Nothing in `src/` is touched: the page is hooked from outside (`page.mjs`), the game's own `__roadcraft` probes are read.
//
// Usage (with `npm run dev` on 5300 and the machine free):
//   node scripts/probe/run.mjs [--phase=both|counting|clean] [--out=test-results/probe/<date>] [--base=http://127.0.0.1:5300/]
//                              [--no-snapshot] [--no-trace] [--scenes=1,2,3] [--fast] [--busy-machine] [--analyze-only=<folder>]
// `--busy-machine`: runs with another process on the GPU or the CPU; the report then says every time has noise.
// `--fast`: the guard between changes, in minutes - the clean pass alone (the counting pass's precise coverage slows the page several
// times: v0's scene 4 took 110 s counting and 20 s clean), scenes 1 to 5 (opening, still, running, district, street), no trace. Same as
// `--phase=clean --scenes=1,2,3,4,5 --no-trace`. Times, long frames, the CPU profile, the pictures and the game's own counters; no coverage,
// allocations or snapshots (no dead-code, leak or large-clone).
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { CHROME_ARGS, cpuNeighbours, gpuNeighbours } from '../lib/measureCity.mjs';
import { cutAllocations, fetchSources, heapAfterGc, heapSnapshot, sceneFile, sourceUrlsOf, sourceUrlsOfProfile, startAllocations, startCoverage, startProfile, stopProfile, takeCoverage } from './collect.mjs';
import { helpers, initScript, workerHooks, workerRead } from './page.mjs';
import { SCENES } from './plan.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
const v = (k) => (typeof cfg[k] === 'object' && cfg[k] !== null && 'value' in cfg[k] ? cfg[k].value : cfg[k]);
const flag = (name) => { const f = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`)); return f === undefined ? undefined : f.includes('=') ? f.slice(f.indexOf('=') + 1) : true; };

const BASE = String(flag('base') ?? 'http://127.0.0.1:5300/');
const FAST = flag('fast') === true;
const PHASE = String(flag('phase') ?? (FAST ? 'clean' : 'both'));
const NO_SNAPSHOT = flag('no-snapshot') === true;
const NO_TRACE = FAST || flag('no-trace') === true;
/** The scenes run: all, or those of `--scenes` (scene 1, the opening, always: every other scene needs the city it opens). */
const ONLY = flag('scenes') ? new Set(['1', ...String(flag('scenes')).split(',')].map(Number)) : FAST ? new Set([1, 2, 3, 4, 5]) : null;
const RUN_SCENES = ONLY ? SCENES.filter((s) => ONLY.has(s.n)) : SCENES;
const BUSY_OK = flag('busy-machine') === true;
const ONLY_ANALYSE = flag('analyze-only');
const OUT = resolve(ONLY_ANALYSE && ONLY_ANALYSE !== true ? ONLY_ANALYSE : String(flag('out') ?? join('test-results', 'probe', new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19))));
const [WIDTH, HEIGHT] = cfg.viewport;
const failedPasses = [];
/** The camera that fits the whole city, set by scene 1 and read by every `lookAt` after it. */
const fitRef = { value: null };

if (!ONLY_ANALYSE) {
  mkdirSync(join(OUT, 'raw'), { recursive: true });
  mkdirSync(join(OUT, 'images'), { recursive: true });

  // THE MACHINE MUST BE FREE (CLAUDE.md "Measurements"): the game open in another browser took 99 % of the GPU and the same scene measured 17, 22 or 37 ms (2026-10-18).
  const gpuBusy = gpuNeighbours(), cpu = cpuNeighbours();
  const busy = { gpu: gpuBusy, cpu: cpu.busy, freeGB: Math.round((cpu.freeBytes / 2 ** 30) * 10) / 10 };
  if ((gpuBusy.length || cpu.busy.length) && !BUSY_OK) {
    console.error(`MEASUREMENT REFUSED: the machine is busy. GPU: ${gpuBusy.map((b) => `${b.name} (pid ${b.pid}) ${b.percent}%`).join(', ') || 'free'}. CPU: ${cpu.busy.map((b) => `${b.name} ${b.cores} core(s)`).join(', ') || 'free'}.`);
    console.error('Close what is yours (the game open in a browser, another Chrome, tests, builds) or run with --busy-machine (the times come out noisy, and the report says so).');
    process.exit(2);
  }
  const meta = {
    date: new Date().toISOString(), base: BASE, out: OUT, phase: PHASE, fast: FAST, scenes: RUN_SCENES.map((x) => x.n), trace: !NO_TRACE, config: cfg, busy, busyAccepted: BUSY_OK,
    node: process.version, playwright: JSON.parse(readFileSync(join(here, '..', '..', 'node_modules', '@playwright', 'test', 'package.json'), 'utf8')).version,
    commit: git('rev-parse', '--short', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), dirty: git('status', '--porcelain').split('\n').filter((l) => l && !l.startsWith('?? test-results')).length,
    chrome: null, gpu: null, passes: {},
  };
  const passes = PHASE === 'both' ? ['counting', 'clean'] : [PHASE];
  const sources = new Set();
  for (const pass of passes) {
    console.log(`\n== ${pass} pass ==`);
    const t0 = Date.now();
    try {
      meta.passes[pass] = await runPass(pass, meta, sources);
      meta.passes[pass].seconds = Math.round((Date.now() - t0) / 1000);
    } catch (err) {
      meta.passes[pass] = { error: String(err?.stack ?? err), seconds: Math.round((Date.now() - t0) / 1000) };
      failedPasses.push(pass);
      console.error(`${pass} pass FAILED: ${String(err?.message ?? err).split('\n')[0]}`);
    }
    writeFileSync(join(OUT, 'raw', 'meta.json'), JSON.stringify(meta, null, 2));
  }
  console.log(`sources: ${await fetchSources(BASE, sources, join(OUT, 'raw', 'sources.json'))} modules of src/ with a map`);
  writeFileSync(join(OUT, 'raw', 'meta.json'), JSON.stringify(meta, null, 2));
}

// THE ANALYSER, in a process of its own with room for a trace of a few hundred MB.
console.log('\n== analysis ==');
const analysed = spawnSync(process.execPath, ['--max-old-space-size=8192', join(here, 'analyze.mjs'), OUT], { stdio: 'inherit' });
if (analysed.status !== 0) { console.error(`analyze.mjs exited with ${analysed.status}`); process.exit(analysed.status ?? 1); }
console.log(`\nREPORT: ${join(OUT, 'report.md')}`);
if (failedPasses.length) { console.error(`failed pass(es): ${failedPasses.join(', ')}`); process.exit(1); }

/** One pass of the script on a fresh Chrome: `counting` counts, `clean` times. Returns what the pass wrote. */
async function runPass(pass, meta, sources) {
  const counting = pass === 'counting';
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
  const summary = { scenes: [], console: [], workers: [], trace: null, reloads: 0 };
  try {
    meta.chrome = browser.version();
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 1 });
    await page.addInitScript(initScript, { hooks: counting, largeBytes: v('largeMessageBytes') });
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') summary.console.push(`${m.type()}: ${m.text()}`.slice(0, 500)); });
    page.on('pageerror', (e) => summary.console.push(`pageerror: ${e.message}\n${e.stack ?? ''}`.slice(0, 1500)));
    page.on('dialog', (d) => { summary.console.push(`dialog (${d.type()}): ${d.message()}`); void d.dismiss().catch(() => {}); });
    let crashReject = null;
    const crashed = new Promise((_, no) => { crashReject = no; });
    crashed.catch(() => {});
    page.on('crash', () => { summary.console.push('PAGE CRASHED'); crashReject?.(new Error('the page died (the renderer process crashed)')); });
    // The workers the page makes (the simulation's, the jobs'; not the workers of workers): hooked in the counting pass, read in both.
    const workers = [];
    page.on('worker', (w) => {
      const row = { url: w.url().replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, ''), hooked: null, worker: w };
      workers.push(row);
      if (counting) w.evaluate(workerHooks).then((r) => { row.hooked = r; }, (e) => { row.hooked = `failed: ${String(e.message ?? e).split('\n')[0]}`; });
      w.on('close', () => { row.closed = true; });
    });
    const cdp = await page.context().newCDPSession(page);
    const traceFile = join(OUT, 'raw', 'clean.trace.json');
    if (!counting && !NO_TRACE) {
      await browser.startTracing(page, { path: traceFile, screenshots: false, categories: ['-*', 'devtools.timeline', 'disabled-by-default-devtools.timeline', 'toplevel', 'blink.user_timing', 'disabled-by-default-v8.gc'] });
      summary.trace = traceFile;
    }
    try {
      await page.goto(BASE, { waitUntil: 'load' });
    } catch (err) {
      throw new Error(`the game did not answer at ${BASE} (${String(err.message).split('\n')[0]}): start the server with \`npm run dev\``, { cause: err });
    }
    let loads = 0;
    page.on('load', () => { loads++; });
    await page.waitForFunction(() => window.__roadcraft?.scene?.().buildingLevels && window.__roadcraft.measure && window.__roadcraft.setTraffic, null, { timeout: 180000 });
    meta.gpu = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2');
      const info = gl?.getExtension('WEBGL_debug_renderer_info');
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl?.getParameter(gl.RENDERER) ?? 'no WebGL2');
    });
    if (/swiftshader|software|llvmpipe|basic render/i.test(meta.gpu)) throw new Error(`the page fell back to the software renderer (${meta.gpu}): nothing here counts`);
    console.log(`Chrome ${meta.chrome} · GPU ${meta.gpu}`);
    const { fit } = await page.evaluate(helpers);
    fitRef.value = fit;
    if (counting) { await startCoverage(cdp); await startAllocations(cdp, v('allocSamplingBytes')); }

    for (const scene of RUN_SCENES) {
      const wall0 = Date.now();
      const record = { n: scene.n, name: scene.name, budget: scene.budget, pass, notes: {}, shots: [], snapshots: {} };
      const ctx = {
        page, cfg, pass, sinceT: 0,
        note: (k, val) => { record.notes[k] = val; },
        settle: () => page.evaluate(({ s, m }) => window.__probe.settle(s, m), { s: v('settleStableMs'), m: v('settleMaxMs') }),
        hold: (ms = v('holdMs')) => page.waitForTimeout(ms),
        // The scene's WINDOW starts here: what came before (the view moved, the scene settling) is its PREPARATION, cut off into files of
        // its own (`-prep`), so a still scene's counts are the still seconds alone. Called once a scene at most.
        since: async () => {
          if (counting) {
            const prep = await takeCoverage(cdp);
            writeFileSync(sceneFile(OUT, scene.n, 'coverage-prep', 'json'), JSON.stringify(prep));
            for (const s of prep.ours) sources.add(s.url);
            record.allocationsPrep = await cutAllocations(cdp, sceneFile(OUT, scene.n, 'allocations-prep', 'heapprofile'), v('allocSamplingBytes'));
            for (const u of sourceUrlsOfProfile(JSON.parse(readFileSync(record.allocationsPrep.file, 'utf8')))) sources.add(u);
          } else {
            record.profilePrep = await stopProfile(cdp, sceneFile(OUT, scene.n, 'cpu-prep', 'cpuprofile'));
            for (const u of sourceUrlsOfProfile(JSON.parse(readFileSync(record.profilePrep.file, 'utf8')))) sources.add(u);
            await startProfile(cdp, v('cpuSamplingUs'));
          }
          // The game's own counters zeroed (the sun's passes, the GPU's samples) and the page's message counts kept: the window's are the difference.
          const m = await page.evaluate(() => { window.__roadcraft.scene().shadowStats(); window.__gpu(true); return { t: performance.now(), frames: window.__probeTap?.frames ?? 0, msgs: window.__probeTap?.msgs ? JSON.parse(JSON.stringify(window.__probeTap.msgs.byWorker)) : null }; });
          ctx.sinceT = m.t; ctx.sinceFrames = m.frames;
          record.windowT0 = m.t;
          record.msgsAtWindow = m.msgs;
        },
        lookAt: async (view, zoom) => {
          const z = ctx.fit.zoom * (zoom ?? cfg.views[view].zoom);
          await page.evaluate(({ x, y, z, az, el }) => window.__roadcraft.setView({ x, y, zoom: z, azimuth: az, elevation: el }), { x: ctx.fit.x, y: ctx.fit.y, z, az: (cfg.orbit.azimuthDeg * Math.PI) / 180, el: (cfg.orbit.elevationDeg * Math.PI) / 180 });
          await page.evaluate(() => window.__probe.frames(2));
        },
        /** The camera at world (x, y), `zoomMul` times the whole city's zoom, tilted `elevationDeg`, at the script's bearing. */
        view: async (x, y, zoomMul, elevationDeg) => {
          await page.evaluate(({ x, y, z, az, el }) => window.__roadcraft.setView({ x, y, zoom: z, azimuth: az, elevation: el }), { x, y, z: ctx.fit.zoom * zoomMul, az: (cfg.orbit.azimuthDeg * Math.PI) / 180, el: (elevationDeg * Math.PI) / 180 });
          await page.evaluate(() => window.__probe.frames(2));
        },
        orbit: (view, ms) => page.evaluate(({ x, y, z, el, ms }) => window.__probe.orbit(x, y, z, el, ms), { x: ctx.fit.x, y: ctx.fit.y, z: ctx.fit.zoom * cfg.views[view].zoom, el: cfg.orbit.elevationDeg, ms }),
        shot: async (name) => {
          await page.evaluate(() => window.__probe.frames(2));
          const file = join(OUT, 'images', `${pass}-scene${String(scene.n).padStart(2, '0')}-${name}.png`);
          await page.screenshot({ path: file });
          record.shots.push(file);
        },
        snapshot: async (label) => {
          if (!counting) { record.snapshots[label] = { skipped: 'clean pass: no snapshot (the forced GC would change the trace)' }; return; }
          if (NO_SNAPSHOT) { record.snapshots[label] = { skipped: '--no-snapshot', ...(await heapAfterGc(cdp)) }; return; }
          const t = Date.now();
          record.snapshots[label] = await heapSnapshot(cdp, sceneFile(OUT, scene.n, `heap-${label}`, 'heapsnapshot'), v('snapshotMaxMb') * 1e6);
          console.log(`  heap snapshot (${label}): ${record.snapshots[label].file ? `${Math.round(record.snapshots[label].bytes / 1e6)} MB in ${Math.round((Date.now() - t) / 1000)} s` : record.snapshots[label].skipped}`);
        },
      };
      // Each scene's property `fit` follows the opening's camera (scene 1 sets it).
      Object.defineProperty(ctx, 'fit', { get: () => fitRef.value, set: (f) => { fitRef.value = f; } });
      record.pageT0 = await page.evaluate((name) => window.__probe.mark(name), `probe:scene:${scene.n}:start`);
      ctx.sinceT = record.pageT0;
      ctx.sinceFrames = await page.evaluate(() => window.__probeTap?.frames ?? 0);
      if (!counting) await startProfile(cdp, v('cpuSamplingUs'));
      console.log(`scene ${scene.n} ${scene.name}`);
      let timer = null;
      await Promise.race([scene.run(ctx), crashed, new Promise((_, no) => { timer = setTimeout(() => no(new Error(`scene ${scene.n} did not finish in 15 min`)), 15 * 60 * 1000); })]).finally(() => clearTimeout(timer));
      if (loads > 0) throw new Error('the page reloaded midway (a file was saved and Vite reloaded the game): the run does not count');
      record.sinceT = ctx.sinceT;
      // THE WINDOW ENDS HERE, before any reading: the readings call the game's own code (`memory`, `budget` walk the scene), which would count
      // as work of the scene. The mark and the frame count are the probe's alone; the coverage, the allocations and the profile are cut next.
      const end = await page.evaluate((name) => ({ t: window.__probe.mark(name), frames: window.__probeTap?.frames ?? 0 }), `probe:scene:${scene.n}:end`);
      record.pageT1 = end.t;
      if (!counting) record.profile = await stopProfile(cdp, sceneFile(OUT, scene.n, 'cpu', 'cpuprofile'));
      if (counting) {
        record.coverage = await takeCoverage(cdp);
        writeFileSync(sceneFile(OUT, scene.n, 'coverage', 'json'), JSON.stringify(record.coverage));
        for (const s of record.coverage.ours) sources.add(s.url);
        const alloc = await cutAllocations(cdp, sceneFile(OUT, scene.n, 'allocations', 'heapprofile'), v('allocSamplingBytes'));
        record.allocations = alloc;
        for (const u of sourceUrlsOfProfile(JSON.parse(readFileSync(alloc.file, 'utf8')))) sources.add(u);
      }
      record.readings = await page.evaluate(({ b, s, f }) => window.__probe.readings(b, s, f), { b: scene.budget, s: ctx.sinceT, f: ctx.sinceFrames });
      record.readings.framesDrawn = end.frames - (ctx.sinceFrames ?? 0);
      record.workers = [];
      for (const w of workers) {
        if (w.closed) { record.workers.push({ url: w.url, closed: true }); continue; }
        try { record.workers.push({ url: w.url, hooked: w.hooked, ...(await Promise.race([w.worker.evaluate(workerRead), new Promise((_, no) => setTimeout(() => no(new Error('no answer in 10 s')), 10000))])) }); }
        catch (e) { record.workers.push({ url: w.url, hooked: w.hooked, error: String(e.message ?? e).split('\n')[0] }); }
      }
      if (counting) {
        record.uaMemory = await page.evaluate((ms) => window.__probe.uaMemory(ms), 25000);
        record.heapAfterGc = await heapAfterGc(cdp);
      } else {
        for (const u of sourceUrlsOfProfile(JSON.parse(readFileSync(record.profile.file, 'utf8')))) sources.add(u);
      }
      for (const e of record.readings.loaf ?? []) for (const sc of e.scripts ?? []) if (sc.sourceURL) sources.add(sc.sourceURL);
      record.wallMs = Date.now() - wall0;
      const coverageOut = record.coverage;
      delete record.coverage;
      writeFileSync(sceneFile(OUT, scene.n, pass, 'json'), JSON.stringify(record, null, 1));
      summary.scenes.push({ n: scene.n, name: scene.name, wallMs: record.wallMs, notes: record.notes, coverageScripts: coverageOut?.ours.length });
      const f = record.readings.frames;
      console.log(`  ${Math.round(record.wallMs / 1000)} s · frames drawn ${record.readings.framesDrawn} · __frames ${f?.frames ?? '?'} (p50 ${f?.total?.p50 ?? '?'} ms, long ${f?.long ?? '?'}) · GPU p50 ${record.readings.gpu?.p50 ?? '—'} ms · heap ${Math.round((record.readings.heap ?? 0) / 1e6)} MB · draw calls ${record.readings.memory?.drawCalls ?? '?'} · LoAF ${record.readings.loaf?.length ?? 0}`);
    }
    summary.workers = workers.map((w) => ({ url: w.url, hooked: w.hooked, closed: !!w.closed }));
    if (!counting && !NO_TRACE) await browser.stopTracing();
    summary.reloads = loads;
  } finally {
    await browser.close().catch(() => {});
  }
  writeFileSync(join(OUT, 'raw', `${pass}.json`), JSON.stringify(summary, null, 1));
  return summary;
}


function git(...args) {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return '?'; }
}
