import { icon } from '../icons';
import type { LabContext, LabTab } from '../labTypes';
import { findingsOf, layerSwitch, layersOf, verdictOf, type Finding } from './findings';
import { quickAb, snapshot, type AbResult, type Snapshot } from './measure';
import './doctor.css';

/** THE DIAGNOSIS (the lab's first tab): it measures by itself - the frame, every GPU pass, one frame's every draw, the CPU's systems and functions - and lists the CAUSES by weight, each with its figures, why it matters, a one-click A/B test of the change that would remove it, and where to look (its draws, the object in the inspector, its code). Chrome's Insights sidebar for the game. */

const PASS_COLOUR: Readonly<Record<string, string>> = {
  shadows: '#9b87f5', scene: '#2fc2ab', gtao: '#f5a524', canyon: '#ef6b5b', bloom: '#ffd166', clouds: '#6aa9ff', smaa: '#8bd17c', output: '#b9c3c8',
};
const fmt = (n: number): string => n.toLocaleString('pt-BR', { maximumFractionDigits: n >= 100 ? 0 : 1 });

export function createDoctorTabs(ctx: LabContext): LabTab[] {
  const root = document.createElement('div');
  root.className = 'lab-doctor';
  let snap: Snapshot | null = null;
  let findings: Finding[] = [];
  let busy = false;
  let status = '';
  const results = new Map<string, AbResult | 'medindo' | string>();

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  };
  const button = (glyph: string, text: string, title: string, onClick: () => void, className = ''): HTMLButtonElement => {
    const b = el('button', className);
    b.type = 'button';
    b.title = title;
    if (glyph) b.appendChild(icon(glyph, 14));
    if (text) b.appendChild(el('span', '', text));
    b.onclick = onClick;
    return b;
  };

  async function measure(): Promise<void> {
    if (busy) return;
    busy = true;
    results.clear();
    draw();
    try {
      snap = await snapshot(ctx, (text) => { status = text; draw(); });
      findings = findingsOf(snap);
      status = `medido às ${new Date().toLocaleTimeString('pt-BR')} em ${snap.frames} quadros`;
      ctx.emit('doctor.measure', `diagnóstico: ${verdictOf(snap).bound}, ${findings.length} causas`, { verdict: verdictOf(snap), findings: findings.map((f) => f.title) });
    } catch (error) {
      console.error('lab doctor: measure failed', error);
      status = `a medida falhou: ${String(error)}`;
    } finally {
      busy = false;
      draw();
    }
  }

  async function test(f: Finding): Promise<void> {
    if (!f.test || busy) return;
    busy = true;
    results.set(f.id, 'medindo');
    draw();
    const test = f.test;
    try {
      ctx.emit('doctor.test', `testar: ${test.label}`, { finding: f.id, values: test.values });
      const r = await quickAb(ctx, () => ctx.effects.setMany(test.values), () => ctx.effects.setMany(test.back), (text) => { status = `${test.label}: ${text}`; draw(); });
      results.set(f.id, r);
      ctx.emit('doctor.result', `${test.label}: GPU ${r.gpuA === null || r.gpuB === null ? '—' : `${fmt(r.gpuA)} → ${fmt(r.gpuB)} ms`}, CPU ${fmt(r.cpuA)} → ${fmt(r.cpuB)} ms`, { finding: f.id, ...r });
      status = `${test.label}: medido`;
    } catch (error) {
      console.error('lab doctor: test failed', error);
      results.set(f.id, `falhou: ${String(error)}`);
    } finally {
      busy = false;
      draw();
    }
  }

  /** The A/B's figures: what the change saves (green) or costs (red), or that it is noise. */
  function abView(r: AbResult): HTMLElement {
    const box = el('div', 'lab-doc-ab');
    const line = (label: string, a: number | null, b: number | null, noise: number, unit: string): void => {
      if (a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b)) { box.appendChild(el('div', 'lab-muted', `${label}: sem medida`)); return; }
      const d = b - a;
      const row = el('div', 'lab-doc-ab-row');
      const margin = Math.max(noise, Math.abs(a) * 0.03);
      const noisy = Math.abs(d) <= margin;
      const change = d < 0 ? `ganho de ${fmt(-d)} ${unit} (${fmt((-d / Math.max(a, 1e-6)) * 100)}%)` : `perda de ${fmt(d)} ${unit} (+${fmt((d / Math.max(a, 1e-6)) * 100)}%)`;
      const verdict = noisy ? `${change} — dentro do ruído (±${fmt(margin)})` : `${change}${noise > 0 ? ` (ruído ±${fmt(noise)})` : ''}`;
      row.append(el('span', 'lab-muted', label), el('span', '', `${fmt(a)} → ${fmt(b)} ${unit}`), el('strong', noisy ? 'lab-muted' : d < 0 ? 'lab-good' : 'lab-bad', verdict));
      box.appendChild(row);
    };
    line('GPU', r.gpuA, r.gpuB, r.noiseGpu, 'ms');
    line('CPU', r.cpuA, r.cpuB, r.noiseCpu, 'ms');
    line('Desenhos', r.drawsA, r.drawsB, 0, '');
    line('Triângulos', r.trisA, r.trisB, 0, '');
    return box;
  }

  function card(f: Finding): HTMLElement {
    const c = el('article', `lab-doc-card sev-${f.severity === 'média' ? 'media' : f.severity}`);
    const head = el('header');
    head.append(el('span', 'lab-doc-sev', f.severity), el('span', 'lab-doc-area', f.area), el('strong', '', f.title));
    const list = el('ul');
    for (const e of f.evidence) list.appendChild(el('li', '', e));
    const actions = el('div', 'lab-row');
    if (f.test) {
      actions.appendChild(button('flask', `Testar: ${f.test.label}`, 'Mede antes, aplica, mede, desfaz e mede de novo (≈ 8 s): mostra o ganho real aqui', () => { void test(f); }, 'lab-doc-primary'));
      const key = Object.keys(f.test.values)[0]!;
      const on = ctx.effects.snapshot()[key];
      actions.appendChild(button('toggle', on === false ? 'Religar' : 'Desligar', 'Aplicar a mudança e deixar (marcado na gravação)', () => { ctx.effects.setMany(on === false ? f.test!.back : f.test!.values); draw(); }));
    }
    if (f.layer) {
      actions.appendChild(button('camera', 'Ver desenhos', 'Cada chamada de desenho desta camada no quadro capturado', () => ctx.navigate('gpu-frame', { filter: f.layer! })));
      if (f.object) {
        actions.appendChild(button('crosshair', 'No Inspetor', 'O objeto mais pesado desta camada: geometria, material, shader, código que o cria, edição ao vivo', () => {
          (window as unknown as { __labInspector?: { select(o: unknown): void } }).__labInspector?.select(f.object);
          ctx.navigate('inspector', {});
        }));
      }
    }
    if (f.pass) actions.appendChild(button('chip', 'Passes da GPU', 'O tempo de cada passe ao vivo', () => ctx.navigate('gpu', { timing: 'on' })));
    if (f.where) actions.appendChild(button('code', 'Ver código', 'A função no perfil de CPU, com o código-fonte', () => ctx.navigate('code', { filter: f.where! })));
    actions.appendChild(button('search', 'Investigar', 'O que é, onde está no código, o que está ligado', () => ctx.investigate({ name: f.title, category: f.area, origin: f.layer ?? f.pass ?? f.where ?? 'diagnóstico', from: 'Diagnóstico', fields: f.evidence.map((e, i) => [`evidência ${i + 1}`, e] as const) })));
    c.append(head, list, el('p', 'lab-doc-why', f.why), actions);
    const r = results.get(f.id);
    if (r === 'medindo') c.appendChild(el('div', 'lab-muted', 'medindo…'));
    else if (typeof r === 'string') c.appendChild(el('div', 'lab-bad', r));
    else if (r) c.appendChild(abView(r));
    return c;
  }

  /** One stacked bar: the parts of a whole, each labelled with its value. */
  function stack(parts: readonly { label: string; value: number; colour: string; onClick?: () => void }[], unit: string): HTMLElement {
    const total = parts.reduce((a, p) => a + p.value, 0) || 1;
    const bar = el('div', 'lab-doc-stack');
    const legend = el('div', 'lab-doc-legend');
    for (const p of parts) {
      const seg = el('span');
      seg.style.width = `${(p.value / total) * 100}%`;
      seg.style.background = p.colour;
      seg.title = `${p.label}: ${fmt(p.value)} ${unit}`;
      if (p.onClick) seg.onclick = p.onClick;
      bar.appendChild(seg);
      const item = el('button', 'lab-doc-key');
      item.type = 'button';
      const dot = el('i');
      dot.style.background = p.colour;
      item.append(dot, el('span', '', p.label), el('strong', '', `${fmt(p.value)} ${unit}`));
      if (p.onClick) item.onclick = p.onClick; else item.disabled = true;
      legend.appendChild(item);
    }
    const box = el('div');
    box.append(bar, legend);
    return box;
  }

  function draw(): void {
    const top = el('div', 'lab-row lab-doc-top');
    top.append(button('refresh', busy ? 'Medindo…' : 'Medir agora', 'Mede o quadro, cada passe da GPU, captura um quadro e amostra a CPU (≈ 5 s)', () => { void measure(); }, 'lab-doc-primary'), el('span', 'lab-muted', status));
    const parts: HTMLElement[] = [top];
    if (!snap) {
      parts.push(el('p', 'lab-muted', busy ? 'Medindo…' : 'Clique em "Medir agora": o laboratório mede sozinho e lista o que mais pesa, com o teste de cada causa.'));
      root.replaceChildren(...parts);
      return;
    }
    const v = verdictOf(snap);
    const banner = el('section', `lab-doc-verdict bound-${v.bound === 'folga' ? 'ok' : v.bound === 'sem medida' ? 'none' : v.bound.toLowerCase()}`);
    banner.append(el('h2', '', v.bound === 'GPU' ? 'Gargalo: GPU' : v.bound === 'CPU' ? 'Gargalo: CPU' : v.bound === 'folga' ? 'Sem gargalo' : 'Sem medida'), el('p', '', v.text));
    parts.push(banner);

    // Where the GPU goes: by pass, then by layer.
    if (snap.passes.length) {
      const sec = el('section', 'lab-doc-section');
      sec.append(el('h3', '', `Onde a GPU gasta, por passe (${fmt(snap.passes.reduce((a, p) => a + p.avg, 0))} ms)`),
        stack(snap.passes.map((p) => ({ label: p.label, value: p.avg, colour: PASS_COLOUR[p.pass] ?? '#999', onClick: () => ctx.navigate('gpu', { filter: p.label }) })), 'ms'));
      parts.push(sec);
    }
    const layers = layersOf(snap.draws).slice(0, 10);
    if (layers.length) {
      const sec = el('section', 'lab-doc-section');
      const total = layers.reduce((a, l) => a + l.triangles, 0) || 1;
      sec.appendChild(el('h3', '', `Onde a GPU gasta, por camada (um quadro: ${fmt(snap.draws.length)} desenhos)`));
      const table = el('div', 'lab-doc-layers');
      for (const l of layers) {
        const row = el('button', 'lab-doc-layer');
        row.type = 'button';
        row.title = 'Ver os desenhos desta camada';
        const share = l.triangles / total;
        const bar = el('span', 'lab-doc-layer-bar');
        bar.style.width = `${Math.max(1, share * 100)}%`;
        const sw = layerSwitch(l.layer);
        row.append(el('span', 'lab-doc-layer-name', sw ? `${sw.label} · ${l.layer}` : l.layer), el('span', 'lab-doc-layer-tris', `${(share * 100).toFixed(0)}% · ${fmt(l.triangles / 1000)} mil tri · ${l.calls} desenhos`), bar);
        row.onclick = () => ctx.navigate('gpu-frame', { filter: l.layer });
        table.appendChild(row);
      }
      sec.appendChild(table);
      parts.push(sec);
    }
    if (snap.systems.length) {
      const sec = el('section', 'lab-doc-section');
      const colours = ['#2fc2ab', '#6aa9ff', '#f5a524', '#9b87f5', '#ef6b5b', '#8bd17c', '#ffd166', '#b9c3c8', '#d18bd1'];
      sec.append(el('h3', '', `Onde a CPU gasta, por sistema do quadro (${fmt(snap.cpuMs)} ms)`),
        stack(snap.systems.filter(([, ms]) => ms >= 0.05).map(([k, ms], i) => ({ label: k, value: ms, colour: colours[i % colours.length]!, onClick: () => ctx.navigate('consumers', { filter: k, category: 'CPU-main' }) })), 'ms'));
      parts.push(sec);
    }
    const causes = el('section', 'lab-doc-section');
    causes.appendChild(el('h3', '', `Causas, em ordem de peso (${findings.length})`));
    if (!findings.length) causes.appendChild(el('p', 'lab-muted', 'Nada acima dos limiares nesta medida.'));
    for (const f of findings) causes.appendChild(card(f));
    parts.push(causes);
    root.replaceChildren(...parts);
  }

  let measuredOnce = false;
  ctx.reportSection('doctor', () => (snap ? {
    verdict: verdictOf(snap),
    frameMs: snap.frameMs, cpuMs: snap.cpuMs, gpuMs: snap.gpuMs,
    passes: snap.passes, layers: layersOf(snap.draws).slice(0, 15).map(({ heaviest: _h, ...l }) => l),
    systems: snap.systems, functions: snap.functions,
    findings: findings.map((f) => ({ ...f, object: undefined, result: results.get(f.id) })),
  } : null));
  (window as unknown as { __labDoctor: unknown }).__labDoctor = { measure, findings: () => findings, snapshot: () => snap, test: (id: string) => { const f = findings.find((x) => x.id === id); return f ? test(f) : Promise.resolve(); } };

  return [{
    id: 'doctor',
    title: 'Diagnóstico',
    mount(host) {
      host.appendChild(root);
      draw();
      // The first time shown: measured at once (the user should not have to start anything to see the causes).
      if (!measuredOnce) { measuredOnce = true; void measure(); }
    },
  }];
}
