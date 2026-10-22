// WHICH OF THE BUILDINGS' MATERIALS COSTS: as `material.mjs`, but one material at a time - the buildings' meshes grouped by the material
// they draw with, each group drawn with a plain material on the same geometry, the GPU's time it gives back measured (twice, the median).
// Usage: npm run dev, then  node scripts/materialEach.mjs [--zoom 4]
import { writeFileSync } from 'node:fs';
import { openCity, sameScene } from './lib/measureCity.mjs';

const { browser, page } = await openCity();
const result = await page.evaluate(async () => {
  const { posePart } = await import('/src/render/buildings/partPose.ts');
  const handle = window.__roadcraft.scene(), scene = handle.scene;
  const layer = scene.children.find((c) => c.name === 'buildings-layer');
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  let MeshBasicMaterial = null;
  scene.traverse((o) => { const m = Array.isArray(o.material) ? o.material[0] : o.material; if (!MeshBasicMaterial && m?.isMeshBasicMaterial) MeshBasicMaterial = m.constructor; });
  const plain = new MeshBasicMaterial({ color: 0x999999 }), plainPosed = posePart(new MeshBasicMaterial({ color: 0x999999 }));
  // Each material and the meshes drawing with it (a mesh of several materials counted under each).
  const groups = new Map();
  layer.traverse((o) => {
    if (!o.isMesh || !o.material || !o.visible) return;
    for (const m of [].concat(o.material)) {
      const g = groups.get(m) ?? { meshes: new Set(), kinds: new Set() };
      g.meshes.add(o); g.kinds.add((o.name || o.type).replace(/[-_:@#\s]*[0-9][\w.,:-]*$/, ''));
      groups.set(m, g);
    }
  });
  // Warm: each plain material compiled for every kind of mesh once, before anything is measured.
  for (const [, g] of groups) for (const mesh of g.meshes) mesh.userData.__own = mesh.material;
  const swapIn = (g) => { for (const mesh of g.meshes) { const p = mesh.geometry?.attributes?.instancePoseA ? plainPosed : plain; mesh.material = Array.isArray(mesh.material) ? mesh.material.map(() => p) : p; } };
  const swapOut = (g) => { for (const mesh of g.meshes) mesh.material = mesh.userData.__own; };
  for (const [, g] of groups) swapIn(g);
  await sleep(4000);
  for (const [, g] of groups) swapOut(g);
  await sleep(3000);
  const windows = [];
  const gpu = async () => { const g = await window.__measure.gpu(1500, 2000); windows.push(g); return g.p50; };
  const out = [];
  const sorted = [...groups].sort((a, b) => b[1].meshes.size - a[1].meshes.size).slice(0, 14);
  for (const [material, g] of sorted) {
    const saves = [];
    for (let t = 0; t < 2; t++) {
      const own = await gpu();
      swapIn(g);
      const simple = await gpu();
      swapOut(g);
      saves.push(own - simple);
    }
    out.push({ material: `${material.type}${material.name ? ' ' + material.name : ''}`, kinds: [...g.kinds].slice(0, 6).join(', '), meshes: g.meshes.size, saveMs: Math.round(((saves[0] + saves[1]) / 2) * 100) / 100, saves: saves.map((x) => Math.round(x * 100) / 100), defines: Object.keys(material.defines ?? {}).join(','), onBeforeCompile: material.onBeforeCompile.toString().length });
  }
  return { out, windows };
});
console.log(sameScene(result.windows).line);
console.log('material'.padEnd(46), 'saves ms  (two turns)     meshes  part kinds');
for (const r of result.out.sort((a, b) => b.saveMs - a.saveMs)) console.log(r.material.slice(0, 45).padEnd(46), String(r.saveMs).padStart(8), `  (${r.saves.join(', ')})`.padEnd(16), String(r.meshes).padStart(6), ' ', r.kinds);
writeFileSync('test-results/materialEach.json', JSON.stringify(result, null, 2));
await browser.close();
