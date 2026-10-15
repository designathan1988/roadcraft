// LOOK AT THE GAME AS THE PLAYER SEES IT, at full resolution, without taking anyone's window
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';
import { joinSessionJob } from './sessionJob.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/look.mjs <script.json>');
  process.exit(2);
}
let plan;
try {
  plan = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`unreadable script (${file}): ${err.message}`);
  process.exit(2);
}
const out = resolve(plan.out ?? join(tmpdir(), 'roadcraft-look', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(out, { recursive: true });
const [width, height] = plan.viewport ?? [1920, 1080];
/** The dev server reloads the page whenever any session saves a file (Vite) */
const ATTEMPTS = 3;
const RELOADED = 'the page reloaded midway (a file was saved and Vite reloaded the game)';

// If the game cannot run within the share, the game is too slow: make it faster, DO NOT lift the cap.
const job = joinSessionJob();
console.log(job.joined ? `share: ${job.percent}% CPU, ${job.memoryGb} GB (${job.name})` : `share: not applied (${job.why})`);
const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
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
    await page.close();
  }
}

async function steps(page, report) {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') report.console.push(`${m.type()}: ${m.text()}`); });
  // With its stack: the message alone does not say which code threw.
  page.on('pageerror', (e) => report.console.push(`pageerror: ${e.message}\n${e.stack ?? ''}`));
  const url = plan.url ?? 'http://127.0.0.1:5300/';
  try {
    await page.goto(url, { waitUntil: 'load' });
  } catch (err) {
    throw new Error(`the game did not answer at ${url} (${err.message.split('\n')[0]}): start the server with \`npm run dev\``, { cause: err });
  }
  page.reloads = 0;
  page.on('load', () => { page.reloads++; });
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
    await page.evaluate((o) => window.__roadcraft.generateCity(o === true ? {} : o), options);
    // `?.`: a reload in the wait leaves the page without `__roadcraft` for a moment.
    await page.waitForFunction(() => window.__roadcraft && !window.__roadcraft.cityGrowth() && window.__roadcraft.memory().drawCalls > 100, null, { timeout: 1_800_000, polling: 1000 });
    stillThere();
    const value = { seconds: (Date.now() - t0) / 1000, builtIn: await page.evaluate(() => window.__roadcraft.cityBuiltIn()) };
    console.log(`city ready in ${value.seconds.toFixed(1)} s (growth ${Number(value.builtIn).toFixed(1)} s)`);
    return value;
  };
  if (plan.city) await city(plan.city);
  /** The DevTools protocol session, made on the first "profile". */
  let cdp = null;
  let profiling = null;

  /** Two drawn frames, so a picture shows what the last step did. */
  const frames = (n = 2) => page.evaluate((count) => new Promise((done) => {
    window.__roadcraft.redraw();
    let left = count;
    const tick = () => (--left <= 0 ? done() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  }), n);

  for (const [i, step] of plan.steps.entries()) {
    const line = { i, step: Object.keys(step)[0] };
    if (step.lookAt) await page.evaluate(([x, y, zoom]) => window.__roadcraft.lookAt(x, y, zoom), step.lookAt);
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
      await page.mouse.wheel(step.wheel[0], step.wheel[1]);
    } else if (step.move) await page.mouse.move(step.move[0], step.move[1], { steps: step.steps ?? 1 });
    else if (step.click) await page.mouse.click(step.click[0], step.click[1], { button: step.button ?? 'left', clickCount: step.count ?? 1 });
    else if (step.key) await page.keyboard.press(step.key);
    else if (step.type !== undefined) await page.keyboard.type(step.type);
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
        return { heapMB: r.heapMB, geometryMB: r.geometryMB, geometryCpuMB: r.geometryCpuMB, textureMB: r.textureMB, drawCalls: r.drawCalls, triangles: r.triangles, cpuByName: r.cpuByName.slice(0, 8) };
      });
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
