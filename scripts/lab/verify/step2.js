// The diagnosis: its measure and one A/B test.
(async () => {
  const { check, assert, wait } = window.__v;
  const lab = window.__lab;
  await check('Diagnóstico mede passes, desenhos, sistemas, funções e causas', async () => {
    const d = window.__labDoctor;
    const before = (d.snapshot() && d.snapshot().at) || 0;
    for (let i = 0; i < 40 && ((d.snapshot() && d.snapshot().at) || 0) <= before; i++) { await d.measure(); await wait(300); }
    const s = d.snapshot();
    assert(s, 'sem medida');
    assert(s.passes.length > 0, 'sem passes da GPU');
    assert(s.draws.length > 0, 'sem captura de quadro');
    assert(s.systems.length > 0, 'sem sistemas de CPU');
    assert(s.functions.length > 0, 'sem funções do perfil de CPU');
    assert(d.findings().length > 0, 'sem causas');
    return `GPU ${s.gpuMs && s.gpuMs.toFixed(1)} ms, CPU ${s.cpuMs.toFixed(1)} ms, ${s.passes.length} passes, ${s.draws.length} desenhos, ${s.functions.length} funções, ${d.findings().length} causas`;
  });
  await check('teste A/B de uma causa devolve números', async () => {
    const f = window.__labDoctor.findings().find((x) => x.test);
    assert(f, 'nenhuma causa testável');
    await window.__labDoctor.test(f.id);
    const r = lab.collectReport().doctor.findings.find((x) => x.id === f.id).result;
    assert(r && typeof r === 'object' && Number.isFinite(r.cpuA) && Number.isFinite(r.trisA), `resultado: ${JSON.stringify(r)}`);
    return `${f.test.label}: GPU ${r.gpuA && r.gpuA.toFixed(1)}→${r.gpuB && r.gpuB.toFixed(1)} ms, triângulos ${Math.round(r.trisA)}→${Math.round(r.trisB)}`;
  });
  return JSON.stringify(window.__v.results.filter((r) => !r.ok).map((r) => r.name));
})();
