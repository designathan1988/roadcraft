import { formatBuildStamp } from '@ui/buildStamp';
import type { LabContext } from '../labTypes';
import { SETTLE_MS, compareAll, describeChange, describeDelta, fmtNum, segment, type Comparison, type Dist, type Segment } from './analysis';
import type { Recording } from './recording';

/** THE RECORDING'S REPORT, written for an AI to read: the JSON with everything, and a Markdown that says what was changed, what it did, and how sure it is. */

export const REPORT_FORMAT = 'roadcraft-lab-recording/1';

export interface Anomaly {
  readonly kind: 'hitch' | 'settle' | 'heap' | 'recompile' | 'longtask';
  readonly t: number;
  readonly detail: string;
}

export interface LabReport {
  /** File name stem: `rec-2026-10-19T12-30-05`. */
  readonly stamp: string;
  readonly json: Record<string, unknown>;
  readonly md: string;
  readonly segments: readonly Segment[];
  readonly comparisons: readonly Comparison[];
  readonly anomalies: readonly Anomaly[];
  /** One line for lists. */
  readonly summary: string;
}

function gpuName(ctx: LabContext): string {
  try {
    const gl = ctx.scene.gl.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
  } catch (error) {
    console.warn('lab recorder: GPU name unreadable', error);
    return 'desconhecida';
  }
}

const s = (ms: number): string => `${fmtNum(ms / 1000, 1)} s`;
const ms = (v: number | undefined | null): string => (v === undefined || v === null ? '—' : fmtNum(v, 2));
const int = (v: number | undefined | null): string => (v === undefined || v === null ? '—' : Math.round(v).toLocaleString('pt-BR'));

/** The frames before the first of each segment's settled frames: what is left out. */
function anomaliesOf(rec: Recording, segments: readonly Segment[]): Anomaly[] {
  const out: Anomaly[] = [];
  const f = rec.frames;
  const settleEnds = segments.slice(1).map((sg) => [sg.startMs, sg.startMs + (sg.settle?.ms ?? SETTLE_MS)] as const);
  const settling = (t: number): boolean => settleEnds.some(([a, b]) => t >= a && t < b);
  const hitches: { t: number; v: number }[] = [];
  for (let i = 0; i < f.t.length; i++) if (!f.gap[i] && f.interval[i]! > 50 && !settling(f.t[i]!)) hitches.push({ t: f.t[i]!, v: f.interval[i]! });
  hitches.sort((a, b) => b.v - a.v);
  const before = (t: number): string => {
    const e = [...rec.events].reverse().find((x) => x.t <= t && x.t > t - 2000 && x.kind !== 'rec.stop');
    return e ? ` (${Math.round(t - e.t)} ms após ${e.kind}: ${e.detail})` : '';
  };
  for (const h of hitches.slice(0, 12)) out.push({ kind: 'hitch', t: h.t, detail: `quadro de ${fmtNum(h.v, 1)} ms em ${s(h.t)}${before(h.t)}` });
  if (hitches.length > 12) out.push({ kind: 'hitch', t: hitches[12]!.t, detail: `e mais ${hitches.length - 12} quadros acima de 50 ms` });
  for (const sg of segments) {
    if (sg.settle && (sg.settle.maxIntervalMs > 50 || sg.settle.maxCpuMs > 33)) {
      out.push({ kind: 'settle', t: sg.startMs, detail: `pico logo após "${sg.label}": intervalo máx. ${fmtNum(sg.settle.maxIntervalMs, 1)} ms, CPU máx. ${fmtNum(sg.settle.maxCpuMs, 1)} ms nos primeiros ${Math.round(sg.settle.ms)} ms (${sg.settle.frames} quadros)${sg.settle.never ? ' — **não assentou** antes da próxima mudança/20 s: as estatísticas do segmento ficam vazias' : ''} — provável compilação de shader/criação de alvos` });
    }
    if (sg.heapSlopeMBps !== null && sg.endMs - sg.startMs >= 5000 && sg.heapSlopeMBps > 0.5) {
      out.push({ kind: 'heap', t: sg.startMs, detail: `heap cresce ${fmtNum(sg.heapSlopeMBps, 2)} MB/s no segmento ${sg.index} ("${sg.label}") — possível vazamento ou lixo acumulando` });
    }
  }
  for (let i = 1; i < rec.sim.length; i++) {
    const a = rec.sim[i - 1]!.programs, b = rec.sim[i]!.programs;
    if (a !== null && b !== null && b > a) out.push({ kind: 'recompile', t: rec.sim[i]!.t, detail: `programas de shader ${a} → ${b} por volta de ${s(rec.sim[i]!.t)}${before(rec.sim[i]!.t)}` });
  }
  const long = rec.events.filter((e) => e.kind === 'longtask');
  if (long.length) {
    const total = long.reduce((sum, e) => sum + ((e.data as { duration?: number } | undefined)?.duration ?? 0), 0);
    out.push({ kind: 'longtask', t: long[0]!.t, detail: `${long.length} tarefas longas (>50 ms) somando ${Math.round(total)} ms; a maior: ${Math.round(Math.max(...long.map((e) => (e.data as { duration?: number } | undefined)?.duration ?? 0)))} ms` });
  }
  return out;
}

/** The other areas' sections, a few lines each: a summary string if they have one, else their costliest rows. */
function suspectsOf(sections: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const COSTLY = /ms|bytes|mb|kb|count|cost|time|calls|tri|gpu|cpu|share|total/i;
  for (const [name, value] of Object.entries(sections)) {
    if (name === 'recording' || name === 'inspector' || value === null || value === undefined) continue;
    const v = value as Record<string, unknown>;
    if (typeof v['summary'] === 'string') { lines.push(`- **${name}**: ${v['summary']}`); continue; }
    const rows = Array.isArray(value) ? value : Object.values(v).find((x) => Array.isArray(x) && x.length && typeof x[0] === 'object');
    if (Array.isArray(rows) && rows.length && rows[0] && typeof rows[0] === 'object') {
      const first = rows[0] as Record<string, unknown>;
      const key = Object.keys(first).find((k) => typeof first[k] === 'number' && COSTLY.test(k)) ?? Object.keys(first).find((k) => typeof first[k] === 'number');
      const sorted = key ? [...rows as Record<string, unknown>[]].sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0)) : rows as Record<string, unknown>[];
      lines.push(`- **${name}** (${rows.length} linhas${key ? `, maiores por \`${key}\`` : ''}):`);
      for (const r of sorted.slice(0, 5)) lines.push(`  - ${JSON.stringify(r).slice(0, 240)}`);
      continue;
    }
    lines.push(`- **${name}**: \`${JSON.stringify(value).slice(0, 400)}\``);
  }
  return lines;
}

const distJson = (d: Dist | null): unknown => (d ? Object.fromEntries(Object.entries(d).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) : null);

export function buildReport(ctx: LabContext, rec: Recording): LabReport {
  const stamp = `rec-${rec.startedAt.slice(0, 19).replace(/:/g, '-')}`;
  const segments = segment(rec.frames, rec.events, rec.endMs);
  const comparisons = compareAll(segments);
  const anomalies = anomaliesOf(rec, segments);
  const sections = Object.fromEntries(Object.entries(ctx.collectReport()).filter(([name]) => name !== 'recording'));
  const build = formatBuildStamp();
  const gpu = gpuName(ctx);
  const startSettings = rec.settings[0]?.effects ?? {};
  const meta = {
    format: REPORT_FORMAT,
    date: rec.startedAt,
    stoppedBy: rec.stopReason,
    durationMs: rec.endMs,
    activeMs: Math.round(rec.activeMs),
    frames: rec.frames.t.length,
    gpu,
    gpuTimer: ctx.scene.gpu.supported,
    userAgent: navigator.userAgent,
    screen: { width: screen.width, height: screen.height, devicePixelRatio: window.devicePixelRatio, canvas: [ctx.scene.gl.domElement.width, ctx.scene.gl.domElement.height] },
    crossOriginIsolated: window.crossOriginIsolated,
    hardwareConcurrency: navigator.hardwareConcurrency,
    build,
    url: location.href,
    settleMs: SETTLE_MS,
  };
  const json: Record<string, unknown> = {
    meta,
    settingsAtStart: rec.settings[0] ?? null,
    settingsChanges: rec.settings.slice(1),
    segments: segments.map((sg) => ({ ...sg, causes: sg.causes.map((c) => ({ t: c.t, kind: c.kind, detail: c.detail, data: c.data })), interval: distJson(sg.interval), cpu: distJson(sg.cpu), gpu: distJson(sg.gpu), drawCalls: distJson(sg.drawCalls), triangles: distJson(sg.triangles) })),
    comparisons,
    anomalies,
    events: rec.events,
    view: rec.views,
    sim: rec.sim,
    frames: { ...rec.frames, systems: Object.fromEntries(rec.frames.systems), gap: rec.frames.gap.map((g) => (g ? 1 : 0)) },
    sections,
  };

  // ---- the Markdown
  const md: string[] = [];
  const previous = new Map(comparisons.filter((c) => c.kind === 'previous').map((c) => [c.segment, c]));
  const baseline = new Map(comparisons.filter((c) => c.kind === 'baseline').map((c) => [c.segment, c]));
  md.push(`# Gravação de desempenho — Roadcraft`, '');
  md.push(`Relatório gerado pelo laboratório de depuração (F7, aba Gravação), para ser lido por uma IA ou por uma pessoa. Formato \`${REPORT_FORMAT}\`; o JSON irmão (\`${stamp}.json\`) tem todos os quadros.`, '');
  md.push('## Contexto', '');
  md.push(`- Data: ${rec.startedAt} · duração ${s(rec.endMs)} (gravando ${s(rec.activeMs)}) · ${rec.frames.t.length.toLocaleString('pt-BR')} quadros · parada: ${rec.stopReason}`);
  md.push(`- GPU: ${gpu} · temporizador de GPU: ${ctx.scene.gpu.supported ? 'sim' : 'não (colunas GPU vazias)'}`);
  md.push(`- Tela: ${screen.width}×${screen.height} @${window.devicePixelRatio} · canvas ${ctx.scene.gl.domElement.width}×${ctx.scene.gl.domElement.height} · crossOriginIsolated: ${String(window.crossOriginIsolated)} · núcleos: ${navigator.hardwareConcurrency}`);
  md.push(`- Build: ${build} · ${location.href}`);
  md.push(`- Navegador: ${navigator.userAgent}`);
  const lastSim = rec.sim[rec.sim.length - 1];
  if (lastSim) md.push(`- Simulação (fim): ${int(lastSim.vehicles)} veículos, ${int(lastSim.people)} pessoas, passo ${ms(lastSim.stepMs)} ms, ${int(lastSim.programs)} programas de shader`);
  const v0 = rec.views[0], vN = rec.views[rec.views.length - 1];
  if (v0 && vN) md.push(`- Câmera: ${v0.kind}, zoom ${v0.zoom} → ${vN.zoom}; ${rec.views.length} posições distintas registradas, ${rec.events.filter((e) => e.kind === 'view.move').length} movimentos`);
  if (startSettings['onDemand'] === true) md.push(`- **Atenção**: \`onDemand\` ligado — o jogo só desenha quando algo muda; os intervalos incluem espera ociosa. Compare CPU/GPU, não o intervalo.`);
  const off = Object.entries(startSettings).filter(([, v]) => v === false).map(([k]) => k);
  const valued = Object.entries(startSettings).filter(([, v]) => typeof v !== 'boolean').map(([k, v]) => `${k}=${String(v)}`);
  md.push(`- Configuração no início: desligados: ${off.length ? off.join(', ') : 'nenhum'}; valores: ${valued.join(', ') || '—'}`, '');

  md.push('## O que mudou e quando', '');
  const changes = rec.events.filter((e) => e.split);
  if (!changes.length) md.push('Nada mudou durante a gravação: um único segmento.');
  for (const e of changes) md.push(`- ${s(e.t)} — \`${e.kind}\`: ${describeChange(e)}`);
  md.push('');

  md.push('## Segmentos', '');
  md.push(`Cada segmento vai de uma mudança à próxima; o assentamento após cada mudança (≥ ${SETTLE_MS} ms, até o jogo se acalmar) fica fora das estatísticas. Tempos em ms; Δ contra o segmento anterior.`, '');
  md.push('| # | início | dur. | quadros | mudança | interv. p50/p95/p99 | CPU p50/p95/p99 | GPU p50/p95/p99 | >25/>50 ms | draw calls | triângulos | heap MB/s | Δ vs anterior | Δ vs base |');
  md.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const sg of segments) {
    const tri = (d: Dist | null): string => (d ? `${ms(d.p50)} / ${ms(d.p95)} / ${ms(d.p99)}` : '—');
    const p = previous.get(sg.index), b = baseline.get(sg.index);
    const deltaText = (c: Comparison | undefined): string => (c ? c.effect : '—');
    md.push(`| ${sg.index} | ${s(sg.startMs)} | ${s(sg.endMs - sg.startMs)} | ${sg.cpu?.n ?? 0} | ${sg.label} | ${tri(sg.interval)} | ${tri(sg.cpu)} | ${tri(sg.gpu)} | ${sg.hitches25}/${sg.hitches50} | ${int(sg.drawCalls?.mean)} | ${int(sg.triangles?.mean)} | ${sg.heapSlopeMBps === null ? '—' : fmtNum(sg.heapSlopeMBps, 2)} | ${deltaText(p)} | ${deltaText(b)} |`);
  }
  md.push('');

  md.push('## Efeito de cada mudança', '');
  if (!comparisons.length) md.push('Sem mudanças: nada a comparar.');
  for (const c of comparisons.filter((x) => x.kind === 'previous')) {
    const sg = segments[c.segment]!;
    md.push(`### Segmento ${c.segment}: ${sg.label}`, '');
    md.push(`- Resumo: **${c.summary}**`);
    for (const d of c.deltas) md.push(`  - ${describeDelta(d)} — ${fmtNum(d.from, 2)} → ${fmtNum(d.to, 2)}, ruído ±${fmtNum(d.noise, 2)} → ${d.verdict}`);
    const bc = baseline.get(c.segment);
    if (bc) md.push(`- Contra a linha de base: ${bc.effect}`);
    const before = segments[c.segment - 1];
    if (before && sg.systems.length) {
      const moved = sg.systems.map((x) => ({ name: x.name, d: x.meanMs - (before.systems.find((y) => y.name === x.name)?.meanMs ?? 0) })).filter((x) => Math.abs(x.d) >= 0.05).sort((a, b2) => Math.abs(b2.d) - Math.abs(a.d)).slice(0, 5);
      if (moved.length) md.push(`- Sistemas da CPU que mais mudaram (média ms/quadro): ${moved.map((x) => `${x.name} ${x.d > 0 ? '+' : ''}${fmtNum(x.d, 2)}`).join(', ')}`);
    }
    if (sg.settle) md.push(`- Assentamento (${Math.round(sg.settle.ms)} ms${sg.settle.never ? ', não assentou' : ''}, ${sg.settle.frames} quadros descartados): intervalo máx. ${ms(sg.settle.maxIntervalMs)}, CPU máx. ${ms(sg.settle.maxCpuMs)}, GPU máx. ${ms(sg.settle.maxGpuMs)}`);
    md.push('');
  }

  const base = segments[0];
  if (base?.systems.length) {
    md.push('## Maiores consumidores da CPU (linha de base)', '');
    for (const x of base.systems.slice(0, 8)) md.push(`- ${x.name}: ${fmtNum(x.meanMs, 2)} ms/quadro`);
    md.push('');
  }
  const edits = rec.events.filter((e) => e.kind.startsWith('edit.'));
  if (edits.length || sections['inspector'] !== undefined) {
    md.push('## Edições feitas pelo Inspector', '');
    for (const e of edits) md.push(`- ${s(e.t)} — \`${e.kind}\`: ${e.detail}${e.data === undefined ? '' : ` \`${JSON.stringify(e.data).slice(0, 300)}\``}`);
    if (!edits.length) md.push('Nenhuma edição durante a gravação.');
    if (sections['inspector'] !== undefined) md.push('', `Seção \`inspector\` (estado no fim): \`${JSON.stringify(sections['inspector']).slice(0, 1500)}\``);
    md.push('');
  }
  const suspects = suspectsOf(sections);
  md.push('## Suspeitos das outras áreas do laboratório', '');
  md.push(...(suspects.length ? suspects : ['Nenhuma outra área registrou seção no relatório.']), '');

  md.push('## Anomalias', '');
  md.push(...(anomalies.length ? anomalies.map((a) => `- [${a.kind}] ${a.detail}`) : ['Nenhuma: sem quadros acima de 50 ms fora do assentamento, sem crescimento de heap, sem recompilações observadas.']), '');
  const markers = rec.events.filter((e) => e.kind === 'rec.marker');
  if (markers.length) {
    md.push('## Marcadores', '');
    for (const m of markers) md.push(`- ${s(m.t)}: ${m.detail}`);
    md.push('');
  }

  md.push('## Como ler', '');
  md.push('- **intervalo**: tempo entre o início de um quadro e o do seguinte — o que o jogador espera (16,7 ms = 60 Hz). Inclui a espera do vsync.');
  md.push('- **CPU**: trabalho do próprio quadro na thread principal (`FrameTimer`). **GPU**: tempo da GPU medido por consulta de temporizador (chega alguns quadros atrasado; repete o último valor até chegar outro).');
  md.push('- **p50/p95/p99**: mediana e percentis; **>25/>50 ms**: quadros cujo intervalo passou disso (travadas).');
  md.push(`- **assentamento**: depois de cada mudança, pelo menos ${SETTLE_MS} ms e até 10 quadros calmos seguidos (intervalo e CPU < 50 ms) — compilação de shaders, criação de alvos; fora das estatísticas, o pico relatado à parte. "Não assentou": o jogo não se acalmou antes da próxima mudança.`);
  md.push('- **ruído**: 2 × erro-padrão da diferença, com a dispersão robusta (MAD×1,4826) de cada segmento e o nº de quadros dividido por 5 (quadros vizinhos não são independentes). p95 usa um erro maior. Uma diferença menor que isso é "dentro do ruído": não conclua nada dela.');
  md.push('- **Δ vs anterior** atribui a diferença à(s) mudança(s) que abriram o segmento; **Δ vs base** compara com o primeiro segmento (tudo como estava no início).');
  md.push('- **heap MB/s**: inclinação do heap JS no segmento (mínimos quadrados); positiva e persistente sugere vazamento — mas o GC é serrilhado: só segmentos longos dizem algo.');
  md.push('- A GPU pode estar compartilhada com outros processos; repita a gravação antes de afirmar um ganho pequeno.');
  md.push('');

  const real = comparisons.filter((c) => c.kind === 'previous').map((c) => c.summary);
  const summary = `${s(rec.endMs)}, ${segments.length} segmentos${real.length ? `: ${real.slice(0, 3).join('; ')}` : ''}`;
  return { stamp, json, md: md.join('\n'), segments, comparisons, anomalies, summary };
}
