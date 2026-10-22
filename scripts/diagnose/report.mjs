// THE DIAGNOSIS READ AS FINDINGS: every measure against what the player should get (the city plan's budgets, a frame that never stops the
// page, memory that comes back, a picture close to its supersampled reference), each finding with what it costs and where in `src/` it comes
// from, the worst first. Written as `report.md` (Portuguese, for the player) beside `report.json` (every figure).
import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SEVERITY = { alta: 0, 'média': 1, baixa: 2 };
/** `src/core/perfBudget.ts` VIEW_BUDGETS: triangles, draw calls (main + shadow), GPU ms; the frame's interval at the view's fps. */
const VIEW_BUDGETS = {
  street: { triangles: 16e6, drawCalls: 1000, gpuMs: 12, frameMs: 1000 / 60 },
  district: { triangles: 16e6, drawCalls: 1100, gpuMs: 12, frameMs: 1000 / 60 },
  map: { triangles: 8e6, drawCalls: 400, gpuMs: 12, frameMs: 1000 / 50 },
};
const VIEW_NAMES = { map: 'mapa', district: 'distrito', street: 'rua' };
const PHASE_NAMES = { boot: 'início do jogo', create: 'criar a cidade', 'view:map': 'vista do mapa', 'view:district': 'vista do distrito', 'view:street': 'vista da rua', navigate: 'navegar', save: 'salvar', reopen: 'reabrir o save' };

/** A profile's blocked stretches (`profileStop` held) as lines: the game's functions that held the page, ms. */
function heldLines(profile, n = 5) {
  return (profile?.held?.by ?? []).slice(0, n).map((r) => `${r.at}: ${r.ms} ms`);
}

/** The scripts that held a phase's long frames, summed by their line in the game (only the frame's entry: `heldLines` goes deeper). */
function heldBy(frames) {
  const rows = new Map();
  for (const f of frames) for (const s of f.scripts) {
    const k = `${s.where || s.url || '(desconhecido)'}${s.fn ? ` (${s.fn})` : ''}`;
    const r = rows.get(k) ?? { ms: 0, n: 0 };
    r.ms += s.ms; r.n++;
    rows.set(k, r);
  }
  return [...rows].sort((a, b) => b[1].ms - a[1].ms).slice(0, 6).map(([k, r]) => `${k}: ${Math.round(r.ms)} ms em ${r.n} quadro(s)`);
}

export function buildFindings(report) {
  const findings = [];
  const add = (f) => findings.push({ where: [], evidence: [], ...f });
  const frames = (phase) => (report.longFrames ?? []).filter((f) => f.phase === phase);
  const own = (profile, n = 5) => (profile?.ownTotal ?? []).slice(0, n).map((r) => `${r.at}: ${r.ms} ms (com o que chama)`);

  // CREATE: from asking to the city on screen.
  const c = report.phases.create;
  if (c) {
    const m = c.marks ?? {};
    const shown = Object.entries(m).filter(([k]) => k === 'opening:shown').map(([, v]) => v).at(-1);
    const askedAt = m['city:asked'] ?? Math.min(...Object.values(m));
    const total = shown !== undefined ? (shown - askedAt) / 1000 : c.limitS;
    const steps = [];
    const gap = (a, b, label) => { if (m[a] !== undefined && m[b] !== undefined) steps.push(`${label}: ${((m[b] - m[a]) / 1000).toFixed(1)} s`); };
    gap('city:asked', 'city:data', 'gerar a cidade (worker)');
    gap('city:data', 'city:baked', 'resolver a rede (worker)');
    gap('city:baked', 'city:applied', 'aplicar na página');
    if (m['city:applied'] !== undefined && shown !== undefined) steps.push(`abrir até mostrar: ${((shown - m['city:applied']) / 1000).toFixed(1)} s`);
    add({ area: 'Cidades grandes', severity: c.outcome !== 'shown' || total > 30 ? 'alta' : total > 10 ? 'média' : 'baixa',
      title: c.outcome === 'shown' ? `Criar uma cidade nova de ${c.buildings} prédios leva ${total.toFixed(1)} s` : `A cidade não ficou pronta em ${c.limitS} s (${c.outcome})`,
      cost: `${total.toFixed(1)} s`, rank: total * 1000, evidence: steps, where: own(c.profile) });
    const h = c.profile?.held;
    if (h?.count) add({ area: 'Cidades grandes', severity: h.worstMs > 500 ? 'alta' : h.worstMs > 100 ? 'média' : 'baixa',
      title: `Ao criar a cidade a página trava ${h.count} vezes (${h.ms} ms no total), a pior por ${h.worstMs} ms seguidos`,
      cost: `${h.ms} ms travada`, rank: h.worstMs, where: heldLines(c.profile), evidence: h.worstBy.map((x) => `na pior: ${x.at} ${x.ms} ms`) });
  }

  // VIEWS: frames, GPU, draws and triangles against the plan's budgets.
  for (const [name, v] of Object.entries(report.views ?? {})) {
    const b = VIEW_BUDGETS[name];
    const label = VIEW_NAMES[name];
    const f = v.frames.frame, g = v.frames.gpu;
    const passes = (v.passes ?? []).slice(0, 5).map((p) => `${p.pass}: ${p.avg} ms (p95 ${p.p95})`);
    if (f.p99 !== null && f.p99 > b.frameMs * 1.1) add({ area: 'Desempenho', severity: f.p99 > b.frameMs * 2 ? 'alta' : 'média',
      title: `Vista ${label}: quadros irregulares (p99 ${f.p99} ms, pior ${f.max} ms, ${f.hitches} acima de 25 ms)`, cost: `p99 ${f.p99} ms`, rank: f.p99,
      evidence: v.frames.systems ? Object.entries(v.frames.systems).filter(([, s]) => s && typeof s === 'object' && s.p95 > 1).slice(0, 6).map(([k, s]) => `${k}: p95 ${s.p95} ms`) : [] });
    if (g.p95 !== null && g.p95 > b.gpuMs) add({ area: 'Desempenho', severity: g.p95 > 16.7 ? 'alta' : 'média',
      title: `Vista ${label}: GPU acima do orçamento (p95 ${g.p95} ms contra ${b.gpuMs} ms)`, cost: `GPU p95 ${g.p95} ms`, rank: g.p95, evidence: passes });
    const draws = v.memory.drawCalls, tris = v.memory.drawnTriangles;
    if (draws > b.drawCalls) add({ area: 'Desempenho', severity: draws > b.drawCalls * 1.5 ? 'alta' : 'média',
      title: `Vista ${label}: ${draws} draw calls contra ${b.drawCalls} do orçamento`, cost: `${draws} draws`, rank: draws / b.drawCalls * 10,
      evidence: (v.draws?.byLayer ?? []).slice(0, 6).map((r) => `${r.key}: ${r.calls} draws`) });
    if (tris > b.triangles) add({ area: 'Desempenho', severity: 'média', title: `Vista ${label}: ${(tris / 1e6).toFixed(1)} M triângulos contra ${(b.triangles / 1e6).toFixed(0)} M`, cost: `${(tris / 1e6).toFixed(1)} M`, rank: tris / b.triangles * 10 });
    if (v.settled && !v.settled.settled) add({ area: 'Desempenho', severity: 'média', title: `Vista ${label}: o mundo não terminou de carregar em ${v.settled.ms / 1000} s`, cost: `${v.settled.ms / 1000} s`, rank: 20,
      evidence: v.settled.held ? [`de ${v.settled.held.looks} olhadas: trabalho do mundo em curso em ${v.settled.held.worldBusy}`, `abertura em curso em ${v.settled.held.opening}`, `células escolhidas e ainda não mostradas em ${v.settled.held.notLanded}`] : [] });
    const p = v.picture;
    if (p && !p.error) {
      const share = p.overShare * 100;
      if (share > 2) add({ area: 'Qualidade', severity: share > 8 ? 'alta' : 'média',
        title: `Vista ${label}: ${share.toFixed(1)} % dos pixels diferem da mesma cena supersampleada (serrilhado, detalhe fino que cintila)`,
        cost: `${share.toFixed(1)} % dos pixels`, rank: share, evidence: [`mapa da diferença: ${relative(report.out, p.files.aliasing).replace(/\\/g, '/')}`, 'props e postes escolhem detalhe pelo tamanho em pixels: na referência pode haver um pouco mais deles'] });
      if (p.approved) {
        const dl = p.frame.lightness - p.approved.lightness, dc = (p.frame.contrast - p.approved.contrast) / p.approved.contrast, dch = (p.frame.chroma - p.approved.chroma) / p.approved.chroma;
        if (Math.abs(dl) > 0.03 || dc < -0.1 || dch < -0.15) add({ area: 'Qualidade', severity: 'alta',
          title: `Vista ${label}: a imagem mudou em relação à aprovada (luz ${dl >= 0 ? '+' : ''}${dl.toFixed(3)}, contraste ${(dc * 100).toFixed(0)} %, cor ${(dch * 100).toFixed(0)} %)`,
          cost: 'imagem diferente da aprovada', rank: 50 });
      }
    }
  }

  // NAVIGATE: the flight's frames, the functions that held them, the waits for the GPU, the programs built while playing.
  const n = report.phases.navigate;
  if (n) {
    const f = n.frames.frame;
    if (f.max > 33 || f.p99 > 20) add({ area: 'Desempenho', severity: f.max > 100 ? 'alta' : 'média',
      title: `Ao navegar a imagem engasga: ${f.hitches} quadros acima de 25 ms em ${f.frames}, p99 ${f.p99} ms, o pior de ${f.max} ms`,
      cost: `pior quadro ${f.max} ms`, rank: f.max, where: n.profile?.held?.count ? heldLines(n.profile) : heldBy(frames('navigate')),
      evidence: (n.profile?.held?.worstBy ?? []).map((x) => `no pior trecho: ${x.at} ${x.ms} ms`) });
    if (n.passes?.length) add({ area: 'Desempenho', severity: 'média', title: `GPU por passe ao navegar: ${n.passes.slice(0, 4).map((p) => `${p.pass} ${p.avg} ms (p95 ${p.p95})`).join(', ')}`, cost: `${n.passes.reduce((a, p) => a + p.avg, 0).toFixed(1)} ms por quadro`, rank: n.passes.reduce((a, p) => a + p.avg, 0), evidence: n.passes.slice(4, 8).map((p) => `${p.pass} ${p.avg} ms`) });
    if (n.frames.gpu.p95 !== null && n.frames.gpu.p95 > 12) add({ area: 'Desempenho', severity: n.frames.gpu.p95 > 16.7 ? 'alta' : 'média',
      title: `Ao navegar a GPU passa do orçamento (p95 ${n.frames.gpu.p95} ms, pior ${n.frames.gpu.max} ms)`, cost: `GPU p95 ${n.frames.gpu.p95} ms`, rank: n.frames.gpu.p95 });
    if (n.shadows) add({ area: 'Desempenho', severity: 'média', title: `Sombras no voo: ${n.shadows.passes} passes, cascatas redesenhadas inteiras ${n.shadows.whole.join('/')} vezes`, cost: `${n.shadows.whole.reduce((a, b) => a + b, 0)} redesenhos inteiros`, rank: n.shadows.whole.reduce((a, b) => a + b, 0) / 10, evidence: Object.entries(n.shadows.why ?? {}).filter(([, v]) => v > 0).map(([k, v]) => `${k}: ${v}`) });
    if (n.allocations) add({ area: 'Desempenho', severity: n.allocations.mbPerSecond > 20 ? 'alta' : 'média', title: `O voo aloca ${n.allocations.mbPerSecond} MB/s de memória (o que a coleta de lixo recolhe)`, cost: `${n.allocations.mbPerSecond} MB/s`, rank: n.allocations.mbPerSecond, where: n.allocations.top.slice(0, 6).map((x) => `${x.at}: ${x.mb} MB`) });
    if (n.profile?.garbageMs > 50) add({ area: 'Desempenho', severity: n.profile.garbageMs > 200 ? 'alta' : 'média',
      title: `Coleta de lixo durante a navegação: ${n.profile.garbageMs} ms em ${(n.profile.ms / 1000).toFixed(1)} s`, cost: `${n.profile.garbageMs} ms`, rank: n.profile.garbageMs / 2 });
    const grew = n.after.heapMB - n.before.heapMB;
    if (grew > 40) add({ area: 'Memória', severity: grew > 150 ? 'alta' : 'média',
      title: `A memória não voltou depois de navegar e voltar à mesma vista: +${grew.toFixed(0)} MB de heap`, cost: `+${grew.toFixed(0)} MB`, rank: grew,
      evidence: [`geometrias ${n.before.glGeometries} → ${n.after.glGeometries}`, `texturas ${n.before.glTextures} → ${n.after.glTextures}`, `programas ${n.before.programs} → ${n.after.programs}`] });
  }

  // WAITS FOR THE GPU, any phase after the boot.
  for (const [ph, calls] of Object.entries(report.sync ?? {})) {
    if (ph === 'boot') continue;
    for (const [name, r] of Object.entries(calls)) {
      if (r.ms < 2 && r.worst < 1) continue;
      add({ area: 'Desempenho', severity: r.worst > 8 || r.ms > 50 ? 'alta' : 'média',
        title: `${name} espera a GPU (${PHASE_NAMES[ph] ?? ph}): ${r.count} chamadas, ${r.ms.toFixed(0)} ms, a pior de ${r.worst.toFixed(1)} ms`,
        cost: `${r.ms.toFixed(0)} ms parados`, rank: r.ms, where: r.stacks.slice(0, 3).map((s) => `${s.at.join(' < ') || '(fora do src)'} — ${s.count}×, ${s.ms.toFixed(0)} ms`) });
    }
  }
  for (const [ph, w] of Object.entries(report.gpuWork ?? {})) {
    if (!/^(view:|navigate)/.test(ph) || !w.linked) continue;
    const built = ph === 'navigate' ? report.phases.navigate?.programsBuilt : report.views?.[ph.slice(5)]?.programsBuilt;
    // A program linked off the draw (`compileAsync`, the scene's door) holds no frame: raised only when the phase had long frames.
    const held = frames(ph).length;
    add({ area: 'Desempenho', severity: held === 0 ? 'baixa' : w.linked > 5 ? 'alta' : 'média', title: `${w.linked} programas de shader compilados durante o jogo (${PHASE_NAMES[ph] ?? ph})${held === 0 ? ', sem nenhum quadro longo na fase' : `, ${held} quadros longos na fase`}`, cost: `${w.linked} programas`, rank: held === 0 ? 1 : w.linked * 10, where: built ?? [] });
  }

  // SAVE AND REOPEN.
  const s = report.phases.save;
  if (s) {
    const held = frames('save');
    const worst = held.length ? Math.max(...held.map((f) => f.ms)) : 0;
    if (s.ms > 500 || worst > 100) add({ area: 'Cidades grandes', severity: worst > 300 || s.ms > 3000 ? 'alta' : 'média',
      title: `Salvar agora (o que mudou desde o último autosave) leva ${s.ms} ms${held.length ? ` e trava a página (${held.length} quadros longos, o pior de ${worst} ms)` : ''}`, cost: `${s.ms} ms`, rank: Math.max(s.ms / 10, worst), where: heldBy(held) });
  }
  const r = report.phases.reopen;
  if (r) {
    const held = frames('reopen');
    const worst = held.length ? Math.max(...held.map((f) => f.ms)) : 0;
    add({ area: 'Cidades grandes', severity: r.outcome !== 'shown' || r.seconds > 20 ? 'alta' : r.seconds > 8 ? 'média' : 'baixa',
      title: r.outcome === 'shown' ? `Reabrir o save leva ${r.seconds.toFixed(1)} s${worst ? `, com a página travada até ${worst} ms seguidos` : ''}` : `O save não reabriu no limite (${r.outcome})`,
      cost: `${r.seconds.toFixed(1)} s`, rank: r.seconds * 1000, where: r.profile?.held?.count ? heldLines(r.profile) : heldBy(held),
      evidence: [...Object.entries(r.marks ?? {}).filter(([k]) => /^(boot|save|restore):/.test(k)).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).slice(0, 8),
        ...(r.profile?.held?.worstBy ?? []).map((x) => `na pior trava: ${x.at} ${x.ms} ms`)] });
    if (r.heap && s?.heapBefore && r.heap.mb > s.heapBefore.mb * 1.15) add({ area: 'Memória', severity: 'alta',
      title: `Depois de reabrir, a mesma cidade ocupa ${r.heap.mb} MB de heap contra ${s.heapBefore.mb} MB quando foi criada`, cost: `+${(r.heap.mb - s.heapBefore.mb).toFixed(0)} MB`, rank: r.heap.mb - s.heapBefore.mb });
  }

  // ERRORS the page threw.
  const errors = new Map();
  for (const e of report.errors ?? []) errors.set(e.message, e);
  for (const e of errors.values()) add({ area: 'Erros', severity: 'alta', title: e.message.slice(0, 160), cost: 'erro', rank: 1e5, where: e.at });

  // THE CODE'S PATTERNS: a lead raised when the run saw its file in a hot function or a wait for the GPU.
  const hot = JSON.stringify([report.phases.navigate?.profile?.ownSelf, report.phases.navigate?.profile?.held, report.phases.create?.profile?.held, report.phases.reopen?.profile?.held, report.sync]);
  // A readback the code has but the run never made: listed, not raised (a branch the game does not take).
  const called = new Set(Object.values(report.sync ?? {}).flatMap((calls) => Object.keys(calls)));
  for (const st of report.static ?? []) {
    const file = st.where.replace(/:\d+$/, '');
    const method = /\.(getBufferSubData|readPixels|clientWaitSync|finish)\b/.exec(st.text)?.[1];
    if (st.rule === 'gl-readback' && method && !called.has(method)) {
      add({ area: 'Código', severity: 'baixa', title: `${st.why} (não aconteceu nesta execução)`, cost: 'não ocorreu', rank: 0, where: [`${st.where} — ${st.text}`] });
      continue;
    }
    add({ area: 'Código', severity: hot.includes(file) ? 'média' : 'baixa', title: `${st.why}`, cost: hot.includes(file) ? 'arquivo quente nesta execução' : 'não medido', rank: hot.includes(file) ? 5 : 0, where: [`${st.where} — ${st.text}`] });
  }
  return findings.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity] || b.rank - a.rank);
}

export function writeReport(report, out) {
  report.out = out;
  const findings = buildFindings(report);
  report.findings = findings;
  const c = report.phases.create;
  const lines = [
    `# Diagnóstico — cidade ${report.size} (${c?.buildings ?? '?'} prédios, semente ${report.seed})`,
    '',
    `${report.startedAt} · ${report.gpu?.label ?? 'GPU ?'} · nível ${report.gpu?.tier ?? '?'} · execução ${report.seconds?.toFixed(0)} s${report.buildSeconds ? ` (+ build ${report.buildSeconds.toFixed(0)} s)` : ''}`,
    report.failure ? `\n**A execução parou:** ${report.failure}\n` : '',
    '## Achados, do mais grave',
    '',
    '| # | Área | Gravidade | O que acontece | Custo medido | Onde no código |',
    '|---|---|---|---|---|---|',
    ...findings.map((f, i) => `| ${i + 1} | ${f.area} | ${f.severity} | ${f.title.replace(/\|/g, '/')} | ${f.cost} | ${[...f.where, ...f.evidence].slice(0, 4).join('<br>').replace(/\|/g, '/') || '—'} |`),
    '',
    '## Fases',
    '',
    '| Fase | Resultado |',
    '|---|---|',
    `| Início do jogo | ${report.phases.boot?.seconds?.toFixed(1) ?? '—'} s |`,
    `| Criar a cidade | ${c ? `${c.outcome}, marcas ${Object.entries(c.marks ?? {}).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)} s`).join(', ')}` : '—'} |`,
    `| Salvar | ${report.phases.save ? `${report.phases.save.ms} ms` : '—'} |`,
    `| Reabrir | ${report.phases.reopen ? `${report.phases.reopen.outcome}, ${report.phases.reopen.seconds.toFixed(1)} s` : '—'} |`,
    '',
    '## Vistas',
    '',
    '| Vista | Quadro p50/p99/pior (ms) | GPU p50/p95/pior (ms) | Draws | Triângulos | Heap (MB) | Geometria/Textura (MB) | Pixels fora da referência |',
    '|---|---|---|---|---|---|---|---|',
    ...Object.entries(report.views ?? {}).map(([name, v]) => `| ${VIEW_NAMES[name]} | ${v.frames.frame.p50}/${v.frames.frame.p99}/${v.frames.frame.max} | ${v.frames.gpu.p50 ?? '—'}/${v.frames.gpu.p95 ?? '—'}/${v.frames.gpu.max ?? '—'} | ${v.memory.drawCalls} | ${(v.memory.drawnTriangles / 1e6).toFixed(1)} M | ${v.memory.heapMB} | ${v.memory.geometryMB}/${v.memory.textureMB} | ${v.picture?.overShare !== undefined ? `${(v.picture.overShare * 100).toFixed(2)} %` : '—'} |`),
    '',
    ...Object.entries(report.views ?? {}).flatMap(([name, v]) => (v.passes?.length ? [`**GPU por passe — ${VIEW_NAMES[name]}:** ${v.passes.slice(0, 8).map((p) => `${p.pass} ${p.avg} ms`).join(' · ')}`, ''] : [])),
    '## Navegação',
    '',
    report.phases.navigate ? `${report.phases.navigate.frames.frame.frames} quadros, p50 ${report.phases.navigate.frames.frame.p50} ms, p99 ${report.phases.navigate.frames.frame.p99} ms, pior ${report.phases.navigate.frames.frame.max} ms; GPU p95 ${report.phases.navigate.frames.gpu.p95 ?? '—'} ms; coleta de lixo ${report.phases.navigate.profile?.garbageMs ?? '—'} ms` : '—',
    '',
    '**Funções do jogo que mais gastaram ao navegar (tempo próprio):**',
    '',
    ...(report.phases.navigate?.profile?.ownSelf ?? []).slice(0, 12).map((r) => `- ${r.at}: ${r.ms} ms`),
    '',
    '## O que esta execução não cobre',
    '',
    ...(report.notCovered ?? []).map((x) => `- ${x}`),
    '',
    `Perfis de CPU (abra no DevTools > Performance): ${['create', 'navigate', 'reopen'].map((p) => `\`${p}.cpuprofile\``).join(', ')}. Todos os números: \`report.json\`.`,
  ];
  const file = join(out, 'report.md');
  writeFileSync(file, lines.join('\n'));
  return file;
}
