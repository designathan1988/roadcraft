// The window, the meters, every tab, the meters' click-through, a table row's investigation.
(async () => {
  const { check, assert, wait } = window.__v;
  const lab = window.__lab;
  await check('lab opens (F7)', () => {
    const p = document.querySelector('.lab-panel');
    assert(lab && p && !p.hidden, 'window closed');
    return 'open';
  });
  await check('usage meters have numbers (CPU, GPU, RAM, FPS)', async () => {
    await window.__v.frames(2500);
    const vals = [...document.querySelectorAll('.lab-meter')].map((m) => `${m.querySelector('.lab-meter-name').textContent}=${m.querySelector('.lab-meter-value').textContent}`);
    for (const k of ['CPU', 'GPU', 'RAM', 'FPS']) assert(vals.some((v) => v.startsWith(`${k}=`) && /\d/.test(v)), `${k} has no value: ${vals.join(' ')}`);
    return vals.join(' ');
  });
  for (const b of [...document.querySelectorAll('.lab-tabs .lab-tab')]) {
    const name = b.textContent;
    await check(`tab "${name}" opens and shows content`, async () => {
      b.click();
      await wait(1200);
      const body = document.querySelector('.lab-body');
      const text = body.innerText.trim();
      assert(!/failed to open/.test(text), 'failed to open');
      assert(text.length > 40, `empty content (${text.length} characters)`);
      return `${text.length} characters: ${text.slice(0, 90).replace(/\s+/g, ' ')}`;
    });
  }
  await check('clicking the CPU meter opens Consumers filtered by CPU-main', async () => {
    [...document.querySelectorAll('.lab-meter')].find((m) => m.textContent.startsWith('CPU')).click();
    await wait(1800);
    const sel = document.querySelector('.lab-body .lab-table-bar select');
    assert(sel && sel.value === 'CPU-main', `filter = ${sel && sel.value}`);
    const rows = document.querySelectorAll('.lab-body .lab-table tbody tr').length;
    assert(rows > 0, 'no rows');
    return `${rows} rows, filter ${sel.value}`;
  });
  await check('row "system: drawing" opens Investigate with the code in src/main.ts', async () => {
    lab.navigate('consumers', { category: '', filter: 'system: drawing' });
    await wait(1800);
    const row = [...document.querySelectorAll('.lab-body .lab-table tbody tr')].find((r) => r.textContent.includes('system: drawing'));
    assert(row, 'row not found');
    row.click();
    await wait(4000);
    const drawer = document.querySelector('.lab-investigate');
    assert(drawer && !drawer.hidden, 'panel did not open');
    const hits = [...drawer.querySelectorAll('.lab-inv-hit strong')].map((s) => s.textContent);
    assert(hits.some((h) => h.startsWith('src/main.ts')), `code found: ${hits.join(', ') || 'none'}`);
    drawer.querySelector('button[title="Close"]')?.click();
    return hits.join(', ');
  });
  return JSON.stringify(window.__v.results.filter((r) => !r.ok).map((r) => r.name));
})();
