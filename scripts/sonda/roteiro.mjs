// THE FIXED SCRIPT (PLANO-SONDA.md §5): the small city of seed 7 at 1920x1080, scenes 1 to 9, the same in both passes. Each scene
// says the view it holds (the budget's name), and what it does to the page through `ctx`; what is read at its end is the driver's
// (`rodar.mjs`). Scene 10 (the 4x city) is not in Etapa 0.
// The gestures are the player's own: keys and mouse drags on the canvas, never a call into a tool - except where the game exposes no
// gesture to the probe (`growTimed`, `setQuality`, `setWeather`, `setSkyMode`), said in the report.

const deg = (d) => (d * Math.PI) / 180;

/** A left-button drag at a hand's pace: `steps` moves spread over `ms`, held `hold` ms before letting go. */
async function drag(page, [x0, y0], [x1, y1], { ms = 1500, steps = 60, hold = 300, button = 'left' } = {}) {
  await page.mouse.move(x0, y0);
  await page.mouse.down({ button });
  const t0 = Date.now();
  for (let k = 1; k <= steps; k++) {
    await page.mouse.move(x0 + ((x1 - x0) * k) / steps, y0 + ((y1 - y0) * k) / steps);
    const due = t0 + (ms * k) / steps - Date.now();
    if (due > 0) await page.waitForTimeout(due);
  }
  if (hold) await page.waitForTimeout(hold);
  await page.mouse.up({ button });
}

/** The edit settled: the network rebuilt for the document and the world not busy (the route's own `until`, `scripts/look/route.json`). */
async function editSettled(page, timeout = 120000) {
  const t0 = Date.now();
  await page.waitForFunction(() => { const r = window.__roadcraft; return r.net.revision === r.doc.revision && !r.scene().worldBusy; }, null, { timeout, polling: 100 });
  return Date.now() - t0;
}

/** The document's counts the edits are checked against. */
const counts = (page) => page.evaluate(() => ({ segments: window.__roadcraft.doc.segments.size, buildings: window.__roadcraft.doc.buildings.size, poles: window.__roadcraft.doc.poles.size, stamps: window.__roadcraft.doc.terrainStamps.length }));

/** One building taken down by the bulldozer's click (the tool already in hand): the nearest to the camera not tried yet, clicked at its centre
 *  projected to the screen. A click that took a road or a pole instead (a grid of clicks did: depuracao-3) is undone (Ctrl+Z) and the next tried.
 *  Returns whether a building went, and the clicks spent. */
async function demolishOne(page, tried, most = 12) {
  for (let k = 0; k < most; k++) {
    const t = await page.evaluate((tried) => {
      const r = window.__roadcraft, v = r.view(), w = innerWidth, h = innerHeight, cam = r.camera;
      let best = null;
      for (const b of r.doc.buildings.all()) {
        if (tried.includes(b.id)) continue;
        const p = v.toScreen({ x: b.x, y: b.y }, w, h, r.scene().terrainHeightAt(b.x, b.y));
        const d = Math.hypot(b.x - cam.x, b.y - cam.y);
        if (p.x > 120 && p.x < w - 120 && p.y > 120 && p.y < h - 240 && (!best || d < best.d)) best = { id: b.id, x: p.x, y: p.y, d };
      }
      return best;
    }, tried);
    if (!t) return { ok: false, clicks: k };
    tried.push(t.id);
    const was = await counts(page);
    await page.mouse.click(t.x, t.y);
    await page.waitForTimeout(200);
    const now = await counts(page);
    if (now.segments < was.segments || now.poles < was.poles) { await page.keyboard.press('Control+z'); await page.waitForTimeout(200); continue; }
    if (now.buildings < was.buildings) return { ok: true, clicks: k + 1 };
  }
  return { ok: false, clicks: most };
}

export const SCENES = [
  {
    n: 1, name: 'abertura', budget: 'map',
    /** The city opened as the menu opens it, timed until shown and until settled. */
    async run(ctx) {
      const { page } = ctx;
      const t0 = Date.now();
      await page.evaluate((seed) => { performance.clearMarks('opening:shown'); window.__roadcraft.smallCity(seed); }, ctx.cfg.seed);
      await page.waitForFunction(() => performance.getEntriesByName('opening:shown').length > 0 || (!window.__roadcraft.scene().opening && window.__roadcraft.memory().drawCalls > 100), null, { timeout: 600000, polling: 250 });
      ctx.note('shownMs', Date.now() - t0);
      const settled = await ctx.settle();
      ctx.note('settledMs', Date.now() - t0);
      ctx.note('settle', settled);
      ctx.fit = await page.evaluate(() => ({ x: window.__roadcraft.camera.x, y: window.__roadcraft.camera.y, zoom: window.__roadcraft.camera.zoom }));
      await ctx.shot('abertura');
    },
  },
  {
    n: 2, name: 'cidade-parada-sim-pausada', budget: 'map',
    /** The whole city, the player's pause (the frame loop on demand, as it is for a player who paused), nothing touched for `holdMs`. */
    async run(ctx) {
      await ctx.lookAt('cidade');
      await ctx.page.evaluate(() => window.__roadcraft.setTraffic(false));
      ctx.note('settle', await ctx.settle());
      // The picture before the window: its two frames drawn would count as work of the still seconds.
      await ctx.shot('cidade-parada');
      await ctx.since();
      await ctx.hold();
    },
  },
  {
    n: 3, name: 'cidade-parada-sim-rodando', budget: 'map',
    async run(ctx) {
      await ctx.page.evaluate(() => window.__roadcraft.setTraffic(true));
      ctx.note('settle', await ctx.settle());
      await ctx.since();
      await ctx.hold();
      await ctx.shot('cidade-rodando');
    },
  },
  {
    n: 4, name: 'bairro-parado-e-girando', budget: 'district',
    async run(ctx) {
      await ctx.lookAt('bairro');
      ctx.note('settle', await ctx.settle());
      await ctx.since();
      await ctx.hold(3000);
      await ctx.shot('bairro-parado');
      ctx.note('orbitFrames', await ctx.orbit('bairro', 6000));
      await ctx.shot('bairro-girado');
    },
  },
  {
    n: 5, name: 'rua-parada-e-girando', budget: 'street',
    async run(ctx) {
      await ctx.lookAt('rua');
      ctx.note('settle', await ctx.settle());
      await ctx.since();
      await ctx.hold(3000);
      await ctx.shot('rua-parada');
      ctx.note('orbitFrames', await ctx.orbit('rua', 6000));
      await ctx.shot('rua-girada');
    },
  },
  {
    n: 6, name: 'zoom-bairro-ate-rua', budget: 'street',
    /** From the district's zoom to the street's in 10 geometric steps, 800 ms each: the levels swap under the camera. */
    async run(ctx) {
      const { page, fit, cfg } = ctx;
      await ctx.lookAt('bairro');
      ctx.note('settle', await ctx.settle());
      await ctx.since();
      const z0 = fit.zoom * cfg.views.bairro.zoom, z1 = fit.zoom * cfg.views.rua.zoom;
      for (let k = 1; k <= 10; k++) {
        const z = z0 * Math.pow(z1 / z0, k / 10);
        await page.evaluate(({ x, y, z, az, el }) => window.__roadcraft.setView({ x, y, zoom: z, azimuth: az, elevation: el }), { x: fit.x, y: fit.y, z, az: deg(cfg.orbit.azimuthDeg), el: deg(cfg.orbit.elevationDeg) });
        await page.waitForTimeout(800);
        if (k === 5) await ctx.shot('zoom-meio');
      }
      ctx.note('settle', await ctx.settle());
      await ctx.shot('zoom-fim');
    },
  },
  {
    n: 7, name: 'edicao-via-terreno-crescimento', budget: 'district',
    /** One road drawn with the road tool (key 1, a drag) and one terrain dab (key T, brush 1, a drag), both on the empty land east of the city
     *  (drawn over buildings the road tool refuses without a word: depuracao-2); then one growth as the game does it - a building demolished with
     *  a click, the game running, and the growth's worker putting one back on the lot. */
    async run(ctx) {
      const { page } = ctx;
      const land = await page.evaluate(() => {
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (const n of window.__roadcraft.doc.nodes.values()) { x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y); }
        return { x: x1 + (x1 - x0) * 0.12, y: (y0 + y1) / 2 };
      });
      await ctx.view(land.x, land.y, 3, ctx.cfg.orbit.elevationDeg);
      ctx.note('settle', await ctx.settle());
      await ctx.snapshot('antes');
      await ctx.since();
      const count = () => page.evaluate(() => ({ segments: window.__roadcraft.doc.segments.size, buildings: window.__roadcraft.doc.buildings.size, stamps: window.__roadcraft.doc.terrainStamps.length }));
      const before = await count();
      await page.keyboard.press('1');
      await drag(page, [660, 480], [1260, 480]);
      ctx.note('roadSettleMs', await editSettled(page));
      await page.keyboard.press('Escape');
      await ctx.shot('via-tracada');
      await page.keyboard.press('t');
      await page.keyboard.press('1');
      await drag(page, [760, 760], [1160, 760], { ms: 1500, steps: 40, hold: 200 });
      ctx.note('terrainSettleMs', await editSettled(page));
      await page.keyboard.press('Escape');
      const edited = await count();
      // The growth: one building down by the bulldozer's click, top-down over downtown, and the wait for the worker's answer to put one back.
      await ctx.view(ctx.fit.x, ctx.fit.y, 8, 80);
      await page.waitForTimeout(2000);
      await page.keyboard.press('b');
      const hit = await demolishOne(page, []);
      const at = Date.now(), left = (await count()).buildings;
      await page.keyboard.press('Escape');
      if (hit.ok) {
        // One more than right after the demolition (the road may have taken buildings of its own: depuracao-3 waited for the scene's first count and never got it).
        const grew = await page.waitForFunction((n) => window.__roadcraft.doc.buildings.size > n, left, { timeout: 60000, polling: 100 }).then(() => Date.now() - at, () => null);
        ctx.note('growth', { demolishedAfterClicks: hit.clicks, grewBackMs: grew });
      } else ctx.note('growth', { demolishedAfterClicks: null, grewBackMs: null, clicks: hit.clicks });
      const after = await count();
      ctx.note('edited', { before, after, edited });
      ctx.note('settle', await ctx.settle());
      await ctx.shot('editado');
      await ctx.snapshot('depois');
    },
  },
  {
    n: 8, name: 'sombra-chuva-noite', budget: 'district',
    /** Shadows off then on, rain on then off, night then day: each held 3 s. Through the handle (`setQuality`, `setWeather`, `setSkyMode`): the settings panel has no gesture the probe can replay without its DOM. */
    async run(ctx) {
      const { page } = ctx;
      await ctx.lookAt('bairro');
      ctx.note('settle', await ctx.settle());
      await ctx.since();
      const level = await page.evaluate(async () => {
        const { QUALITY } = await import('/src/render/quality.ts');
        const h = window.__roadcraft.scene(), level = h.stats.quality;
        window.__sondaQuality = { level, settings: QUALITY[level] ?? QUALITY.high };
        h.setQuality(level, { ...window.__sondaQuality.settings, shadows: false });
        return level;
      });
      ctx.note('quality', level);
      await ctx.hold(3000);
      await ctx.shot('sem-sombra');
      await page.evaluate(() => { const q = window.__sondaQuality; window.__roadcraft.scene().setQuality(q.level, { ...q.settings, shadows: true }); });
      await ctx.hold(3000);
      await page.evaluate(() => window.__roadcraft.doc.setWeather({ rain: 0.6 }));
      await ctx.hold(3000);
      await ctx.shot('chuva');
      await page.evaluate(() => window.__roadcraft.doc.setWeather({ rain: 0 }));
      await ctx.hold(3000);
      await page.evaluate(() => window.__roadcraft.scene().setSkyMode('night'));
      await ctx.hold(3000);
      await ctx.shot('noite');
      await page.evaluate(() => window.__roadcraft.scene().setSkyMode('day'));
      await ctx.hold(3000);
      ctx.note('settle', await ctx.settle());
    },
  },
  {
    n: 9, name: 'remover-predios-e-vias', budget: 'street',
    /** The game paused (the growth runs on the simulation's clock and put demolished buildings back: depuracao-2), then the bulldozer (key B)
     *  clicked over downtown, top-down, until 20 buildings went; then 5 roads, each clicked at the middle of its two ends projected to the screen.
     *  Every removal is counted off the document, never assumed. */
    async run(ctx) {
      const { page } = ctx;
      await page.evaluate(() => window.__roadcraft.setTraffic(false));
      await ctx.view(ctx.fit.x, ctx.fit.y, 8, 80);
      ctx.note('settle', await ctx.settle());
      await ctx.snapshot('antes');
      await ctx.since();
      const count = () => page.evaluate(() => ({ segments: window.__roadcraft.doc.segments.size, buildings: window.__roadcraft.doc.buildings.size, poles: window.__roadcraft.doc.poles.size }));
      const before = await count();
      await page.keyboard.press('b');
      let buildings = 0, clicks = 0;
      const triedBuildings = [];
      for (let k = 0; k < 30 && buildings < 20; k++) {
        const hit = await demolishOne(page, triedBuildings);
        clicks += hit.clicks;
        if (hit.ok) buildings++;
        else if (!hit.clicks) break;
      }
      // The roads from higher up (at the street's zoom a block's roads have their middles off the screen), each tried once.
      await ctx.view(ctx.fit.x, ctx.fit.y, 4, 80);
      await page.waitForTimeout(1500);
      let roads = 0, roadClicks = 0;
      const tried = [];
      for (let k = 0; k < 20 && roads < 5; k++) {
        const t = await page.evaluate((tried) => {
          const r = window.__roadcraft, v = r.view(), w = innerWidth, h = innerHeight, cam = r.camera;
          let best = null;
          for (const s of r.doc.segments.values()) {
            const a = r.doc.nodes.get(s.a), b = r.doc.nodes.get(s.b);
            if (!a || !b || tried.includes(s.id)) continue;
            const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
            const p = v.toScreen(m, w, h, r.scene().terrainHeightAt(m.x, m.y));
            const d = Math.hypot(m.x - cam.x, m.y - cam.y);
            if (p.x > 100 && p.x < w - 100 && p.y > 100 && p.y < h - 220 && (!best || d < best.d)) best = { id: s.id, x: p.x, y: p.y, d };
          }
          return best;
        }, tried);
        if (!t) break;
        tried.push(t.id);
        const was = await count();
        await page.mouse.click(t.x, t.y);
        roadClicks++;
        await page.waitForTimeout(300);
        const now = await count();
        if (now.segments < was.segments) roads++;
        else if (now.buildings < was.buildings) buildings++;
      }
      ctx.note('removeSettleMs', await editSettled(page));
      await page.keyboard.press('Escape');
      const after = await count();
      ctx.note('removed', { buildings: before.buildings - after.buildings, segments: before.segments - after.segments, poles: before.poles - after.poles, clicks, roadClicks, before, after });
      ctx.note('settle', await ctx.settle());
      await ctx.shot('removido');
      await ctx.snapshot('depois');
    },
  },
];
