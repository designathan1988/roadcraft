// The recorder and its report on disk, the inspector, the tests, the resources, the whole report.
(async () => {
  const { check, assert, wait, frames } = window.__v;
  const lab = window.__lab;
  await check('Gravação: marca a mudança, gera trechos e a tabela de funções de CPU', async () => {
    const r = window.__labRecorder;
    r.start({});
    await frames(5000); lab.effects.setMany({ bShadows: false });
    await frames(5000); lab.effects.setMany({ bShadows: true });
    await frames(2500);
    r.stop(); await wait(3000);
    const rep = r.report();
    assert(rep, 'sem relatório');
    const md = rep.markdown || rep.md || JSON.stringify(rep);
    assert(/bShadows/.test(md), 'mudança não marcada');
    assert(/Funções que mais gastaram CPU/.test(md), 'sem seção de funções');
    assert(/\| [^|\n]+ \| src\/[^|\n]+\.ts:\d+/.test(md), 'tabela de funções vazia');
    const segs = (md.match(/^\| \d+ \|/gm) || []).length;
    assert(segs >= 2, `trechos: ${segs}`);
    return `${segs} trechos; ${rep.stamp}`;
  });
  await check('relatório gravado em lab-reports/ no disco', async () => {
    const list = await (await fetch('/__lab/reports')).json();
    const stamp = window.__labRecorder.report().stamp;
    assert(JSON.stringify(list).includes(stamp), 'não está na lista do servidor');
    return `${stamp} presente`;
  });
  await check('Inspetor: um prédio selecionado mostra objeto, material e o código que o cria', async () => {
    let target = null;
    lab.scene.scene.traverse((o) => { if (!target && o.isMesh && o.name === 'building-shell' && o.visible) target = o; });
    assert(target, 'nenhuma malha building-shell');
    window.__labInspector.select(target);
    lab.navigate('inspector'); await wait(5000);
    const text = document.querySelector('.lab-body').innerText;
    assert(/building-shell/.test(text), 'nome não aparece');
    assert(/material/i.test(text), 'sem material');
    const code = text.match(/src\/[\w/]+\.ts:\d+/);
    assert(code, 'sem o código que o cria');
    return code[0];
  });
  await check('Testes: varredura A/B de um item devolve uma linha', async () => {
    const res = await window.__labTests.sweep({ items: ['switch.sharpen'], frames: 30, reps: 1, settleMaxMs: 4000 });
    assert(res.rows.length === 1, `linhas: ${res.rows.length}`);
    const row = res.rows[0];
    return `${row.label}: GPU ${row.gpuA}→${row.gpuB}, veredito ${row.verdict}`;
  });
  await check('Consumo e Diagnóstico têm dados', async () => {
    const r = window.__labResources;
    const rows = r.rows('30s');
    assert(rows.length > 10, `linhas: ${rows.length}`);
    return `${rows.length} consumidores`;
  });
  await check('relatório completo traz todas as seções sem erro', async () => {
    const all = lab.collectReport();
    const keys = Object.keys(all);
    for (const k of ['doctor', 'resources', 'diagnostics', 'code', 'gpu', 'optimizations', 'recording', 'tests', 'inspector']) assert(keys.includes(k), `falta ${k}`);
    const bad = keys.filter((k) => all[k] && all[k].error);
    assert(!bad.length, `seções com erro: ${bad}`);
    return keys.join(', ');
  });
  return JSON.stringify(window.__v.results);
})();
