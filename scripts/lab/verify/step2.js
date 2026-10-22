// The diagnosis: its measure and one A/B test.
(async () => {
  const { check, assert, wait } = window.__v;
  const lab = window.__lab;
  await check('Doctor measures passes, draws, systems, functions and causes', async () => {
    const d = window.__labDoctor;
    const before = (d.snapshot() && d.snapshot().at) || 0;
    for (let i = 0; i < 40 && ((d.snapshot() && d.snapshot().at) || 0) <= before; i++) { await d.measure(); await wait(300); }
    const s = d.snapshot();
    assert(s, 'no measure');
    assert(s.passes.length > 0, 'no GPU passes');
    assert(s.draws.length > 0, 'no frame capture');
    assert(s.systems.length > 0, 'no CPU systems');
    assert(s.functions.length > 0, 'no functions from the CPU profile');
    assert(d.findings().length > 0, 'no causes');
    return `GPU ${s.gpuMs && s.gpuMs.toFixed(1)} ms, CPU ${s.cpuMs.toFixed(1)} ms, ${s.passes.length} passes, ${s.draws.length} draws, ${s.functions.length} functions, ${d.findings().length} causes`;
  });
  await check('an A/B test of a cause gives numbers', async () => {
    const f = window.__labDoctor.findings().find((x) => x.test);
    assert(f, 'no testable cause');
    await window.__labDoctor.test(f.id);
    const r = lab.collectReport().doctor.findings.find((x) => x.id === f.id).result;
    assert(r && typeof r === 'object' && Number.isFinite(r.cpuA) && Number.isFinite(r.trisA), `result: ${JSON.stringify(r)}`);
    return `${f.test.label}: GPU ${r.gpuA && r.gpuA.toFixed(1)}→${r.gpuB && r.gpuB.toFixed(1)} ms, triangles ${Math.round(r.trisA)}→${Math.round(r.trisB)}`;
  });
  return JSON.stringify(window.__v.results.filter((r) => !r.ok).map((r) => r.name));
})();
