// WHY THE GPU'S TIME JUMPS WITH NOTHING CHANGED: the small city's district view, nothing swapped; windows of a couple of
// seconds in a row, each with the GPU's p50 and the sun's cascades' passes in it - in the measure mode (the clock held), then with the game running.
// Usage: npm run dev, then node scripts/gpuSteady.mjs [--zoom 4] [--windows 8]
import { arg, openCity, sameScene } from './lib/measureCity.mjs';

const WINDOWS = Number(arg('--windows', '8'));
const { browser, page } = await openCity();
for (const measuring of [true, false]) {
  const rows = await page.evaluate(async ({ WINDOWS, measuring }) => {
    const r = window.__roadcraft, handle = r.scene();
    r.measure(measuring);
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    await sleep(1500);
    const out = [];
    handle.shadowStats();
    for (let w = 0; w < WINDOWS; w++) {
      window.__gpu(true);
      const since = performance.now();
      await sleep(2000);
      const g = window.__gpu(), s = handle.shadowStats(), f = window.__frames(since), lv = handle.buildingLevels();
      out.push({ scene: window.__measure.sign(window.__measure.scene()), p50: g.p50, p95: g.p95, n: g.n, passes: s?.passes, whole: s?.whole?.join('/'), why: JSON.stringify(s?.why), cpu: f.total?.p50, chosenTri: lv.chosenTriangles, detail: lv.shownDetail, facade: lv.shownFacade });
    }
    r.measure(true);
    return { out };
  }, { WINDOWS, measuring });
  console.log(`\n== ${measuring ? 'measure mode (clock held)' : 'game running'} ==`);
  console.log(sameScene(rows.out).line);
  for (const o of rows.out) console.log(`GPU p50 ${String(o.p50).padStart(6)} p95 ${String(o.p95).padStart(6)} n ${o.n}  CPU ${o.cpu}  shadow passes ${o.passes} whole ${o.whole} by ${o.why}  tri ${o.chosenTri} det ${o.detail} facade ${o.facade}`);
}
await browser.close();
