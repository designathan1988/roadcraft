import type { Material, Object3D } from 'three';
import { createLabTable } from '../table';
import { button, bytes, el, fold, heading, kv } from './dom';
import { gpuDrawsOf, findSource, memoryOf, openInEditor, optimizationSystemsOf, type SourceHit, switchesOf } from './related';
import type { InspectorState } from './state';

/** THE INSPETOR'S "RELACIONADO": the switches that hide the object (flipped from here), the optimisations of its system, its draws in the GPU tab's last capture, its memory, and where in the code it is made, each place opened in the editor. */

interface OptRow { readonly id: string; readonly system: string; readonly title: string; readonly value: unknown; readonly default: unknown }

export function relatedSection(state: InspectorState, object: Object3D): HTMLElement {
  const ctx = state.ctx;
  const box = el('div');
  box.appendChild(heading('Relacionado', 'toggle'));

  // ---- the switches
  const switches = switchesOf(object);
  const settings = ctx.effects.snapshot();
  const switchList = el('div', 'insp-fields');
  for (const s of switches) {
    const on = settings[s.key];
    const row = el('div', 'insp-field');
    const b = button('', typeof on === 'boolean' ? (on ? 'ligado' : 'desligado') : '—', `Inverte o interruptor ${s.key}`, () => {
      const now = ctx.effects.snapshot()[s.key];
      if (typeof now !== 'boolean') return;
      ctx.effects.setMany({ [s.key]: !now });
      b.querySelector('span')!.textContent = !now ? 'ligado' : 'desligado';
      b.classList.toggle('on', !now);
      ctx.requestDraw();
    });
    b.classList.toggle('on', on === true);
    row.append(el('span', 'insp-field-name', s.key), b, el('span', 'lab-muted', s.why));
    switchList.appendChild(row);
  }
  if (!switches.length) switchList.appendChild(el('span', 'lab-muted', 'Nenhum interruptor de camada esconde este objeto.'));
  const toSwitches = button('toggle', 'Abrir Interruptores', 'Abre a aba dos interruptores', () => ctx.navigate('switches'));
  box.appendChild(fold(`Interruptores (${switches.length})`, true, switchList, toSwitches));

  // ---- the optimisations of its systems
  const opt = (window as unknown as { __labOpt?: { list(): OptRow[] } }).__labOpt;
  const systems = optimizationSystemsOf(switches, object);
  const rows = opt ? opt.list().filter((r) => systems.includes(r.system)) : [];
  const table = createLabTable<OptRow>({
    columns: [
      { key: 'system', label: 'Sistema', value: (r) => r.system },
      { key: 'title', label: 'Otimização', value: (r) => r.title },
      { key: 'value', label: 'Valor', value: (r) => String(r.value) },
      { key: 'changed', label: 'Mudada', value: (r) => (r.value === r.default ? '' : 'sim') },
    ],
    rows: () => rows,
    sort: { key: 'changed', desc: true },
    categoryKey: 'system',
    onRow: (r) => ctx.navigate('optimizations', { filter: r.title }),
  });
  table.refresh();
  box.appendChild(fold(`Otimizações dos seus sistemas (${rows.length})`, false, opt ? table.element : el('span', 'lab-muted', 'Aba de otimizações ausente (window.__labOpt).')));

  // ---- its draws in the last GPU capture
  const gpu = gpuDrawsOf(object);
  const gpuBox = el('div');
  if (gpu.draws.length) {
    const draws = createLabTable({
      columns: [
        { key: 'i', label: '#', value: (d: (typeof gpu.draws)[number]) => d.index },
        { key: 'pass', label: 'Passe', value: (d) => d.pass },
        { key: 'program', label: 'Programa', value: (d) => d.program },
        { key: 'tri', label: 'Triângulos', value: (d) => d.triangles },
        { key: 'inst', label: 'Instâncias', value: (d) => d.instances },
        { key: 'calls', label: 'Chamadas', value: (d) => d.calls },
        { key: 'target', label: 'Alvo', value: (d) => d.target },
      ],
      rows: () => gpu.draws,
      sort: { key: 'i', desc: false },
    });
    draws.refresh();
    gpuBox.appendChild(draws.element);
  } else {
    gpuBox.appendChild(el('p', 'lab-muted', gpu.captured ? 'Nenhuma chamada deste objeto no último quadro capturado.' : 'Nenhum quadro capturado ainda: capture um na aba Quadro da GPU e selecione de novo.'));
  }
  gpuBox.appendChild(button('camera', 'Capturar na aba GPU', 'Abre a captura de quadro da GPU', () => ctx.navigate('gpu-frame')));
  box.appendChild(fold(`Chamadas de desenho na última captura (${gpu.draws.length})`, gpu.draws.length > 0, gpuBox));

  // ---- its memory
  try {
    const uniformsOf = (material: object): Record<string, { value: unknown }> | undefined =>
      (ctx.scene.gl.properties.get(material as Material) as { uniforms?: Record<string, { value: unknown }> } | undefined)?.uniforms;
    const mem = memoryOf(object, uniformsOf);
    box.appendChild(fold('Memória (o objeto e sua subárvore)', false, kv([
      ['geometria na GPU', bytes(mem.geometryBytes)], ['geometria ainda na CPU', bytes(mem.geometryCpuBytes)], ['buffers', mem.buffers], ['buffers liberados da CPU', mem.releasedBuffers],
      ['texturas', `${mem.textures} · ${bytes(mem.textureBytes)}`],
    ])));
  } catch (error) {
    console.warn('lab inspector: memory count failed', error);
  }

  // ---- the code that makes it
  const names = [...new Set([object.name, object.parent?.name ?? ''].filter((n) => n && n.length > 1))];
  const source = el('div');
  const status = el('p', 'lab-muted', names.length ? `Procurando ${names.map((n) => `"${n}"`).join(', ')} em src/…` : 'Objeto sem nome: nada a procurar.');
  source.appendChild(status);
  box.appendChild(fold('Código que o cria', true, source));
  if (names.length) void showSources(state, names, source, status);
  return box;
}

async function showSources(state: InspectorState, names: readonly string[], host: HTMLElement, status: HTMLElement): Promise<void> {
  const all: (SourceHit & { q: string })[] = [];
  for (const q of names) {
    const found = await findSource(q);
    if (typeof found === 'string') { status.textContent = found; return; }
    for (const h of found) if (!all.some((a) => a.file === h.file && a.line === h.line)) all.push({ ...h, q });
  }
  status.textContent = all.length ? `${all.length} lugar(es), do mais provável:` : 'Nenhum lugar encontrado (o nome pode ser montado de partes muito comuns).';
  const preview = el('pre', 'lab-code insp-source');
  preview.hidden = true;
  const list = el('div', 'insp-sources');
  for (const h of all.slice(0, 30)) {
    const row = el('div', 'insp-source-row');
    const where = el('button', 'insp-link', `${h.file}:${h.line}`);
    where.type = 'button';
    where.title = 'Mostrar as linhas em volta';
    where.onclick = () => {
      preview.hidden = false;
      preview.textContent = h.context.split('\n').map((line, i) => `${String(h.start + i).padStart(5)}${h.start + i === h.line ? ' ▶ ' : '   '}${line}`).join('\n');
    };
    const open = button('code', 'abrir no editor', `Abre ${h.file}:${h.line} no editor (Vite /__open-in-editor)`, () => openInEditor(h.file, h.line));
    const code = button('', 'Código', 'Mostra este arquivo no perfilador de código (aba Código)', () => state.ctx.navigate('code', { filter: h.file.split('/').pop() ?? h.file }));
    row.append(where, el('span', 'lab-muted', ` ${h.how} · "${h.q}"`), open, code, el('code', 'insp-source-text', h.text));
    list.appendChild(row);
  }
  host.append(list, preview);
}
