// THE FRAME MEASURE: the small city of a fixed seed, three fixed views, each measured by the game's own counters (`__frames`: the page's time
// a frame and its systems; `__gpu`: the GPU's time a frame) - no probe in the page, so a before and an after compare.
// Opened, held and settled by `lib/measureCity.mjs` (report AST-15: this script opened its own Chrome, measured a scene still changing and
// never refused a busy machine). Each view twice, side by side (report UI-15 a): FROZEN (the measure mode: the simulation's clock held, the
// scene the same to the triangle) and RUNNING (the clock going, as the player plays: the agents, the growth, the wear in it). The view's
// `cpuP50`/`gpuP50`... are the running window's, as before this rewrite; `frozen` has the other. Every window says the scene it measured.
// Usage: npm run dev, then  node scripts/frames.mjs [--base http://127.0.0.1:5300/] [--seed 7] [--settle 8] [--hold 12] [--out test-results/frames.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, lookAt, openCity } from './lib/measureCity.mjs';

const SEED = Number(arg('--seed', '7'));
const SETTLE = Number(arg('--settle', '8')) * 1000;
const HOLD = Number(arg('--hold', '12')) * 1000;
const OUT = arg('--out', 'test-results/frames.json');

const t0 = Date.now();
const { browser, page, fit } = await openCity({ zoom: 1, width: 1600, height: 900 });
let crashed = false;
page.on('crash', () => { crashed = true; });
const VIEWS = [
  { name: 'whole city', zoom: 1 },
  { name: 'district', zoom: 4 },
  { name: 'street, downtown', zoom: 14 },
];
const results = { seed: SEED, openedMs: Date.now() - t0, views: [] };

/** One window of `HOLD` after `SETTLE`: the page's frames, the GPU's, the heap, and the scene at its start and end. */
const window1 = () => page.evaluate(async ({ SETTLE, HOLD }) => {
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  await sleep(SETTLE);
  const before = window.__measure.sign(window.__measure.scene());
  window.__gpu(true);
  const since = performance.now();
  await sleep(HOLD);
  const after = window.__measure.sign(window.__measure.scene());
  return {
    frames: window.__frames(since), gpu: window.__gpu(), heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6),
    scene: before === after ? after : `${before} -> ${after}`,
    vehicles: window.__roadcraft.sim.vehicles.size, people: window.__roadcraft.sim.pedViews.length,
  };
}, { SETTLE, HOLD });

const line = (r) => ({ cpuP50: r.frames.total?.p50, cpuP95: r.frames.total?.p95, cpuMax: r.frames.total?.max, frames: r.frames.frames, long: r.frames.long, gpuP50: r.gpu?.p50, gpuP95: r.gpu?.p95, disjoint: r.gpu?.disjoint, heapMB: r.heapMB, scene: r.scene, shown: `${r.vehicles} vehicles · ${r.people} people`, systems: Object.entries(r.frames.systems ?? {}).filter(([, s]) => s.p50 >= 0.5 || s.p95 >= 2).sort((a, b) => b[1].p50 - a[1].p50).map(([k, s]) => `${k} ${s.p50}/${s.p95}`) });

for (const v of VIEWS) {
  if (crashed) break;
  await page.evaluate(() => window.__roadcraft.measure(true));
  const settled = await lookAt(page, fit, v.zoom);
  const frozen = await window1().catch((e) => ({ error: String(e) }));
  await page.evaluate(() => window.__roadcraft.measure(false));
  const running = await window1().catch((e) => ({ error: String(e) }));
  await page.evaluate(() => window.__roadcraft.measure(true));
  // What the view shows: a picture, and the town's cells by level (detail, facade, masses) and why (`SceneHandle.buildingLevels`).
  const shot = OUT.replace(/\.json$/, '') + `-${results.views.length + 1}.png`;
  await page.screenshot({ path: shot }).catch(() => {});
  const lv = await page.evaluate(() => window.__roadcraft.scene().buildingLevels?.() ?? null).catch(() => null);
  const levels = lv && `detail ${lv.shownDetail}/${lv.chosenDetail}, facade ${lv.shownFacade}/${lv.chosenFacade}, masses ${lv.chosenFar} of ${lv.cells} cells; triangles ${Math.round(lv.chosenTriangles / 1e6)}M of ${Math.round(lv.budgetTriangles / 1e6)}M, held ${lv.heldFar + lv.heldCoarse}`;
  const row = { view: v.name, settledS: settled.seconds, unsettled: !!settled.unsettled, ...(running.error ? { error: running.error } : line(running)), frozen: frozen.error ? { error: frozen.error } : line(frozen), levels, shot };
  results.views.push(row);
  console.log(JSON.stringify(row));
}
results.crashed = crashed;
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(crashed ? 'RESULT: PAGE CRASHED' : `RESULT: written ${OUT}`);
await browser.close();
