import { execFile } from 'node:child_process';
// LOOK AT THE GAME AS THE PLAYER SEES IT, at full resolution, without taking anyone's window
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { _electron, chromium } from '@playwright/test';

// `node scripts/look.mjs <script.json> [out folder] [--video] [--url=http://…]`
const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [file, outArg] = args.filter((a) => !a.startsWith('--'));
if (!file) {
  console.error('usage: node scripts/look.mjs <script.json> [out folder] [--video] [--url=http://...]');
  process.exit(2);
}
let plan;
try {
  plan = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`unreadable script (${file}): ${err.message}`);
  process.exit(2);
}
if (flags.includes('--video')) plan.video = true;
const urlFlag = flags.find((f) => f.startsWith('--url='));
if (urlFlag) plan.url = urlFlag.slice('--url='.length);
const out = resolve(outArg ?? plan.out ?? join(tmpdir(), 'roadcraft-look', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(out, { recursive: true });
const [width, height] = plan.viewport ?? [1920, 1080];
/** The dev server reloads the page whenever any session saves a file (Vite) */
const ATTEMPTS = 3;
const RELOADED = 'the page reloaded midway (a file was saved and Vite reloaded the game)';

// LOOK_JS_FLAGS: V8 flags for the run's Chrome, as the desktop build passes them (`desktop/main.cjs` js-flags): the dev run measured as the product runs.
const jsFlags = process.env.LOOK_JS_FLAGS ? [`--js-flags=${process.env.LOOK_JS_FLAGS}`] : [];
/** `--electron`: the desktop build as the player runs it (`desktop/main.cjs`, the game from `dist/`: build it first, `--mode development` for the probes the steps call), its window hidden at 1920x1080 (`ROADCRAFT_LOOK`), no Steam. */
const electron = flags.includes('--electron');
const browser = electron ? await desktopBrowser() : await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', ...jsFlags] });

/** The desktop app as a browser of one page (Playwright `_electron`): its window the page; closing it ends the app. */
async function desktopBrowser() {
  const app = await _electron.launch({ args: [join(resolve('.'), 'desktop', 'main.cjs')], env: { ...process.env, ROADCRAFT_LOOK: '1', ROADCRAFT_NO_STEAM: '1' } });
  // The shell's own lines (each process's memory, `main.cjs` LOOK), as they come.
  app.process().stdout?.on('data', (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line.startsWith('[metrics]')) console.log(`${new Date().toISOString().slice(11, 19)} ${line} MB`); });
  const window = await app.firstWindow();
  window.desktop = true;
  // A dialog of the page's (an alert, a confirm): said, then dismissed, never left open under the run.
  window.on('dialog', (dialog) => { console.log(`dialog (${dialog.type()}): ${dialog.message()}`); void dialog.dismiss().catch(() => {}); });
  return { newPage: async () => window, close: () => app.close(), startTracing: () => Promise.reject(new Error('no trace in --electron')), stopTracing: () => Promise.resolve() };
}
let report;
try {
  for (let attempt = 1; ; attempt++) {
    report = { out, renderer: '', console: [], steps: [] };
    try {
      await runOnce(report);
      break;
    } catch (err) {
      if (!String(err.message).includes(RELOADED) || attempt >= ATTEMPTS) throw err;
      console.log(`${RELOADED}: attempt ${attempt + 1} of ${ATTEMPTS}`);
    }
  }
} finally {
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`report: ${join(out, 'report.json')}${report.console.length ? ` (${report.console.length} errors/warnings in the console)` : ''}`);

/** One run of the steps on a fresh page; throws `RELOADED` if the page reloads under it. */
async function runOnce(report) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: plan.dpr ?? 1 });
  // A slower computer: the page's CPU N times slower (DevTools protocol `Emulation.setCPUThrottlingRate`, rate 1 = none).
  if (plan.cpu && plan.cpu > 1) {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: plan.cpu });
    console.log(`CPU ${plan.cpu}x slower (emulated)`);
  }
  try {
    await steps(page, report);
  } catch (err) {
    // A reload mid-call surfaces as "Execution context was destroyed" or a missing `__roadcraft`.
    if (page.reloads) throw new Error(`${RELOADED} (${String(err.message).split('\n')[0]})`, { cause: err });
    throw err;
  } finally {
    if (!page.desktop) await page.close();
  }
}

async function steps(page, report) {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(`${m.type()}: ${m.text()}`); });
  // With its stack: the message alone does not say which code threw.
  page.on('pageerror', (e) => report.console.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
  // A confirm or alert of the game's answered as the player would (`plan.dialogs`: "accept", or dismissed), and said.
  if (!page.desktop) page.on('dialog', (d) => { console.log(`dialog (${d.type()}): ${d.message()}`); void (plan.dialogs === 'accept' ? d.accept() : d.dismiss()).catch(() => {}); });
  // A file the game offers (a saved map) kept in the run's folder, its path said.
  page.on('download', (d) => { const path = join(out, d.suggestedFilename()); void d.saveAs(path).then(() => console.log(`download: ${path}`)); });
  // The file the next file picker gets ("file" step), as the player picks one.
  page.on('filechooser', (chooser) => { if (page.nextFile) void chooser.setFiles(page.nextFile); page.nextFile = null; });
  const url = plan.url ?? 'http://127.0.0.1:5300/';
  try {
    // The desktop's window opens its own game (`app://roadcraft/`).
    if (page.desktop) await page.waitForLoadState('load');
    else await page.goto(url, { waitUntil: 'load' });
  } catch (err) {
    throw new Error(`the game did not answer at ${url} (${err.message.split('\n')[0]}): start the server with \`npm run dev\``, { cause: err });
  }
  page.reloads = 0;
  page.on('load', () => { page.reloads++; });
  // DO NOT wait on a page that is gone: Playwright's awaits hang, and the run looked like a stall (k20g/i/j/m: the renderer's out-of-memory dump, 0xE0000008, seconds after the last picture). Said and ended.
  page.on('crash', () => { console.log('PAGE CRASHED (the renderer process died: Crashpad in the profile says why)'); report.console.push('PAGE CRASHED'); process.exitCode = 4; void browser.close().finally(() => process.exit(4)); });
  const stillThere = () => { if (page.reloads) throw new Error(RELOADED); };

  report.renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl?.getParameter(gl.RENDERER) ?? 'no WebGL2');
  });
  console.log(`GPU: ${report.renderer}`);
  if (/swiftshader|software|llvmpipe|basic render/i.test(report.renderer)) throw new Error(`software renderer (${report.renderer}): shots and times do not count`);

  await page.waitForFunction(() => Boolean(window.__roadcraft?.memory), null, { timeout: 120_000 });
  // Every long frame from now on, kept in the page for "profileEnd".
  await page.evaluate(() => {
    window.__longFrames = [];
    if (!PerformanceObserver.supportedEntryTypes.includes('long-animation-frame')) return;
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longFrames.push(e.toJSON()); })
      .observe({ type: 'long-animation-frame', buffered: true });
  });
  /** A city generated, and the seconds until it stands. */
  const city = async (options) => {
    const t0 = Date.now();
    // An earlier opening's mark is not this city's.
    await page.evaluate((o) => { performance.clearMarks('opening:shown'); window.__roadcraft.generateCity(o === true ? {} : o); }, options);
    // `?.`: a reload in the wait leaves the page without `__roadcraft` for a moment.
    // Shown: the opening's own mark (`renderer.ts` reveal), read for nothing; the draw calls only every 10th look (`memory` walks the whole scene: 9 s of an opening's page, 2026-10-16), for a town shown without the mark.
    await page.waitForFunction(() => {
      const game = window.__roadcraft;
      if (!game) return false;
      if (performance.getEntriesByName('opening:shown').length > 0) return true;
      window.__lookPolls = (window.__lookPolls ?? 0) + 1;
      return window.__lookPolls % 10 === 0 && game.memory().drawCalls > 100;
    }, null, { timeout: 1_800_000, polling: 1000 });
    stillThere();
    const value = { seconds: (Date.now() - t0) / 1000 };
    console.log(`city ready in ${value.seconds.toFixed(1)} s`);
    return value;
  };
  if (plan.city) await city(plan.city);
  /** The DevTools protocol session, made on the first "profile". */
  let cdp = null;
  let profiling = null;

  /** The frames being timed ("record"), the screencast filming them (`plan.video`) and the allocations sampled. */
  let recording = null;
  let sampling = null;
  let tracing = false;
  const session = async () => (cdp ??= await page.context().newCDPSession(page));

  /** Two drawn frames, so a picture shows what the last step did. */
  const frames = (n = 2) => page.evaluate((count) => new Promise((done) => {
    window.__roadcraft.redraw();
    let left = count;
    const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

  // A STEP THAT NEVER ENDS (the page stuck or gone): after LOOK_STALL_MS (60 s by default) with no step ended, 5 s of the page's CPU profile taken on a session of its own, its heap, and the run ended - the stall is the defect, never waited out.
  const stall = { at: Date.now(), i: -1, step: '' };
  const stallMs = Number(process.env.LOOK_STALL_MS ?? 60_000);
  const watchdog = setInterval(async () => {
    if (Date.now() - stall.at < stallMs) return;
    clearInterval(watchdog);
    console.log(`STALLED at step ${stall.i} (${stall.step}) for ${Math.round((Date.now() - stall.at) / 1000)} s`);
    // Which of Chrome's processes is working (the page's renderer, the GPU's): CPU seconds of each, twice 5 s apart (Windows), every call bounded.
    const cpu = () => new Promise((done) => execFile('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'headless' } | ForEach-Object { $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $matches[1] } else { 'browser' }; '{0} {1} {2:N1}' -f $_.ProcessId, $t, (((Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).TotalProcessorTime.TotalSeconds)) }"], { timeout: 20_000 }, (_, text) => done(String(text ?? '').trim())));
    try { console.log(`  chrome CPU s (pid type cpu):
${(await cpu()).replace(/^/gm, '    ')}`); await new Promise((r) => setTimeout(r, 5000)); console.log(`  5 s later:
${(await cpu()).replace(/^/gm, '    ')}`); } catch (error) { console.log(`  no CPU: ${String(error)}`); }
    const bounded = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`no answer in ${ms} ms`)), ms))]);
    // A profile already running when the page stopped (a "profile" step before the stall): its samples up to the stall, the stall's own frames among them.
    if (profiling && cdp) {
      try { const { profile } = await bounded(cdp.send('Profiler.stop'), 30_000); writeFileSync(join(out, `stalled-${profiling.name}.cpuprofile`), JSON.stringify(profile)); console.log(`  running profile kept: stalled-${profiling.name}.cpuprofile`); profiling = null; }
      catch (error) { console.log(`  running profile not stopped: ${String(error)}`); }
    }
    try {
      const probe = await bounded(page.context().newCDPSession(page), 10_000);
      const heap = await Promise.race([probe.send('Runtime.getHeapUsage'), new Promise((r) => setTimeout(() => r(null), 5000))]);
      console.log(`  page heap: ${heap ? `${Math.round(heap.usedSize / 1e6)} MB used of ${Math.round(heap.totalSize / 1e6)} MB` : 'no answer'}`);
      await bounded(probe.send('Profiler.enable'), 10_000);
      await bounded(probe.send('Profiler.setSamplingInterval', { interval: 1000 }), 10_000);
      await bounded(probe.send('Profiler.start'), 10_000);
      await new Promise((r) => setTimeout(r, 5000));
      const { profile } = await Promise.race([probe.send('Profiler.stop'), new Promise((_, no) => setTimeout(() => no(new Error('no profile in 30 s')), 30_000))]);
      writeFileSync(join(out, 'stalled.cpuprofile'), JSON.stringify(profile));
      console.log(`  profile: ${join(out, 'stalled.cpuprofile')}`);
    } catch (error) { console.log(`  no profile: ${String(error)}`); }
    // DO NOT leave the headless Chrome behind (CLAUDE.md): closed, or its processes killed.
    try { await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 15_000))]); } catch { /* closed by the kill below */ }
    execFile('powershell', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\" | Where-Object { $_.CommandLine -match 'headless' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"], () => process.exit(3));
  }, 5000);
  watchdog.unref?.();
  for (const [i, step] of plan.steps.entries()) {
    const line = { i, step: Object.keys(step)[0] };
    stall.at = Date.now(); stall.i = i; stall.step = JSON.stringify(step).slice(0, 80);
    if (process.env.LOOK_STEPS) console.log(`step ${i}: ${JSON.stringify(step).slice(0, 120)}`);
    if (step.lookAt) await page.evaluate(([x, y, zoom]) => window.__roadcraft.lookAt(x, y, zoom), step.lookAt);
    // An exact view: centre, zoom, bearing and tilt in degrees.
    else if (step.setView) await page.evaluate(([x, y, zoom, azimuth, elevation]) => window.__roadcraft.setView({ x, y, zoom, azimuth: (azimuth * Math.PI) / 180, elevation: (elevation * Math.PI) / 180 }), step.setView);
    else if (step.record) {
      if (recording) throw new Error('"record" while another is open');
      recording = { name: step.record, since: await page.evaluate(startFrames), film: plan.video ? await film(await session(), width, height) : null };
    } else if (step.recordEnd) {
      if (!recording) throw new Error('"recordEnd" with no "record" before it');
      const times = await page.evaluate(stopFrames);
      line.value = { name: recording.name, ...frameStats(times), game: await page.evaluate((since) => window.__frames(since), recording.since), gpu: await page.evaluate(() => window.__gpu(true)) };
      if (recording.film) line.value.video = await recording.film.stop(join(out, `${String(i).padStart(2, '0')}-${recording.name}.webm`));
      console.log(`frames "${recording.name}": ${line.value.frames} in ${line.value.seconds} s, p50 ${line.value.p50} p95 ${line.value.p95} p99 ${line.value.p99} max ${line.value.max} ms, ${line.value.hitches} over 25 ms, ${line.value.dropped} vsyncs missed; GPU p95 ${line.value.gpu.p95 ?? '—'} ms${line.value.video ? `; video ${line.value.video}` : ''}`);
      recording = null;
    } else if (step.allocations) {
      const c = await session();
      await c.send('HeapProfiler.enable');
      // The objects already collected kept in the profile (what was allocated), or with `live` only what survived (CDP HeapProfiler.startSampling).
      const collected = !step.live;
      await c.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: collected, includeObjectsCollectedByMinorGC: collected });
      sampling = { name: step.allocations, t0: Date.now() };
    } else if (step.allocationsEnd) {
      if (!sampling) throw new Error('"allocationsEnd" with no "allocations" before it');
      const { profile } = await cdp.send('HeapProfiler.stopSampling');
      line.value = { name: sampling.name, ...allocationStats(profile, (Date.now() - sampling.t0) / 1000) };
      console.log(`allocations "${sampling.name}": ${line.value.mbPerSecond} MB/s over ${line.value.seconds} s\n  ${line.value.top.map(([k, mb]) => `${mb} MB  ${k}`).join('\n  ')}`);
      console.log(`  by the game's frames:\n  ${line.value.stacks.map(([k, mb]) => `${mb} MB  ${k}`).join('\n  ')}`);
      console.log(`  by the game's files:\n  ${line.value.files.map(([k, mb]) => `${mb} MB  ${k}`).join('\n  ')}`);
      sampling = null;
    } else if (step.trace) {
      // The Performance panel's trace (open the file in DevTools > Performance).
      await browser.startTracing(page, { path: join(out, `${String(i).padStart(2, '0')}-${step.trace}.trace.json`), screenshots: true });
      tracing = true;
      line.file = step.trace;
    } else if (step.traceEnd) {
      if (!tracing) throw new Error('"traceEnd" with no "trace" before it');
      await browser.stopTracing();
      tracing = false;
    } else if (step.until) {
      // Seconds until a condition holds in the page (the game's own state, not a guess at a wait).
      const t0 = Date.now();
      await page.waitForFunction(step.until, null, { timeout: step.timeout ?? 600_000, polling: step.polling ?? 'raf' });
      line.value = { name: step.name ?? step.until, seconds: (Date.now() - t0) / 1000 };
      console.log(`until "${line.value.name}": ${line.value.seconds.toFixed(2)} s`);
    } else if (step.reload) {
      // The saved map opened again: the page reloaded on purpose, timed until `step.reload` holds.
      const t0 = Date.now();
      await page.reload({ waitUntil: 'load' });
      page.reloads = 0;
      cdp = null;
      await page.waitForFunction(step.reload, null, { timeout: step.timeout ?? 600_000, polling: 250 });
      line.value = { seconds: (Date.now() - t0) / 1000 };
      console.log(`reopened in ${line.value.seconds.toFixed(1)} s`);
    } else if (step.gc) {
      const c = await session();
      await c.send('HeapProfiler.collectGarbage');
    } else if (step.snapshot) {
      // The page's heap written whole (DevTools > Memory reads it), streamed in chunks (CDP HeapProfiler.takeHeapSnapshot).
      const c = await session();
      const file = join(out, `${String(i).padStart(2, '0')}-${step.snapshot}.heapsnapshot`);
      const stream = createWriteStream(file);
      const write = ({ chunk }) => { stream.write(chunk); };
      c.on('HeapProfiler.addHeapSnapshotChunk', write);
      await c.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false });
      c.off('HeapProfiler.addHeapSnapshotChunk', write);
      await new Promise((done) => stream.end(done));
      line.file = file;
      console.log(`snapshot: ${file}`);
    }
    else if (step.wait !== undefined) await page.waitForTimeout(step.wait);
    else if (step.frames !== undefined) await frames(step.frames);
    else if (step.drag) {
      const [[x0, y0], [x1, y1]] = step.drag;
      for (const k of step.keys ?? []) await page.keyboard.down(k);
      await page.mouse.move(x0, y0);
      await page.mouse.down({ button: step.button ?? 'left' });
      if (step.ms) {
        // A hand's pace: the moves spread over `ms` of real time (a mouse reports every few ms), not dispatched at once
        const n = step.steps ?? 30;
        const t0 = Date.now();
        for (let k = 1; k <= n; k++) {
          await page.mouse.move(x0 + ((x1 - x0) * k) / n, y0 + ((y1 - y0) * k) / n);
          const due = t0 + (step.ms * k) / n - Date.now();
          if (due > 0) await page.waitForTimeout(due);
        }
      } else await page.mouse.move(x1, y1, { steps: step.steps ?? 30 });
      // Held still before letting go: no fling.
      if (step.hold) await page.waitForTimeout(step.hold);
      await page.mouse.up({ button: step.button ?? 'left' });
      for (const k of step.keys ?? []) await page.keyboard.up(k);
    } else if (step.wheel) {
      if (step.at) await page.mouse.move(step.at[0], step.at[1]);
      // `count` notches spread over `ms` of real time, as a hand turns the wheel.
      const n = step.count ?? 1;
      const t0 = Date.now();
      for (let k = 1; k <= n; k++) {
        await page.mouse.wheel(step.wheel[0], step.wheel[1]);
        const due = t0 + ((step.ms ?? 0) * k) / n - Date.now();
        if (due > 0) await page.waitForTimeout(due);
      }
    } else if (step.move) await page.mouse.move(step.move[0], step.move[1], { steps: step.steps ?? 1 });
    else if (step.click) await page.mouse.click(step.click[0], step.click[1], { button: step.button ?? 'left', clickCount: step.count ?? 1 });
    // A control found by what it says (its label, its tooltip or its text, the last match if several), clicked with the mouse where it stands.
    else if (step.press) {
      const at = await page.evaluate((name) => {
        const said = (b) => [b.getAttribute('aria-label'), b.title, b.textContent].map((s) => (s ?? '').trim());
        const seen = [...document.querySelectorAll('button, [role=button], [role=switch], summary, label')].filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden' && said(b).some((s) => s === name || s.startsWith(name));
        });
        const exact = seen.filter((b) => said(b).some((s) => s === name));
        const b = (exact.length ? exact : seen).at(-1);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      }, step.press);
      if (!at) throw new Error(`no control says "${step.press}"`);
      await page.mouse.click(at[0], at[1], { button: step.button ?? 'left' });
    }
    else if (step.key) await page.keyboard.press(step.key);
    // A key held down for `ms` (WASD panning, a held modifier), as a hand holds it.
    else if (step.hold) {
      await page.keyboard.down(step.hold);
      await page.waitForTimeout(step.ms ?? 1000);
      await page.keyboard.up(step.hold);
    }
    else if (step.type !== undefined) await page.keyboard.type(step.type);
    else if (step.file) page.nextFile = resolve(step.file.replace('<out>', out));
    else if (step.eval) line.value = await page.evaluate(step.eval);
    else if (step.evalFile) {
      line.value = await page.evaluate(readFileSync(step.evalFile, 'utf8'));
      console.log(`${step.evalFile}:\n  ${[].concat(line.value).join('\n  ')}`);
    }
    else if (step.shot) {
      await frames();
      const path = join(out, `${String(i).padStart(2, '0')}-${step.shot}.png`);
      const [x, y, w, h] = step.clip ?? [];
      await page.screenshot({ path, ...(step.clip ? { clip: { x, y, width: w, height: h } } : {}) });
      line.file = path;
      console.log(`shot: ${path}`);
    } else if (step.budget) {
      await frames(30);
      line.value = await page.evaluate((view) => window.__roadcraft.budget(view).map((r) => `${r.status} | ${r.item} | ${r.measured} | ${r.budget}${r.times ? ` | ${r.times}×` : ''}`), step.budget);
      console.log(`budget (${step.budget}):\n  ${line.value.join('\n  ')}`);
    } else if (step.city) line.value = await city(step.city);
    else if (step.memory) {
      line.value = await page.evaluate(() => {
        const r = window.__roadcraft.memory();
        const d = window.__roadcraft.doc;
        return { buildings: d.buildings.size, segments: d.segments.size, lots: d.lots.length, heapMB: r.heapMB, geometryMB: r.geometryMB, geometryCpuMB: r.geometryCpuMB, textureMB: r.textureMB, targetMB: r.targetMB, buildingDetailMB: r.buildingDetailMB, drawCalls: r.drawCalls, triangles: r.triangles, programs: r.programs, cpuByName: r.cpuByName.slice(0, 8) };
      });
      // The heap exact after a collection (CDP Runtime.getHeapUsage), not `performance.memory`'s rounded figure.
      if (step.memory === 'exact') {
        const c = await session();
        await c.send('HeapProfiler.collectGarbage');
        const { usedSize } = await c.send('Runtime.getHeapUsage');
        line.value.heapMB = Math.round(usedSize / 1e5) / 10;
        line.value.heapKBPerBuilding = line.value.buildings ? Math.round(usedSize / 1e3 / line.value.buildings) : null;
      }
      console.log(`memory: ${JSON.stringify(line.value)}`);
    } else if (step.profile) {
      cdp ??= await page.context().newCDPSession(page);
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
      profiling = { name: step.profile, since: await page.evaluate(() => performance.now()) };
    } else if (step.profileEnd) {
      if (!profiling) throw new Error('"profileEnd" with no "profile" before it');
      const { profile } = await cdp.send('Profiler.stop');
      const path = join(out, `${String(i).padStart(2, '0')}-${profiling.name}.cpuprofile`);
      writeFileSync(path, JSON.stringify(profile));
      const frames = await page.evaluate((since) => window.__longFrames.filter((f) => f.startTime >= since), profiling.since);
      line.value = { name: profiling.name, cpuprofile: path, ...summarise(profile, frames) };
      console.log(report1(line.value));
      profiling = null;
    } else throw new Error(`unknown step: ${JSON.stringify(step)}`);
    stillThere();
    report.steps.push(line);
  }
  clearInterval(watchdog);
}

/** In the page: every animation frame's time kept from now (the game draws on demand; a late frame is a late callback). */
function startFrames() {
  const rec = { times: [], on: true };
  window.__frameRecord = rec;
  const tick = (t) => { if (!rec.on) return; rec.times.push(t); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return performance.now();
}
function stopFrames() {
  const rec = window.__frameRecord;
  rec.on = false;
  return rec.times;
}

/** The frames' intervals in ms: percentiles, the ones a player sees as a hitch and the vsyncs missed.
 *  The display's period is read off the intervals, not taken as 60 Hz (a 120 or 144 Hz display counted at 60 Hz hid half its missed vsyncs:
 *  report AST-15): the 10th percentile, since no frame comes faster than the display (DO NOT take the median: a game held at 30 fps on a 60 Hz
 *  display would read 33 ms and miss nothing). 60 Hz when that is no display's period (under 240 Hz or over 30 Hz). */
function frameStats(times) {
  const gaps = times.slice(1).map((t, k) => t - times[k]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const fast = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
  const VSYNC = fast >= 1000 / 240 && fast <= 1000 / 30 ? fast : 1000 / 60;
  const at = (q) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] * 10) / 10 : null);
  return {
    frames: gaps.length, seconds: times.length > 1 ? Math.round(times.at(-1) - times[0]) / 1000 : 0,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length ? Math.round(sorted.at(-1)) : null,
    hitches: gaps.filter((g) => g > 25).length,
    dropped: gaps.reduce((a, g) => a + Math.max(0, Math.round(g / VSYNC) - 1), 0),
    vsyncMs: Math.round(VSYNC * 100) / 100,
    worst: [...gaps.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, g]) => [Math.round(times[k] - times[0]), Math.round(g)]),
  };
}

/** The page filmed frame by frame (CDP Page.startScreencast); `stop` writes a 60 fps WebM, each slot showing the frame then on screen. */
async function film(cdp, width, height) {
  const shots = [];
  const take = ({ data, metadata, sessionId }) => {
    shots.push({ data, t: metadata.timestamp });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  };
  cdp.on('Page.screencastFrame', take);
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return {
    async stop(path) {
      await cdp.send('Page.stopScreencast');
      cdp.off('Page.screencastFrame', take);
      if (shots.length < 2) return null;
      const ffmpeg = playwrightFfmpeg();
      if (!ffmpeg) return `no ffmpeg (npx playwright install ffmpeg): ${shots.length} frames not written`;
      // Playwright's own ffmpeg build: JPEG in through a pipe, VP9 in WebM out.
      const enc = spawn(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '60', '-i', 'pipe:0',
        '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-row-mt', '1', '-b:v', '0', '-crf', '30', '-pix_fmt', 'yuv420p', path], { stdio: ['pipe', 'ignore', 'inherit'] });
      const done = new Promise((ok, fail) => { enc.on('exit', (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited ${code}`)))); enc.on('error', fail); });
      const t0 = shots[0].t, t1 = shots.at(-1).t;
      let k = 0;
      for (let slot = 0; t0 + slot / 60 <= t1; slot++) {
        while (k + 1 < shots.length && shots[k + 1].t <= t0 + slot / 60) k++;
        if (!enc.stdin.write(Buffer.from(shots[k].data, 'base64'))) await new Promise((ok) => enc.stdin.once('drain', ok));
      }
      enc.stdin.end();
      await done;
      return path;
    },
  };
}

/** The ffmpeg Playwright installs (`ms-playwright/ffmpeg-*`), or null. */
function playwrightFfmpeg() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? (process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'ms-playwright') : join(homedir(), '.cache', 'ms-playwright'));
  if (!existsSync(root)) return null;
  const dir = readdirSync(root).filter((n) => n.startsWith('ffmpeg-')).sort().at(-1);
  if (!dir) return null;
  const exe = readdirSync(join(root, dir)).find((n) => n.startsWith('ffmpeg'));
  return exe ? join(root, dir, exe) : null;
}

/** A sampled allocation profile summed: MB allocated a second and the functions that allocated most (self, MB). */
function allocationStats(profile, seconds) {
  const self = new Map();
  const stacks = new Map();
  const files = new Map();
  let bytes = 0;
  // Also by the nearest three of the game's own frames (`src/`): which part of the game holds it, not only who allocated.
  const walk = (node, ours) => {
    bytes += node.selfSize;
    const k = where(node.callFrame.functionName, node.callFrame.url, node.callFrame.lineNumber);
    self.set(k, (self.get(k) ?? 0) + node.selfSize);
    const mine = String(node.callFrame.url).includes('/src/') ? [...ours, k.replace(' @ src/', '@')].slice(-3) : ours;
    if (node.selfSize) { const key = mine.join(' < ') || '(none of ours)'; stacks.set(key, (stacks.get(key) ?? 0) + node.selfSize); }
    if (node.selfSize) { const file = (mine[mine.length - 1] ?? '(none of ours)').replace(/^[^@]*@/, '').replace(/:\d+$/, ''); files.set(file, (files.get(file) ?? 0) + node.selfSize); }
    for (const c of node.children ?? []) walk(c, mine);
  };
  walk(profile.head, []);
  return {
    seconds: Math.round(seconds * 10) / 10, mb: Math.round(bytes / 1e5) / 10, mbPerSecond: Math.round(bytes / 1e5 / seconds) / 10,
    top: [...self].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([k, b]) => [k, Math.round(b / 1e5) / 10]),
    stacks: [...stacks].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, b]) => [k, Math.round(b / 1e5) / 10]),
    files: [...files].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, b]) => [k, Math.round(b / 1e5) / 10]),
  };
}

/** A script's place, short: the function, the file under `src/` (no origin, no Vite query) and the line. */
// A declaration, not a `const`: the steps above run
function where(fn, url, line) {
  const file = String(url ?? '').replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '') || '(native)';
  return `${fn || '(anonymous)'} @ ${file}${line >= 0 ? `:${line + 1}` : ''}`;
}

/** What a profile and the long frames say, in milliseconds: each function's own time */
function summarise(profile, frames) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(), total = new Map();
  const keyOf = (n) => where(n.callFrame.functionName, n.callFrame.url, n.callFrame.lineNumber);
  let ms = 0;
  for (let s = 0; s < profile.samples.length; s++) {
    const dt = (profile.timeDeltas[s] ?? 0) / 1000;
    ms += dt;
    let id = profile.samples[s];
    const top = byId.get(id);
    if (!top) continue;
    const k = keyOf(top);
    self.set(k, (self.get(k) ?? 0) + dt);
    const seen = new Set();
    while (id !== undefined) {
      const n = byId.get(id);
      const key = keyOf(n);
      if (!seen.has(key)) { seen.add(key); total.set(key, (total.get(key) ?? 0) + dt); }
      id = parent.get(id);
    }
  }
  const idle = /^\((idle|program|garbage collector|root)\)/;
  const rank = (m) => [...m].filter(([k]) => !idle.test(k)).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => [k, Math.round(v)]);
  const gc = [...self].filter(([k]) => k.startsWith('(garbage collector)')).reduce((a, [, v]) => a + v, 0);
  const held = new Map();
  for (const f of frames) for (const sc of f.scripts ?? []) {
    const k = where(sc.sourceFunctionName, sc.sourceURL, -1) + (sc.invoker ? ` ← ${sc.invoker}` : '');
    const was = held.get(k) ?? { ms: 0, count: 0, worst: 0 };
    held.set(k, { ms: was.ms + sc.duration, count: was.count + 1, worst: Math.max(was.worst, sc.duration) });
  }
  return {
    profiledMs: Math.round(ms), garbageMs: Math.round(gc),
    longFrames: frames.length,
    longFramesMs: Math.round(frames.reduce((a, f) => a + f.duration, 0)),
    worstFrameMs: Math.round(frames.reduce((a, f) => Math.max(a, f.duration), 0)),
    blockingMs: Math.round(frames.reduce((a, f) => a + (f.blockingDuration ?? 0), 0)),
    heldBy: [...held].sort((a, b) => b[1].ms - a[1].ms).slice(0, 15).map(([k, v]) => [k, Math.round(v.ms), v.count, Math.round(v.worst)]),
    selfMs: rank(self), totalMs: rank(total),
  };
}

/** The summary as lines for the console. */
function report1(v) {
  return [
    `profile "${v.name}": ${v.profiledMs} ms measured, garbage collection ${v.garbageMs} ms; ${v.longFrames} frames > 50 ms (${v.longFramesMs} ms, worst ${v.worstFrameMs} ms, blocking ${v.blockingMs} ms)`,
    '  long frames, by function (ms, times, worst):', ...v.heldBy.map(([k, ms, n, w]) => `    ${ms} ms  ×${n}  worst ${w}  ${k}`),
    '  self time (ms):', ...v.selfMs.slice(0, 15).map(([k, ms]) => `    ${ms}  ${k}`),
    '  total time, with callees (ms):', ...v.totalMs.slice(0, 15).map(([k, ms]) => `    ${ms}  ${k}`),
    `  profile: ${v.cpuprofile}`,
  ].join('\n');
}
