// THE GAME'S CODE THAT NEVER RUNS: V8's precise coverage of a played session, mapped to the TypeScript, merged with knip's unused exports and files.
// `node scripts/lab/coverage.mjs [--seconds=45] [--city] [--views] [--no-knip] [--url=http://127.0.0.1:5300/]` with the dev server running (`npm run dev`).
// Writes lab-reports/coverage-<date>.json and .md: per file, the functions never executed and the share of its lines executed (dead code candidates).
// How: headless Chrome (as scripts/look.mjs), CDP Profiler.startPreciseCoverage {callCount, detailed} before the page loads, the game played, Profiler.takePreciseCoverage;
// each script's inline source map (Vite) decoded by the lab's own decoder (src/lab/code/sourceMap.ts). Only the page's main thread: the workers' code is not covered.
import { exec } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { lookup, mapOfModule } from '../../src/lab/code/sourceMap.ts';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const seconds = Number(option('seconds', '45'));
const url = option('url', 'http://127.0.0.1:5300/');
const root = resolve('.');
const out = join(root, 'lab-reports');
mkdirSync(out, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
/** The dev server reloads the page whenever any session saves a file (Vite): the run is taken again, up to three times. */
const RELOADED = 'the page reloaded midway (a file was saved and Vite reloaded the game)';
let report;
try {
  for (let attempt = 1; ; attempt++) {
    try {
      report = await play();
      break;
    } catch (error) {
      // A reload mid-step surfaces as a destroyed context or a closed page.
      if (!/the page reloaded midway|Execution context was destroyed|has been closed/.test(error.message) || attempt >= 3) throw error;
      console.log(`${RELOADED}: attempt ${attempt + 1} of 3`);
    }
  }
} finally {
  await browser.close();
}
if (!flag('no-knip')) report.knip = await knip();
writeFileSync(join(out, `coverage-${stamp}.json`), JSON.stringify(report, null, 1));
writeFileSync(join(out, `coverage-${stamp}.md`), markdown(report));
console.log(`coverage: ${report.summary.functionsNeverRun} of ${report.summary.functions} functions never ran, ${report.summary.linePct}% of the mapped lines ran; ${report.summary.filesNeverLoaded} files never loaded`);
console.log(`report: ${join(out, `coverage-${stamp}.md`)}`);

/** The game opened with coverage on, played, and its coverage mapped to the sources. */
async function play() {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('crash', () => console.log('PAGE CRASHED (the renderer process died)'));
  page.on('close', () => console.log('page closed'));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  // Before the page's first script: what loads is counted from its start ("data for JavaScript executed before enabling ... may be incomplete").
  await cdp.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  await cdp.send('Debugger.enable');
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'load' });
  let reloads = 0;
  page.on('load', () => { reloads++; });
  await page.waitForFunction('Boolean(window.__roadcraft && window.__roadcraft.memory)', null, { timeout: 180_000 });
  console.log(`game up in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (flag('city')) {
    await page.evaluate("performance.clearMarks('opening:shown'); window.__roadcraft.generateCity({})");
    await page.waitForFunction("performance.getEntriesByName('opening:shown').length > 0", null, { timeout: 1_800_000, polling: 1000 });
    console.log(`city up at ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  const end = Date.now() + seconds * 1000;
  if (flag('views')) {
    // A player looking around: zoomed in and out, panned with the keys, turned with the right button, the lab opened on each tab.
    await page.mouse.move(800, 450);
    for (const dy of [-600, -600, 900, 900, -300]) { await page.mouse.wheel(0, dy); await sleep(600); }
    for (const key of ['w', 'a', 's', 'd']) { await page.keyboard.down(key); await sleep(1200); await page.keyboard.up(key); }
    await page.mouse.move(800, 450);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(1100, 380, { steps: 30 });
    await page.mouse.up({ button: 'right' });
    await page.keyboard.press('F7');
    // The lab's tab buttons (`lab/window.ts`, class lab-tab).
    const TABS = "document.querySelectorAll('.lab-panel .lab-tab, .lab-panel .lab-tabs button')";
    const tabs = await page.evaluate(`${TABS}.length`);
    for (let i = 0; i < tabs; i++) {
      const name = await page.evaluate(`${TABS}[${i}]?.textContent`);
      if (process.env.COVERAGE_STEPS) console.log(`  tab ${i}: ${name}`);
      await page.evaluate(`${TABS}[${i}]?.click()`);
      await sleep(1500);
    }
    console.log(`lab: ${tabs} tabs visited`);
    await page.keyboard.press('F7');
  }
  const left = end - Date.now();
  if (left > 0) await sleep(left);
  // A reload threw away the counts of the page played: taken again.
  if (reloads) { await page.close(); throw new Error(RELOADED); }
  const { result } = await cdp.send('Profiler.takePreciseCoverage');
  await cdp.send('Profiler.stopPreciseCoverage');
  const files = new Map();
  let scripts = 0;
  for (const script of result) {
    if (!/^https?:\/\/[^/]+\/src\//.test(script.url)) continue;
    scripts++;
    const source = await scriptSource(cdp, script);
    if (source === null) continue;
    const map = await mapOfModule(source, script.url);
    if (!map) continue;
    mapScript(script, source, map, files);
  }
  await cdp.send('Debugger.disable');
  const loaded = new Set([...files.keys()]);
  const never = sourceFiles(join(root, 'src')).filter((f) => !loaded.has(f));
  const fileRows = [...files.values()].map(finish).sort((a, b) => a.linePct - b.linePct || b.neverRun.length - a.neverRun.length);
  const functions = fileRows.reduce((a, f) => a + f.functions, 0);
  const neverRun = fileRows.reduce((a, f) => a + f.neverRun.length, 0);
  const lines = fileRows.reduce((a, f) => a + f.lines, 0);
  const ran = fileRows.reduce((a, f) => a + f.linesRun, 0);
  return {
    date: new Date().toISOString(), url, seconds, city: flag('city'), views: flag('views'), pageErrors: errors,
    summary: { scripts, files: fileRows.length, functions, functionsNeverRun: neverRun, lines, linesRun: ran, linePct: pct(ran, lines), filesNeverLoaded: never.length },
    files: fileRows,
    filesNeverLoaded: never,
  };
}

/** The script's text as V8 ran it (offsets are into it), else fetched again. */
async function scriptSource(cdp, script) {
  try {
    const { scriptSource } = await cdp.send('Debugger.getScriptSource', { scriptId: script.scriptId });
    return scriptSource;
  } catch (error) {
    console.warn(`no source from V8 for ${script.url} (${error.message}), fetched`);
    try {
      const response = await globalThis.fetch(script.url);
      return response.ok ? await response.text() : null;
    } catch (fetchError) {
      console.warn(`no source for ${script.url}: ${fetchError.message}`);
      return null;
    }
  }
}

/** One script's ranges onto its original file: each function's first range (the function, its call count), and each mapped segment executed or not. */
function mapScript(script, source, map, files) {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const position = (offset) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return [lo, offset - lineStarts[lo]];
  };
  // Executed or not, per character: the ranges applied outer first (start ascending, end descending), the inner overriding.
  const ran = new Uint8Array(source.length).fill(1);
  const ranges = script.functions.flatMap((f) => f.ranges).sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
  for (const r of ranges) ran.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, source.length));
  const fileOf = (path) => {
    let f = files.get(path);
    if (!f) { f = { file: path, functions: new Map(), lines: new Map() }; files.set(path, f); }
    return f;
  };
  for (const fn of script.functions) {
    const whole = fn.ranges[0];
    // The module's own top level is not a function to report.
    // V8's own (`<instance_members_initializer>`): a class's fields, not a function written.
    if (!whole || (whole.startOffset === 0 && whole.endOffset >= source.length - 1 && !fn.functionName) || fn.functionName.startsWith('<')) continue;
    const [line, column] = position(whole.startOffset);
    const at = lookup(map, line, column);
    if (!at || !at.file.startsWith('/src/')) continue;
    const f = fileOf(at.file.slice(1));
    const key = `${at.line}:${fn.functionName}`;
    const was = f.functions.get(key);
    f.functions.set(key, { name: fn.functionName || '(anônima)', line: at.line, count: (was?.count ?? 0) + whole.count });
  }
  // Lines: each segment spans to the next on its generated line; a TS line ran if any of its segments ran.
  map.lines.forEach((row, genLine) => {
    const start = lineStarts[genLine];
    if (start === undefined) return;
    const lineEnd = lineStarts[genLine + 1] ?? source.length;
    for (let k = 0; k < row.length; k += 5) {
      if (row[k + 1] < 0) continue;
      const file = map.sources[row[k + 1]];
      if (!file?.startsWith('/src/')) continue;
      const from = start + row[k], to = k + 5 < row.length ? start + row[k + 5] : lineEnd;
      let hit = false;
      for (let i = from; i < to && !hit; i++) hit = ran[i] === 1;
      const lines = fileOf(file.slice(1)).lines;
      const tsLine = row[k + 2] + 1;
      lines.set(tsLine, (lines.get(tsLine) ?? false) || hit);
    }
  });
}

/** A file's figures for the report. */
function finish(f) {
  const fns = [...f.functions.values()];
  const neverRun = fns.filter((x) => x.count === 0).sort((a, b) => a.line - b.line).map((x) => ({ name: x.name, line: x.line }));
  const lines = f.lines.size;
  const linesRun = [...f.lines.values()].filter(Boolean).length;
  const unrun = [...f.lines].filter(([, hit]) => !hit).map(([l]) => l).sort((a, b) => a - b);
  return { file: f.file, functions: fns.length, functionsRun: fns.length - neverRun.length, neverRun, lines, linesRun, linePct: pct(linesRun, lines), linesNotRun: ranges(unrun), hottest: fns.sort((a, b) => b.count - a.count).slice(0, 5).map((x) => ({ name: x.name, line: x.line, calls: x.count })) };
}

/** `[3,4,5,9]` as "3-5, 9". */
function ranges(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[j] + 1) j++;
    out.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
    i = j;
  }
  return out.join(', ');
}

/** `a` of `b` in percent, one decimal. */
function pct(a, b) {
  return b ? Math.round((1000 * a) / b) / 10 : 0;
}

/** Every TypeScript file under `dir` (no declarations), as `src/...` paths. */
function sourceFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && /\.(ts|tsx)$/.test(d.name) && !d.name.endsWith('.d.ts') && !/\.test\.ts$/.test(d.name))
    .map((d) => relative(root, join(d.parentPath, d.name)).replace(/\\/g, '/'));
}

/** knip's unused files, exports and types (static: the code nothing imports). */
function knip() {
  return new Promise((done) => {
    exec('npx knip --reporter json --no-exit-code', { cwd: root, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) { console.warn(`knip failed: ${error.message}\n${stderr}`); done({ error: error.message }); return; }
      try {
        const { issues } = JSON.parse(stdout);
        const pick = (kind) => issues.flatMap((i) => (i[kind] ?? []).map((x) => ({ file: i.file, name: x.name, line: x.line })));
        done({ files: issues.filter((i) => i.files?.length).map((i) => i.file), exports: pick('exports'), types: pick('types'), unresolved: pick('unresolved'), duplicates: pick('duplicates') });
      } catch (parseError) {
        console.warn(`knip output unreadable: ${parseError.message}`);
        done({ error: parseError.message });
      }
    });
  });
}

/** The report for a reader: the summary, the files by share of lines run, each one's functions never run, then knip's findings. */
function markdown(r) {
  const s = r.summary;
  const lines = [
    `# Cobertura do código — ${r.date}`,
    '',
    `Sessão de ${r.seconds} s em ${r.url}${r.city ? ', com cidade gerada' : ''}${r.views ? ', visitando vistas' : ''}. Cobertura precisa do V8 (só a thread principal: o código dos workers não entra).`,
    '',
    `- Funções: ${s.functions}, nunca executadas: **${s.functionsNeverRun}**`,
    `- Linhas mapeadas executadas: **${s.linePct}%** (${s.linesRun} de ${s.lines})`,
    `- Arquivos de src/ nunca carregados na página: **${s.filesNeverLoaded}** (workers, desktop, testes ou código morto)`,
    ...(r.pageErrors.length ? ['', `Erros da página: ${r.pageErrors.length}`] : []),
    '',
    '## Arquivos (do menos executado)',
    '',
    '| Arquivo | Linhas executadas | Funções executadas | Nunca executadas |',
    '|---|---:|---:|---|',
    ...r.files.map((f) => `| ${f.file} | ${f.linePct}% | ${f.functionsRun}/${f.functions} | ${f.neverRun.slice(0, 12).map((x) => `${x.name}:${x.line}`).join(', ')}${f.neverRun.length > 12 ? ` (+${f.neverRun.length - 12})` : ''} |`),
    '',
    '## Arquivos nunca carregados',
    '',
    ...r.filesNeverLoaded.map((f) => `- ${f}`),
  ];
  if (r.knip) {
    lines.push('', '## knip (análise estática)', '');
    if (r.knip.error) lines.push(`knip falhou: ${r.knip.error}`);
    else {
      lines.push(`- Arquivos não usados: ${r.knip.files.length}`, ...r.knip.files.map((f) => `  - ${f}`));
      lines.push(`- Exports não usados: ${r.knip.exports.length}`, ...r.knip.exports.map((x) => `  - ${x.file}:${x.line} ${x.name}`));
      lines.push(`- Tipos não usados: ${r.knip.types.length}`, ...r.knip.types.map((x) => `  - ${x.file}:${x.line} ${x.name}`));
      if (r.knip.unresolved.length) lines.push(`- Imports não resolvidos: ${r.knip.unresolved.length}`, ...r.knip.unresolved.map((x) => `  - ${x.file}:${x.line} ${x.name}`));
    }
  }
  return `${lines.join('\n')}\n`;
}
