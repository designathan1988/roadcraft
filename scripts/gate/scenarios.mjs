// The gate's fixed scenarios, run in one game page through its real controls
// (docs/PLAN.md section 2). Each returns numbers; pictures are written to `out`.
import { join } from 'node:path';
import { begin, clickWorld, dock, drawerTab, drawn, end, heap, look, measure, phase, ready, screenOf, sleep } from './page.mjs';

const shot = async (page, out, name, photos) => {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  photos.push(name);
};

/** The scenarios on an empty map, then on a generated city of 400 people and 400 vehicles. */
export async function cityRun(page, cdp, out, opts, n = {}, photos = []) {
  // `n` and `photos` belong to the caller: a step that fails keeps what the steps before it measured.
  phase.now = 'vazio';
  // 1. Empty map: opening, then the idle frames.
  n.openMs = await ready(page);
  await sleep(3000);
  n.empty = await measure(page, 6000);
  n.emptyDrawn = await drawn(page);
  n.emptyHeap = await heap(cdp, true);
  await shot(page, out, 'vazio', photos);

  phase.now = 'crescer';
  // 5. Zoning and growing: the generated city, measured while it grows.
  await begin(page);
  const g0 = Date.now();
  const city = await page.evaluate(async () => {
    const R = window.__roadcraft;
    R.generateCity({});
    for (let i = 0; i < 400 && R.cityGrowth(); i++) await new Promise((r) => setTimeout(r, 500));
    const ns = [...R.doc.nodes.values()];
    return {
      nodes: ns.length, segments: R.doc.segments.size, buildings: R.doc.buildings.size,
      x0: Math.min(...ns.map((p) => p.x)), x1: Math.max(...ns.map((p) => p.x)),
      y0: Math.min(...ns.map((p) => p.y)), y1: Math.max(...ns.map((p) => p.y)),
    };
  });
  n.growMs = Date.now() - g0;
  n.grow = await end(page);
  n.city = city;
  const cx = (city.x0 + city.x1) / 2;
  const cy = (city.y0 + city.y1) / 2;

  phase.now = 'povoar';
  // The crowd out: 400 people, 400 vehicles, measured while they come.
  await begin(page);
  const f0 = Date.now();
  await page.evaluate(() => { const R = window.__roadcraft; R.sim.trafficCount = 400; R.sim.pedestrianCount = 400; });
  let counts = { vehicles: 0, people: 0 };
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    counts = await page.evaluate(() => { const m = document.body.innerText.match(/(\d+) veículos · (\d+) pessoas/); return m ? { vehicles: Number(m[1]), people: Number(m[2]) } : { vehicles: 0, people: 0 }; });
    if (counts.vehicles >= 340 && counts.people >= 340) break;
  }
  n.fillMs = Date.now() - f0;
  n.fill = await end(page);
  n.crowd = counts;

  phase.now = 'vistas';
  // 2. The views: street, neighbourhood, high, and close to a person.
  const west = await page.evaluate(({ x0 }) => {
    const ns = [...window.__roadcraft.doc.nodes.values()];
    return ns.reduce((a, c) => (Math.hypot(a.x - x0, a.y) < Math.hypot(c.x - x0, c.y) ? a : c));
  }, city);
  const views = {
    rua: { x: west.x, y: west.y, zoom: 14, azimuth: 0.6, elevation: 0.3 },
    bairro: { x: cx, y: cy, zoom: 3, azimuth: 0.8, elevation: 0.8 },
    alto: { x: cx, y: cy, zoom: 0.6, azimuth: 0.8, elevation: 1.1 },
  };
  n.views = {};
  for (const [name, v] of Object.entries(views)) {
    await look(page, v, 4000);
    const m = await measure(page, 8000);
    n.views[name] = { ...m, drawn: await drawn(page) };
    await shot(page, out, name, photos);
  }
  const person = await page.evaluate(({ x, y }) => {
    const pv = window.__roadcraft.sim.pedViews.filter((p) => p.walking);
    return pv.reduce((a, c) => (Math.hypot(a.x - x, a.y - y) < Math.hypot(c.x - x, c.y - y) ? a : c), pv[0]);
  }, views.rua);
  if (person) {
    await look(page, { x: person.x, y: person.y, zoom: 80, azimuth: 0.6, elevation: 0.6 }, 3000);
    const m = await measure(page, 6000);
    n.views.perto = { ...m, drawn: await drawn(page) };
    // The picture with the simulation paused, the camera back on the same person (who walked on while measured).
    await page.evaluate(() => window.__roadcraft.setTraffic(false));
    const now = await page.evaluate((id) => window.__roadcraft.sim.pedViews.find((q) => q.id === id) ?? null, person.id);
    if (now) await look(page, { x: now.x, y: now.y, zoom: 80, azimuth: 0.6, elevation: 0.6 }, 1500);
    await shot(page, out, 'perto', photos);
    await page.evaluate(() => window.__roadcraft.setTraffic(true));
  }

  phase.now = 'movimento';
  // 3. Moving: spin, pan, zoom from the street to the farthest and back.
  await look(page, views.rua, 3000);
  n.spin = await measure(page, 6500, () => page.evaluate(() => new Promise((done) => {
    const v = window.__roadcraft.scene().viewport;
    const t0 = performance.now();
    const step = (t) => { const k = (t - t0) / 6000; v.setOrbit(0.6 + k * 2 * Math.PI, 0.3); window.__roadcraft.redraw(); if (k < 1) requestAnimationFrame(step); else done(); };
    requestAnimationFrame(step);
  })));
  n.pan = await measure(page, 6500, () => page.evaluate(({ x, y, cx, cy }) => new Promise((done) => {
    const R = window.__roadcraft;
    const t0 = performance.now();
    const step = (t) => { const k = Math.min(1, (t - t0) / 6000); R.lookAt(x + (cx - x) * k * 2, y + (cy - y) * k * 2, 14); if (k < 1) requestAnimationFrame(step); else done(); };
    requestAnimationFrame(step);
  }), { ...views.rua, cx, cy }));
  await look(page, views.rua, 2000);
  n.zoom = await measure(page, 12500, () => page.evaluate(() => new Promise((done) => {
    const R = window.__roadcraft;
    const v = R.view();
    const bounds = typeof v.zoomBounds === 'function' ? v.zoomBounds() : v.zoomBounds;
    const lo = Math.log(bounds.min * 1.05);
    const hi = Math.log(14);
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 12000);
      const u = k < 0.5 ? k * 2 : 2 - k * 2;
      R.lookAt(R.camera.x, R.camera.y, Math.exp(hi + (lo - hi) * u));
      if (k < 1) requestAnimationFrame(step); else done();
    };
    requestAnimationFrame(step);
  })));

  phase.now = 'vias';
  // 4. Ten roads drawn by clicks: five beside the city, five far from it.
  n.edits = [];
  for (let k = 0; k < 10; k++) {
    const far = k >= 5;
    // Far: 600 m past the city, inside the planet's playable area (the camera stops near 1 km).
    const x = city.x1 + (far ? 600 : 90);
    const y = cy + ((k % 5) - 2) * 30;
    await look(page, { x: x + 30, y: y - 20, zoom: 4, azimuth: Math.PI / 2, elevation: 1.3 }, 2500);
    await page.keyboard.press('Escape');
    await dock(page, 0);
    await drawerTab(page, 'Desenhar');
    await clickWorld(page, x, y);
    const segs = await page.evaluate(() => {
      const w = window;
      w.__edit = { t0: performance.now(), measures: [], frames: [] };
      w.__editObs?.disconnect();
      w.__editObs = new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__edit.measures.push({ name: e.name, start: e.startTime, duration: e.duration }); });
      w.__editObs.observe({ type: 'measure' });
      const tick = (t) => { w.__edit.frames.push(t); if (t - w.__edit.t0 < 6000) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
      return window.__roadcraft.doc.segments.size;
    });
    await clickWorld(page, x + 60, y);
    await sleep(6500);
    n.edits.push(await page.evaluate((before) => {
      const e = window.__edit;
      const f = e.frames;
      const of = (re) => e.measures.filter((m) => m.start >= e.t0 && re.test(m.name));
      const gaps = f.slice(1).map((t, i) => t - f[i]);
      const world = of(/^hitch:road-edit\/world rebuilt/);
      return {
        built: window.__roadcraft.doc.segments.size > before,
        clickMs: Math.max(0, ...of(/^hitch:mutate\/edit\+after/).map((m) => m.duration)),
        worldMs: Math.max(0, ...world.map((m) => m.duration)),
        readyMs: world.length ? Math.max(...world.map((m) => m.start + m.duration - e.t0)) : -1,
        groundMs: Math.max(0, ...of(/ground shape/).map((m) => m.start + m.duration - e.t0)),
        over33: gaps.filter((g) => g > 33.9).length,
        maxGap: Math.max(0, ...gaps),
      };
    }, segs));
    await page.keyboard.press('Escape');
    if (k === 4 || k === 9) {
      // The drawer closed, so the new roads are not under it.
      await page.evaluate(() => document.querySelector('.v2-drawer button[title="Fechar"]')?.click());
      await sleep(500);
      await shot(page, out, far ? 'via-longe' : 'via-perto', photos);
    }
  }
  n.editsHeap = await heap(cdp, true);

  // 6. The bomb, then the pistol (Actions, Demolish drawer). After the roads:
  // at the SOURCE a shot can break the physics and hang the page
  // (docs/PROBLEMS.md R1), which must not cost the steps before it.
  phase.now = 'bomba';
  await look(page, views.bairro, 3000);
  await dock(page, 5);
  n.bombTab = await drawerTab(page, 'Bomba');
  n.bomb = await measure(page, 9000, async () => {
    const target = await page.evaluate(({ cx, cy }) => {
      const bs = [...window.__roadcraft.doc.buildings.all()];
      return bs.reduce((a, b) => (Math.hypot(a.x - cx, a.y - cy) < Math.hypot(b.x - cx, b.y - cy) ? a : b));
    }, { cx, cy });
    await clickWorld(page, target.x, target.y);
    await sleep(1500);
    await shot(page, out, 'bomba', photos);
  });
  phase.now = 'pistola';
  n.pistolTab = await drawerTab(page, 'Pistola');
  if (person) {
    await page.evaluate(() => window.__roadcraft.setTraffic(false));
    const p = await page.evaluate(() => window.__roadcraft.sim.pedViews.find((q) => q.walking));
    // From nearly overhead: a low camera beside a person can end inside a facade.
    await look(page, { x: p.x, y: p.y, zoom: 60, azimuth: 0.6, elevation: 1.2 }, 2000);
    n.pistol = await measure(page, 6000, async () => {
      const q = await page.evaluate((id) => window.__roadcraft.sim.pedViews.find((r) => r.id === id), p.id);
      if (!q) return;
      const z = await page.evaluate(({ x, y }) => window.__roadcraft.scene().terrainHeightAt(x, y), q);
      const s = await screenOf(page, q.x, q.y, z + 1.2);
      await page.mouse.click(s.x, s.y);
      await sleep(1200);
      await shot(page, out, 'pistola', photos);
    });
    await page.evaluate(() => window.__roadcraft.setTraffic(true));
  }
  await page.keyboard.press('Escape');

  phase.now = 'parado';
  // 9. Standing still: the heap over `idleMinutes`, collected each minute.
  if (opts.idleMinutes > 0) {
    await look(page, views.rua, 3000);
    const samples = [];
    const t0 = Date.now();
    await begin(page);
    for (let m = 0; m <= opts.idleMinutes; m++) {
      samples.push({ min: (Date.now() - t0) / 60000, ...(await heap(cdp, true)) });
      if (m < opts.idleMinutes) await sleep(60000);
    }
    n.idle = { ...(await end(page)), samples, slopeMBperMin: slope(samples.map((s) => [s.min, s.usedMB])) };
  }

  // 8. Switching mode, on the populated world, last (the flat build leaves the page for the planet's).
  phase.now = 'modo';
  await look(page, views.bairro, 3000);
  const sw = await modeRun(page, out, false);
  Object.assign(n, sw.numbers);
  photos.push(...sw.photos);
  return { numbers: n, photos };
}

/** Least-squares slope of [x, y] points. */
function slope(points) {
  const k = points.length;
  if (k < 2) return 0;
  const mx = points.reduce((a, p) => a + p[0], 0) / k;
  const my = points.reduce((a, p) => a + p[1], 0) / k;
  const sxy = points.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0);
  const sxx = points.reduce((a, p) => a + (p[0] - mx) ** 2, 0);
  return sxx ? sxy / sxx : 0;
}

/** 7. Opening a large map (one of the player's, copied) through the game's own file picker. */
export async function openMapRun(page, out, file) {
  const photos = [];
  await ready(page);
  await sleep(2000);
  await begin(page);
  const t0 = Date.now();
  const chooser = page.waitForEvent('filechooser');
  const opened = page.evaluate(() => window.__roadcraft.importMap());
  await (await chooser).setFiles(file);
  await opened;
  await sleep(500);
  await ready(page, 300000);
  const n = { openMapMs: Date.now() - t0 };
  n.openMap = await end(page);
  const info = await page.evaluate(() => {
    const R = window.__roadcraft;
    const ns = [...R.doc.nodes.values()];
    return { nodes: ns.length, segments: R.doc.segments.size, buildings: R.doc.buildings.size, x: ns.reduce((a, p) => a + p.x, 0) / ns.length, y: ns.reduce((a, p) => a + p.y, 0) / ns.length };
  });
  n.map = info;
  await look(page, { x: info.x, y: info.y, zoom: 3, azimuth: 0.8, elevation: 0.8 }, 5000);
  n.mapView = { ...(await measure(page, 6000)), drawn: await drawn(page) };
  await shot(page, out, 'mapa-grande', photos);
  return { numbers: n, photos };
}

/** 8. Switching mode with the top bar's button: in place on the planet, to the other page on the flat build. */
export async function modeRun(page, out, fresh = true) {
  const photos = [];
  if (fresh) {
    await ready(page);
    await sleep(2000);
  }
  // The button by its text ("Planeta" / "Mapa plano"): its title is taken over by the shell's tooltip after a click.
  const button = page.locator('button.v2-pill').filter({ hasText: /^(Planeta|Mapa plano)$/ }).first();
  const n = { modeLabel: await button.textContent() };
  const url0 = page.url();
  await begin(page);
  const t0 = Date.now();
  await button.click();
  await sleep(500);
  if (page.url() !== url0) {
    n.modeNavigated = true;
    await page.waitForLoadState('load');
    await ready(page);
    n.modeMs = Date.now() - t0;
    n.mode = null;
  } else {
    // At the SOURCE the flat view can stay "busy" for minutes (docs/PROBLEMS.md):
    // waited for 30 s at most, and whether it settled is a number of its own.
    n.modeSettled = await ready(page, 30000).then(() => true, () => false);
    n.modeMs = Date.now() - t0;
    await sleep(3000);
    n.mode = await end(page);
    n.modeBusy = await page.evaluate(() => window.__roadcraft.scene().busy());
    await shot(page, out, 'modo-trocado', photos);
    await begin(page);
    await button.click();
    await sleep(3000);
    n.modeBack = await end(page);
  }
  return { numbers: n, photos };
}
