// A BRUSH STROKE'S PICTURES AND COUNTS, for an A/B of two builds of the game (`landStroke.ts`: the page's work moved to a worker must draw the same).
// The small city of a seed opened and held by `lib/measureCity.mjs`, frames drawn with no time passed (the wind, the water, the clouds), people and
// vehicles hidden; the same stroke laid through the document (a raise stroke and a river stroke, dab by dab, a frame apart), then the views mapa
// (zoom 1), bairro (4) and rua (14) on the stroke, each shot twice to know the floor of the noise. Counted, never timed: the calls of the ground's
// functions on the page's thread during the stroke (V8 precise coverage, call counts) and the bytes posted to the dab's worker.
// Usage: npm run dev (or another port), then  node scripts/strokeShots.mjs --base http://127.0.0.1:5300/ --out test-results/strokeShots/after [--spread]
//   --spread: before the stroke the map's terrain is made 4x larger: stamps laid over a square twice as wide as the city, and the plates there visited.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { arg, lookAt, openCity } from './lib/measureCity.mjs';

const OUT = arg('--out', 'test-results/strokeShots/run');
const SPREAD = process.argv.includes('--spread');
const ZOOM = { mapa: 1, bairro: 4, rua: 14 };
/** The functions counted on the page: the dab's ground work and what it reads. */
const COUNTED = ['sampleCorners', 'natureNoise', 'natureDensity', 'woodsBaseInto', 'woodsBase', 'coarseRange', 'parting', 'measure', 'shoreLevels', 'shoreLevelsInto',
  'sampleTerrainHeight', 'cellDiagonal', 'landNormalsInto', 'landTexelsInto', 'unifiedWaterGeometry', 'woodsOutsideReads', 'measureLevels', 'woodsBlock'];
mkdirSync(OUT, { recursive: true });

/** The bytes posted to the dab's worker (`landStroke`), counted at `Worker.postMessage`, before the game's code runs. */
const countPosts = () => {
  // The page's own randomness the same at every load (mulberry32 of a fixed seed): two loads of one build draw one picture.
  let seed = 0x5eed;
  Math.random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  // Every frame drawn with no time passed from the FIRST one (the wind's sway and the clouds' drift add up the frames' time: frozen once the
  // city was open they held what the loading's frames had added, different at each load): `__roadcraft`'s draw wrapped as the game sets it.
  let probes;
  Object.defineProperty(window, '__roadcraft', {
    configurable: true,
    get: () => probes,
    set: (value) => {
      probes = value;
      const handle = value.scene();
      const draw = handle.draw;
      handle.draw = (net, sim, alpha, _delta, options) => draw.call(handle, net, sim, alpha, 0, options);
    },
  });
  const post = Worker.prototype.postMessage;
  window.__posted = { landStroke: 0, landStrokeBytes: 0 };
  Worker.prototype.postMessage = function (message, transfer) {
    if (message && message.service === 'landStroke') {
      window.__posted.landStroke++;
      for (const value of Object.values(message.data ?? {})) if (ArrayBuffer.isView(value)) window.__posted.landStrokeBytes += value.byteLength;
    }
    return post.call(this, message, transfer);
  };
};

// The clock held BEFORE the city opens: held after, it stopped at a different minute each load, and the trees, the furniture and the population
// with it (two loads of one build differed in 50-70 thousand pixels, 2026-10-19).
const { browser, page } = await openCity({ zoom: 4, width: 1920, height: 1080, free: false, init: countPosts, city: false, settle: false });
await page.evaluate(() => window.__roadcraft.measure(true));
// No wind: the plants still and the clouds where they are (the player's ask for the pictures).
await page.evaluate(() => window.__roadcraft.doc.setWeather({ wind: 0 }));
await page.evaluate(() => window.__roadcraft.smallCity(7));
await page.waitForTimeout(8000);
await page.evaluate(() => window.__roadcraft.doc.setWeather({ wind: 0 }));
await page.waitForTimeout(8000);
const fit = await page.evaluate(() => ({ x: window.__roadcraft.camera.x, y: window.__roadcraft.camera.y, zoom: window.__roadcraft.camera.zoom }));
await lookAt(page, fit, 4);
console.log(`base ${arg('--base', 'http://127.0.0.1:5300/')}  cidade ${JSON.stringify(fit)}`);
// The wall's clock held and the agents hidden (as `scripts/lib/passVariants.mjs` freeze): two shots of one picture equal to the pixel.
await page.evaluate(() => {
  const handle = window.__roadcraft.scene();
  for (const g of handle.scene.children) if (g.name === 'agent-parts' || g.name === 'densityCars') { g.visible = false; Object.defineProperty(g, 'visible', { configurable: true, get: () => false, set: () => {} }); }
});
const units = await page.evaluate(async () => (await import('/src/world/units.ts')).m(1));
// The stroke where the city stands: its centre, and a river beside it.
const at = { x: fit.x, y: fit.y };

if (SPREAD) {
  // The map's terrain 4x the city's: a stamp every 160 m over a square twice as wide as the city's view, each plate there visited once.
  // The city's view is the screen at `fit.zoom` (pixels a world unit): a square twice its width, its half one width.
  const half = await page.evaluate((zoom) => { const r = window.__roadcraft; return Math.max(r.surface.cssW, r.surface.cssH) / zoom; }, fit.zoom);
  await page.evaluate(({ at, half, units }) => {
    const doc = window.__roadcraft.doc;
    for (let y = at.y - half; y <= at.y + half; y += 160 * units) for (let x = at.x - half; x <= at.x + half; x += 160 * units) {
      if (Math.hypot(x - at.x, y - at.y) < 300 * units) continue;
      doc.addTerrainStamp({ x, y, radius: 40 * units, strength: 3 * units, mode: 'raise', rough: true });
    }
  }, { at, half, units });
  for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
    await page.evaluate(({ x, y }) => window.__roadcraft.lookAt(x, y, window.__roadcraft.camera.zoom), { x: at.x + x * half * 0.7, y: at.y + y * half * 0.7 });
    await page.waitForTimeout(3000);
  }
  await lookAt(page, fit, 4);
}

await page.evaluate(({ x, y }) => window.__roadcraft.lookAt(x, y, window.__roadcraft.camera.zoom), at);
await page.evaluate(() => window.__measure.settle());
const cdp = await page.context().newCDPSession(page);
await cdp.send('Profiler.enable');
await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
await cdp.send('Profiler.takePreciseCoverage');
const postedBefore = await page.evaluate(() => ({ ...window.__posted }));
// The stroke: 12 raise dabs along a line, then 6 river dabs across it, one a frame, as the brush lays them.
await page.evaluate(async ({ at, units }) => {
  const doc = window.__roadcraft.doc;
  const frame = () => new Promise((done) => requestAnimationFrame(() => done()));
  for (let k = 0; k < 12; k++) {
    doc.addTerrainStamp({ x: at.x - 60 * units + k * 10 * units, y: at.y + 40 * units, radius: 28 * units, strength: 4 * units, mode: 'raise', rough: true, stroke: 901, ox: at.x, oy: at.y });
    window.__roadcraft.redraw();
    await frame();
  }
  for (let k = 0; k < 6; k++) {
    doc.addTerrainStamp({ x: at.x + 30 * units, y: at.y - 80 * units + k * 12 * units, radius: 22 * units, strength: 3 * units, mode: 'river', rough: true, stroke: 902, ox: at.x, oy: at.y });
    window.__roadcraft.redraw();
    await frame();
  }
}, { at, units });
// Everything the stroke asked landed: the workers' answers, the water, the world rebuilt on the ground.
await page.waitForTimeout(8000);
await page.evaluate(() => window.__measure.settle());
const { result } = await cdp.send('Profiler.takePreciseCoverage');
await cdp.send('Profiler.stopPreciseCoverage');
const posted = await page.evaluate((b) => ({ landStroke: window.__posted.landStroke - b.landStroke, landStrokeBytes: window.__posted.landStrokeBytes - b.landStrokeBytes }), postedBefore);
const calls = {};
for (const script of result) {
  if (!/\/src\//.test(script.url)) continue;
  const file = script.url.replace(/^.*\/src\//, 'src/').replace(/\?.*$/, '');
  for (const fn of script.functions) {
    if (!COUNTED.includes(fn.functionName)) continue;
    const key = `${fn.functionName} (${file})`;
    calls[key] = (calls[key] ?? 0) + fn.ranges[0].count;
  }
}
const counts = { spread: SPREAD, calls, posted, stamps: await page.evaluate(() => window.__roadcraft.doc.terrainStamps.length) };
writeFileSync(join(OUT, 'counts.json'), JSON.stringify(counts, null, 2));
console.log('chamadas na thread da página durante a pincelada:');
for (const [key, n] of Object.entries(calls).sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(12)}  ${key}`);
console.log(`mensagens ao worker landStroke: ${posted.landStroke}, ${posted.landStrokeBytes} bytes; carimbos no mapa: ${counts.stamps}`);

if (!SPREAD) {
  for (const [view, zoom] of Object.entries(ZOOM)) {
    await page.evaluate(({ x, y, zoom }) => window.__roadcraft.lookAt(x, y, zoom), { x: at.x, y: at.y, zoom: fit.zoom * zoom });
    await page.evaluate(() => window.__measure.settle());
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(OUT, `${view}.png`) });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(OUT, `${view}-again.png`) });
    console.log(`foto ${view} (zoom ${zoom}): ${join(OUT, `${view}.png`)} e -again`);
  }
}
await browser.close();
