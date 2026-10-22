// Switches, optimisations, the GPU area, the CPU profile.
(async () => {
  const { check, assert, frames } = window.__v;
  const lab = window.__lab;
  const scene = lab.scene;
  await check('a switch really hides (buildings: triangles drop and come back)', async () => {
    await frames(800); const a = scene.stats.drawnTriangles;
    lab.effects.setMany({ buildings: false }); await frames(800); const b = scene.stats.drawnTriangles;
    lab.effects.setMany({ buildings: true }); await frames(1200); const c = scene.stats.drawnTriangles;
    assert(b < a * 0.8, `did not drop: ${a} → ${b}`);
    assert(c > b * 1.1, `did not come back: ${b} → ${c}`);
    return `${a} → ${b} → ${c}`;
  });
  await check('an optimisation applies and restores (opaqueSort, anisotropy)', async () => {
    const o = window.__labOpt;
    assert(o, 'no __labOpt');
    o.set('opaqueSort', 'depth');
    assert(o.get('opaqueSort') === 'depth', 'not applied');
    o.set('anisotropy', 2); await frames(600);
    const rep = scene.optimizationReport();
    assert(rep.texturesCapped > 0, `no texture capped: ${JSON.stringify(rep)}`);
    o.reset(); await frames(600);
    assert(o.get('opaqueSort') === 'material', `not restored: ${o.get('opaqueSort')}`);
    return `textures capped ${rep.texturesCapped}; restored`;
  });
  await check('GPU: per-pass timing measures', async () => {
    const g = window.__labGpu;
    g.passTiming(true); await frames(1800);
    const rows = g.passes(); g.passTiming(false);
    assert(rows.length >= 3 && rows.every((r) => Number.isFinite(r.avg)), `passes: ${JSON.stringify(rows).slice(0, 200)}`);
    return rows.map((r) => `${r.label} ${r.avg.toFixed(2)}`).join(' | ');
  });
  await check("GPU: frame capture matches the game's counter", async () => {
    await frames(300);
    const game = scene.stats.drawCalls;
    const cap = await window.__labGpu.capture();
    const calls = cap.records.reduce((a, r) => a + r.calls, 0);
    assert(cap.records.length > 0, 'empty capture');
    assert(Math.abs(calls - game) <= Math.max(30, game * 0.1), `captured ${calls} x game ${game}`);
    return `${calls} calls captured; game ${game}`;
  });
  await check('GPU: objects (textures, targets, geometries)', async () => {
    const o = window.__labGpu.objects();
    const n = (k) => (Array.isArray(o[k]) ? o[k].length : 0);
    assert(n('textures') > 0 && n('geometries') > 0, `empty: ${Object.keys(o)}`);
    return `textures ${n('textures')}, targets ${n('targets')}, geometries ${n('geometries')}`;
  });
  await check('Code: the CPU profile gives game functions with a .ts file:line', async () => {
    const c = window.__labCode;
    c.start(true); await frames(4500);
    const f = c.functions('session').filter((x) => x.category === 'game');
    assert(f.length > 0, 'no game function');
    const mapped = f.filter((x) => /\.ts:\d+$/.test(x.where));
    assert(mapped.length / f.length > 0.7, `only ${mapped.length} of ${f.length} with .ts:line (e.g. ${f.slice(0, 3).map((x) => x.where)})`);
    return `${f.length} functions, ${mapped.length} mapped; ${f.slice(0, 3).map((x) => `${x.name}@${x.where}`).join(' | ')}`;
  });
  return JSON.stringify(window.__v.results.filter((r) => !r.ok).map((r) => r.name));
})();
