// THE CATALOGUE AS A PAGE: every object saved in `rows/` with its picture (render + hidden-line wireframe), its numbers and its 3D file, by group.
// Written again after each object is saved (`scripts/model-catalog.mjs`); by hand: `node scripts/model-catalog-report.mjs [catalogue folder]`.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `index.html` of `folder` from the objects saved so far (`rows/*.json`), what could not be measured (`gaps.json`) and the state of the run. */
export function writeReport(folder, status = '') {
const rows = existsSync(join(folder, 'rows')) ? readdirSync(join(folder, 'rows')).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(folder, 'rows', f), 'utf8'))) : [];
const data = { generated: new Date().toISOString(), gaps: existsSync(join(folder, 'gaps.json')) ? JSON.parse(readFileSync(join(folder, 'gaps.json'), 'utf8')) : [],
  hiddenTriangles: 'hidden triangles: triangles whose centre lies strictly inside another closed convex solid of the same object (its face planes, the solids welded by position), or pressed face to face on another triangle (the same centre, opposite normals); n/a for lines, points and geometry whose arrays could not be read.' };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const n = (v) => Number(v ?? 0).toLocaleString('en');
const kb = (b) => `${n(Math.round((b ?? 0) / 1024))} KB`;

/** What is not catalogued yet, and why: the engine's layout layers still to be built alone. */
const PENDING = [
  'Traffic signals (src/render/signals.ts createSignalHeads)', 'Signs (src/render/signLayer.ts)', 'Barriers (src/render/barriers.ts)', 'Flags (src/render/buildings/flagLayer.ts)',
  'Gardens (src/render/gardens.ts)', 'Long grass clumps (src/render/grass.ts)', 'Water (src/render/terrain.ts unifiedWaterGeometry)', 'Far forest (src/render/farForest.ts)',
  'Far traffic (src/render/densityCars.ts)', 'Rail tracks and stations (src/render/transit.ts)', 'Network far roads (src/render/networkFarRoads.ts)',
  'The building shell piece by piece, each emit function of src/render/buildings/buildingMesh.ts on its own (bays, plinths, every roof kind, cornices, bands, terraces, roof plant, lanterns, clocks, lot parts, stairs, fences, parking)',
  'The buildings\' far levels (massCells.ts, farParts.ts, shellBatch.ts, partCells.ts)',
  'Copies of each object in a generated city, and triangles x copies',
];

const groups = new Map();
for (const r of rows) { const list = groups.get(r.group) ?? []; list.push(r); groups.set(r.group, list); }
const order = [...groups.entries()].map(([g, list]) => ({ g, list: list.sort((a, b) => b.triangles - a.triangles), triangles: list.reduce((s, r) => s + r.triangles, 0) })).sort((a, b) => b.triangles - a.triangles);

const card = (r, up = '') => `<article class="row" id="${esc(r.id)}">
  ${r.sheet ? `<a href="${up}${esc(r.sheet)}"><img loading="lazy" src="${up}${esc(r.sheet)}" alt="${esc(r.id)}"></a>` : '<div class="none">no sheet</div>'}
  <div class="data">
    <h3>${esc(r.name)}${r.variation ? ` <small>${esc(r.variation)}</small>` : ''}</h3>
    <dl>
      <dt>Triangles</dt><dd>${n(r.triangles)}</dd><dt>Vertices</dt><dd>${n(r.vertices)}</dd>
      <dt>Levels</dt><dd>${esc(r.levels.map((l) => `L${l.level} ${n(l.triangles)}`).join(' / '))}</dd>
      <dt>Memory</dt><dd>${kb(r.totalBytes)} (geometry ${kb(r.geometryBytes)}, textures ${kb(r.textureBytes)}${r.extraBytes ? `, other ${kb(r.extraBytes)}` : ''})</dd>
      <dt>Per vertex</dt><dd>${r.bytesPerVertex} B: ${esc(r.attributes)}</dd>
      <dt>Drawn as</dt><dd>${esc(r.build)}</dd><dt>Material</dt><dd>${esc(r.materials)}</dd><dt>Shader</dt><dd>${esc(r.shader)}${r.motion ? ` · ${esc(r.motion)}` : ''}</dd>
      <dt>Solids</dt><dd>${esc(r.solids || '-')}</dd><dt>Hidden triangles</dt><dd>${r.hiddenTriangles === null ? 'n/a' : n(r.hiddenTriangles)}</dd>
      <dt>Shadow</dt><dd>${esc(r.shadow || '-')}</dd>${r.bones ? `<dt>Bones</dt><dd>${r.bones}</dd>` : ''}${r.morphTargets ? `<dt>Shape targets</dt><dd>${r.morphTargets} (${kb(r.morphBytes)})</dd>` : ''}
      ${r.floors ? `<dt>Floors</dt><dd>${r.floors} (${n(r.trianglesPerFloor)} triangles a floor)</dd>` : ''}
      ${r.textures?.length ? `<dt>Textures</dt><dd>${r.textures.map(esc).join('<br>')}</dd>` : ''}
      <dt>Source</dt><dd><code>${esc(r.source)}</code> (${esc(r.origin)})</dd>
      ${r.notes.length ? `<dt>Notes</dt><dd>${r.notes.map(esc).join('<br>')}</dd>` : ''}
    </dl>
    ${r.model ? `<a class="file" href="${up}${esc(r.model)}" download>3D file (GLB)</a>` : ''}
  </div>
</article>`;

const slug = (g) => g.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const style = `<style>
:root { --bg: #f5f6f8; --card: #fff; --ink: #18202a; --muted: #5d6875; --line: #dde1e6; --accent: #2457c5; }
@media (prefers-color-scheme: dark) { :root { --bg: #14181d; --card: #1c2228; --ink: #e8ecf0; --muted: #9aa5b1; --line: #2c343c; --accent: #7ea6ff; } }
* { box-sizing: border-box; } body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.45 system-ui, sans-serif; }
header, main { max-width: 1400px; margin: 0 auto; padding: 16px; } h1 { margin: 8px 0; font-size: 24px; } h2 { margin: 32px 0 8px; font-size: 19px; }
.muted { color: var(--muted); } nav { columns: 3 260px; font-size: 13px; } nav a { display: block; color: var(--accent); text-decoration: none; }
table.sum { border-collapse: collapse; width: 100%; font-size: 13px; } table.sum td, table.sum th { padding: 4px 8px; border-bottom: 1px solid var(--line); text-align: right; } table.sum td:first-child, table.sum th:first-child { text-align: left; }
.row { display: grid; grid-template-columns: minmax(0, 560px) minmax(0, 1fr); gap: 16px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px; margin: 10px 0; }
.row img { width: 100%; height: auto; border-radius: 4px; display: block; } .none { display: grid; place-items: center; min-height: 120px; color: var(--muted); border: 1px dashed var(--line); }
.row h3 { margin: 0 0 6px; font-size: 16px; } .row small { color: var(--muted); font-weight: 400; }
dl { display: grid; grid-template-columns: 130px minmax(0, 1fr); gap: 2px 10px; margin: 0; font-size: 13px; } dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
.file { display: inline-block; margin-top: 8px; color: var(--accent); } code { font-size: 12px; }
@media (max-width: 800px) { .row { grid-template-columns: 1fr; } dl { grid-template-columns: 1fr; } }
a { color: var(--accent); }
</style>`;
const head = (title) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${style}</head><body>`;
// One page a group, its objects costliest first: a page of every object at once is too heavy for a browser to draw.
mkdirSync(join(folder, 'groups'), { recursive: true });
for (const o of order) {
  writeFileSync(join(folder, 'groups', `${slug(o.g)}.html`), `${head(o.g)}
<header><p><a href="../index.html">Engine Geometry Catalogue</a></p><h1>${esc(o.g)}</h1><p class="muted">${o.list.length} objects, ${n(o.triangles)} triangles one of each.</p></header>
<main>${o.list.map((r) => card(r, '../')).join('\n')}</main></body></html>`);
}
const html = `${head('Engine Geometry Catalogue')}
<header>
<h1>Engine Geometry Catalogue</h1>
<p class="muted">Every object the engine's builders make, each built alone (no city). ${n(rows.length)} objects so far, updated ${esc(data.generated)}${status ? ` - ${esc(status)}` : ''}. Each picture: the object rendered (left) and its hidden-line wireframe (right).</p>
<p class="muted">${esc(data.hiddenTriangles ?? '')}</p>
<h2>Groups</h2>
<table class="sum"><tr><th>Group</th><th>Objects</th><th>Triangles (one of each)</th></tr>
${order.map((o) => `<tr><td><a href="groups/${slug(o.g)}.html">${esc(o.g)}</a></td><td>${o.list.length}</td><td>${n(o.triangles)}</td></tr>`).join('\n')}
</table>
<h2>Not catalogued yet</h2>
<ul>${PENDING.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
<h2>Could not be measured</h2>
<ul>${(data.gaps ?? []).map((g) => `<li>${esc(g)}</li>`).join('')}</ul>
</header></body></html>`;
writeFileSync(join(folder, 'index.html'), html);
return rows.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const folder = resolve(process.argv[2] ?? 'reports/engine-geometry');
  console.log(`${writeReport(folder)} objects -> ${join(folder, 'index.html')}`);
}
