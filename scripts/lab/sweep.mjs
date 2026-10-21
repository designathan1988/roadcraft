// THE LAB'S A/B SWEEP WITHOUT A WINDOW: the same sweep as the lab's A/B sweep tab (`src/lab/tests/sweep.ts`, `window.__labTests`), driven
// in a Chrome of its own by Playwright, the city opened and held as every measure holds it (`scripts/lib/measureCity.mjs`: the small city of a
// seed, the clock held, the scene settled; REFUSED when another process draws on the GPU or the machine is busy - `--shared-gpu`,
// `--shared-machine` measure anyway and the report says so). Writes `lab-reports/sweep-<date>.json` and `.md` for a person or an AI to read.
//
// Usage (the dev server running: npm run dev):
//   node scripts/lab/sweep.mjs [--group "<group label>"] [--items switch.bloom,switch.smaa] [--frames 120] [--reps 2] [--view current|map|district|street]
//                              [--zoom 4] [--seed 7] [--settle 20] [--bench views|stress|leak|hitch|longrun] [--seconds 30] [--out lab-reports]
//   node scripts/lab/sweep.mjs --list     the items the sweep can flip (opens the game)
//   node scripts/lab/sweep.mjs --specs    the spec files (vitest) by folder, from the disk (no browser)
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { clearInterval, setInterval } from 'node:timers';
import { arg, cpuNeighbours, gpuNeighbours, openCity } from '../lib/measureCity.mjs';

const has = (name) => process.argv.includes(name);
const list = (value) => (value ? String(value).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const outDir = resolve(arg('--out', 'lab-reports'));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

if (has('--specs')) {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(spec|test)\.ts$/.test(e.name) ? [join(dir, e.name)] : []));
  const files = walk(resolve('tests')).map((f) => relative(resolve('.'), f).replace(/\\/g, '/'));
  const byFolder = new Map();
  for (const f of files) { const folder = f.split('/')[1]; byFolder.set(folder, [...(byFolder.get(folder) ?? []), f]); }
  for (const [folder, specs] of [...byFolder].sort()) console.log(`${folder} (${specs.length}):\n  ${specs.join('\n  ')}`);
  console.log(`\n${files.length} files. npm test (all but perf/scale) · npm run test:scale · npx vitest run tests/<folder>`);
  process.exit(0);
}

const bench = arg('--bench', null);
const options = bench
  ? { frames: Number(arg('--frames', '120')), seconds: Number(arg('--seconds', '30')) }
  : {
    items: list(arg('--items', null)), groups: list(arg('--group', null)), view: arg('--view', 'current'),
    frames: Number(arg('--frames', '120')), reps: Number(arg('--reps', '1')), settleMaxMs: Number(arg('--settle', '20')) * 1000,
  };

// The machine as it was before the run (openCity refuses a busy one unless told otherwise): kept in the report.
const machine = { gpu: gpuNeighbours(), cpu: cpuNeighbours(), sharedGpu: has('--shared-gpu'), sharedMachine: has('--shared-machine') };
const { browser, page } = await openCity({ zoom: Number(arg('--zoom', '4')) });
try {
  await page.waitForFunction(() => Boolean(globalThis.__labTests), null, { timeout: 60000 });
  if (has('--list')) {
    const items = await page.evaluate(() => globalThis.__labTests.items());
    for (const i of items) console.log(`${i.id.padEnd(28)} ${i.group.padEnd(26)} ${JSON.stringify(i.value)}`);
    process.exitCode = 0;
  } else {
    const ticker = setInterval(() => { void page.evaluate(() => globalThis.__labTests.running()).then((line) => { if (line) console.log(line); }, (error) => console.warn(`progress unread: ${error.message}`)); }, 5000);
    let result;
    try {
      // The dev server reloads the page when any session saves a file (Vite): the run begun again, up to three times.
      for (let attempt = 1; ; attempt++) {
        try {
          result = await page.evaluate(([kind, opts]) => (kind ? globalThis.__labTests.benchmark(kind, opts) : globalThis.__labTests.sweep(opts)), [bench, options]);
          break;
        } catch (error) {
          if (attempt >= 3 || !/context was destroyed|navigation/i.test(error.message)) throw error;
          console.warn(`the page reloaded midway (Vite): attempt ${attempt + 1} of 3`);
          await page.waitForFunction(() => Boolean(globalThis.__labTests && globalThis.__roadcraft?.measure), null, { timeout: 180000 });
          await page.evaluate((seed) => globalThis.__roadcraft.smallCity(seed), Number(arg('--seed', '7')));
          await page.waitForTimeout(8000);
          await page.evaluate(() => globalThis.__roadcraft.measure(true));
        }
      }
    } finally {
      clearInterval(ticker);
    }
    const report = { tool: 'scripts/lab/sweep.mjs', options, bench, machine, shared: machine.sharedGpu || machine.sharedMachine, result };
    mkdirSync(outDir, { recursive: true });
    const base = join(outDir, `${bench ? `bench-${bench}` : 'sweep'}-${stamp}`);
    writeFileSync(`${base}.json`, JSON.stringify(report, null, 1));
    writeFileSync(`${base}.md`, markdown(report));
    console.log(`report: ${base}.json\n        ${base}.md`);
  }
} finally {
  await browser.close();
}

function markdown(report) {
  const r = report.result;
  const lines = [`# ${report.bench ? `Benchmark ${report.bench}` : 'A/B sweep'} — ${r.startedAt}`, ''];
  lines.push(`- GPU: ${r.gpuLabel ?? '—'}${r.gpuTimer === false ? ' (no timer: verdict by the frame)' : ''}`);
  lines.push(`- Duration: ${Math.round(r.ms / 1000)} s${r.cancelled ? ' (cancelled)' : ''}`);
  if (!report.bench) lines.push(`- View: ${r.view} · ${r.frames} frames per window · ${r.reps} repetition(s) · A/B/A with the simulation's clock held`);
  const busy = [...report.machine.gpu.map((g) => `${g.name} GPU ${g.percent}%`), ...report.machine.cpu.busy.map((c) => `${c.name} ${c.cores} cores`)];
  lines.push(`- Machine at the start: ${busy.length ? busy.join(', ') : 'free'}${report.shared ? ' — MEASURED ON A SHARED MACHINE (--shared-*): the numbers do not count as a measure' : ''}`);
  for (const w of r.warnings ?? []) lines.push(`- Warning: ${w}`);
  lines.push('');
  if (!report.bench) {
    lines.push('Δ = B − mean of the two A windows (ms; negative = cheaper with B). "noise": |Δ| does not clear the noise (A/A apart, error of the medians, spread of the repetitions, ≥ 2 % of A).', '');
    lines.push('| item | group | A → B | GPU A | GPU B | Δ GPU | Δ% | Δ CPU | Δ frame | Δ calls | Δ triangles | noise | drift | programs | alerts | verdict |');
    lines.push('|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|');
    const sorted = [...r.rows].sort((a, b) => (a.gpuDelta ?? a.frameDelta ?? 0) - (b.gpuDelta ?? b.frameDelta ?? 0));
    for (const x of sorted) {
      const flags = [x.sceneChanged && 'scene changed', x.unsettled && 'not settled', x.basis === 'frame' && 'no GPU'].filter(Boolean).join(', ');
      lines.push(`| ${x.item} | ${x.group} | ${x.a} → ${x.b} | ${x.gpuA ?? '—'} | ${x.gpuB ?? '—'} | ${x.gpuDelta ?? '—'} | ${x.gpuDeltaPct ?? '—'} | ${x.cpuDelta ?? '—'} | ${x.frameDelta ?? '—'} | ${x.callsDelta} | ${x.trianglesDelta} | ${x.noise ?? '—'} | ${x.drift ?? '—'} | ${x.newPrograms} | ${flags} | **${x.verdict}** |`);
    }
  } else {
    lines.push('| case | metric | value | unit | reference | status |', '|---|---|---:|---|---|---|');
    for (const x of r.rows) lines.push(`| ${x.case} | ${x.metric} | ${x.value ?? '—'} | ${x.unit} | ${x.reference} | ${x.status} |`);
  }
  return `${lines.join('\n')}\n`;
}
