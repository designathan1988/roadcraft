// LOOK AT THE GAME AS THE PLAYER SEES IT, at full resolution, without taking
// anyone's window: the installed Google Chrome driven by Playwright, headless,
// on the real GPU, with exact mouse and keyboard gestures, from a script of
// steps. node scripts/look.mjs <steps.json>   (example: scripts/look/views.json)
//
// Why not the desktop app's browser pane: its screenshots come back at the
// pane's size (800x450 asked at 1920x1080, 2026-10-14), too small to see a
// defect. Claude Opus 5.x reads images up to 2576 px on the long edge without
// downscaling (platform.claude.com/docs/en/build-with-claude/vision), so a
// 1920x1080 PNG is seen whole; a detail is a `clip` taken with `dpr: 2`.
// Why the installed Chrome (`channel: 'chrome'`, playwright.dev/docs/browsers):
// the Chromium Playwright downloads (chromium-1234, -1243, -1248) does not
// start on this machine (Windows: "side-by-side configuration is incorrect",
// or its sandbox denied access to its own executable), while the installed
// Chrome and the headless shell do.
// Why `--enable-gpu`: headless Chrome draws with SwiftShader (the CPU) unless
// told otherwise (chromium headless_mode_switches.h); the run stops if the
// renderer is still a software one - its pictures and timings would lie.
//
// steps.json: { "url"?, "viewport"?: [w, h], "dpr"?: 1|2, "city"?: false |
//   true | { CityOptions }, "out"?: dir, "steps": [ ... ] } where each step is
//   { "lookAt": [x, y, zoom] }           the camera on a world point (__roadcraft.lookAt)
//   { "wait": ms }                       real time, the game running
//   { "frames": n }                      n drawn frames
//   { "drag": [[x0, y0], [x1, y1]], "button"?: "left"|"right"|"middle", "steps"?: n, "keys"?: ["Shift"] }
//   { "wheel": [dx, dy], "at"?: [x, y] } scroll (zoom) at a screen point
//   { "move": [x, y], "steps"?: n }      the pointer only (hover)
//   { "click": [x, y], "button"?, "count"? }
//   { "key": "Escape" }                  a key or chord ("Control+Z")
//   { "type": "text" }
//   { "eval": "expression" }             JavaScript in the page, its value reported
//   { "evalFile": "scripts/look/x.js" }  the same from a file: one expression, a promise awaited
//   { "shot": "name", "clip"?: [x, y, w, h] }  a PNG (CSS pixels; with dpr 2, twice the pixels)
//   { "budget": "rua"|"bairro"|"mapa" }  the plan's budget table at this view
// Screen points are CSS pixels of the viewport, from its top-left corner
// (playwright.dev/docs/api/class-mouse). The game's camera (`main.ts`, the
// pointer down): the middle button dragged pans, the right one swings it round
// (Shift + right pans), the wheel zooms; the left button belongs to the tool.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';

const file = process.argv[2];
if (!file) {
  console.error('uso: node scripts/look.mjs <roteiro.json>');
  process.exit(2);
}
let plan;
try {
  plan = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`roteiro ilegível (${file}): ${err.message}`);
  process.exit(2);
}
const out = resolve(plan.out ?? join(tmpdir(), 'roadcraft-look', new Date().toISOString().replace(/[:.]/g, '-')));
mkdirSync(out, { recursive: true });
const [width, height] = plan.viewport ?? [1920, 1080];
/**
 * The dev server reloads the page whenever any session saves a file (Vite):
 * the city generated so far is gone, so an attempt cut by a reload starts
 * over, at most this many times.
 */
const ATTEMPTS = 3;
const RELOADED = 'a página recarregou no meio (um arquivo foi salvo e o Vite recarregou o jogo)';

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
      console.log(`${RELOADED}: tentativa ${attempt + 1} de ${ATTEMPTS}`);
    }
  }
} finally {
  writeFileSync(join(out, 'relatorio.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(`relatório: ${join(out, 'relatorio.json')}${report.console.length ? ` (${report.console.length} erros/avisos no console)` : ''}`);

/** One run of the steps on a fresh page; throws `RELOADED` if the page reloads under it. */
async function runOnce(report) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: plan.dpr ?? 1 });
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
  page.on('pageerror', (e) => report.console.push(`pageerror: ${e.message}`));
  const url = plan.url ?? 'http://127.0.0.1:5300/';
  try {
    await page.goto(url, { waitUntil: 'load' });
  } catch (err) {
    throw new Error(`o jogo não respondeu em ${url} (${err.message.split('\n')[0]}): suba o servidor com \`npm run dev\``, { cause: err });
  }
  page.reloads = 0;
  page.on('load', () => { page.reloads++; });
  const stillThere = () => { if (page.reloads) throw new Error(RELOADED); };

  report.renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl?.getParameter(gl.RENDERER) ?? 'sem WebGL2');
  });
  console.log(`placa: ${report.renderer}`);
  if (/swiftshader|software|llvmpipe|basic render/i.test(report.renderer)) throw new Error(`renderizador de software (${report.renderer}): fotos e tempos não valem`);

  await page.waitForFunction(() => Boolean(window.__roadcraft?.memory), null, { timeout: 120_000 });
  if (plan.city) {
    await page.evaluate((options) => window.__roadcraft.generateCity(options === true ? {} : options), plan.city);
    // `?.`: a reload in the wait leaves the page without `__roadcraft` for a moment.
    await page.waitForFunction(() => window.__roadcraft && !window.__roadcraft.cityGrowth() && window.__roadcraft.memory().drawCalls > 100, null, { timeout: 300_000, polling: 1000 });
    stillThere();
    console.log('cidade pronta');
  }

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
      await page.mouse.move(x1, y1, { steps: step.steps ?? 30 });
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
      console.log(`foto: ${path}`);
    } else if (step.budget) {
      await frames(30);
      line.value = await page.evaluate((view) => window.__roadcraft.budget(view).map((r) => `${r.situação} | ${r.item} | ${r.medido} | ${r.orçamento}${r.vezes ? ` | ${r.vezes}×` : ''}`), step.budget);
      console.log(`orçamento (${step.budget}):\n  ${line.value.join('\n  ')}`);
    } else throw new Error(`passo desconhecido: ${JSON.stringify(step)}`);
    stillThere();
    report.steps.push(line);
  }
}
