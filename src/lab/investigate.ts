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

/** What the subject's name is, without its kind ("system: drawing" → "drawing"), and that kind. */
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
  if (origin.includes('frametimer') || kind === 'system') q.push(`mark('${plain}')`, `'${plain}'`);
  if (origin.includes('hitch') || kind === 'measure') q.push(`hitch:${plain}`, `'${plain}'`, plain);
  if (origin.includes('engine') || kind === 'product') q.push(`'${plain}'`, plain);
  if (origin.includes('gputimer') || /frame: gpu/i.test(subject.name)) q.push('gpuTimer.begin()', 'post.render(delta)');
  if (/frame: cpu/i.test(subject.name)) q.push('frameTimer.begin()', 'function frame(now');
  if (origin.includes('laststepms') || /simulation/i.test(subject.name)) q.push('lastStepMs');
  if (origin.includes('gpuledger')) q.push(`gpuLedger.set('${plain}'`, plain);
  if (!q.length) q.push(plain, ...plain.split(/[\s/:]+/).filter((w) => w.length >= 5).slice(0, 2));
  return [...new Set(q)].filter((s) => s.length >= 2 && s.length <= 200);
}

/** What the subject is, in a sentence, by where it was measured. */
function explain(subject: LabSubject): string {
  const o = (subject.origin ?? '').toLowerCase();
  const n = subject.name.toLowerCase();
  if (o.includes('frametimer') && n.startsWith('system')) return 'Main-thread time in one stretch of the frame loop (`main.ts` frame(), between two frameTimer.mark calls). "drawing" includes scene.draw: preparing the frame, picking levels, syncing people and vehicles and sending it all to the GPU.';
  if (o.includes('frametimer')) return 'The whole frame\'s work on the main thread, from the start of frame() to its end (FrameTimer).';
  if (o.includes('hitch')) return 'An explicit measure in the code (measureHitch / performance.measure) around a piece of work: each time it runs, it lands here. The stretch measured is the code between the mark and the measure shown below.';
  if (o.includes('performance.measure')) return 'A measure (performance.measure) the code takes around a piece of work.';
  if (o.includes('engine')) return 'A derived product of the engine (`core/engine.ts`) remade: "keys" is how many items it remade; IDLE means it remade them with no input changed (wasted work).';
  if (o.includes('gputimer')) return 'The time the GPU took to run the whole frame (EXT_disjoint_timer_query): shadows, scene and every pass. To know which pass costs, turn on per-pass timing in the GPU tab; to know which object, capture a frame.';
  if (o.includes('laststepms') || o.includes('simclient')) return 'The simulation step in the worker (`sim/sim.worker.ts`): traffic and pedestrians, off the main thread.';
  if (o.includes('long-animation-frame') || o.includes('loaf')) return 'A long animation frame (Long Animation Frames): the browser was busy for over 50 ms; the script and function to blame are in the fields.';
  if (o.includes('longtask')) return 'A long task (> 50 ms) that blocked the main thread.';
  if (o.includes('gpuledger') || subject.category === 'VRAM') return 'Video memory the game counted for this owner (`render/gpuLedger.ts`).';
  if (o.includes('resource') || subject.category === 'Network') return 'A file loaded over the network (Resource Timing): duration and size.';
  if (subject.category === 'Disk' || o.includes('storage')) return 'The site\'s storage use (IndexedDB, OPFS, cache).';
  if (subject.category === 'RAM') return 'Memory of the JavaScript process (heap) or of the page.';
  return `An item of the ${subject.from ?? 'lab\'s'} tab: below, where it appears in the code and what is tied to it.`;
}

const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9\u00e0-\u00fa]+/).filter((w) => w.length >= 4);

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
      button('code', 'Open in editor', 'Open this file at this line in the editor (Vite /__open-in-editor)', () => openInEditor(hit.file, hit.line)),
      button('pulse', 'In profile', 'See this file\'s functions in the CPU profile (Code tab)', () => ctx.navigate('code', { filter: hit.file })));
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
      if (m) direct.push({ file: m[1]!, line: Number(m[2] ?? 1), text: value, context: '', start: Number(m[2] ?? 1), how: 'cited in the item', score: 1000 });
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
      out.push(['chip', 'Per-pass timing', 'Turns on timing of each GPU pass', () => ctx.navigate('gpu', { timing: 'on' })]);
      out.push(['camera', 'Capture frame', 'Every draw call of this frame', () => ctx.navigate('gpu-frame', {})]);
    }
    if (cat === 'VRAM') out.push(['boxes', 'GPU objects', 'Textures, targets and geometries', () => ctx.navigate('gpu-objects', { filter })]);
    if (cat.startsWith('CPU') || /system|measure|product|frame: cpu/i.test(subject.name)) {
      out.push(['code', 'CPU profile', 'The functions running now (Code tab)', () => ctx.navigate('code', { filter })]);
    }
    out.push(['bars', 'In Consumers', 'This item in the consumers table', () => ctx.navigate('consumers', { filter, ...(cat ? { category: cat } : {}) })]);
    out.push(['flask', 'A/B test', 'Measure the gain of each switch or optimisation tied to this', () => ctx.navigate('tests-sweep', {})]);
    out.push(['record', 'Record', 'Record performance while you change things', () => ctx.navigate('recorder', {})]);
    return out;
  }

  async function render(subject: LabSubject): Promise<void> {
    const mine = ++token;
    const head = el('header', 'lab-inv-head');
    const title = el('div', 'lab-inv-title');
    title.append(icon('search', 16), el('strong', '', subject.name));
    head.append(title, button('copy', '', 'Copy this investigation as JSON (for the AI)', () => {
      const data = { subject, explanation: explain(subject), code: lastHits.map((h) => ({ file: h.file, line: h.line, text: h.text })), profile: profileRows(subject, lastHits), options: relatedOptions(subject).map((o) => o.id), switches: relatedSwitches(subject) };
      void navigator.clipboard.writeText(JSON.stringify(data, null, 1)).catch((error: unknown) => console.warn('lab: not copied', error));
    }), button('close', '', 'Close', () => inv.close()));
    const chips = el('div', 'lab-row');
    for (const c of [subject.category, subject.origin, subject.from]) if (c) chips.appendChild(el('span', 'lab-chip', c));

    const what = section('What it is', 'info');
    what.appendChild(el('p', '', explain(subject)));
    const fields = el('dl', 'lab-inv-fields');
    for (const [k, v] of subject.fields) fields.append(el('dt', '', k), el('dd', '', v));
    what.appendChild(fields);

    const actions = section('Dig deeper', 'zap');
    const row = el('div', 'lab-row');
    for (const [glyph, text, tip, act] of deeper(subject)) row.appendChild(button(glyph, text, tip, act));
    actions.appendChild(row);

    const code = section('Where it is in the code', 'code');
    code.appendChild(el('p', 'lab-muted', 'Searching the source code…'));
    const profile = section('In the CPU profile now', 'pulse');
    const related = section('Related switches and optimisations', 'toggle');

    const switches = relatedSwitches(subject);
    const opts = relatedOptions(subject);
    if (!switches.length && !opts.length) related.appendChild(el('p', 'lab-muted', 'Nothing tied directly by name. See the Optimizations tab or an A/B test.'));
    for (const [key, on] of switches) {
      related.appendChild(button(on ? 'toggle' : 'minus', `${key}: ${on ? 'on' : 'off'}`, 'Click to flip (marked in the recording)', () => { ctx.effects.setMany({ [key]: !on }); void render(subject); }));
    }
    for (const o of opts) {
      const b = button('zap', `${o.title} = ${String(o.value)}`, `${o.system} · affects ${o.affects.join(', ')} · click to open in Optimizations`, () => ctx.navigate('optimizations', { id: o.id }));
      if (o.value !== o.default) b.classList.add('on');
      related.appendChild(b);
    }

    root.replaceChildren(head, chips, what, actions, code, profile, related);
    root.scrollTop = 0;

    const hits = await findCode(subject);
    if (mine !== token) return;
    lastHits = hits;
    code.querySelector('p')?.remove();
    if (!hits.length) code.appendChild(el('p', 'lab-muted', 'No snippet found by name (the dev server does the search; the desktop app has none).'));
    for (const h of hits) {
      if (h.context) code.appendChild(codeBlock(h));
      else {
        const card = el('div', 'lab-card lab-row');
        card.append(el('strong', '', `${h.file}:${h.line}`), el('span', 'lab-muted', h.how),
          button('code', 'Open in editor', 'Open in editor', () => openInEditor(h.file, h.line)),
          button('pulse', 'In profile', 'See in the CPU profile', () => ctx.navigate('code', { filter: h.file })));
        code.appendChild(card);
      }
    }
    const prof = profileRows(subject, hits);
    if (!prof.length) {
      profile.append(el('p', 'lab-muted', 'The CPU profile has not seen functions tied to this yet.'),
        button('play', 'Start live profile', 'Starts sampling the CPU (Code tab)', () => {
          (window as unknown as { __labCode?: { start(live?: boolean): void } }).__labCode?.start(true);
          window.setTimeout(() => { if (current === subject) void render(subject); }, 3500);
        }));
    } else {
      const t = el('table', 'lab-inv-table');
      const tr = el('tr');
      for (const h of ['Function', 'Where', 'Self ms', 'Total ms']) tr.appendChild(el('th', '', h));
      t.appendChild(tr);
      for (const r of prof) {
        const line = el('tr');
        line.append(el('td', '', r.name || '(anonymous)'), el('td', '', r.where), el('td', 'num', r.selfMs.toFixed(1)), el('td', 'num', r.totalMs.toFixed(1)));
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
      ctx.emit('lab.investigate', `investigate: ${subject.name}`, { name: subject.name, category: subject.category, from: subject.from });
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
