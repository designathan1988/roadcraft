// The recorder and its report on disk, the inspector, the tests, the resources, the whole report.
(async () => {
  const { check, assert, wait, frames } = window.__v;
  const lab = window.__lab;
  await check('Recording: marks the change, makes segments and the CPU functions table', async () => {
    const r = window.__labRecorder;
    r.start({});
    await frames(5000); lab.effects.setMany({ bShadows: false });
    await frames(5000); lab.effects.setMany({ bShadows: true });
    await frames(2500);
    r.stop(); await wait(3000);
    const rep = r.report();
    assert(rep, 'no report');
    const md = rep.markdown || rep.md || JSON.stringify(rep);
    assert(/bShadows/.test(md), 'change not marked');
    assert(/Functions that spent the most CPU/.test(md), 'no functions section');
    assert(/\| [^|\n]+ \| src\/[^|\n]+\.ts:\d+/.test(md), 'functions table empty');
    const segs = (md.match(/^\| \d+ \|/gm) || []).length;
    assert(segs >= 2, `segments: ${segs}`);
    return `${segs} segments; ${rep.stamp}`;
  });
  await check('report written to lab-reports/ on disk', async () => {
    const list = await (await fetch('/__lab/reports')).json();
    const stamp = window.__labRecorder.report().stamp;
    assert(JSON.stringify(list).includes(stamp), "not in the server's list");
    return `${stamp} present`;
  });
  await check('Inspector: a selected building shows object, material and the code that creates it', async () => {
    let target = null;
    lab.scene.scene.traverse((o) => { if (!target && o.isMesh && o.name === 'building-shell' && o.visible) target = o; });
    assert(target, 'no building-shell mesh');
    window.__labInspector.select(target);
    lab.navigate('inspector'); await wait(5000);
    const text = document.querySelector('.lab-body').innerText;
    assert(/building-shell/.test(text), 'name does not show');
    assert(/material/i.test(text), 'no material');
    const code = text.match(/src\/[\w/]+\.ts:\d+/);
    assert(code, 'without the code that creates it');
    return code[0];
  });
  await check('Tests: an A/B sweep of one item gives one row', async () => {
    const res = await window.__labTests.sweep({ items: ['switch.sharpen'], frames: 30, reps: 1, settleMaxMs: 4000 });
    assert(res.rows.length === 1, `rows: ${res.rows.length}`);
    const row = res.rows[0];
    return `${row.label}: GPU ${row.gpuA}→${row.gpuB}, verdict ${row.verdict}`;
  });
  await check('Consumers and Diagnostics have data', async () => {
    const r = window.__labResources;
    const rows = r.rows('30s');
    assert(rows.length > 10, `rows: ${rows.length}`);
    return `${rows.length} consumers`;
  });
  await check('the full report carries every section without error', async () => {
    const all = lab.collectReport();
    const keys = Object.keys(all);
    for (const k of ['doctor', 'resources', 'diagnostics', 'code', 'gpu', 'optimizations', 'recording', 'tests', 'inspector']) assert(keys.includes(k), `missing ${k}`);
    const bad = keys.filter((k) => all[k] && all[k].error);
    assert(!bad.length, `sections with an error: ${bad}`);
    return keys.join(', ');
  });
  return JSON.stringify(window.__v.results);
})();
