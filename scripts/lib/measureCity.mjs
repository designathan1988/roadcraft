// THE ONE WAY THE MEASURES OPEN AND HOLD THE CITY (scripts/layers.mjs, material.mjs, shellMaps.mjs...): a Chrome of its own, the small city
// of a seed, the camera at a view, the game in its measure mode (`__roadcraft.measure`: the simulation's clock held, a frame every refresh),
// and nothing measured before the scene is settled. Every window says the scene it measured; a run whose windows saw different scenes is
// not a measure.
// DO NOT measure a scene that is still changing: with the cells still landing the GPU's time of one material went 17 -> 22 -> 37 ms with
// nothing swapped, and A/B rows "cheaper with more work" came out of it (2026-10-18). The causes found: the GPU-time governor of the
// buildings' detail (removed from the game), the detail still landing after the view moved, the simulation's clock (the sun, the shadows'
// refits, the population governor's vehicles and people), the meshes of a swap listed once while new cells landed, and another process drawing on the same GPU (`gpuNeighbours`).
import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

export const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback; };

/** Chrome's flags for a measure: the real GPU through ANGLE's D3D11; no throttling of a page the window manager thinks hidden. */
export const CHROME_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-precise-memory-info',
  '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];

/** The processes drawing on the GPU's 3D engine now, past `least` percent (Windows' "GPU Engine" counters): name, pid, percent. */
export function gpuNeighbours(least = 3) {
  if (process.platform !== 'win32') return [];
  const ps = `(Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.CookedValue -gt ${least} } | ForEach-Object { $p = [regex]::Match($_.InstanceName,'pid_(\\d+)').Groups[1].Value; "$p|$((Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName)|$([math]::Round($_.CookedValue,1))" }`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
  return out.split(/\r?\n/).filter(Boolean).map((line) => { const [pid, name, percent] = line.split('|'); return { pid: Number(pid), name, percent: Number(percent) }; });
}

/** The processes busy on the CPU now, past `leastCores` of one core (Windows' "Process" counters, the dev server's node and this measure's
 *  own shells left out), and the free memory, bytes. */
export function cpuNeighbours(leastCores = 0.5) {
  if (process.platform !== 'win32') return { busy: [], freeBytes: Infinity };
  const ps = [
    "$s = (Get-Counter '\\Process(*)\\% Processor Time' -ErrorAction SilentlyContinue).CounterSamples;",
    "$s | Where-Object { $_.InstanceName -notmatch '^(_total|idle|node|powershell|conhost|chrome)(#\\d+)?$' -and $_.CookedValue -gt " + leastCores * 100 + " }",
    "| ForEach-Object { \"$($_.InstanceName)|$([math]::Round($_.CookedValue / 100, 2))\" };",
    "\"free|$((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory)\"",
  ].join(' ');
  const lines = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).split(/\r?\n/).filter(Boolean);
  const free = lines.find((l) => l.startsWith('free|'));
  return {
    busy: lines.filter((l) => !l.startsWith('free|')).map((l) => { const [name, cores] = l.split('|'); return { name, cores: Number(cores) }; }),
    freeBytes: free ? Number(free.split('|')[1]) * 1024 : Infinity,
  };
}

/** Under this much free memory a measure is refused: the page's own 1-3 GB and the GPU process would page. */
const LEAST_FREE_BYTES = 3 * 2 ** 30;

/** A browser and page with the small city of `seed` open at `zoom` times the whole city's view, the measure mode on, the scene settled.
 *  DO NOT measure with another process drawing on the GPU: the game left open in the app's browser pane held 99 % of the 3D engine and the
 *  district view's GPU time came out 17, 22 or 37 ms by its load, the same scene to the triangle (2026-10-18). `--shared-gpu` measures anyway; the CPU and the memory likewise (`cpuNeighbours`, `--shared-machine`). */
export async function openCity({ base = arg('--base', 'http://127.0.0.1:5300/'), seed = Number(arg('--seed', '7')), zoom = Number(arg('--zoom', '4')), width = 1600, height = 900, init = null, free = true, headless = true, settle = true, city = true } = {}) {
  const busy = gpuNeighbours();
  if (free && busy.length && !process.argv.includes('--shared-gpu')) {
    console.error(`MEDIÇÃO RECUSADA: outro processo está usando a GPU: ${busy.map((b) => `${b.name} (pid ${b.pid}) ${b.percent}%`).join(', ')}. Feche-o (um jogo aberto no painel do navegador, outra aba) ou passe --shared-gpu.`);
    process.exit(2);
  }
  // The CPU and the memory too: a build, a test run or another game paces the page's frames and the GPU process's submissions.
  const machine = cpuNeighbours();
  const shortOfMemory = machine.freeBytes < LEAST_FREE_BYTES;
  if (free && (machine.busy.length || shortOfMemory) && !process.argv.includes('--shared-machine')) {
    const why = [...machine.busy.map((b) => `${b.name} ${b.cores} núcleo(s)`), ...(shortOfMemory ? [`só ${(machine.freeBytes / 2 ** 30).toFixed(1)} GB de memória livre`] : [])];
    console.error(`MEDIÇÃO RECUSADA: a máquina está ocupada: ${why.join(', ')}. Feche o que for seu (testes, builds, outro Chrome) ou passe --shared-machine.`);
    process.exit(2);
  }
  const browser = await chromium.launch({ channel: 'chrome', headless, args: headless ? CHROME_ARGS : [...CHROME_ARGS, '--start-maximized'] });
  // With a window (a player playing while the probe records): the window's own size.
  const page = await browser.newPage({ viewport: headless ? { width, height } : null });
  // What must run before the game's code (the probe's counters on WebGL, workers, timers...).
  if (init) await page.addInitScript(init);
  await page.goto(base);
  await page.waitForFunction(() => window.__roadcraft?.scene?.().buildingLevels && window.__roadcraft.measure, null, { timeout: 180000 });
  await page.waitForTimeout(2000);
  // `city` false: the page as it boots, the city not opened (a probe that records the opening opens it itself).
  if (city) {
    await page.evaluate((s) => window.__roadcraft.smallCity(s), seed);
    await page.waitForTimeout(8000);
  }
  // The real GPU: DO NOT measure a WebGL that fell back to SwiftShader (Playwright always passes --enable-unsafe-swiftshader: the "GPU" would be the CPU), nor one without the timer queries.
  const gpu = await page.evaluate(() => ({ label: window.__gpu().label, supported: window.__gpu().supported }));
  if (!gpu.supported || /swiftshader|llvmpipe|software|basic render/i.test(gpu.label)) {
    console.error(`MEDIÇÃO RECUSADA: a GPU da página não serve para medir: ${gpu.label || 'sem nome'} (timer ${gpu.supported ? 'presente' : 'AUSENTE'}).`);
    await browser.close();
    process.exit(2);
  }
  const fit = await page.evaluate(() => ({ x: window.__roadcraft.camera.x, y: window.__roadcraft.camera.y, zoom: window.__roadcraft.camera.zoom }));
  await page.evaluate(installHelpers);
  if (settle) {
    await page.evaluate(() => window.__roadcraft.measure(true));
    await lookAt(page, fit, zoom);
  }
  return { browser, page, fit };
}

/** The camera at `zoom` times the whole city's view (`fit`), and the scene settled there. */
export async function lookAt(page, fit, zoom) {
  await page.evaluate(({ x, y, zoom }) => window.__roadcraft.lookAt(x, y, zoom), { x: fit.x, y: fit.y, zoom: fit.zoom * zoom });
  const settled = await page.evaluate(() => window.__measure.settle());
  if (settled.unsettled) console.warn(`AVISO: a cena não assentou em ${settled.seconds} s (${settled.scene})`);
  return settled;
}

/** The helpers in the page: `window.__measure.scene()` the scene's signature, `settle()`, `gpu()` a window of the GPU's time. */
function installHelpers() {
  const r = window.__roadcraft, handle = r.scene();
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  /** What makes the scene the scene: the buildings' levels chosen and shown, the vehicles and people. */
  const scene = () => {
    const lv = handle.buildingLevels();
    return { tri: lv.chosenTriangles, detail: lv.shownDetail, facade: lv.shownFacade, notLanded: lv.notLanded, vehicles: r.sim.vehicles.size, people: r.sim.pedViews.length };
  };
  const sign = (s) => `${s.tri}|${s.detail}|${s.facade}|${s.vehicles}|${s.people}`;
  window.__measure = {
    scene, sign,
    /** Settled: nothing waiting to land and the scene's signature the same for `stableMs`. */
    async settle(stableMs = 4000, maxMs = 120000) {
      const t0 = performance.now();
      let last = '', since = performance.now();
      while (performance.now() - t0 < maxMs) {
        const s = scene(), now = sign(s);
        if (now !== last || s.notLanded > 0) { last = now; since = performance.now(); }
        else if (performance.now() - since >= stableMs) return { seconds: Math.round((performance.now() - t0) / 1000), scene: now };
        await sleep(250);
      }
      return { seconds: Math.round(maxMs / 1000), scene: last, unsettled: true };
    },
    /** A window of the GPU's time after `settleMs` (a swap's programs compiled and its first frames gone), with the scene before and after it,
     *  the page's time a frame (`cpu`: near the GPU's, the frame is the page's and the timer measures the GPU waiting for it), and the
     *  results the timer threw away for a disjoint GPU (a window with any is not a measure). */
    async gpu(settleMs = 1500, holdMs = 2200) {
      await sleep(settleMs);
      const before = sign(scene());
      const disjointBefore = window.__gpu().disjoint;
      window.__gpu(true);
      const since = performance.now();
      await sleep(holdMs);
      const g = window.__gpu(), after = sign(scene()), frames = window.__frames(since);
      const disjoint = g.disjoint - disjointBefore;
      const changed = before !== after ? `${before} -> ${after}` : null;
      return { p50: g.p50, p95: g.p95, n: g.n, cpu: frames.total?.p50 ?? null, disjoint, scene: changed ?? (disjoint > 0 ? `${after} DISJOINT ${disjoint}` : after) };
    },
  };
}

/** Whether every window of a run saw the same scene: the line to print, and true when it did. */
export function sameScene(windows) {
  const scenes = [...new Set(windows.map((w) => w.scene))];
  return scenes.length === 1
    ? { ok: true, line: `cena igual em todas as ${windows.length} janelas (triângulos|detalhe|fachada|veículos|pessoas = ${scenes[0]})` }
    : { ok: false, line: `CENA MUDOU entre as janelas - MEDIÇÃO INVÁLIDA: ${scenes.join(' ; ')}` };
}

export const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
