// THE WEIGHT OF EACH KIND OF BUILDING PART: the small city of a fixed seed in the district view, everything on (shadows and post off);
// each kind of building mesh hidden alone for a few seconds, the GPU's time it gives back measured, and its triangles and
// instances, and how many of its triangles cast into the shadows. Usage: npm run dev, then  node scripts/buildingParts.mjs [--zoom 4] [--shadows]
import { writeFileSync } from 'node:fs';
import { arg, openCity, sameScene } from './lib/measureCity.mjs';

const SHADOWS = process.argv.includes('--shadows');
const TURNS = Number(arg('--turns', '3'));
const { browser, page } = await openCity();
const rows = await page.evaluate(async ({ shadows, TURNS }) => {
  const { QUALITY } = await import('/src/render/quality.ts');
  const handle = window.__roadcraft.scene(), scene = handle.scene;
  handle.setQuality('ultra', { ...QUALITY.ultra, shadows, postProcessing: false, ambientOcclusion: false, smaa: false });
  const layer = scene.children.find((c) => c.name === 'buildings-layer');
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const kindOf = (m) => (m.name || m.type).replace(/[-_:@#\s]*[0-9][\w.,:-]*$/, '');
  const kinds = new Map();
  layer.traverse((m) => {
    if (!m.isMesh || !m.visible || !m.geometry) return;
    const g = m.geometry, n = g.index ? g.index.count : (g.attributes.position?.count || 0), inst = m.isInstancedMesh ? m.count : 1;
    const k = kinds.get(kindOf(m)) ?? { meshes: [], tris: 0, inst: 0, casting: 0, verts: 0 };
    k.meshes.push(m); k.tris += (n / 3) * inst; k.inst += inst; k.verts = Math.max(k.verts, g.attributes.position?.count || 0); if (m.castShadow) k.casting += (n / 3) * inst;
    kinds.set(kindOf(m), k);
  });
  await sleep(3000);
  await window.__measure.settle();
  const windows = [];
  const gpu = async () => { const g = await window.__measure.gpu(900, 1600); windows.push(g); return g.p50; };
  const med = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const out = [], bases = [];
  for (const [name, k] of [...kinds].sort((a, b) => b[1].tris - a[1].tris)) {
    if (k.tris < 20000) continue;
    // The whole and the kind hidden, turn about: each kind's saving against a whole measured next to it.
    const saves = [];
    for (let t = 0; t < TURNS; t++) {
      const whole = await gpu();
      bases.push(whole);
      for (const m of k.meshes) m.visible = false;
      saves.push(whole - await gpu());
      for (const m of k.meshes) m.visible = true;
    }
    out.push({ name, saveMs: Math.round(med(saves) * 100) / 100, trisK: Math.round(k.tris / 1000), meshes: k.meshes.length, instances: k.inst, vertsMax: k.verts, castsK: Math.round(k.casting / 1000) });
  }
  handle.setQuality('ultra', QUALITY.ultra);
  return { base: med(bases), out, windows };
}, { shadows: SHADOWS, TURNS });
console.log(sameScene(rows.windows).line);
console.log(`GPU p50 com tudo: ${rows.base} ms (sombras ${SHADOWS ? 'ligadas' : 'desligadas'}, pós desligado)`);
console.log('peça'.padEnd(34), 'devolve ms', ' tri(k)', 'malhas', 'instâncias', 'vért/peça', 'projeta sombra(k)');
for (const r of rows.out.sort((a, b) => b.saveMs - a.saveMs)) console.log(r.name.padEnd(34), String(r.saveMs).padStart(9), String(r.trisK).padStart(7), String(r.meshes).padStart(6), String(r.instances).padStart(10), String(r.vertsMax).padStart(9), String(r.castsK).padStart(10));
writeFileSync(`test-results/buildingParts${SHADOWS ? '-shadows' : ''}.json`, JSON.stringify(rows, null, 2));
await browser.close();
