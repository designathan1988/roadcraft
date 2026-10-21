// COVERAGE: whether everything that spends the GPU, the CPU and the memory has an owner in the lab, and how much is left unattributed.
(async () => {
  const { check, assert, frames } = window.__v;
  const lab = window.__lab;
  const scene = lab.scene;
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  await check('GPU: the passes add up to the frame time (what is left has no owner)', async () => {
    await frames(1500);
    const ring = scene.gpu.samples;
    const frame = [];
    for (let b = 0; b < Math.min(ring.pushed, 60); b++) frame.push(ring.newest(b));
    frame.sort((a, b) => a - b);
    const whole = frame[frame.length >> 1];
    window.__labGpu.passTiming(true); await frames(2000);
    const sum = window.__labGpu.passes().reduce((a, p) => a + p.avg, 0);
    window.__labGpu.passTiming(false); await frames(500);
    const gap = Math.abs(whole - sum) / whole;
    assert(gap < 0.15, `frame ${whole.toFixed(2)} ms x sum of the passes ${sum.toFixed(2)} ms: ${pct(gap)} unowned`);
    return `frame ${whole.toFixed(2)} ms, passes ${sum.toFixed(2)} ms (${pct(gap)} apart)`;
  });
  await check('GPU: every captured triangle has a named layer and object', async () => {
    const cap = await window.__labGpu.capture();
    const total = cap.records.reduce((a, r) => a + r.triangles, 0) || 1;
    const anon = cap.records.filter((r) => !r.name || r.layer === 'Mesh' || r.layer === '(unnamed)' || /^Mesh$|^Group$/.test(r.layer));
    const anonTris = anon.reduce((a, r) => a + r.triangles, 0);
    const share = anonTris / total;
    const sample = [...new Set(anon.map((r) => `${r.layer}/${r.name || '(unnamed)'}/${r.material}`))].slice(0, 8);
    assert(share < 0.02, `${pct(share)} of the triangles (${anon.length} draws) unnamed: ${sample.join(', ')}`);
    return `${anon.length} unnamed draws, ${pct(share)} of the triangles${sample.length ? `: ${sample.join(', ')}` : ''}`;
  });
  await check("CPU: the frame's systems add up to the frame's work", async () => {
    const samples = [];
    const stop = lab.onFrame((s) => samples.push(s));
    await frames(2000); stop();
    let sys = 0, cpu = 0;
    for (const s of samples) { cpu += s.cpuMs; for (const v of s.systems.values()) sys += v; }
    const gap = Math.abs(cpu - sys) / Math.max(cpu, 1e-6);
    assert(gap < 0.1, `work ${cpu.toFixed(0)} ms x systems ${sys.toFixed(0)} ms: ${pct(gap)} unowned`);
    return `${samples.length} frames, ${pct(gap)} outside the systems`;
  });
  await check('CPU: the profile attributes the time to code files', async () => {
    const f = window.__labCode.functions('session');
    const total = f.reduce((a, x) => a + x.selfMs, 0) || 1;
    const byCat = {};
    for (const x of f) byCat[x.category] = (byCat[x.category] || 0) + x.selfMs;
    const unknown = f.filter((x) => !/\.(ts|js|mjs)(:\d+)?/.test(x.where) && x.category !== 'browser' && x.category !== 'engine').reduce((a, x) => a + x.selfMs, 0);
    const share = unknown / total;
    assert(share < 0.15, `${pct(share)} of the time with no file; by category: ${JSON.stringify(byCat)}`);
    return Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v / total)}`).join(', ');
  });
  await check('Consumers covers every category (CPU, workers, GPU, VRAM, RAM, disk, network)', async () => {
    window.__labResources.readStorage?.();
    await frames(2500);
    const rows = window.__labResources.rows('session');
    const cats = new Set(rows.map((r) => r.category));
    const missing = ['CPU-main', 'CPU-worker', 'GPU', 'VRAM', 'RAM', 'Disk', 'Network'].filter((c) => !cats.has(c));
    assert(!missing.length, `missing: ${missing.join(', ')}`);
    return [...cats].map((c) => `${c} ${rows.filter((r) => r.category === c).length}`).join(', ');
  });
  await check("VRAM: the lab's meter shows what exists on the GPU", async () => {
    const o = window.__labGpu.objects();
    const sum = (list) => list.reduce((a, x) => a + x.bytes, 0);
    const real = sum(o.textures) + sum(o.geometries) + scene.targetBytes();
    await frames(5500);
    const meter = [...document.querySelectorAll('.lab-meter')].find((m) => m.textContent.startsWith('VRAM'));
    const shown = meter && /([\d.,]+) (MB|GB)/.exec(meter.title);
    assert(shown, `meter with no value: ${meter && meter.title}`);
    const mbShown = parseFloat(shown[1].replace(',', '.')) * (shown[2] === 'GB' ? 1024 : 1);
    const gap = Math.abs(mbShown - real / 1048576) / (real / 1048576);
    assert(gap < 0.1, `meter ${mbShown} MB x found ${(real / 1048576).toFixed(0)} MB`);
    const ledger = (await import('/src/render/gpuLedger.ts')).gpuLedger.bytes();
    return `found ${(real / 1048576).toFixed(0)} MB = meter ${mbShown} MB; the game's gpuLedger counts ${(ledger / 1048576).toFixed(0)} MB`;
  });
  await check('RAM: the process memory by part (page, workers)', async () => {
    const m = await window.__labResources.measureMemory?.();
    assert(m, 'measureUserAgentSpecificMemory unavailable');
    return JSON.stringify(m).slice(0, 300);
  });
  return JSON.stringify(window.__v.results);
})();
