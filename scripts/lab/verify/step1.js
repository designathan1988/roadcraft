// The window, the meters, every tab, the meters' click-through, a table row's investigation.
(async () => {
  const { check, assert, wait } = window.__v;
  const lab = window.__lab;
  await check('laboratório abre (F7)', () => {
    const p = document.querySelector('.lab-panel');
    assert(lab && p && !p.hidden, 'janela fechada');
    return 'aberto';
  });
  await check('medidores de uso têm números (CPU, GPU, RAM, FPS)', async () => {
    await window.__v.frames(2500);
    const vals = [...document.querySelectorAll('.lab-meter')].map((m) => `${m.querySelector('.lab-meter-name').textContent}=${m.querySelector('.lab-meter-value').textContent}`);
    for (const k of ['CPU', 'GPU', 'RAM', 'FPS']) assert(vals.some((v) => v.startsWith(`${k}=`) && /\d/.test(v)), `${k} sem valor: ${vals.join(' ')}`);
    return vals.join(' ');
  });
  for (const b of [...document.querySelectorAll('.lab-tabs .lab-tab')]) {
    const name = b.textContent;
    await check(`aba "${name}" abre e mostra conteúdo`, async () => {
      b.click();
      await wait(1200);
      const body = document.querySelector('.lab-body');
      const text = body.innerText.trim();
      assert(!/falhou ao abrir/.test(text), 'falhou ao abrir');
      assert(text.length > 40, `conteúdo vazio (${text.length} caracteres)`);
      return `${text.length} caracteres: ${text.slice(0, 90).replace(/\s+/g, ' ')}`;
    });
  }
  await check('clique no medidor CPU abre Consumo filtrado por CPU-main', async () => {
    [...document.querySelectorAll('.lab-meter')].find((m) => m.textContent.startsWith('CPU')).click();
    await wait(1800);
    const sel = document.querySelector('.lab-body .lab-table-bar select');
    assert(sel && sel.value === 'CPU-main', `filtro = ${sel && sel.value}`);
    const rows = document.querySelectorAll('.lab-body .lab-table tbody tr').length;
    assert(rows > 0, 'sem linhas');
    return `${rows} linhas, filtro ${sel.value}`;
  });
  await check('linha "sistema: drawing" abre Investigar com o código em src/main.ts', async () => {
    lab.navigate('consumers', { category: '', filter: 'sistema: drawing' });
    await wait(1800);
    const row = [...document.querySelectorAll('.lab-body .lab-table tbody tr')].find((r) => r.textContent.includes('sistema: drawing'));
    assert(row, 'linha não encontrada');
    row.click();
    await wait(4000);
    const drawer = document.querySelector('.lab-investigate');
    assert(drawer && !drawer.hidden, 'painel não abriu');
    const hits = [...drawer.querySelectorAll('.lab-inv-hit strong')].map((s) => s.textContent);
    assert(hits.some((h) => h.startsWith('src/main.ts')), `código achado: ${hits.join(', ') || 'nada'}`);
    drawer.querySelector('button[title="Fechar"]')?.click();
    return hits.join(', ');
  });
  return JSON.stringify(window.__v.results.filter((r) => !r.ok).map((r) => r.name));
})();
