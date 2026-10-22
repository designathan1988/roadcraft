// Switches, optimisations, the GPU area, the CPU profile.
(async () => {
  const { check, assert, frames } = window.__v;
  const lab = window.__lab;
  const scene = lab.scene;
  await check('interruptor esconde de verdade (prédios: triângulos caem e voltam)', async () => {
    await frames(800); const a = scene.stats.drawnTriangles;
    lab.effects.setMany({ buildings: false }); await frames(800); const b = scene.stats.drawnTriangles;
    lab.effects.setMany({ buildings: true }); await frames(1200); const c = scene.stats.drawnTriangles;
    assert(b < a * 0.8, `não caiu: ${a} → ${b}`);
    assert(c > b * 1.1, `não voltou: ${b} → ${c}`);
    return `${a} → ${b} → ${c}`;
  });
  await check('otimização aplica e restaura (opaqueSort, anisotropy)', async () => {
    const o = window.__labOpt;
    assert(o, 'sem __labOpt');
    o.set('opaqueSort', 'depth');
    assert(o.get('opaqueSort') === 'depth', 'não aplicou');
    o.set('anisotropy', 2); await frames(600);
    const rep = scene.optimizationReport();
    assert(rep.texturesCapped > 0, `nenhuma textura limitada: ${JSON.stringify(rep)}`);
    o.reset(); await frames(600);
    assert(o.get('opaqueSort') === 'material', `não restaurou: ${o.get('opaqueSort')}`);
    return `texturas limitadas ${rep.texturesCapped}; restaurado`;
  });
  await check('GPU: tempo por passe mede', async () => {
    const g = window.__labGpu;
    g.passTiming(true); await frames(1800);
    const rows = g.passes(); g.passTiming(false);
    assert(rows.length >= 3 && rows.every((r) => Number.isFinite(r.avg)), `passes: ${JSON.stringify(rows).slice(0, 200)}`);
    return rows.map((r) => `${r.label} ${r.avg.toFixed(2)}`).join(' | ');
  });
  await check('GPU: captura de quadro bate com o contador do jogo', async () => {
    await frames(300);
    const game = scene.stats.drawCalls;
    const cap = await window.__labGpu.capture();
    const calls = cap.records.reduce((a, r) => a + r.calls, 0);
    assert(cap.records.length > 0, 'captura vazia');
    assert(Math.abs(calls - game) <= Math.max(30, game * 0.1), `capturado ${calls} x jogo ${game}`);
    return `${calls} chamadas capturadas; jogo ${game}`;
  });
  await check('GPU: objetos (texturas, alvos, geometrias)', async () => {
    const o = window.__labGpu.objects();
    const n = (k) => (Array.isArray(o[k]) ? o[k].length : 0);
    assert(n('textures') > 0 && n('geometries') > 0, `vazio: ${Object.keys(o)}`);
    return `texturas ${n('textures')}, alvos ${n('targets')}, geometrias ${n('geometries')}`;
  });
  await check('Código: perfil de CPU devolve funções do jogo com arquivo:linha .ts', async () => {
    const c = window.__labCode;
    c.start(true); await frames(4500);
    const f = c.functions('session').filter((x) => x.category === 'jogo');
    assert(f.length > 0, 'nenhuma função do jogo');
    const mapped = f.filter((x) => /\.ts:\d+$/.test(x.where));
    assert(mapped.length / f.length > 0.7, `só ${mapped.length} de ${f.length} com .ts:linha (ex.: ${f.slice(0, 3).map((x) => x.where)})`);
    return `${f.length} funções, ${mapped.length} mapeadas; ${f.slice(0, 3).map((x) => `${x.name}@${x.where}`).join(' | ')}`;
  });
  return JSON.stringify(window.__v.results.filter((r) => !r.ok).map((r) => r.name));
})();
