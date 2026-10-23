// THE CATALOGUE'S OPTIMIZATION ADVICE: for every object saved in `rows/`, what to change and why, against a triangle budget for its kind; written into
// each row (`advice`, `target`) and summed up in `optimization.html`. The budgets and techniques come from the references listed in SOURCES
// (the optimization lab and optimized-city prototypes the player handed over, Cities: Skylines' asset guidance, GPU Gems 3, meshoptimizer).
// `node scripts/model-catalog-advice.mjs [catalogue folder]` (default `reports/engine-geometry`).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const folder = resolve(process.argv[2] ?? 'reports/engine-geometry');
const files = readdirSync(join(folder, 'rows')).filter((f) => f.endsWith('.json')).sort();
const rows = files.map((f) => ({ file: f, row: JSON.parse(readFileSync(join(folder, 'rows', f), 'utf8')) }));

const SOURCES = [
  ['Optimization lab prototype (Laboratório de Otimização 3D): hidden faces, thin cylinders to boxes, merge, quantize, fake rounded corners, LOD, impostors, instancing, compact instances, chunk LOD, atlas, shadow cache, blob shadows, GPU crowd', 'Downloads/Laboratório de Otimização 3D (5).html'],
  ['Optimized city prototype (Cidade Otimizada): building 10 triangles with facade + interior-mapping shader, person ~82/36, car ~100/28, tree 250/86/20, balcony 10+6, AC 10, lamp 34, fence 2, whole ground 2 triangles', 'Downloads/Cidade Otimizada.html'],
  ['Cities: Skylines asset guidance (community relay of the official guide): buildings < 1,000 to ~5,000 triangles, vehicles ~500-1,000, props warned above 1,000', 'https://steamcommunity.com/workshop/filedetails/discussion/667342976/1636416951459546732'],
  ['GTA V graphics study: aggressive LOD, far cars down to their headlights', 'https://adriancourreges.com/blog/2015/11/02/gta-v-graphics-study-part-2'],
  ['GTA V vehicle LOD chain (community figures): LOD0 to LOD4 of ~500-1,000 triangles, highest level in a separate _hi file', 'https://www.modding-forum.com/guide/1-lod-models/'],
  ['GPU Gems 3, ch. 2, Animated Crowd Rendering: instanced palette skinning with animation in textures, ~10,000 characters', 'https://developer.nvidia.com/gpugems/GPUGems3/gpugems3_ch02.html'],
  ['GPU-animated glTF crowds (luma.gl): one instanced draw per source primitive; 19 primitives cloned 100 times are 1,900 draws', 'https://luma.gl/docs/api-reference/gltf/gltf-crowd-usage'],
  ['Interior mapping (fake rooms behind windows) as an open-world optimization', 'https://godotshaders.com/shader/fake-window-interior-shader/'],
  ['Trim sheets and baked detail for props (Polycount)', 'https://polycount.com/discussion/234240/combine-high-poly-bake-trimsheet'],
  ['meshoptimizer / gltfpack: simplification to a target with an error bound, lockBorder for stitched levels, quantization (KHR_mesh_quantization, read by three.js)', 'https://gltf-transform.dev/modules/functions/functions/quantize'],
];

/** The triangle budget of a kind, near level; and what it is built as there (Cidade Otimizada's and Cities: Skylines' figures). */
const BUDGET = [
  [/^People: (hair)$/, 400, 'hair as a few alpha-tested cards (or painted on the head at the crowd\'s distance), merged into the body\'s one skinned mesh'],
  [/^People: (eyebrows|eyelashes|eyes)$/, 0, 'painted into the head\'s texture: no geometry of its own'],
  [/^People: (jewelry|glasses|mask|horns|beard|socks|gloves)$/, 40, 'painted into the body\'s texture, or a few triangles merged into the body; never a mesh of its own'],
  [/^People: (shoes|underwear|suit|dress|top|bottom|skirt|clothes|hat|helmet|equipment)$/, 0, 'no garment mesh at run time: the outfit baked onto the body\'s one skinned mesh (the body under it removed), its look in the body\'s texture atlas'],
  [/^People: base body$/, 0, 'not shipped to the game: a build-time source only'],
  [/^People: cast/, 3000, 'one skinned mesh a body, clothes and hair baked in (GTA-style), LODs ~3,000 / 1,000 / 300 / an impostor'],
  [/^People: procedural crowd$/, 300, 'as it is far; the near crowd one skinned mesh a body'],
  [/^People: held props$/, 24, 'a box or a 4-sided prism, painted'],
  [/^Vehicles$/, 1000, 'body as a few boxes and tapered boxes, glass and lights as faces of it, wheels of 6-8 sides; LOD0 ~1,000, LOD1 ~300, LOD2 ~36 (its far model), headlights alone at the farthest (GTA V)'],
  [/^Furniture/, 40, 'boxes with the fake rounded-corner shader, detail (doors, burners, books, screens) in the texture or by parallax; only drawn in the cut-open view'],
  [/^Buildings: part models$/, 24, 'boxes or one plane with an alpha-cut or painted texture; painted by the facade shader past ~240 m'],
  [/^Buildings: shell pieces$/, 2, 'one quad a face of a block: openings, frames, sills, slabs and bands drawn by the facade shader'],
  [/^Buildings: (presets|functions|made to measure)$/, 1500, 'blocks as boxes (10 triangles each) with the facade shader (windows, frames, sills, slabs, shopfronts, doors, fake interiors), roof and props as geometry near only'],
  [/^Buildings: far facade/, 200, 'the blocks as boxes and the facade shader alone: no parts, the balconies and railings painted (Cidade Otimizada does it past 240 m)'],
  [/^Buildings: interiors/, 2000, 'walls and floors as boxes, furniture at its budget'],
  [/^Buildings: masses/, 120, 'as it is'],
  [/^Buildings: base/, 40, 'as it is'],
  [/^Street furniture$/, 40, 'boxes and 6-sided prisms, detail in the texture; decals (drains, tree pits) as one textured quad on the footway'],
  [/^Street trees and bushes$|^Forest trees|^Ecosystem trees$|^Low-poly plant models$/, 250, 'three levels with the same silhouette (~250 / 86 / 20, Cidade Otimizada) before the impostor'],
  [/^Ground cover$|^Landscape elements/, 60, 'a few crossed alpha-tested cards; gone past a short distance'],
  [/^Utility poles$/, 60, 'prisms of 4-6 sides; insulators and caps painted'],
  [/^Traffic signals$/, 400, 'about 100 a head: post and arm as 6-sided prisms, housing a box, lenses and visors painted on its face (emissive)'],
  [/^Signs$/, 30, 'as it is: a post and a plate'],
  [/^Barriers$/, 40, 'one plane a run with its bars or boards cut out of a texture (2 triangles a 25 m run in Cidade Otimizada), posts painted'],
  [/^Flags$/, 64, 'a cloth of 8 x 4 quads: the wave stays smooth in the vertex shader'],
  [/^Transit$/, 400, 'boxes; sleepers and rails as one textured strip'],
  [/^Roads$/, 600, 'the carriageway as a strip with vertices where the road bends or climbs only; markings, kerbs, joints and gutters in the road shader on road-space UVs (Cidade Otimizada draws the whole ground as one plane)'],
  [/^Roads: network far level$/, 200, 'as it is'],
  [/^Terrain$|^Water$|^Far forest$|^Sky$|^Effects$/, Infinity, 'as it is'],
  [/^Editor previews$/, Infinity, 'editor only'],
];

/** What to do with an object of this name, beyond its kind's budget (the objects the player named and the like). */
const SPECIFIC = [
  [/bookshelf/, 'One box (10 triangles) whose front face shows the books by parallax (interior mapping of a shallow box): 184 boxes today, one a book.'],
  [/^shelf$|^rack$/, 'One box whose front shows the shelves and goods by parallax or an alpha-cut texture, not a box a plank.'],
  [/^stove$/, 'One box: the burners, knobs and oven door painted (or a normal map), not 4 cylinders.'],
  [/^fridge$|^wardrobe$|^locker$|^atm$|^machine$|^checkout$/, 'One box: doors, handles, screens and slots painted on its faces.'],
  [/^tv$|^screen$|^blackboard$/, 'One thin box or a quad: the screen or board is the texture.'],
  [/officeChair/, 'Boxes for seat and back, one 3-sided prism for the column, the 5 wheels and spheres gone (painted or a disc): 820 triangles today.'],
  [/^plant$|^pot$|foliage|^bush$/, 'Crossed alpha-tested leaf cards on a 6-sided pot: no spheres.'],
  [/Lamp$/, '6-sided prisms or boxes, its glow emissive.'],
  [/^bars$|^railing$|^airer$/, 'One plane with the bars cut out of a texture in the shader (alphaTest), not a cylinder or a box a bar.'],
  [/^(bed|singleBed|sofa|armchair|table|chair|wardBed|altar|barCounter)$/, 'Legs as open boxes or 3-sided prisms (8 or 6 triangles) with the fake rounded-corner shader, not cylinders of 8 sides with caps.'],
  [/^acUnit$/, 'One box (10 triangles): the grille and fan painted (Cidade Otimizada: 10).'],
  [/^bike$/, 'A cut-out card or a 2-3 box silhouette near only.'],
  [/^dish$/, 'A 6-sided cone and a stick.'],
  [/^phone$/, 'One box with the booth painted: 560 triangles today, 240 of them hidden.'],
  [/^bin$|^hydrant$|^postbox$/, 'A 6-sided prism or a box, the details painted.'],
  [/^drain$|^tree pit$/, 'A textured decal quad on the ground (2 triangles).'],
  [/^bench$/, 'Seat, back and two legs as boxes (Cidade Otimizada: 48).'],
  [/lamp light beam/, 'A cone of 8-12 sides, or a screen-facing card.'],
  [/^lamp$/, 'A 6-sided column and a box head, glow emissive (Cidade Otimizada: 34).'],
  [/^(hatch|sedan|suv|van)$/, 'Rebuild near 1,000 triangles; the interior (seats, dashboard, wheel) only through the glass when near, or painted.'],
  [/^bus$/, 'Rebuild near 1,500; 62 cylinders and 208 boxes today.'],
  [/^wheel$/, 'Tyre and rim as one 6-8 sided prism with the rim painted.'],
  [/^(motorcycle|bicycle)$/, 'A few boxes and two 6-sided wheels, near only; a card past it.'],
  [/mushrooms|flowers|clover|tallGrass|grass|fern|scrub/, 'Alpha-tested cards; drop past ~30 m.'],
  [/^stones$|^pebbles$|^gravel$/, 'Painted on the ground at any distance but the closest; a decal.'],
  [/signalised junction/, 'About 100 triangles a head.'],
  [/flag cloth/, '8 x 4 quads.'],
  [/^railing$|^fence$|^guardrail$|^wall$/, 'Cut-out plane a run.'],
  [/MakeHuman base mesh/, 'Stays a build-time source; with its helper geometry (joints and fitting cubes, 36,608 triangles) it is never drawn.'],
];

/** What the pictures and wireframes show, by group and name (`group | name`): the build errors seen object by object. */
const SEEN = [
  [/shell pieces \| facade bay/, 'Picture: the wall round each opening is cut into many small rectangles (reveals, sill, head) a bay; the whole face should be one quad and the openings, reveals and sills drawn by the facade shader (window grid by UV).'],
  [/shell pieces \| flush storey band/, 'Picture: a 2-triangle strip a storey laid over the wall; it is a line of colour, paint it in the facade shader.'],
  [/shell pieces \| streak under a sill/, 'Picture: a stain under a sill built as geometry; a texture or shader term (weathering), never triangles.'],
  [/shell pieces \| roof plant/, 'Picture: tanks, fans and vents as 14-sided cylinders (42 triangles a drum) and tiny boxes; boxes or 6-sided prisms without caps, the smallest vents painted on the roof.'],
  [/shell pieces \| (lot ground and foundation|plinth)/, 'Picture: the foundation ring round the lot is cut into many strips (44-164 triangles); one box ring (8-16 triangles) or the lot plane alone.'],
  [/shell pieces \| parking/, 'Picture: the parking is a grid of quads; one quad with the bays painted.'],
  [/shell pieces \| (building body|roof terrace|roof \(polygon plan\)|roof$|lot$|facade relief)/, 'Picture: faces split along every bay and storey line (long slivers in the wireframe); one polygon a face, the lines in the facade shader.'],
  [/^Buildings: far facade/, 'Picture: the far level still carries every balcony, railing bar, unit and roof drum of the near level; at this distance the masses level (boxes) with the facade texture is what shows.'],
  [/^Buildings: masses|^Buildings: base/, 'Picture: walls cut by a ground-floor line and vertical slivers; one quad a wall face (10 triangles a box) is enough at this level.'],
  [/^People: (eyebrows|eyelashes) \| mindfront/, 'Picture: strand-by-strand brows or lashes (14,000-42,000 triangles) beside the 192-triangle strips of the same pieces; the strip with a texture, or painted on the head.'],
  [/^People: eyes \| eyes$/, 'Picture: two full spheres of 1,020 triangles; the visible front as a few triangles or painted in the head.'],
  [/^People: (equipment|horns) \|/, 'Picture: a prop (weapon, instrument, tool, horns) no city figure wears; not shipped with the game.'],
  [/^People: (jewelry) \|/, 'Picture: a ring, chain or necklace modelled link by link or pearl by pearl; painted on the body.'],
  [/^People: (shoes) \|/, 'Picture: soles, laces and straps modelled at full detail (up to 153,938 triangles a pair); a city figure\'s feet are a few pixels.'],
  [/^People: (hair) \|/, 'Picture: hair as dense sheets or locks of geometry; a few alpha cards, or a cap painted on the head.'],
  [/^Terrain \| far patch/, 'Picture: a flat plate of 2,560 triangles; where the ground is flat a 2-triangle plate (vertices only where the height changes).'],
  [/^Water \| lake/, 'Picture: a flat disc of 4,624 triangles; a 32-64 sided fan, the waves in the shader.'],
  [/^Barriers \| railing/, 'Picture: 6,996 triangles for 70 m, a box a bar; a cut-out plane.'],
  [/^Flags \||^Transit \| metro/, 'Picture: nothing visible in the isolated shot (the object draws off its own transform or under the ground plane); check it is drawn at all where placed.'],
  [/^Vehicles \| (hatch|sedan|suv|van)/, 'Picture: the body is one dense, even grid (a subdivided surface): flat doors, roof and sides carry as many triangles as the curved corners; flat panels as single quads, the curve only on the edges.'],
  [/^Vehicles \| wheel/, 'Picture: the tyre is a rounded drum of 400-670 triangles with spokes; a few pixels on screen, a 6-8 sided prism with the rim painted.'],
  [/^Roads \|/, 'Picture: the wireframe of a flat, straight carriageway is solid black: an even grid across the whole width and length where two triangles a lane a bend would do; markings and kerbs from the shader.'],
  [/^Furniture \(interiors\) \| (ceilingLamp|floorLamp|tableLamp)/, 'Picture: shades and bases as 24-sided cones and discs (146-260 triangles for a lamp); 6-8 sides.'],
  [/^Furniture \(interiors\) \| plant/, 'Picture: three geodesic spheres of leaves on a 16-sided pot (462 triangles); crossed leaf cards.'],
  [/^Street furniture \| (bin|hydrant|phone|lamp light beam|lamp light pool)/, 'Picture: 16-24 sided cylinders, cones and a sphere where a 6-8 sided prism or a flat card reads the same at street distance.'],
  [/^Utility poles \| utility-(transformers|caps|insulators|lamp-beams|lamp-pools)/, 'Picture: 16-24 sided drums, cones and discs on a pole; 6 sides, or painted.'],
  [/^Buildings: part models \| (pot|table|dish|column|bike|airer|foliage|bush)/, 'Picture: round parts at 12-24 sides (pot rim, table top and base, dish bowl); 6-8 sides, or a card.'],
  [/^Landscape elements.*mushrooms|^Landscape elements.*flowers 2/, 'Picture: each cap or blossom a closed dense mesh (880-3,216 triangles a clump); cut-out cards.'],
  [/^(Buildings: functions|Buildings: far facade).*(square|playground|sportsCourt|park|cityHall|council|library|busStation|supermarket|church|warehouse|gasStation|club|police|school|prison|restaurant)/, 'Picture: the paved ground of the lot is a grid of quads round the building; one quad with the paving painted.'],
];

const shapes = (r, kind) => Number((new RegExp(`(\\d+) ${kind}`).exec(r.solids ?? '') ?? [0, 0])[1]);
// The first object of each (group, triangles, vertices): a later one with the same numbers is the same mesh loaded again.
const twins = new Map();
for (const { row: r } of rows) { const key = `${r.group}|${r.triangles}|${r.vertices}`; if (!twins.has(key)) twins.set(key, r); }
for (const { row: r } of rows) {
  const advice = [];
  const budget = BUDGET.find(([re]) => re.test(r.group));
  const target = budget ? budget[1] : Infinity;
  if (budget && Number.isFinite(target) && r.triangles > target) {
    const over = target > 0 ? `, ${(r.triangles / target).toFixed(1)} times the budget` : '';
    advice.push(`Budget: ${target === 0 ? 'no geometry of its own' : `about ${target.toLocaleString('en')} triangles`} (${r.triangles.toLocaleString('en')} today${over}): ${budget[2]}.`);
  }
  for (const [re, text] of SPECIFIC) if (re.test(r.name)) { advice.push(text); break; }
  for (const [re, text] of SEEN) if (re.test(`${r.group} | ${r.name} ${r.variation ?? ''}`)) { advice.push(text); break; }
  const twin = twins.get(`${r.group}|${r.triangles}|${r.vertices}`);
  if (twin && twin.id !== r.id && r.triangles > 100) advice.push(`Same triangles and vertices as ${twin.name} ${twin.variation ?? ''}: load one mesh and change its colour, not a second copy.`);
  if (r.hiddenTriangles > 0) advice.push(`Remove its ${r.hiddenTriangles.toLocaleString('en')} hidden triangles: faces inside another part or pressed face to face, never seen.`);
  const round = shapes(r, 'closed cylinder') + shapes(r, 'open prism');
  if (round > 0 && !/^People/.test(r.group) && r.triangles > 20) advice.push(`${round} round part(s) (cylinders, prisms): thin ones as boxes without caps or 3-sided prisms and the fake rounded-corner shader; caps that touch another part left out.`);
  if (r.levels.length <= 1 && r.triangles > 300 && !/^Buildings: (shell|masses|base)|^People: (?!cast)|^Roads: network|^Terrain|^Water|^Sky|^Effects|^Editor/.test(r.group)) advice.push('No level of detail: add ~50% levels (meshoptimizer simplify, weld first) and an impostor or nothing past a few pixels.');
  if (r.bytesPerVertex > 24) advice.push(`${r.bytesPerVertex} bytes a vertex: quantize (position 3 x int16, normal as 2 x int8 octahedral, colour 4 x uint8): about 12-16 bytes (KHR_mesh_quantization).`);
  if (r.morphTargets > 0) advice.push(`${r.morphTargets} shape targets (${Math.round(r.morphBytes / 1024)} KB): bake the shape the body wears; keep only the face's few expressions, or none past the near distance.`);
  if (/^People: (?!cast|procedural|held)/.test(r.group)) advice.push('Loaded at run time from public/models/people (loadProxyItem in personBuild.ts, proceduralCrowd.ts, skinAppearance.ts): ship baked bodies only, not the MakeHuman pieces.');
  if (r.textureBytes > 4 * 1024 * 1024) advice.push(`${Math.round(r.textureBytes / 1048576)} MB of textures (as counted for this object, shared textures included): GPU-compressed KTX2 (ETC1S/UASTC), the size its pixels on screen need.`);
  r.advice = advice;
  r.target = Number.isFinite(target) ? target : null;
}
for (const { file, row } of rows) writeFileSync(join(folder, 'rows', file), JSON.stringify(row, null, 1));

// ---- the page: what is wrong, by group, and the answers asked.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const n = (v) => Number(v ?? 0).toLocaleString('en');
const groups = new Map();
for (const { row: r } of rows) { const l = groups.get(r.group) ?? []; l.push(r); groups.set(r.group, l); }
const table = [...groups].map(([g, list]) => {
  const now = list.reduce((s, r) => s + r.triangles, 0);
  const target = list.reduce((s, r) => s + (r.target === null ? r.triangles : Math.min(r.triangles, r.target)), 0);
  const hidden = list.reduce((s, r) => s + (r.hiddenTriangles ?? 0), 0);
  return { g, count: list.length, now, target, hidden, worst: [...list].sort((a, b) => b.triangles - a.triangles)[0] };
}).sort((a, b) => (b.now - b.target) - (a.now - a.target));
const slug = (g) => g.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Geometry Optimization</title>
<style>:root{--bg:#f5f6f8;--card:#fff;--ink:#18202a;--muted:#5d6875;--line:#dde1e6;--accent:#2457c5;--bad:#a9521a}
@media (prefers-color-scheme: dark){:root{--bg:#14181d;--card:#1c2228;--ink:#e8ecf0;--muted:#9aa5b1;--line:#2c343c;--accent:#7ea6ff;--bad:#ee9a62}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,sans-serif}main{max-width:1200px;margin:0 auto;padding:16px}a{color:var(--accent)}
h1{font-size:24px}h2{font-size:19px;margin-top:28px}section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 16px;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{padding:5px 8px;border-bottom:1px solid var(--line);text-align:right;vertical-align:top}td:first-child,th:first-child{text-align:left}.l{text-align:left}.bad{color:var(--bad);font-weight:600}
@media (max-width:700px){table{display:block;overflow-x:auto}}</style></head><body><main>
<p><a href="index.html">Engine Geometry Catalogue</a></p><h1>Geometry Optimization</h1>
<p>Every object of the catalogue measured against a triangle budget for its kind, with what to change in it (each object's card lists its own changes). Nothing in the game was changed.</p>
<section><h2>What goes into the game, and what is loaded for nothing</h2><ul>
<li><b>Roads: three versions, all in the game.</b> Near the camera each block of road is drawn at full detail (the "Roads" rows, their L0); farther, the same block's far level, simplified by the road workers (<code>coarseArrays</code>, their L1); and wherever the far budget let a block's far level go, or while a large city opens, the network's far level made from the roads' outlines alone ("Roads: network far level"). The near level is the costly one: 2,040 to 12,228 triangles for 140 m of road, against a strip of a few hundred and the markings in the shader.</li>
<li><b>People: the MakeHuman pipeline ships with the game.</b> When a body has no cooked file, <code>riggedCitizens.ts</code> builds it at run time (<code>personBuild.ts</code>: the base mesh and its shape targets, 17.6 MB, by <code>loadPeopleAssets</code>, and every garment and hair it wears by <code>loadProxyItem</code>); the procedural crowd loads brows, lashes and other pieces the same way (<code>proceduralCrowd.ts</code>), and their textures (<code>skinAppearance.ts</code>). The game should load one baked skinned mesh a body (clothes and hair in it, one texture atlas) and nothing of MakeHuman.</li>
<li><b>The cast's bodies:</b> 28,736 to 45,256 triangles near, 84 bytes a vertex; a city-builder figure a few pixels tall needs a few thousand at most near, a few hundred beyond.</li>
<li><b>Buildings' far facade (L1) keeps almost all of the near level</b> (apartments 11,156 against 12,258): its balconies, railings, units and pots stay as geometry, and 90,284 hidden triangles over the 80 buildings.</li>
<li><b>What the pictures show, object by object:</b> building walls cut into many rectangles round every opening (one quad a face is enough, openings in the shader); storey bands and stains under sills built as triangles; roof drums of 14 sides; lot foundations and paved lots as grids of strips and quads; far facades that keep every balcony bar (the residential tower far level 140,962 triangles, the large made-to-measure tower 157,990); MakeHuman shoes up to 153,938 triangles a pair, hair up to 120,022, strand-by-strand brows and lashes of 14,000-42,000 next to 192-triangle strips of the same piece, two eyes of 2,040, a pearl necklace of 56,064, weapons and instruments no city figure carries; the same garment loaded twice under two names; a flat lake disc of 4,624 and a flat far ground plate of 2,560.</li>
<li><b>Hidden triangles everywhere:</b> ${n(rows.reduce((s, { row }) => s + (row.hiddenTriangles ?? 0), 0))} over the catalogue.</li>
</ul></section>
<section><h2>By group, the most to gain first</h2><table><tr><th>Group</th><th>Objects</th><th>Triangles now (one of each)</th><th>At budget</th><th>Hidden</th><th class="l">Heaviest</th></tr>
${table.map((t) => `<tr><td><a href="groups/${slug(t.g)}.html">${esc(t.g)}</a></td><td>${t.count}</td><td>${n(t.now)}</td><td>${n(t.target)}</td><td>${n(t.hidden)}</td><td class="l">${esc(t.worst.name)} ${esc(t.worst.variation)} <span class="bad">${n(t.worst.triangles)}</span></td></tr>`).join('\n')}
</table></section>
<section><h2>Sources</h2><ul>${SOURCES.map(([t, u]) => `<li>${esc(t)}: ${u.startsWith('http') ? `<a href="${esc(u)}">${esc(u)}</a>` : esc(u)}</li>`).join('')}</ul></section>
</main></body></html>`;
writeFileSync(join(folder, 'optimization.html'), html);
console.log(`${rows.length} objects advised -> ${join(folder, 'optimization.html')}`);
