// THE GATE (docs/PLAN.md section 2). Measures a production build of the game
// in a visible Chrome on this machine's RTX 3060, in both modes, through the
// real controls, in interleaved A/B rounds, each round a new Chrome with a
// fresh temporary profile; writes numbers and pictures, and compares the
// candidate (B) with the base (A) against the noise measured A/A.
//
// node scripts/gate/gate.mjs --a <url> [--b <url>] [--modes plano,planeta]
//   [--rounds 3] [--parts city,map,mode] [--idle 0] [--out dir]
//   [--map-plano file] [--map-planeta file] [--noise file] [--label text]
// Only --a: the base alone (a baseline). --b equal to --a: an A/A run (noise).
// Exit: 0 nothing worse; 1 something worse or a run failed; 3 NOT VERIFIED
// (the machine was busy or the GPU was not the RTX 3060).
import { chromium } from '@playwright/test';
import { cpus, freemem } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { instrument } from './instrument.mjs';
import { H, W, phase, sleep } from './page.mjs';
import { cityRun, modeRun, openMapRun } from './scenarios.mjs';
import { diffPictures, noiseOf, summarize } from './compare.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const A = arg('a');
const B = arg('b');
if (!A) { console.error('uso: gate.mjs --a <url> [--b <url>] ...'); process.exit(2); }
const MODES = arg('modes', 'plano,planeta').split(',');
const ROUNDS = Number(arg('rounds', '3'));
// The mode switch runs at the end of the city part (on the populated world); `mode` alone runs it on an empty map.
const PARTS = arg('parts', 'city,map').split(',');
const IDLE = Number(arg('idle', '0'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = resolve(arg('out', join('gate', 'runs', stamp)));
const MAPS = { plano: arg('map-plano'), planeta: arg('map-planeta') };
const NOISE = arg('noise') && existsSync(arg('noise')) ? JSON.parse(readFileSync(arg('noise'), 'utf8')) : {};
const GPU_NEEDED = 'RTX 3060';
mkdirSync(OUT, { recursive: true });

/** CPU in use over two seconds, all processors, %. */
async function cpuPercent() {
  const take = () => cpus().reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
  const a = take();
  await sleep(2000);
  const b = take();
  return 100 * (1 - (b.idle - a.idle) / Math.max(1, b.total - a.total));
}

/** Waits for a quiet machine (the player plays on it); after ten minutes the run is NOT VERIFIED. */
async function machineQuiet() {
  const t0 = Date.now();
  for (;;) {
    const cpu = await cpuPercent();
    const free = freemem() / 2 ** 30;
    if (cpu <= 40 && free >= 6) return { cpu: Math.round(cpu), freeGB: +free.toFixed(1) };
    if (Date.now() - t0 > 600000) {
      console.log(`NÃO VERIFICADO: máquina ocupada (CPU ${cpu.toFixed(0)}%, ${free.toFixed(1)} GB livres)`);
      process.exit(3);
    }
    console.log(`esperando a máquina: CPU ${cpu.toFixed(0)}%, ${free.toFixed(1)} GB livres`);
    await sleep(15000);
  }
}

/** One part of one side of one round: a new visible Chrome, a fresh profile, the game at `url`. */
async function runPart(part, url, mode, dir) {
  mkdirSync(dir, { recursive: true });
  const machine = await machineQuiet();
  const context = await chromium.launchPersistentContext('', {
    channel: 'chrome', headless: false, viewport: { width: W, height: H }, deviceScaleFactor: 1,
    args: ['--use-angle=d3d11', `--window-size=${W + 16},${H + 120}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.addInitScript(instrument);
  // Every file the game fetched from its own server: which assets a scenario really loads.
  const fetched = new Set();
  page.on('requestfinished', (r) => { if (r.url().startsWith(url)) fetched.add(new URL(r.url()).pathname); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`[${phase.now}] ${String(e.stack ?? e).slice(0, 600)}`));
  phase.now = 'abertura';
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  // Filled step by step by the scenario: kept when a later step fails.
  const partial = { numbers: {}, photos: [] };
  try {
    await page.goto(`${url.replace(/\/$/, '')}/${mode}/`);
    await page.waitForFunction(() => window.__roadcraft?.scene, null, { timeout: 240000 });
    const gpu = await page.evaluate(() => window.__roadcraft.scene().gl.getContext().getParameter(0x1f01) + ' | ' + (window.__gpu?.().label ?? ''));
    if (!gpu.includes(GPU_NEEDED)) {
      console.log(`NÃO VERIFICADO: a GPU não é a ${GPU_NEEDED}: ${gpu}`);
      process.exit(3);
    }
    let result;
    if (part === 'city') result = await cityRun(page, cdp, dir, { idleMinutes: IDLE }, partial.numbers, partial.photos);
    else if (part === 'map') result = MAPS[mode] ? await openMapRun(page, dir, MAPS[mode]) : { numbers: {}, photos: [] };
    else result = await modeRun(page, dir);
    const out = { part, url, mode, machine, gpu, errors, ...result };
    writeFileSync(join(dir, `${part}.json`), JSON.stringify(out, null, 1));
    return out;
  } catch (error) {
    await page.screenshot({ path: join(dir, `${part}-falha.png`) }).catch((e) => console.error('sem foto da falha', e));
    const out = { part, url, mode, machine, errors: [...errors, `FALHA [${phase.now}]: ${String(error).slice(0, 400)}`], numbers: partial.numbers, photos: partial.photos };
    writeFileSync(join(dir, `${part}.json`), JSON.stringify(out, null, 1));
    return out;
  } finally {
    writeFileSync(join(dir, `${part}-rede.txt`), [...fetched].sort().join('\n') + '\n');
    await context.close();
  }
}

const sides = B ? ['A', 'B'] : ['A'];
const urls = { A, B };
const runs = {};
for (const mode of MODES) {
  runs[mode] = { A: [], B: [] };
  for (let r = 0; r < ROUNDS; r++) {
    const order = r % 2 === 0 ? sides : [...sides].reverse();
    for (const side of order) {
      const dir = join(OUT, mode, `${side}-r${r}`);
      const merged = { numbers: {}, photos: [], errors: [], gpu: '' };
      for (const part of PARTS) {
        console.log(`${mode} rodada ${r} lado ${side}: ${part}`);
        const res = await runPart(part, urls[side], mode, dir);
        Object.assign(merged.numbers, res.numbers);
        merged.photos.push(...res.photos);
        merged.errors.push(...res.errors);
        merged.gpu = res.gpu ?? merged.gpu;
      }
      runs[mode][side].push({ dir, ...merged });
    }
  }
}

// The verdict, per mode, and the pictures compared round by round.
const report = { a: A, b: B ?? null, rounds: ROUNDS, parts: PARTS, at: new Date().toISOString(), modes: {} };
let worse = false;
const browser = await chromium.launch({ channel: 'chrome', headless: false });
const blank = await browser.newPage();
for (const mode of MODES) {
  const a = runs[mode].A.map((r) => r.numbers);
  const b = runs[mode].B.map((r) => r.numbers);
  const rows = summarize(a, b, NOISE[mode] ?? {});
  const pictures = [];
  if (B) {
    for (let r = 0; r < ROUNDS; r++) {
      const ra = runs[mode].A[r];
      const rb = runs[mode].B[r];
      for (const name of ra.photos.filter((p) => rb.photos.includes(p))) {
        const d = await diffPictures(blank, join(ra.dir, `${name}.png`), join(rb.dir, `${name}.png`), join(OUT, mode, `diff-${name}-r${r}.png`));
        pictures.push({ name, round: r, ...d });
      }
    }
  }
  const errors = [...runs[mode].A, ...runs[mode].B].flatMap((r) => r.errors);
  const failed = rows.filter((x) => x.verdict === 'PIOR');
  if (failed.length || errors.length) worse = true;
  report.modes[mode] = { rows, pictures, errors, noiseAA: B === A ? noiseOf(a, b) : undefined, gpu: runs[mode].A[0]?.gpu };
  console.log(`\n== ${mode}: ${failed.length} métricas piores, ${errors.length} erros`);
  for (const x of rows.filter((y) => y.judged)) {
    console.log(`${x.verdict.padEnd(6)} ${x.key.padEnd(42)} A ${fmt(x.a)} [${fmt(x.aMin)}–${fmt(x.aMax)}]${B ? `  B ${fmt(x.b)} [${fmt(x.bMin)}–${fmt(x.bMax)}]` : ''}`);
  }
  for (const p of pictures) console.log(`foto ${p.name} r${p.round}: ${(p.share * 100).toFixed(3)}% pixels diferentes, média ${p.mean.toFixed(2)}`);
  if (errors.length) console.log('erros:', errors.join(' | '));
}
await browser.close();
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
console.log(`\nrelatório: ${join(OUT, 'report.json')}`);
process.exit(worse ? 1 : 0);

function fmt(x) {
  if (!Number.isFinite(x)) return '—';
  return Math.abs(x) >= 100 ? x.toFixed(0) : x.toFixed(1);
}
