// THE COST OF THE BUILDINGS' SHADING: the small city of a fixed seed, opened, held and settled by `lib/measureCity.mjs`; in one page, the
// buildings' meshes drawn with their own materials, then with a plain one on the same geometry (a posed part keeps its pose: `posePart`),
// turn and turn about, the GPU's time measured each turn, every window saying the scene it measured. What the plain material gives back is
// what the buildings' shading costs.
// Usage: npm run dev, then  node scripts/material.mjs [--base http://127.0.0.1:5300/] [--turns 3] [--settle 3] [--hold 2.5]
import { writeFileSync } from 'node:fs';
import { arg, lookAt, median, openCity, sameScene } from './lib/measureCity.mjs';

const TURNS = Number(arg('--turns', '3'));
const SETTLE = Number(arg('--settle', '3')) * 1000;
const HOLD = Number(arg('--hold', '2.5')) * 1000;
const { browser, page, fit } = await openCity({ zoom: 1 });
const all = [];
for (const view of [{ name: 'bairro', zoom: 4 }, { name: 'rua no centro', zoom: 14 }]) {
  await lookAt(page, fit, view.zoom);
  const rows = await page.evaluate(async ({ TURNS, SETTLE, HOLD }) => {
    const { posePart } = await import('/src/render/buildings/partPose.ts');
    const handle = window.__roadcraft.scene(), scene = handle.scene;
    const layer = scene.children.find((c) => c.name === 'buildings-layer');
    // The game's own three: the constructor of a basic material already in the scene (a second copy of three would not be the renderer's).
    let MeshBasicMaterial = null;
    scene.traverse((o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!MeshBasicMaterial && m?.isMeshBasicMaterial) MeshBasicMaterial = m.constructor; });
    if (!MeshBasicMaterial) throw new Error('no basic material in the scene to take the constructor of');
    const plain = new MeshBasicMaterial({ color: 0x999999 });
    const plainPosed = posePart(new MeshBasicMaterial({ color: 0x999999 }));
    const swapped = [];
    layer.traverse((o) => {
      if (!o.isMesh || !o.material) return;
      const posed = !!o.geometry?.attributes?.instancePoseA;
      swapped.push({ mesh: o, own: o.material, plain: posed ? plainPosed : plain });
    });
    const windows = [];
    const gpu = async () => { const g = await window.__measure.gpu(SETTLE, HOLD); windows.push(g); return { p50: g.p50, p95: g.p95, n: g.n }; };
    const out = [];
    for (let t = 0; t < TURNS; t++) {
      for (const s of swapped) s.mesh.material = s.own;
      out.push({ turn: t, material: 'próprio', ...(await gpu()) });
      for (const s of swapped) s.mesh.material = Array.isArray(s.own) ? s.own.map(() => s.plain) : s.plain;
      out.push({ turn: t, material: 'simples', ...(await gpu()) });
    }
    for (const s of swapped) s.mesh.material = s.own;
    return { meshes: swapped.length, out, windows };
  }, { TURNS, SETTLE, HOLD });
  console.log(`\n== ${view.name} (${rows.meshes} malhas de prédio) ==`);
  console.log(sameScene(rows.windows).line);
  for (const r of rows.out) console.log(`volta ${r.turn}  ${r.material.padEnd(8)}  GPU p50 ${String(r.p50).padStart(6)} ms  p95 ${String(r.p95).padStart(6)} ms  (${r.n} quadros)`);
  const own = rows.out.filter((r) => r.material === 'próprio').map((r) => r.p50), simple = rows.out.filter((r) => r.material === 'simples').map((r) => r.p50);
  console.log(`mediana: próprio ${median(own)} ms, simples ${median(simple)} ms, o sombreamento dos prédios custa ~${(median(own) - median(simple)).toFixed(2)} ms`);
  all.push({ view: view.name, ...rows });
}
writeFileSync('test-results/material.json', JSON.stringify(all, null, 2));
await browser.close();
