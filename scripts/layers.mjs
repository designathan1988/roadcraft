// THE WEIGHT OF EACH LAYER: the small city of a fixed seed, three fixed views; the scene's layers put in one at a time (empty, ground, roads,
// street furniture and poles, vegetation, buildings, vehicles and people, shadows, post-processing), each measured for a few seconds by the
// game's own counters (`__gpu` the GPU's time a frame, `__frames` the page's) (no governor: the detail is not changed under a measure).
// What a layer adds over the one before it is its weight.
// Usage: npm run dev, then  node scripts/layers.mjs [--base http://127.0.0.1:5300/] [--seed 7] [--settle 1.2] [--hold 2] [--out test-results/layers.json]
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { arg, lookAt, openCity, sameScene } from './lib/measureCity.mjs';

const SETTLE = Number(arg('--settle', '1.2')) * 1000;
const HOLD = Number(arg('--hold', '2')) * 1000;
const OUT = arg('--out', 'test-results/layers.json');

/** The layers in the order they are put in: the groups of the scene each brings (top-level names, or `world/<child>`), and the quality it turns on. */
const LAYERS = [
  { name: 'vazio (só o céu)', groups: [] },
  { name: '+ terreno', groups: ['flat-world-ground'] },
  { name: '+ vias', groups: ['world/road-network', 'world/roads-far-tiles', 'world/road-stand-ins', 'world/road-structure-details'] },
  { name: '+ mobiliário, postes, placas, semáforos', groups: ['world/street-furniture', 'world/utilities', 'world/signs', 'world/barriers', 'world/transit', 'world/elements', 'traffic-signals'] },
  { name: '+ vegetação', groups: ['world/*garden*', 'world/*forest*', 'world/grass', 'world/ground-cover', 'world/nature-cards'] },
  { name: '+ prédios', groups: ['buildings-layer'] },
  { name: '+ veículos e pessoas', groups: ['agent-parts', 'densityCars'] },
  { name: '+ sombras', quality: { shadows: true } },
  { name: '+ pós-processamento (AO, SMAA, bloom)', quality: { postProcessing: true, ambientOcclusion: true, smaa: true } },
];

const { browser, page, fit } = await openCity({ zoom: 1 });

const results = { seed: Number(arg('--seed', '7')), views: [] };
for (const view of [{ name: 'cidade inteira', zoom: 1 }, { name: 'bairro', zoom: 4 }, { name: 'rua no centro', zoom: 14 }]) {
  await lookAt(page, fit, view.zoom);
  const rows = await page.evaluate(async ({ LAYERS, SETTLE, HOLD }) => {
    const { QUALITY } = await import('/src/render/quality.ts');
    const r = window.__roadcraft, handle = r.scene(), scene = handle.scene;
    const world = scene.children.find((c) => c.name === 'world');
    const pick = (spec) => {
      const [top, child] = spec.split('/');
      if (!child) return scene.children.filter((c) => c.name === top);
      const re = new RegExp('^' + child.replace(/\*/g, '.*') + '$');
      return (world?.children ?? []).filter((c) => re.test(c.name));
    };
    const all = LAYERS.flatMap((l) => (l.groups ?? []).flatMap(pick));
    const was = new Map(all.map((g) => [g, g.visible]));
    let quality = { ...QUALITY.ultra, shadows: false, postProcessing: false, ambientOcclusion: false, smaa: false };
    handle.setQuality('ultra', quality);
    for (const g of all) g.visible = false;
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const visibleTris = () => { let t = 0, meshes = 0; scene.traverseVisible((m) => { if (!m.isMesh || !m.geometry) return; meshes++; const g = m.geometry; const n = g.index ? g.index.count : (g.attributes.position?.count || 0); t += (n / 3) * (m.isInstancedMesh ? m.count : 1); }); return { tris: t, meshes }; };
    const out = [];
    for (const layer of LAYERS) {
      for (const g of (layer.groups ?? []).flatMap(pick)) g.visible = was.get(g) ?? true;
      if (layer.quality) { quality = { ...quality, ...layer.quality }; handle.setQuality('ultra', quality); }
      const since = performance.now() + SETTLE;
      const gpu = await window.__measure.gpu(SETTLE, HOLD), frames = window.__frames(since), seen = visibleTris();
      // Memory: the page's V8 heap and the buildings' detail on the GPU.
      const levels = handle.buildingLevels?.() ?? {};
      out.push({ layer: layer.name, scene: gpu.scene, gpuP50: gpu.p50, gpuP95: gpu.p95, cpuP50: frames.total?.p50, frames: frames.frames, trisM: Math.round(seen.tris / 1e4) / 100, meshes: seen.meshes,
        heapMB: Math.round(performance.memory.usedJSHeapSize / 1e6), detailMB: Math.round((levels.residentBytes ?? 0) / 1e6) });
    }
    handle.setQuality('ultra', QUALITY.ultra);
    return out;
  }, { LAYERS, SETTLE, HOLD });
  let before = null;
  console.log(`\n== ${view.name} ==`);
  console.log(sameScene(rows).line);
  for (const row of rows) {
    const add = before === null ? '' : `  (+${(row.gpuP50 - before.gpuP50).toFixed(2)} ms GPU, +${(row.trisM - before.trisM).toFixed(2)} M tri)`;
    console.log(`${row.layer.padEnd(42)} GPU p50 ${String(row.gpuP50).padStart(6)} ms  p95 ${String(row.gpuP95).padStart(6)}  CPU p50 ${String(row.cpuP50).padStart(5)} ms  ${String(row.trisM).padStart(6)} M tri  ${String(row.meshes).padStart(5)} malhas  heap ${row.heapMB} MB  detalhe ${row.detailMB} MB${add}`);
    before = row;
  }
  results.views.push({ view: view.name, rows });
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`\nRESULT: written ${OUT}`);
await browser.close();
