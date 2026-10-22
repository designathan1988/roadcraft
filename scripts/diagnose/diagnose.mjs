// THE GAME DIAGNOSED AS THE PLAYER PLAYS IT, in one command: a new city created from a seed never made before (no shipped city, no kept
// one), the views a player looks at, a flight across the city, the map saved and opened again - each timed on the real GPU, every long
// frame and every wait for the GPU traced to the game's own line (`src/...:line`), the memory read after each, the picture measured against a
// supersampled reference, and the code's known costly patterns listed. One report, ranked by what the player pays.
//
//   npm run diagnose -- [--size small|large|25k|70k|200k] [--seed N] [--rebuild] [--no-quality] [--no-reopen] [--approve]
//                      [--shared-gpu] [--shared-machine]
//
// Its own build (`.cache/diagnose-dist`, `--mode probe`) on its own port (5302): another session saving files never reloads it.
// DO NOT measure a city that came from a file (cooked/cities, IndexedDB): the player creating a city pays its generation, and so does this.
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { CHROME_ARGS, cpuNeighbours, gpuNeighbours } from '../lib/measureCity.mjs';
import { DIST, PORT, ROOT, ensureBuild, startServer } from './server.mjs';
import { instrument } from './instrument.mjs';
import { sourceMapper } from './sources.mjs';
import { comparePictures } from './quality.mjs';
import { staticFindings } from './staticRules.mjs';
import { writeReport } from './report.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : fallback; };

/** The sizes a player can ask for, as the game makes them (`main.ts` generateCity; radii from `largeCity.ts`'s scale steps), and how long each may take to stand before the run says it did not. */
const SIZES = {
  small: { ask: { size: 'small' }, limitS: 120 },
  large: { ask: { size: 'large' }, limitS: 180 },
  '25k': { ask: { size: 'large', radiusMetres: 2800 }, limitS: 300 },
  '70k': { ask: { size: 'large', radiusMetres: 4700 }, limitS: 600 },
  '200k': { ask: { size: 'large', radiusMetres: 8850 }, limitS: 1500 },
};
const sizeName = value('--size', 'large');
const size = SIZES[sizeName];
if (!size) { console.error(`--size must be one of ${Object.keys(SIZES).join(', ')}`); process.exit(2); }
// A seed never shipped: the shipped cities are seed 7 (`cookedCities.ts`), opened from a file instead of made.
const seed = Number(value('--seed', String(1000 + Math.floor(Math.random() * 1e6))));
if (seed === 7 && size.ask.radiusMetres === undefined) console.warn('WARNING: seed 7 opens the shipped city (made at build time), not one made in front of the player');

/** The views a player looks at, as the project's scale plans set them (`scripts/look/step-*.json`): x/y offsets from the city's centre in world units, zoom, bearing and tilt in degrees. */
const VIEWS = [
  { name: 'map', zoom: 0.12, az: 45, el: 48 },
  { name: 'district', zoom: 2.5, az: 45, el: 48 },
  { name: 'street', zoom: 5, az: 20, el: 35 },
];
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = join(ROOT, 'lab-reports', 'diagnose', `${stamp}-${sizeName}`);
mkdirSync(out, { recursive: true });
const t0 = Date.now();
const log = (line) => console.log(`${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${line}`);

// ONE TIMED RUN AT A TIME ON THIS MACHINE, shared with `scripts/look.mjs` (its lock file): two cities at once make each other's times worthless.
const lockFile = join(tmpdir(), 'roadcraft-look.lock');
for (let said = false; ;) {
  try { writeFileSync(lockFile, String(process.pid), { flag: 'wx' }); break; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  let holder;
  try { holder = Number(readFileSync(lockFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; continue; }
  let alive = false;
  try { process.kill(holder, 0); alive = true; } catch (error) { if (error.code === 'EPERM') alive = true; else if (error.code !== 'ESRCH') throw error; }
  if (!alive) { try { rmSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') throw error; } continue; }
  if (!said) { log(`waiting for the timed run of pid ${holder} to end`); said = true; }
  await new Promise((r) => setTimeout(r, 1000));
}
process.on('exit', () => { try { if (readFileSync(lockFile, 'utf8') === String(process.pid)) rmSync(lockFile); } catch (error) { if (error.code !== 'ENOENT') console.warn(`lock not released: ${error.message}`); } });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));

const report = { size: sizeName, seed, startedAt: new Date().toISOString(), phases: {}, views: {}, errors: [], notCovered: [] };
/** The first page's records, read just before the reload that opens the save again (the reload throws them away). */
let firstPage = null;
const records = () => page.evaluate(() => ({ longFrames: window.__diag.longFrames, sync: window.__diag.sync, gpuWork: window.__diag.gpuWork }));

const buildSeconds = await ensureBuild({ force: has('--rebuild') });
report.buildSeconds = buildSeconds;
log(buildSeconds ? `game built for the diagnosis in ${buildSeconds.toFixed(0)} s` : 'game build up to date');
const server = await startServer();
const sources = sourceMapper(DIST, ROOT);

// The machine free: another process on the GPU or the CPU changes every time measured (`scripts/lib/measureCity.mjs`).
const gpuBusy = gpuNeighbours();
const machine = cpuNeighbours(0.5, { port: PORT });
report.machine = { gpuBusy, cpuBusy: machine.busy, freeGB: +(machine.freeBytes / 2 ** 30).toFixed(1) };
if ((gpuBusy.length && !has('--shared-gpu')) || ((machine.busy.length || machine.freeBytes < 3 * 2 ** 30) && !has('--shared-machine'))) {
  console.error(`MEASUREMENT REFUSED: the machine is busy (GPU: ${gpuBusy.map((b) => `${b.name} ${b.percent}%`).join(', ') || 'free'}; CPU: ${machine.busy.map((b) => `${b.name} ${b.cores} cores`).join(', ') || 'free'}; ${report.machine.freeGB} GB free). Close it or pass --shared-gpu / --shared-machine.`);
  await server.close();
  process.exit(2);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: CHROME_ARGS });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await context.addInitScript(instrument);
const page = await context.newPage();
page.on('pageerror', (e) => report.errors.push({ message: e.message, at: sources.stack(e.stack ?? '').slice(0, 6) }));
page.on('console', (m) => { if (m.type() === 'error') report.errors.push({ message: `console: ${m.text().slice(0, 300)}`, at: [] }); });
page.on('dialog', (d) => void d.dismiss().catch((error) => console.warn(`dialog not dismissed: ${error.message}`)));
let crashed = false;
page.on('crash', () => { crashed = true; report.errors.push({ message: 'PAGE CRASHED (the renderer process died)', at: [] }); });
const cdp = await context.newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('HeapProfiler.enable');

try {
  await diagnose();
} catch (error) {
  report.failure = `${error.message}`.split('\n')[0];
  console.error(`RUN STOPPED: ${report.failure}`);
} finally {
  report.seconds = (Date.now() - t0) / 1000;
  report.static = staticFindings(ROOT);
  // `--approve`: this run's pictures become the look later runs are held to (lightness, contrast, colour of each view).
  if (has('--approve')) {
    const looks = Object.fromEntries(Object.entries(report.views).filter(([, v]) => v.picture?.frame).map(([k, v]) => [k, v.picture.frame]));
    writeFileSync(join(ROOT, 'lab-reports', 'diagnose', 'approved.json'), JSON.stringify(looks, null, 2));
    log(`approved look written for ${Object.keys(looks).join(', ')}`);
  }
  const file = writeReport(report, out);
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close().catch((error) => console.warn(`browser not closed: ${error.message}`));
  await server.close();
  log(`report: ${file}`);
}

async function diagnose() {
  // BOOT: the game as the player starts it.
  const bootStart = Date.now();
  await page.goto(server.url, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__roadcraft?.memory && window.__gpu && window.__diag), null, { timeout: 180_000 });
  report.phases.boot = { seconds: (Date.now() - bootStart) / 1000 };
  const gpu = await page.evaluate(() => {
    const g = window.__gpu();
    return { label: g.label, timer: g.supported, tier: window.__roadcraft.scene().quality, stored: localStorage.getItem('roadcraft.quality') };
  });
  report.gpu = gpu;
  log(`GPU ${gpu.label} (timer ${gpu.timer ? 'on' : 'MISSING'}), tier ${gpu.tier}`);
  if (/swiftshader|llvmpipe|software|basic render/i.test(gpu.label)) throw new Error(`software renderer (${gpu.label}): nothing timed would count`);
  if (!gpu.timer) report.notCovered.push('GPU time: the timer queries (EXT_disjoint_timer_query_webgl2) are missing in this browser');

  // CREATE: a new city as the menu makes one, timed mark by mark; the page's CPU profiled throughout.
  await phase('create');
  await profileStart(1000);
  await page.evaluate((ask) => { performance.clearMarks(); window.__cityAsk = window.__roadcraft.generateCity(ask).catch((e) => { window.__cityFailed = String(e); console.error(e); }); }, { ...size.ask, seed });
  const created = { limitS: size.limitS };
  const reached = await page.waitForFunction(() => {
    if (window.__cityFailed) return 'failed';
    const shown = performance.getEntriesByName('opening:shown').some((e) => e.startTime > (performance.getEntriesByName('city:applied')[0]?.startTime ?? Infinity));
    const curtain = document.getElementById('loading-curtain');
    return shown && (!curtain || getComputedStyle(curtain).display === 'none') ? 'shown' : false;
  }, null, { timeout: size.limitS * 1000, polling: 250 }).then((h) => h.jsonValue(), () => 'timeout');
  created.outcome = reached;
  created.marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter((m) => /^(city|opening|restore|boot|save):/.test(m.name)).map((m) => [m.name, Math.round(m.startTime)])));
  created.buildings = await page.evaluate(() => window.__roadcraft.doc.buildings.size);
  created.profile = await profileStop('create');
  report.phases.create = created;
  log(`city ${reached}: ${created.buildings} buildings; marks ${JSON.stringify(created.marks)}`);
  if (reached !== 'shown') throw new Error(`the city did not stand within ${size.limitS} s (${reached}); last marks ${JSON.stringify(created.marks)}`);
  report.phases.create.heap = await heap();

  // The start screen's buttons, as the player presses them.
  for (const label of ['Começar a construir', 'Continuar']) await press(label);
  // Noon and a clear sky for every run alike; the simulation running a fixed step each frame (`__roadcraft.measure('running')`): the game as it plays.
  await page.evaluate(() => { window.__roadcraft.sim.setClock?.(720); window.__roadcraft.scene().setSkyMode?.('day'); window.__roadcraft.measure('running'); });
  const centre = await page.evaluate(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of window.__roadcraft.doc.nodes.values()) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
    return Number.isFinite(x0) ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2, reach: 0.35 * Math.min(x1 - x0, y1 - y0) } : { x: 0, y: 0, reach: 1000 };
  });

  // VIEWS: each settled, then its frames, its GPU (whole frame, then pass by pass), what it draws, its memory and its picture.
  for (const v of VIEWS) {
    await phase(`view:${v.name}`);
    const programsBefore = await programNames();
    await setView({ x: centre.x, y: centre.y, zoom: v.zoom, az: v.az, el: v.el });
    const settled = await settle(20_000);
    const row = { settled };
    row.frames = await frameWindow(3000);
    row.passes = await page.evaluate(async () => {
      if (!window.__labGpu) return null;
      window.__labGpu.passTiming(true);
      await new Promise((r) => setTimeout(r, 2500));
      const rows = window.__labGpu.passes();
      window.__labGpu.passTiming(false);
      return rows.map((p) => ({ pass: p.pass, avg: +p.avg.toFixed(2), p95: +p.p95.toFixed(2), max: +p.max.toFixed(2), share: Math.round(p.share) })).sort((a, b) => b.avg - a.avg);
    });
    row.draws = await page.evaluate(async () => {
      if (!window.__labGpu) return null;
      await window.__labGpu.capture();
      const c = window.__labGpu.report()?.capture;
      const rows = (list) => (list ?? []).slice(0, 12).map((r) => ({ key: r.key, calls: r.calls, triangles: r.triangles, instances: r.instances }));
      // By the mesh's name (digits taken out: one row a kind of run or cell) and pass: which object of a layer holds its triangles.
      const byName = new Map();
      for (const d of window.__labGpu.lastCapture()?.records ?? []) {
        const k = `${d.pass === 'shadows' ? 'shadow ' : ''}${String(d.name || d.path).replace(/\d+/g, '#')}`;
        const row = byName.get(k) ?? { key: k, calls: 0, triangles: 0, instances: 0 };
        row.calls += d.calls; row.triangles += d.triangles; row.instances += d.instances;
        byName.set(k, row);
      }
      const named = [...byName.values()].sort((a, b) => b.triangles - a.triangles).slice(0, 25);
      return c ? { calls: c.calls, triangles: c.triangles, byLayer: rows(c.byLayer), byPass: rows(c.byPass), byMaterial: rows(c.byMaterial), byName: named } : null;
    });
    row.memory = await memory();
    // The programs built while this view landed (its first frames in play): named, so each can be built before the curtain.
    row.programsBuilt = newPrograms(programsBefore, await programNames());
    if (!has('--no-quality')) row.picture = await picture(v.name);
    report.views[v.name] = row;
    log(`${v.name}: frame p99 ${row.frames.frame.p99} ms, GPU p95 ${row.frames.gpu.p95 ?? '—'} ms, draws ${row.memory.drawCalls}, triangles ${(row.memory.drawnTriangles / 1e6).toFixed(1)} M${row.picture ? `, ${(row.picture.overShare * 100).toFixed(2)} % of pixels off the supersampled reference` : ''}`);
  }

  // NAVIGATE: the camera flown across the city as a player pans and zooms - cells streaming in and out, levels swapped, programs and uploads on the way.
  await phase('navigate');
  await setView({ x: centre.x, y: centre.y, zoom: 2.5, az: 45, el: 48 });
  await settle(15_000);
  const before = await memory();
  await profileStart(500);
  const R = centre.reach;
  const tour = [
    { x: centre.x, y: centre.y, zoom: 2.5, az: 45, el: 48, ms: 0 },
    { x: centre.x + R, y: centre.y + R, zoom: 2.5, az: 45, el: 48, ms: 4000 },
    { x: centre.x, y: centre.y, zoom: 0.12, az: 45, el: 48, ms: 2500 },
    { x: centre.x - 0.6 * R, y: centre.y - 0.4 * R, zoom: 5, az: 20, el: 35, ms: 3000 },
    { x: centre.x - 0.2 * R, y: centre.y - 0.4 * R, zoom: 5, az: 60, el: 35, ms: 3000 },
  ];
  const flightPrograms = await programNames();
  const flight = await frameWindow(0, () => page.evaluate(fly, tour));
  const nav = { frames: flight, profile: await profileStop('navigate') };
  // The same flight again, the GPU timed pass by pass (its per-pass queries cost the page: kept out of the flight above).
  await setView({ x: centre.x, y: centre.y, zoom: 2.5, az: 45, el: 48 });
  await page.evaluate(() => window.__labGpu?.passTiming(true));
  await page.evaluate(fly, tour);
  const flightPasses = await page.evaluate(() => {
    const rows = window.__labGpu?.passes() ?? [];
    window.__labGpu?.passTiming(false);
    return rows.map((p) => ({ pass: p.pass, avg: +p.avg.toFixed(2), p95: +p.p95.toFixed(2), max: +p.max.toFixed(2), share: Math.round(p.share) })).sort((a, b) => b.avg - a.avg);
  });
  // RETURN: the first view again: what the flight left behind (heap after a collection, geometries, textures, programs).
  await setView({ x: centre.x, y: centre.y, zoom: 2.5, az: 45, el: 48 });
  await settle(15_000);
  nav.before = before;
  nav.passes = flightPasses;
  nav.programsBuilt = newPrograms(flightPrograms, await programNames());
  nav.after = await memory();
  report.phases.navigate = nav;
  log(`flight: ${flight.frame.frames} frames, p99 ${flight.frame.p99} ms, worst ${flight.frame.max} ms, ${flight.frame.hitches} over 25 ms; heap ${before.heapMB} -> ${nav.after.heapMB} MB`);

  if (!has('--no-reopen')) {
    // SAVE: the autosave written now, timed to stored.
    await phase('save');
    const heapBefore = await heap();
    const saveMs = await page.evaluate(async () => { const t = performance.now(); await window.__roadcraft.saved(); return Math.round(performance.now() - t); });
    report.phases.save = { ms: saveMs, heapBefore };
    log(`saved in ${saveMs} ms`);
    // REOPEN: the game started again on that save, as the player's next session.
    firstPage = await records();
    await page.evaluate(() => sessionStorage.setItem('diag:phase', 'reopen'));
    const buildings = report.phases.create.buildings;
    await profileStart(1000);
    const reopenStart = Date.now();
    await page.reload({ waitUntil: 'load' });
    const opened = await page.waitForFunction((least) => {
      const r = window.__roadcraft;
      return Boolean(r) && !r.scene().opening && !r.scene().worldBusy && r.doc.buildings.size >= least;
    }, Math.floor(buildings * 0.9), { timeout: size.limitS * 1000, polling: 250 }).then(() => 'shown', () => 'timeout');
    const reopen = { outcome: opened, seconds: (Date.now() - reopenStart) / 1000 };
    reopen.profile = await profileStop('reopen');
    reopen.marks = await page.evaluate(() => Object.fromEntries(performance.getEntriesByType('mark').filter((m) => /^(city|opening|restore|boot|save):/.test(m.name)).map((m) => [m.name, Math.round(m.startTime)])));
    if (opened === 'shown') {
      await settle(15_000);
      reopen.heap = await heap();
    }
    report.phases.reopen = reopen;
    log(`reopened: ${opened} in ${reopen.seconds.toFixed(1)} s; heap ${reopen.heap?.mb ?? '—'} MB (before the save ${heapBefore.mb} MB)`);
  } else report.notCovered.push('save and reopen (--no-reopen)');

  // Everything the page saw, by phase: long frames with their scripts, waits for the GPU with their stacks, programs linked, bytes uploaded.
  const seen = await records();
  // The reload started a new page: the first page's records were read before it (`firstPage`).
  report.longFrames = [...(firstPage?.longFrames ?? []), ...seen.longFrames].map((f) => ({ ...f, scripts: f.scripts.map((s) => ({ ...s, where: sources.atChar(s.url, s.pos)?.where ?? s.url?.replace(/^https?:\/\/[^/]+\//, '') ?? '' })) }));
  report.sync = mergeSync(firstPage?.sync ?? {}, seen.sync);
  report.gpuWork = { ...(firstPage?.gpuWork ?? {}), ...seen.gpuWork };
  report.notCovered.push(
    'worker threads (city generation, network bake, simulation, save compression): timed by their phases only, not profiled function by function',
    'the desktop build (Electron, saves in a folder, Steam overlay): this run is the browser build',
    'other GPUs and weaker machines: measured on this machine only',
    'long sessions (hours): a run of minutes shows leaks only as growth over one flight',
    'shadow and AO quality against a higher-setting reference; flicker in motion: only the supersampled reference of still frames is compared',
  );
}

/** The programs three holds now, by name and cache key (`renderer.info.programs`). */
function programNames() {
  return page.evaluate(() => (window.__roadcraft.scene().gl.info.programs ?? []).map((p) => `${p.name} ${String(p.cacheKey).slice(0, 60)}`));
}

/** The programs in `after` not in `before`, by name with how many of each. */
function newPrograms(before, after) {
  const had = new Set(before);
  const counts = new Map();
  for (const p of after) if (!had.has(p)) { const name = p.slice(0, 70); counts.set(name, (counts.get(name) ?? 0) + 1); }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ×${n}`);
}

async function phase(name) {
  await page.evaluate((n) => window.__diag.setPhase(n), name);
}

function mergeSync(a, b) {
  const outSync = {};
  for (const src of [a, b]) for (const [ph, calls] of Object.entries(src)) {
    const p = (outSync[ph] ??= {});
    for (const [name, row] of Object.entries(calls)) {
      const r = (p[name] ??= { count: 0, ms: 0, worst: 0, stacks: [] });
      r.count += row.count; r.ms += row.ms; r.worst = Math.max(r.worst, row.worst);
      for (const [stack, s] of Object.entries(row.stacks)) r.stacks.push({ count: s.count, ms: s.ms, at: sources.stack(stack).slice(0, 4) });
    }
  }
  for (const calls of Object.values(outSync)) for (const r of Object.values(calls)) r.stacks.sort((x, y) => y.ms - x.ms).splice(8);
  return outSync;
}

/** A start screen's button by what it says, clicked where it stands; nothing when the screen does not show it. */
async function press(label) {
  const at = await page.evaluate((name) => {
    const said = (b) => [b.getAttribute('aria-label'), b.title, b.textContent].map((s) => (s ?? '').trim());
    const seen = [...document.querySelectorAll('button, [role=button]')].filter((b) => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(b).visibility !== 'hidden' && said(b).some((s) => s === name || s.startsWith(name));
    });
    const b = seen.at(-1);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, label);
  if (at) await page.mouse.click(at[0], at[1]);
}

async function setView({ x, y, zoom, az, el }) {
  await page.evaluate((v) => window.__roadcraft.setView({ x: v.x, y: v.y, zoom: v.zoom, azimuth: (v.az * Math.PI) / 180, elevation: (v.el * Math.PI) / 180 }), { x, y, zoom, az, el });
}

/** Waits until nothing is landing (the world's jobs done, every chosen building level built), at most `maxMs`. */
function settle(maxMs) {
  return page.evaluate(async (most) => {
    const t = performance.now();
    const h = window.__roadcraft.scene();
    let calm = 0;
    // How many of the looks found each still working: what kept the world from standing still.
    const held = { worldBusy: 0, opening: 0, notLanded: 0, looks: 0 };
    while (performance.now() - t < most) {
      const levels = h.buildingLevels();
      held.looks++;
      if (h.worldBusy) held.worldBusy++;
      if (h.opening) held.opening++;
      if ((levels.notLanded ?? 0) > 0) held.notLanded++;
      const busy = h.worldBusy || h.opening || (levels.notLanded ?? 0) > 0;
      calm = busy ? 0 : calm + 1;
      if (calm >= 6) return { ms: Math.round(performance.now() - t), settled: true };
      await new Promise((r) => setTimeout(r, 250));
    }
    return { ms: most, settled: false, held };
  }, maxMs);
}

/** A window of frames: `ms` of waiting (or `during` run to its end), the frames' intervals as the player sees them, the GPU's own time of
 *  those frames only (its ring cleared at the start: the opening's frames are not in it), and the page's time per system. */
async function frameWindow(ms, during = null) {
  const since = await page.evaluate(() => {
    window.__gpu(true);
    const rec = { times: [], on: true };
    window.__diagFrames = rec;
    const tick = (t) => { if (!rec.on) return; rec.times.push(t); requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return performance.now();
  });
  if (during) await during();
  else await page.waitForTimeout(ms);
  const got = await page.evaluate((s) => {
    window.__diagFrames.on = false;
    const g = window.__gpu(true);
    return { times: window.__diagFrames.times, gpu: { p50: g.p50, p95: g.p95, p99: g.p99, max: g.max, n: g.n, disjoint: g.disjoint }, systems: window.__frames?.(s) ?? null };
  }, since);
  return { frame: frameStats(got.times), gpu: got.gpu, systems: got.systems };
}

/** The frames' intervals, ms: percentiles, hitches (> 25 ms), vsyncs missed (`scripts/look.mjs` frameStats). */
function frameStats(times) {
  const gaps = times.slice(1).map((t, k) => t - times[k]);
  const sorted = [...gaps].sort((a, b) => a - b);
  const fast = sorted.length ? sorted[Math.floor(sorted.length * 0.1)] : 0;
  const vsync = fast >= 1000 / 240 && fast <= 1000 / 30 ? fast : 1000 / 60;
  const at = (q) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * q) - 1)] * 10) / 10 : null);
  return {
    frames: gaps.length, seconds: times.length > 1 ? Math.round(times.at(-1) - times[0]) / 1000 : 0,
    p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length ? Math.round(sorted.at(-1)) : null,
    hitches: gaps.filter((g) => g > 25).length,
    dropped: gaps.reduce((a, g) => a + Math.max(0, Math.round(g / vsync) - 1), 0),
  };
}

/** In the page: the camera flown through `keys`, each leg eased over its `ms`, zoom on a log scale. */
async function fly(keys) {
  const r = window.__roadcraft;
  const lerp = (a, b, t) => a + (b - a) * t;
  for (let k = 1; k < keys.length; k++) {
    const a = keys[k - 1], b = keys[k];
    const start = performance.now();
    await new Promise((done) => {
      const step = () => {
        const t = Math.min(1, (performance.now() - start) / b.ms);
        const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        r.setView({ x: lerp(a.x, b.x, e), y: lerp(a.y, b.y, e), zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), e)), azimuth: (lerp(a.az, b.az, e) * Math.PI) / 180, elevation: (lerp(a.el, b.el, e) * Math.PI) / 180 });
        if (t < 1) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
  }
}

/** The page's heap after a full collection (CDP), MB. */
async function heap() {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return { mb: Math.round(usedSize / 1e5) / 10 };
}

async function memory() {
  const m = await page.evaluate(() => {
    const r = window.__roadcraft.memory();
    return { geometryMB: r.geometryMB, textureMB: r.textureMB, targetMB: r.targetMB, buildingDetailMB: r.buildingDetailMB, drawCalls: r.drawCalls, drawnTriangles: r.drawnTriangles, builtTriangles: r.builtTriangles, programs: r.programs, glGeometries: r.glGeometries, glTextures: r.glTextures, gpuByName: r.gpuByName, textureByName: r.textureByName?.slice(0, 8) };
  });
  return { ...m, heapMB: (await heap()).mb };
}

/** The frame against the same frame at twice the resolution each way, filtered down by the browser (a 4-sample supersampled reference). */
async function picture(name) {
  await page.evaluate(() => window.__roadcraft.measure(true));
  const ratio = await page.evaluate(() => window.__roadcraft.scene().gl.getPixelRatio());
  const drawn = (n) => page.evaluate((count) => new Promise((done) => { window.__roadcraft.redraw(); let left = count; const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick)); requestAnimationFrame(tick); }), n);
  await drawn(4);
  const framePath = join(out, `${name}-frame.png`);
  await page.screenshot({ path: framePath });
  await page.evaluate((r) => window.__roadcraft.scene().resize(r * 2), ratio);
  await drawn(8);
  const refPath = join(out, `${name}-reference.png`);
  await page.screenshot({ path: refPath });
  await page.evaluate((r) => window.__roadcraft.scene().resize(r), ratio);
  await drawn(4);
  await page.evaluate(() => window.__roadcraft.measure('running'));
  const data = (p) => `data:image/png;base64,${readFileSync(p).toString('base64')}`;
  const result = await page.evaluate(comparePictures, { frame: data(framePath), reference: data(refPath), threshold: 0.05 });
  if (result.error) return { error: result.error };
  const heat = join(out, `${name}-aliasing.png`);
  writeFileSync(heat, Buffer.from(result.png.split(',')[1], 'base64'));
  const approved = join(ROOT, 'lab-reports', 'diagnose', 'approved.json');
  const look = existsSync(approved) ? JSON.parse(readFileSync(approved, 'utf8'))[name] ?? null : null;
  return { overShare: result.overShare, meanError: result.meanError, frame: result.frame, reference: result.reference, approved: look, files: { frame: framePath, reference: refPath, aliasing: heat } };
}

async function profileStart(intervalUs) {
  await cdp.send('Profiler.setSamplingInterval', { interval: intervalUs });
  await cdp.send('Profiler.start');
}

/** The profile stopped and read: each of the game's functions' own time and time with its callees, in ms, by its line in `src/`. */
async function profileStop(name) {
  let profile;
  try { ({ profile } = await cdp.send('Profiler.stop')); } catch (error) { console.warn(`profile "${name}" not read: ${error.message}`); return { error: String(error) }; }
  writeFileSync(join(out, `${name}.cpuprofile`), JSON.stringify(profile));
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const keys = new Map();
  const keyOf = (n) => {
    if (keys.has(n.id)) return keys.get(n.id);
    const f = n.callFrame;
    const p = f.url ? sources.at(f.url, f.lineNumber, f.columnNumber) : null;
    const k = p ? `${f.functionName || p.name || '(anonymous)'} @ ${p.where}` : `${f.functionName || '(anonymous)'}${f.url ? '' : ' (native)'}`;
    keys.set(n.id, k);
    return k;
  };
  const self = new Map(), total = new Map();
  let ms = 0;
  for (let s = 0; s < profile.samples.length; s++) {
    const dt = (profile.timeDeltas[s] ?? 0) / 1000;
    ms += dt;
    let id = profile.samples[s];
    const top = byId.get(id);
    if (!top) continue;
    self.set(keyOf(top), (self.get(keyOf(top)) ?? 0) + dt);
    const seen = new Set();
    while (id !== undefined) {
      const k = keyOf(byId.get(id));
      if (!seen.has(k)) { seen.add(k); total.set(k, (total.get(k) ?? 0) + dt); }
      id = parent.get(id);
    }
  }
  const idle = /^\((idle|program|root)\)/;
  const rank = (m, src) => [...m].filter(([k]) => !idle.test(k) && (!src || k.includes('@ src/'))).sort((a, b) => b[1] - a[1]).slice(0, 20).map(([k, v]) => ({ at: k, ms: Math.round(v) }));
  const gc = [...self].filter(([k]) => k.startsWith('(garbage collector)')).reduce((a, [, v]) => a + v, 0);

  // THE PAGE HELD: stretches of 50 ms or more with the main thread never idle (what a player sees as a freeze or a hitch), each sample put on
  // the game's own function nearest the top of its stack (three's or the browser's frames above it belong to the game's call that led there).
  const nearest = new Map();
  const ownOf = (id) => {
    if (nearest.has(id)) return nearest.get(id);
    // The game's own frame nearest the top; with none (a timer of three's, the browser's own work), the nearest frame with a source (three's
    // `compileAsync` polling its programs, say) before the native call itself.
    let at = id, found = null, sourced = null;
    while (at !== undefined && !found) {
      const k = keyOf(byId.get(at));
      if (k.includes('@ src/')) found = k;
      else if (!sourced && k.includes(' @ ')) sourced = k;
      at = parent.get(at);
    }
    const native = keyOf(byId.get(id));
    const value = found ?? (sourced ? `${native.replace(/ \(native\)$/, '')} < ${sourced.replace(/^.*node_modules\//, '')}` : native);
    nearest.set(id, value);
    return value;
  };
  const blocks = [];
  let run = null;
  for (let s = 0; s < profile.samples.length; s++) {
    const dt = (profile.timeDeltas[s] ?? 0) / 1000;
    const k = keyOf(byId.get(profile.samples[s]) ?? { id: -1, callFrame: { functionName: '(root)' } });
    if (k.startsWith('(idle)')) {
      if (run && run.ms >= 50) blocks.push(run);
      run = null;
      continue;
    }
    run ??= { ms: 0, by: new Map() };
    run.ms += dt;
    const own = ownOf(profile.samples[s]);
    run.by.set(own, (run.by.get(own) ?? 0) + dt);
  }
  if (run && run.ms >= 50) blocks.push(run);
  const heldBy = new Map();
  for (const b of blocks) for (const [k, v] of b.by) heldBy.set(k, (heldBy.get(k) ?? 0) + v);
  const top = (m, n) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ at: k, ms: Math.round(v) }));
  const worst = blocks.reduce((w, b) => (!w || b.ms > w.ms ? b : w), null);
  const held = { count: blocks.length, ms: Math.round(blocks.reduce((a, b) => a + b.ms, 0)), worstMs: Math.round(worst?.ms ?? 0), worstBy: worst ? top(worst.by, 4) : [], by: top(heldBy, 12) };
  return { file: `${name}.cpuprofile`, ms: Math.round(ms), garbageMs: Math.round(gc), idleMs: Math.round(self.get('(idle) (native)') ?? 0), held, self: rank(self, false), ownSelf: rank(self, true), ownTotal: rank(total, true) };
}

if (crashed) process.exitCode = 4;
