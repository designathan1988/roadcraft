// WHAT OF THE SHELL'S PROGRAM COSTS: the shell's material and copies of it with one piece taken out of its fragment program (the weathering,
// the colour, roughness and normal maps, the finishes' look table), and a plain standard material,
// one at a time in one page, the city opened, held and settled by `lib/measureCity.mjs` (every window says the scene it measured).
// Usage: npm run dev, then node scripts/shellMaps.mjs [--zoom 4] [--turns 3]
import { writeFileSync } from 'node:fs';
import { arg, median, openCity, sameScene } from './lib/measureCity.mjs';

const TURNS = Number(arg('--turns', '3'));
const { browser, page } = await openCity();
const result = await page.evaluate(async (TURNS) => {
  const { posePart } = await import('/src/render/buildings/partPose.ts');
  const { createShellMaterial } = await import('/src/render/buildings/finishes.ts');
  const handle = window.__roadcraft.scene(), scene = handle.scene;
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const layer = scene.children.find((c) => c.name === 'buildings-layer');
  let own = null;
  layer.traverse((o) => { if (!own && o.isMesh && o.material?.name === 'building-shell') own = o.material; });
  const cut = (name, cuts, options = { plain: true }) => {
    const m = createShellMaterial(options, 8);
    const compile = m.onBeforeCompile;
    m.onBeforeCompile = (shader, renderer) => {
      compile.call(m, shader, renderer);
      for (const [from, to, stage = 'fragmentShader'] of cuts) {
        if (!from.test(shader[stage])) throw new Error(`${name}: ${from} not in the shell's ${stage}`);
        shader[stage] = shader[stage].replace(from, to);
      }
    };
    m.customProgramCacheKey = () => `shell-maps-test-${name}`;
    return posePart(m);
  };
  const COLOUR = [/diffuseColor \*= texture\(shellMaps, [^;]*;/, ''];
  const ROUGH = [/shellRoughTexel = texture\(shellRough, [^;]*;/, ''];
  const NORMAL = [/normal = normalize\(shellTbn \* mapN\);/, ''];
  const LOOK = [/shellLook = shellLooks\[[^;]*;\s*shellKind = shellLooks\[[^;]*;/, 'shellLook = vec4(1.0, 1.0, 0.0, 1.0); shellKind = vec4(0.0);'];
  // The vertex's work: the planar uv (`shellPlanarUv`, the shell's own and the parts'), the parts' tone noise (`shellMacroNoise`, eight hashes a vertex).
  const UV = [/vShellUv = shellPlanarUv\(\(modelMatrix[^;]*;/, 'vShellUv = vec2(0.0);', 'vertexShader'];
  const PART_UV = [/vShellUv = shellPlanarUv\(shellAt[^;]*;/, 'vShellUv = vec2(0.0);', 'vertexShader'];
  const TONE = [/float tone = 0\.97 \+ shellMacroNoise\([^;]*;/, 'float tone = 1.0;', 'vertexShader'];
  let Standard = null;
  scene.traverse((o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!Standard && m?.isMeshStandardMaterial) Standard = m.constructor; });
  const variants = {
    'own': own,
    'no weathering': posePart(createShellMaterial({ plain: true }, 8)),
    'no weathering, no table': cut('look', [LOOK]),
    'no weathering, no 3 maps': cut('maps', [COLOUR, ROUGH, NORMAL]),
    'no weathering/table/maps': cut('bare', [LOOK, COLOUR, ROUGH, NORMAL]),
    'nothing in fragment, no vertex uv': cut('bare-uv', [LOOK, COLOUR, ROUGH, NORMAL, UV, PART_UV]),
    'nothing in fragment, no tone noise': cut('bare-tone', [LOOK, COLOUR, ROUGH, NORMAL, TONE]),
    'nothing in fragment or vertex': cut('bare-all', [LOOK, COLOUR, ROUGH, NORMAL, UV, PART_UV, TONE]),
    'standard, colour only': posePart(new Standard({ vertexColors: true, roughness: 0.9, metalness: 0 })),
  };
  const ours = new Set(Object.values(variants));
  const put = (m) => { let n = 0; layer.traverse((o) => { if (o.isMesh && ours.has(o.material)) { o.material = m; n++; } }); return n; };
  for (const m of Object.values(variants)) { put(m); await sleep(2500); }
  const times = Object.fromEntries(Object.keys(variants).map((k) => [k, []]));
  const windows = [];
  let meshes = 0;
  for (let t = 0; t < TURNS; t++) for (const [name, m] of Object.entries(variants)) { meshes = put(m); const g = await window.__measure.gpu(); times[name].push(g.p50); windows.push(g); }
  put(own);
  return { meshes, windows, times };
}, TURNS);
const same = sameScene(result.windows);
console.log(same.line);
result.rows = Object.entries(result.times).map(([name, a]) => ({ name, median: median(a), all: a }));
console.log(`meshes with the shell's material: ${result.meshes}`);
const base = result.rows[0].median;
for (const r of result.rows) console.log(r.name.padEnd(36), `GPU p50 median ${String(r.median).padStart(6)} ms  (turns ${r.all.join(', ')})  ${r === result.rows[0] ? '' : `${base - r.median >= 0 ? 'saves' : 'costs extra'} ${Math.abs(base - r.median).toFixed(2)} ms`}`);
writeFileSync('test-results/shellMaps.json', JSON.stringify(result, null, 2));
await browser.close();
