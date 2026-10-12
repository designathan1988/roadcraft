// Helpers the gate runs against one open game page: readiness, measured
// windows (frame intervals, long frames, GPU, programs linked, bytes uploaded,
// draw calls), the heap through the DevTools protocol, and the real controls
// (dock, drawer tabs, clicks on world points).

export const W = 1280;
export const H = 720;
/** Two periods of a 59 Hz display: a frame interval above it is a visible stutter. */
const STUTTER_MS = 2 * (1000 / 59);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The step a scenario is in, so a page error can say where it happened. */
export const phase = { now: '' };

/** Waits until the game is up and its world is built; returns ms since navigation start. */
export async function ready(page, timeout = 240000) {
  await page.waitForFunction(() => {
    const R = window.__roadcraft;
    if (!R?.scene) return false;
    const s = R.scene();
    // The world built (`worldBusy`, `opening`), not `busy()`: that one stays true
    // while effects play (a bomb's fire burns for minutes).
    return !s.opening && !s.worldBusy && !/Carregando o mapa/.test(document.body.innerText);
  }, null, { timeout, polling: 200 });
  return page.evaluate(() => performance.now());
}

/** Starts a measured window inside the page. */
export async function begin(page) {
  await page.evaluate(() => {
    const g = window.__gate;
    const kinds = new Map([...g.up.byKind].map(([k, v]) => [k, v.bytes]));
    const w = { t0: performance.now(), gaps: [], prev: -1, stop: false, links: g.links, up: { buffer: g.up.buffer, texture: g.up.texture, calls: g.up.calls, kinds } };
    window.__win = w;
    window.__gpu?.(true);
    const tick = (t) => {
      if (w.stop) return;
      if (w.prev >= 0) w.gaps.push(t - w.prev);
      w.prev = t;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

/** Ends the window: the numbers of what happened in it. */
export async function end(page) {
  return page.evaluate((stutter) => {
    const g = window.__gate;
    const w = window.__win;
    w.stop = true;
    const t1 = performance.now();
    const gaps = [...w.gaps].sort((a, b) => a - b);
    const at = (p) => (gaps.length ? gaps[Math.min(gaps.length, Math.max(1, Math.ceil((p / 100) * gaps.length))) - 1] : 0);
    const loaf = g.loaf.filter((e) => e.start >= w.t0 && e.start <= t1);
    const worst = [...loaf].sort((a, b) => b.duration - a.duration).slice(0, 3);
    const gpu = window.__gpu?.() ?? null;
    return {
      ms: t1 - w.t0,
      frames: gaps.length,
      p50: at(50), p95: at(95), p99: at(99), max: at(100),
      stutters: gaps.filter((x) => x > stutter).length,
      over50: gaps.filter((x) => x > 50).length,
      loafCount: loaf.length,
      loafMax: loaf.reduce((a, e) => Math.max(a, e.duration), 0),
      loafBlocking: loaf.reduce((a, e) => a + e.blocking, 0),
      loafWorst: worst.map((e) => ({ duration: Math.round(e.duration), scripts: e.scripts })),
      gpu: gpu?.supported ? { p50: gpu.p50, p95: gpu.p95, p99: gpu.p99, max: gpu.max, n: gpu.n, label: gpu.label } : null,
      programsLinked: g.links - w.links,
      uploadBuffer: g.up.buffer - w.up.buffer,
      uploadTexture: g.up.texture - w.up.texture,
      uploadCalls: g.up.calls - w.up.calls,
      uploadTop: [...g.up.byKind].map(([k, v]) => [k, v.bytes - (w.up.kinds.get(k) ?? 0), v.calls])
        .filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, bytes]) => ({ kind: k, MB: +(bytes / 1e6).toFixed(1) })),
    };
  }, STUTTER_MS);
}

/** Runs `fn` inside a measured window lasting at least `ms`. */
export async function measure(page, ms, fn = null) {
  await begin(page);
  const t0 = Date.now();
  if (fn) await fn();
  const left = ms - (Date.now() - t0);
  if (left > 0) await sleep(left);
  return end(page);
}

/** Draw calls and triangles of one whole frame (the largest of five), and the programs the renderer holds. */
export async function drawn(page) {
  return page.evaluate(async () => {
    const R = window.__roadcraft;
    const gl = R.scene().gl;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    let calls = 0;
    let triangles = 0;
    gl.info.autoReset = false;
    // The game draws on demand: each measured frame is asked for.
    for (let i = 0; i < 5; i++) {
      await frame();
      gl.info.reset();
      R.redraw();
      await frame();
      calls = Math.max(calls, gl.info.render.calls);
      triangles = Math.max(triangles, gl.info.render.triangles);
    }
    gl.info.autoReset = true;
    return { calls, triangles, programs: gl.info.programs?.length ?? 0, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures };
  });
}

/** The JavaScript heap in MB, after a full collection when `collect` (DevTools protocol, HeapProfiler and Performance domains). */
export async function heap(cdp, collect = false) {
  if (collect) await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const get = (name) => metrics.find((m) => m.name === name)?.value ?? 0;
  return { usedMB: get('JSHeapUsedSize') / 1e6, totalMB: get('JSHeapTotalSize') / 1e6 };
}

/** Clicks the dock button `index` (0 Roads … 5 Demolish). */
export async function dock(page, index) {
  await page.$$eval('.v2-dock button', (b, i) => b[i].click(), index);
  await sleep(600);
}

/** Clicks the drawer tab whose text is `label`. */
export async function drawerTab(page, label) {
  const found = await page.evaluate((text) => {
    const b = [...document.querySelectorAll('.v2-drawer button')].find((x) => x.textContent.trim() === text);
    b?.click();
    return Boolean(b);
  }, label);
  await sleep(400);
  return found;
}

/** The screen point of a world point (at height `z` above the reference). */
export function screenOf(page, x, y, z = 0) {
  return page.evaluate(({ x, y, z, W, H }) => window.__roadcraft.scene().viewport.toScreen({ x, y }, W, H, z), { x, y, z, W, H });
}

/** A real mouse click on a world point, the pointer moved there first. */
export async function clickWorld(page, x, y) {
  const s = await screenOf(page, x, y);
  await page.mouse.move(s.x, s.y, { steps: 4 });
  await sleep(150);
  await page.mouse.click(s.x, s.y);
  await sleep(300);
}

/** Puts the camera on a world point, with a zoom and an orbit, and waits for the view to settle. */
export async function look(page, { x, y, zoom, azimuth, elevation }, settle = 2500) {
  await page.evaluate(({ x, y, zoom, azimuth, elevation }) => {
    const R = window.__roadcraft;
    R.lookAt(x, y, zoom);
    R.scene().viewport.setOrbit(azimuth, elevation);
    R.redraw();
  }, { x, y, zoom, azimuth, elevation });
  await sleep(settle);
}
