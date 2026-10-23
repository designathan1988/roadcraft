/* global window, performance, document, fetch, getComputedStyle */
// THE ENGINE'S CATALOGUE OF OBJECTS WITH GEOMETRY: every kit's objects and variations built on their own by the engine's own builders and measured
// (triangles, vertices, attributes and their bytes, memory, material and shader, how it is drawn, levels of detail, hidden faces, shadow, bones),
// what depends on the city's layout read from a large test city, the test city's copies of each object and its cost (triangles x copies),
// every group's draw calls, the destruction's peak. Lights and effects of the frame are not objects and are left out; the effects with geometry
// are measured in a section of their own; the editor's previews are listed but kept out of the running game's cost.
//
// `node scripts/model-catalog.mjs [out folder] [--url=http://127.0.0.1:5300] [--seed=7] [--sheets=20]`   (default folder: `reports/model-catalog`)
// Writes `catalog.csv` and `catalog.json` (sorted by total cost), `sheets/NN-<id>.png` (render + wireframe of the costliest), `gaps.md`.
// The page side is `src/lab/catalog/` (kits.ts, people.ts, city.ts, measure.ts, items.ts, run.ts).
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const flag = (name, fallback) => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(args.find((a) => !a.startsWith('--')) ?? 'reports/model-catalog');
const url = flag('url', 'http://127.0.0.1:5300/');
const seed = Number(flag('seed', 7));
const sheetCount = Number(flag('sheets', 20));
mkdirSync(out, { recursive: true });
rmSync(join(out, 'sheets'), { recursive: true, force: true });
mkdirSync(join(out, 'sheets'), { recursive: true });

// ---- what the page needs from the disk: the garment and hair files, the shape targets' size, the textures' sizes.
const PEOPLE = resolve('public/models/people');
const proxies = readdirSync(join(PEOPLE, 'proxies')).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
const targetBytes = ['targets-local.bin', 'targets-macro-pca.bin', 'faceunits.bin'].reduce((sum, f) => sum + statSync(join(PEOPLE, f)).size, 0);

/** A WebP file's width and height from its header (VP8, VP8L, VP8X), or null. */
function webpSize(path) {
  try {
    const b = readFileSync(path);
    const chunk = b.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') { const bits = b.readUInt32LE(21); return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }; }
    if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  } catch (error) {
    console.error(`unreadable WebP header: ${path}`, error);
  }
  return null;
}

let server = null;
if (!(await fetch(url).then((r) => r.ok, () => false))) {
  const { createServer } = await import('vite');
  server = await createServer({ server: { host: '127.0.0.1', port: 5300, strictPort: true } });
  await server.listen();
}

/** Where the camera looks from in the test city, far to near, so that every layer and level is drawn once. */
const VIEWS = [
  [0, 0, 0.17, 45, 48], [0, 0, 0.6, 0, 60], [0, 0, 1.2, 30, 38], [0, 0, 2.5, 0, 89], [0, 0, 4, 20, 40],
  [150, 0, 7, 20, 30], [150, 0, 12, 20, 25], [-500, 300, 6, 0, 45], [900, 900, 3.5, 0, 50], [-600, -400, 9, 120, 30],
];
const RUN = '/src/lab/catalog/run.ts';
const call = (page, name, ...rest) => page.evaluate(async ([path, fn, params]) => (await import(path))[fn](...params), [RUN, name, rest]);
const step = (text) => console.log(`${new Date().toISOString().slice(11, 19)} ${text}`);

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
let result;
const sheets = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();
  page.on('pageerror', (error) => console.error(`page error: ${error.message}`));
  await page.goto(url);
  await page.waitForFunction(() => performance.getEntriesByName('opening:shown').length > 0, null, { timeout: 180000, polling: 250 });
  step('kits');
  step(`kits: ${await call(page, 'catalogueKits', proxies, targetBytes)} items`);
  await page.evaluate((s) => { performance.clearMarks(); return window.__roadcraft.generateCity({ seed: s, size: 'large' }); }, seed);
  await page.waitForFunction(() => performance.getEntriesByName('city:applied').length > 0 && performance.getEntriesByName('opening:shown').length > 0, null, { timeout: 600000, polling: 250 });
  await page.waitForFunction(() => { const c = document.getElementById('loading-curtain'); return !!c && getComputedStyle(c).display === 'none'; }, null, { timeout: 300000, polling: 250 });
  await page.waitForTimeout(2000);
  step(`test city objects: ${await call(page, 'catalogueCityObjects')} items`);
  for (const view of VIEWS) {
    await call(page, 'catalogueView', ...view);
    await page.waitForTimeout(3500);
    step(`view ${view.join(' ')}: ${await call(page, 'catalogueLook')} layer kinds`);
  }
  await call(page, 'catalogueView', ...VIEWS[3]);
  await page.waitForTimeout(3000);
  step(`finish: ${await call(page, 'catalogueFinish')} items`);
  result = await call(page, 'catalogueResult');
  // The proxies' textures: their size on the GPU (RGBA, its mips) from the file's header.
  for (const row of result.rows) {
    const texture = row.notes.find((n) => n.startsWith('texture '))?.slice(8);
    if (!texture) continue;
    const size = webpSize(join(PEOPLE, 'proxies', texture));
    if (!size) { row.notes.push('texture size unreadable'); continue; }
    const bytes = Math.round(size.width * size.height * 4 * 4 / 3);
    row.textureBytes += bytes;
    row.totalBytes += bytes;
    row.notes.push(`texture ${size.width}x${size.height} (${Math.round(bytes / 1024)} KB with mips)`);
  }
  result.rows.sort((a, b) => b.totalTriangles - a.totalTriangles || b.triangles - a.triangles);
  const top = result.rows.filter((r) => !r.preview && r.totalTriangles > 0 && r.origin !== 'test city').slice(0, sheetCount);
  for (const [i, row] of top.entries()) {
    let png = null;
    try {
      png = await call(page, 'catalogueSheet', row.id);
    } catch (error) {
      console.error(`sheet of ${row.id} failed: ${error.message}`);
      result.gaps.push(`${row.id}: its sheet could not be drawn (${error.message.split('\n')[0]})`);
    }
    if (!png) continue;
    const file = `${String(i + 1).padStart(2, '0')}-${row.id.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 80)}.png`;
    writeFileSync(join(out, 'sheets', file), Buffer.from(png, 'base64'));
    sheets.push(file);
  }
} finally {
  await browser.close();
  await server?.close();
}

// ---- the outputs: CSV and JSON by total cost, the gaps.
const rows = result.rows;
const kb = (b) => Math.round(b / 1024);
const COLUMNS = [
  ['rank', (r, i) => i + 1], ['group', (r) => r.group], ['name', (r) => r.name], ['variation', (r) => r.variation], ['origin', (r) => r.origin], ['source', (r) => r.source],
  ['build', (r) => r.build], ['triangles', (r) => r.triangles], ['vertices', (r) => r.vertices], ['bytes_per_vertex', (r) => r.bytesPerVertex], ['attributes', (r) => r.attributes],
  ['geometry_kb', (r) => kb(r.geometryBytes)], ['texture_kb', (r) => kb(r.textureBytes)], ['other_kb', (r) => kb(r.extraBytes)], ['total_kb', (r) => kb(r.totalBytes)],
  ['materials', (r) => r.materials], ['shader', (r) => r.shader], ['shader_motion', (r) => r.motion],
  ['lod_triangles', (r) => r.levels.map((l) => `L${l.level}:${l.triangles}`).join(' ')], ['solids', (r) => r.solids], ['hidden_triangles', (r) => (r.hiddenTriangles === null ? 'n/a' : r.hiddenTriangles)],
  ['shadow', (r) => r.shadow], ['bones', (r) => r.bones || ''], ['morph_targets', (r) => r.morphTargets || ''], ['floors', (r) => r.floors || ''], ['triangles_per_floor', (r) => r.trianglesPerFloor || ''],
  ['instances', (r) => r.instances], ['instances_from', (r) => r.instancesFrom], ['total_triangles', (r) => r.totalTriangles],
  ['editor_preview', (r) => (r.preview ? 'yes' : '')], ['effect', (r) => (r.effect ? 'yes' : '')], ['notes', (r) => r.notes.join('; ')],
];
const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
writeFileSync(join(out, 'catalog.csv'), [COLUMNS.map(([h]) => h).join(','), ...rows.map((r, i) => COLUMNS.map(([, f]) => cell(f(r, i))).join(','))].join('\n'));

const known = [
  'Clouds: no mesh; drawn by ray marching in the post chain (src/render/postprocess.ts CLOUD_SHADOWS).',
  'Buildings\' far levels (facade level L1, masses, base): built per cell of the building layer from many buildings at once (massCells.ts, farParts.ts), not per building; measured as the test city\'s layers.',
  'Vehicles\' intermediate levels: made at run time by the simplifier (vehicleLevels.ts partLevels, meshoptimizer); the catalogue gives the full model (L0) and the far model.',
  'Signals, signs, barriers, flags and the far traffic: their layers build their models only from placed items (the builders are private to the layer); measured from the test city\'s meshes where it has them.',
  'Garments and hair: how many people wear each one is decided per person at run time; their copies are not counted.',
  'Editor feedback on the ground (src/render/renderer.ts blink) and the tools\' 2D gizmos (drawn on a canvas over the view): no catalogued mesh.',
];
// Each group's total: the running game's (no previews, no effects), the effects', the previews'.
const groups = {};
for (const r of rows) {
  const g = (groups[r.group] ??= { rows: 0, triangles: 0, totalTriangles: 0, bytes: 0, section: r.preview ? 'editor preview' : r.effect ? 'effect' : 'game' });
  g.rows++; g.triangles += r.triangles; g.totalTriangles += r.totalTriangles; g.bytes += r.totalBytes;
}
const json = {
  generated: new Date().toISOString(), seed, views: VIEWS, drawCalls: result.drawCalls, destruction: result.destruction, sheets, gaps: [...known, ...result.gaps],
  groups: Object.fromEntries(Object.entries(groups).sort((a, b) => b[1].totalTriangles - a[1].totalTriangles)),
  effects: rows.filter((r) => r.effect).map((r) => r.id), editorPreviews: rows.filter((r) => r.preview).map((r) => r.id), rows, scene: result.scene,
};
writeFileSync(join(out, 'catalog.json'), JSON.stringify(json, null, 1));
writeFileSync(join(out, 'gaps.md'), ['# What the catalogue could not measure, and why', '', ...json.gaps.map((g) => `- ${g}`), '', '## Rows without vertex-level measures (arrays sent to the GPU only)', '',
  ...rows.filter((r) => r.released).map((r) => `- ${r.id}`)].join('\n'));

const sum = (list, f) => list.reduce((s, r) => s + f(r), 0);
const game = rows.filter((r) => !r.preview && !r.effect);
console.log(`${rows.length} rows (${sum(rows, (r) => (r.preview ? 1 : 0))} editor previews, ${sum(rows, (r) => (r.effect ? 1 : 0))} effects), ${json.gaps.length} gaps, ${sheets.length} sheets`);
console.log(`running game: ${sum(game, (r) => r.totalTriangles).toLocaleString('en')} triangles over the test city's copies; draw calls ${result.drawCalls?.total ?? '?'}`);
for (const r of rows.slice(0, 10)) console.log(`  ${String(r.totalTriangles).padStart(12)}  ${r.id}`);
console.log(`-> ${out}`);
