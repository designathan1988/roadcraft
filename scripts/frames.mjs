// THE FRAME MEASURE: the small city of a fixed seed, three fixed views, each held still a while and then measured by the game's own counters
// (`__frames`: the page's time a frame and its systems; `__gpu`: the GPU's time a frame) - no probe in the page, so a before and an after compare.
// Usage: npm run dev, then  node scripts/frames.mjs [--base http://127.0.0.1:5300/] [--seed 7] [--settle 8] [--hold 12] [--out test-results/frames.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { chromium } from '@playwright/test';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };
const BASE = arg('--base', 'http://127.0.0.1:5300/');
const SEED = Number(arg('--seed', '7'));
const SETTLE = Number(arg('--settle', '8')) * 1000;
const HOLD = Number(arg('--hold', '12')) * 1000;
const OUT = arg('--out', 'test-results/frames.json');

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
let crashed = false;
page.on('crash', () => { crashed = true; });
await page.goto(BASE);
await page.waitForFunction(() => window.__roadcraft && !/Carregando|Gerando/.test(document.body.innerText), null, { timeout: 180000 });
await page.waitForTimeout(2000);
const opened = await page.evaluate(async (seed) => { const t = performance.now(); await window.__roadcraft.smallCity(seed); return performance.now() - t; }, SEED);
const fit = await page.evaluate(() => ({ x: window.__roadcraft.camera.x, y: window.__roadcraft.camera.y, zoom: window.__roadcraft.camera.zoom }));
const VIEWS = [
  { name: 'whole city', zoom: 1 },
  { name: 'district', zoom: 4 },
  { name: 'street, downtown', zoom: 14 },
];
const results = { seed: SEED, openedMs: Math.round(opened), views: [] };
for (const v of VIEWS) {
  if (crashed) break;
  await page.evaluate(({ x, y, zoom }) => window.__roadcraft.lookAt(x, y, zoom), { x: fit.x, y: fit.y, zoom: fit.zoom * v.zoom });
  await page.waitForTimeout(SETTLE);
  const since = await page.evaluate(() => { window.__gpu?.(true); return performance.now(); });
  await page.waitForTimeout(HOLD);
  const r = await page.evaluate((since) => ({
    frames: window.__frames(since),
    gpu: window.__gpu(),
    heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6),
    shown: document.body.innerText.match(/[\d.]+ veículos[^\n]*/)?.[0] ?? '',
  }), since).catch((e) => ({ error: String(e) }));
  // What the view shows: a picture, and the town's cells by level (detail, facade, masses) and why (`SceneHandle.buildingLevels`).
  const shot = OUT.replace(/\.json$/, '') + `-${results.views.length + 1}.png`;
  await page.screenshot({ path: shot }).catch(() => {});
  r.levels = await page.evaluate(() => window.__roadcraft.scene().buildingLevels?.() ?? null).catch(() => null);
  const f = r.frames ?? {};
  const systems = Object.entries(f.systems ?? {}).filter(([, s]) => s.p50 >= 0.5 || s.p95 >= 2).sort((a, b) => b[1].p50 - a[1].p50).map(([k, s]) => `${k} ${s.p50}/${s.p95}`);
  const lv = r.levels;
  const levels = lv && `detail ${lv.shownDetail}/${lv.chosenDetail}, facade ${lv.shownFacade}/${lv.chosenFacade}, masses ${lv.chosenFar} of ${lv.cells} cells; triangles ${Math.round(lv.chosenTriangles / 1e6)}M of ${Math.round(lv.budgetTriangles / 1e6)}M, held ${lv.heldFar + lv.heldCoarse}`;
  const line = { view: v.name, cpuP50: f.total?.p50, cpuP95: f.total?.p95, cpuMax: f.total?.max, frames: f.frames, long: f.long, gpuP50: r.gpu?.p50, gpuP95: r.gpu?.p95, heapMB: r.heapMB, shown: r.shown, levels, shot, systems };
  results.views.push(line);
  console.log(JSON.stringify(line));
}
results.crashed = crashed;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(crashed ? 'RESULT: PAGE CRASHED' : `RESULT: written ${OUT}`);
await browser.close();
