// COVERAGE: whether everything that spends the GPU, the CPU and the memory has an owner in the lab, and how much is left unattributed.
(async () => {
  const { check, assert, frames } = window.__v;
  const lab = window.__lab;
  const scene = lab.scene;
  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  await check('GPU: os passes somam o tempo do quadro (o que sobra não tem dono)', async () => {
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
    assert(gap < 0.15, `quadro ${whole.toFixed(2)} ms x soma dos passes ${sum.toFixed(2)} ms: ${pct(gap)} sem dono`);
    return `quadro ${whole.toFixed(2)} ms, passes ${sum.toFixed(2)} ms (${pct(gap)} de diferença)`;
  });
  await check('GPU: todo triângulo da captura tem camada e objeto nomeados', async () => {
    const cap = await window.__labGpu.capture();
    const total = cap.records.reduce((a, r) => a + r.triangles, 0) || 1;
    const anon = cap.records.filter((r) => !r.name || r.layer === 'Mesh' || r.layer === '(sem nome)' || /^Mesh$|^Group$/.test(r.layer));
    const anonTris = anon.reduce((a, r) => a + r.triangles, 0);
    const share = anonTris / total;
    const sample = [...new Set(anon.map((r) => `${r.layer}/${r.name || '(sem nome)'}/${r.material}`))].slice(0, 8);
    assert(share < 0.02, `${pct(share)} dos triângulos (${anon.length} desenhos) sem nome: ${sample.join(', ')}`);
    return `${anon.length} desenhos sem nome, ${pct(share)} dos triângulos${sample.length ? `: ${sample.join(', ')}` : ''}`;
  });
  await check('CPU: os sistemas do quadro somam o trabalho do quadro', async () => {
    const samples = [];
    const stop = lab.onFrame((s) => samples.push(s));
    await frames(2000); stop();
    let sys = 0, cpu = 0;
    for (const s of samples) { cpu += s.cpuMs; for (const v of s.systems.values()) sys += v; }
    const gap = Math.abs(cpu - sys) / Math.max(cpu, 1e-6);
    assert(gap < 0.1, `trabalho ${cpu.toFixed(0)} ms x sistemas ${sys.toFixed(0)} ms: ${pct(gap)} sem dono`);
    return `${samples.length} quadros, ${pct(gap)} fora dos sistemas`;
  });
  await check('CPU: o perfil atribui o tempo a arquivos do código', async () => {
    const f = window.__labCode.functions('session');
    const total = f.reduce((a, x) => a + x.selfMs, 0) || 1;
    const byCat = {};
    for (const x of f) byCat[x.category] = (byCat[x.category] || 0) + x.selfMs;
    const unknown = f.filter((x) => !/\.(ts|js|mjs)(:\d+)?/.test(x.where) && x.category !== 'navegador' && x.category !== 'motor').reduce((a, x) => a + x.selfMs, 0);
    const share = unknown / total;
    assert(share < 0.15, `${pct(share)} do tempo sem arquivo; por categoria: ${JSON.stringify(byCat)}`);
    return Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v / total)}`).join(', ');
  });
  await check('Consumo cobre todas as categorias (CPU, workers, GPU, VRAM, RAM, disco, rede)', async () => {
    window.__labResources.readStorage?.();
    await frames(2500);
    const rows = window.__labResources.rows('session');
    const cats = new Set(rows.map((r) => r.category));
    const missing = ['CPU-main', 'CPU-worker', 'GPU', 'VRAM', 'RAM', 'Disco', 'Rede'].filter((c) => !cats.has(c));
    assert(!missing.length, `faltam: ${missing.join(', ')}`);
    return [...cats].map((c) => `${c} ${rows.filter((r) => r.category === c).length}`).join(', ');
  });
  await check('VRAM: o medidor do laboratório mostra o que existe na GPU', async () => {
    const o = window.__labGpu.objects();
    const sum = (list) => list.reduce((a, x) => a + x.bytes, 0);
    const real = sum(o.textures) + sum(o.geometries) + scene.targetBytes();
    await frames(5500);
    const meter = [...document.querySelectorAll('.lab-meter')].find((m) => m.textContent.startsWith('VRAM'));
    const shown = meter && /([\d.,]+) (MB|GB)/.exec(meter.title);
    assert(shown, `medidor sem valor: ${meter && meter.title}`);
    const mbShown = parseFloat(shown[1].replace(',', '.')) * (shown[2] === 'GB' ? 1024 : 1);
    const gap = Math.abs(mbShown - real / 1048576) / (real / 1048576);
    assert(gap < 0.1, `medidor ${mbShown} MB x achado ${(real / 1048576).toFixed(0)} MB`);
    const ledger = (await import('/src/render/gpuLedger.ts')).gpuLedger.bytes();
    return `achado ${(real / 1048576).toFixed(0)} MB = medidor ${mbShown} MB; o gpuLedger do jogo conta ${(ledger / 1048576).toFixed(0)} MB`;
  });
  await check('RAM: memória do processo por parte (página, workers)', async () => {
    const m = await window.__labResources.measureMemory?.();
    assert(m, 'measureUserAgentSpecificMemory indisponível');
    return JSON.stringify(m).slice(0, 300);
  });
  return JSON.stringify(window.__v.results);
})();
