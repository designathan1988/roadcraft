import { icon } from './icons';
import type { LabContext, LabSubject } from './labTypes';

/** INVESTIGATE: any row of any table of the lab (or any meter, tile or item) clicked opens this drawer - what the thing is, where it is in the code (the snippet, open in the editor), what of it the CPU profile sees now, the switches and optimisations that touch it, and where to dig deeper. Every tab gets it from `table.ts` without doing anything. */

/** The DOM event a table (or anything) sends up to the lab's window to have a subject investigated. */
export const INVESTIGATE_EVENT = 'lab-investigate';

export function sendInvestigate(from: Element, subject: LabSubject): void {
  from.dispatchEvent(new CustomEvent<LabSubject>(INVESTIGATE_EVENT, { bubbles: true, detail: subject }));
}

interface SourceHit { readonly file: string; readonly line: number; readonly text: string; readonly context: string; readonly start: number; readonly how: string; readonly score: number }
interface ProfileRow { readonly name: string; readonly where: string; readonly category: string; readonly selfMs: number; readonly totalMs: number; readonly samples: number }
interface OptRow { readonly id: string; readonly system: string; readonly title: string; readonly value: unknown; readonly default: unknown; readonly choices: readonly unknown[]; readonly affects: readonly string[] }

const FILE_REF = /(src\/[\w./-]+\.(?:ts|js|mjs))(?:[:@](\d+))?/;

/** What the subject's name is, without its kind ("sistema: drawing" → "drawing"), and that kind. */
function parts(subject: LabSubject): { kind: string; bare: string } {
  const m = /^([^:]{2,40}):\s*(.+)$/.exec(subject.name);
  return m ? { kind: m[1]!.trim().toLowerCase(), bare: m[2]!.trim() } : { kind: '', bare: subject.name.trim() };
}

/** The searches that find where in the code the subject is made or measured, by where it was measured. */
function queriesOf(subject: LabSubject): string[] {
  const { kind, bare } = parts(subject);
  const origin = (subject.origin ?? '').toLowerCase();
  const plain = bare.replace(/\s*\([^)]*\)\s*$/, '').trim();
  const q: string[] = [];
  if (origin.includes('frametimer') || kind === 'sistema') q.push(`mark('${plain}')`, `'${plain}'`);
  if (origin.includes('hitch') || kind === 'medida') q.push(`hitch:${plain}`, `'${plain}'`, plain);
  if (origin.includes('engine') || kind === 'produto') q.push(`'${plain}'`, plain);
  if (origin.includes('gputimer') || /quadro: gpu/i.test(subject.name)) q.push('gpuTimer.begin()', 'post.render(delta)');
  if (/quadro: cpu/i.test(subject.name)) q.push('frameTimer.begin()', 'function frame(now');
  if (origin.includes('laststepms') || /simula/i.test(subject.name)) q.push('lastStepMs');
  if (origin.includes('gpuledger')) q.push(`gpuLedger.set('${plain}'`, plain);
  if (!q.length) q.push(plain, ...plain.split(/[\s/:]+/).filter((w) => w.length >= 5).slice(0, 2));
  return [...new Set(q)].filter((s) => s.length >= 2 && s.length <= 200);
}

/** What the subject is, in a sentence, by where it was measured. */
function explain(subject: LabSubject): string {
  const o = (subject.origin ?? '').toLowerCase();
  const n = subject.name.toLowerCase();
  if (o.includes('frametimer') && n.startsWith('sistema')) return 'Tempo da thread principal num trecho do laço do quadro (`main.ts` frame(), entre duas chamadas frameTimer.mark). "drawing" inclui scene.draw: preparar o quadro, escolher níveis, sincronizar pessoas e veículos e enviar tudo à GPU.';
  if (o.includes('frametimer')) return 'O trabalho do quadro inteiro na thread principal, do começo de frame() ao fim (FrameTimer).';
  if (o.includes('hitch')) return 'Uma medida explícita no código (measureHitch / performance.measure) em volta de um trabalho: cada vez que ele roda, entra aqui. O trecho medido é o código entre a marca e a medida mostradas abaixo.';
  if (o.includes('performance.measure')) return 'Uma medida (performance.measure) que o código faz em volta de um trabalho.';
  if (o.includes('engine')) return 'Um produto derivado do motor (`core/engine.ts`) refeito: "chaves" é quantos itens ele refez; OCIOSO quer dizer que refez sem nenhuma entrada ter mudado (trabalho à toa).';
  if (o.includes('gputimer')) return 'O tempo que a GPU levou para executar o quadro inteiro (EXT_disjoint_timer_query): sombras, cena e todos os passes. Para saber qual passe custa, ligue o tempo por passe na aba GPU; para saber qual objeto, capture um quadro.';
  if (o.includes('laststepms') || o.includes('simclient')) return 'O passo da simulação no worker (`sim/sim.worker.ts`): trânsito e pedestres, fora da thread principal.';
  if (o.includes('long-animation-frame') || o.includes('loaf')) return 'Um quadro de animação longo (Long Animation Frames): o navegador ficou ocupado mais de 50 ms; o script e a função culpados estão nos campos.';
  if (o.includes('longtask')) return 'Uma tarefa longa (> 50 ms) que bloqueou a thread principal.';
  if (o.includes('gpuledger') || subject.category === 'VRAM') return 'Memória de vídeo que o jogo contou para este dono (`render/gpuLedger.ts`).';
  if (o.includes('resource') || subject.category === 'Rede') return 'Um arquivo carregado pela rede (Resource Timing): duração e tamanho.';
  if (subject.category === 'Disco' || o.includes('storage')) return 'Uso do armazenamento do site (IndexedDB, OPFS, cache).';
  if (subject.category === 'RAM') return 'Memória do processo JavaScript (heap) ou da página.';
  return `Item da aba ${subject.from ?? 'do laboratório'}: abaixo, onde ele aparece no código e o que está ligado a ele.`;
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9à-ú]+/).filter((w) => w.length >= 4);

export interface Investigator {
  readonly element: HTMLElement;
  open(subject: LabSubject): void;
  close(): void;
}

export function createInvestigator(ctx: LabContext): Investigator {
  const root = document.createElement('aside');
  root.className = 'lab-investigate';
  root.hidden = true;
  let token = 0;
  let current: LabSubject | null = null;
  let lastHits: SourceHit[] = [];

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    if (className) e.className = className;
    if (text) e.textContent = text;
    return e;
  };
  const button = (glyph: string, text: string, title: string, onClick: () => void): HTMLButtonElement => {
    const b = el('button');
    b.type = 'button';
    b.title = title;
    if (glyph) b.appendChild(icon(glyph, 14));
    if (text) b.appendChild(el('span', '', text));
    b.onclick = onClick;
    return b;
  };
  const openInEditor = (file: string, line: number): void => {
    void fetch(`/__open-in-editor?file=${encodeURIComponent(`${file}:${line}`)}`).catch((error: unknown) => console.warn('lab: editor not opened', error));
  };
  const section = (title: string, glyph: string): HTMLElement => {
    const box = el('section', 'lab-inv-section');
    const h = el('h3');
    h.append(icon(glyph, 13), el('span', '', title));
    box.appendChild(h);
    return box;
  };

  const codeBlock = (hit: SourceHit): HTMLElement => {
    const card = el('div', 'lab-card lab-inv-hit');
    const head = el('div', 'lab-row');
    const where = el('strong', '', `${hit.file}:${hit.line}`);
    head.append(where, el('span', 'lab-muted', hit.how),
      button('code', 'Abrir no editor', 'Abrir este arquivo nesta linha no editor (Vite /__open-in-editor)', () => openInEditor(hit.file, hit.line)),
      button('pulse', 'No perfil', 'Ver as funções deste arquivo no perfil de CPU (aba Código)', () => ctx.navigate('code', { filter: hit.file })));
    const pre = el('pre', 'lab-code');
    hit.context.split('\n').forEach((text, i) => {
      const n = hit.start + i;
      const line = el('div', n === hit.line ? 'lab-inv-line on' : 'lab-inv-line');
      line.append(el('span', 'lab-inv-no', String(n).padStart(5, ' ')), document.createTextNode(` ${text}`));
      pre.appendChild(line);
    });
    card.append(head, pre);
    return card;
  };

  async function findCode(subject: LabSubject): Promise<SourceHit[]> {
    const direct: SourceHit[] = [];
    for (const [, value] of subject.fields) {
      const m = FILE_REF.exec(value);
      if (m) direct.push({ file: m[1]!, line: Number(m[2] ?? 1), text: value, context: '', start: Number(m[2] ?? 1), how: 'citado no item', score: 1000 });
    }
    const all = new Map<string, SourceHit>();
    for (const q of queriesOf(subject)) {
      try {
        const r = await fetch(`/__lab/source-find?q=${encodeURIComponent(q)}`);
        if (!r.ok) continue;
        const { hits } = (await r.json()) as { hits: SourceHit[] };
        for (const h of hits) {
          // The lab's own sources name every subject (its searches, its labels): never where the subject is.
          if (h.file.startsWith('src/lab/') && !/lab/i.test(subject.origin ?? '')) continue;
          const key = `${h.file}:${h.line}`;
          const known = all.get(key);
          if (!known || known.score < h.score) all.set(key, h);
        }
      } catch (error) {
        console.warn('lab: source search failed', error);
      }
    }
    return [...direct, ...[...all.values()].sort((a, b) => b.score - a.score)].slice(0, 8);
  }

  function profileRows(subject: LabSubject, hits: readonly SourceHit[]): ProfileRow[] {
    const code = (window as unknown as { __labCode?: { functions(view?: string): ProfileRow[] } }).__labCode;
    if (!code) return [];
    let rows: ProfileRow[];
    try { rows = code.functions('session'); } catch (error) { console.warn('lab: profile unread', error); return []; }
    const files = new Set(hits.map((h) => h.file));
    const tokens = words(parts(subject).bare);
    return rows.filter((r) => [...files].some((f) => r.where.includes(f)) || tokens.some((t) => r.name.toLowerCase().includes(t)))
      .sort((a, b) => b.totalMs - a.totalMs).slice(0, 12);
  }

  function relatedOptions(subject: LabSubject): OptRow[] {
    const opt = (window as unknown as { __labOpt?: { list(): OptRow[] } }).__labOpt;
    if (!opt) return [];
    let list: OptRow[];
    try { list = opt.list(); } catch (error) { console.warn('lab: options unread', error); return []; }
    const tokens = words(`${subject.name} ${subject.category ?? ''}`);
    const gpu = subject.category === 'GPU' || subject.category === 'VRAM';
    return list.filter((o) => {
      const text = `${o.id} ${o.title} ${o.system} ${o.affects.join(' ')}`.toLowerCase();
      return tokens.some((t) => text.includes(t)) || (gpu && /pass:|shadows|post|textures/.test(o.affects.join(' ')));
    }).slice(0, 12);
  }

  function relatedSwitches(subject: LabSubject): [string, boolean][] {
    const snap = ctx.effects.snapshot();
    const tokens = words(`${subject.name} ${subject.origin ?? ''}`);
    return Object.entries(snap).filter((e): e is [string, boolean] => typeof e[1] === 'boolean')
      .filter(([key]) => tokens.some((t) => key.toLowerCase().includes(t) || t.includes(key.toLowerCase().replace(/^b/, ''))));
  }

  function deeper(subject: LabSubject): [string, string, string, () => void][] {
    const out: [string, string, string, () => void][] = [];
    const filter = parts(subject).bare;
    const cat = subject.category ?? '';
    if (cat === 'GPU' || /gpu/i.test(subject.name)) {
      out.push(['chip', 'Tempo por passe', 'Liga a medição de cada passe da GPU', () => ctx.navigate('gpu', { timing: 'on' })]);
      out.push(['camera', 'Capturar quadro', 'Cada chamada de desenho deste quadro', () => ctx.navigate('gpu-frame', {})]);
    }
    if (cat === 'VRAM') out.push(['boxes', 'Objetos na GPU', 'Texturas, alvos e geometrias', () => ctx.navigate('gpu-objects', { filter })]);
    if (cat.startsWith('CPU') || /sistema|medida|produto|quadro: cpu/i.test(subject.name)) {
      out.push(['code', 'Perfil de CPU', 'As funções que rodam agora (aba Código)', () => ctx.navigate('code', { filter })]);
    }
    out.push(['bars', 'No Consumo', 'Este item na tabela de consumo', () => ctx.navigate('consumers', { filter, ...(cat ? { category: cat } : {}) })]);
    out.push(['flask', 'Testar A/B', 'Medir o ganho de cada interruptor ou otimização ligado a isto', () => ctx.navigate('tests-sweep', {})]);
    out.push(['record', 'Gravar', 'Gravar o desempenho enquanto você muda as coisas', () => ctx.navigate('recorder', {})]);
    return out;
  }

  async function render(subject: LabSubject): Promise<void> {
    const mine = ++token;
    const head = el('header', 'lab-inv-head');
    const title = el('div', 'lab-inv-title');
    title.append(icon('search', 16), el('strong', '', subject.name));
    head.append(title, button('copy', '', 'Copiar esta investigação em JSON (para a IA)', () => {
      const data = { subject, explanation: explain(subject), code: lastHits.map((h) => ({ file: h.file, line: h.line, text: h.text })), profile: profileRows(subject, lastHits), options: relatedOptions(subject).map((o) => o.id), switches: relatedSwitches(subject) };
      void navigator.clipboard.writeText(JSON.stringify(data, null, 1)).catch((error: unknown) => console.warn('lab: not copied', error));
    }), button('close', '', 'Fechar', () => inv.close()));
    const chips = el('div', 'lab-row');
    for (const c of [subject.category, subject.origin, subject.from]) if (c) chips.appendChild(el('span', 'lab-chip', c));

    const what = section('O que é', 'info');
    what.appendChild(el('p', '', explain(subject)));
    const fields = el('dl', 'lab-inv-fields');
    for (const [k, v] of subject.fields) fields.append(el('dt', '', k), el('dd', '', v));
    what.appendChild(fields);

    const actions = section('Aprofundar', 'zap');
    const row = el('div', 'lab-row');
    for (const [glyph, text, tip, act] of deeper(subject)) row.appendChild(button(glyph, text, tip, act));
    actions.appendChild(row);

    const code = section('Onde está no código', 'code');
    code.appendChild(el('p', 'lab-muted', 'Procurando no código-fonte…'));
    const profile = section('No perfil de CPU agora', 'pulse');
    const related = section('Interruptores e otimizações relacionados', 'toggle');

    const switches = relatedSwitches(subject);
    const opts = relatedOptions(subject);
    if (!switches.length && !opts.length) related.appendChild(el('p', 'lab-muted', 'Nada ligado diretamente pelo nome. Veja a aba Otimizações ou teste A/B.'));
    for (const [key, on] of switches) {
      related.appendChild(button(on ? 'toggle' : 'minus', `${key}: ${on ? 'ligado' : 'desligado'}`, 'Clique para inverter (marcado na gravação)', () => { ctx.effects.setMany({ [key]: !on }); void render(subject); }));
    }
    for (const o of opts) {
      const b = button('zap', `${o.title} = ${String(o.value)}`, `${o.system} · afeta ${o.affects.join(', ')} · clique para abrir em Otimizações`, () => ctx.navigate('optimizations', { id: o.id }));
      if (o.value !== o.default) b.classList.add('on');
      related.appendChild(b);
    }

    root.replaceChildren(head, chips, what, actions, code, profile, related);
    root.scrollTop = 0;

    const hits = await findCode(subject);
    if (mine !== token) return;
    lastHits = hits;
    code.querySelector('p')?.remove();
    if (!hits.length) code.appendChild(el('p', 'lab-muted', 'Nenhum trecho encontrado pelo nome (o servidor de desenvolvimento faz a busca; no app desktop ela não existe).'));
    for (const h of hits) {
      if (h.context) code.appendChild(codeBlock(h));
      else {
        const card = el('div', 'lab-card lab-row');
        card.append(el('strong', '', `${h.file}:${h.line}`), el('span', 'lab-muted', h.how),
          button('code', 'Abrir no editor', 'Abrir no editor', () => openInEditor(h.file, h.line)),
          button('pulse', 'No perfil', 'Ver no perfil de CPU', () => ctx.navigate('code', { filter: h.file })));
        code.appendChild(card);
      }
    }
    const prof = profileRows(subject, hits);
    if (!prof.length) {
      profile.append(el('p', 'lab-muted', 'O perfil de CPU não viu funções ligadas a isto ainda.'),
        button('play', 'Ligar perfil ao vivo', 'Começa a amostrar a CPU (aba Código)', () => {
          (window as unknown as { __labCode?: { start(live?: boolean): void } }).__labCode?.start(true);
          window.setTimeout(() => { if (current === subject) void render(subject); }, 3500);
        }));
    } else {
      const t = el('table', 'lab-inv-table');
      const tr = el('tr');
      for (const h of ['Função', 'Onde', 'Próprio ms', 'Total ms']) tr.appendChild(el('th', '', h));
      t.appendChild(tr);
      for (const r of prof) {
        const line = el('tr');
        line.append(el('td', '', r.name || '(anônima)'), el('td', '', r.where), el('td', 'num', r.selfMs.toFixed(1)), el('td', 'num', r.totalMs.toFixed(1)));
        line.onclick = () => ctx.navigate('code', { filter: r.name || r.where });
        t.appendChild(line);
      }
      profile.appendChild(t);
    }
  }

  const inv: Investigator = {
    element: root,
    open(subject) {
      current = subject;
      root.hidden = false;
      ctx.emit('lab.investigate', `investigar: ${subject.name}`, { name: subject.name, category: subject.category, from: subject.from });
      void render(subject);
    },
    close() {
      root.hidden = true;
      current = null;
      token++;
    },
  };
  return inv;
}
