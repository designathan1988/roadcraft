import type { Material, Object3D } from 'three';
import { createLabTable } from '../table';
import { button, bytes, el, fold, heading, kv } from './dom';
import { gpuDrawsOf, findSource, memoryOf, openInEditor, optimizationSystemsOf, type SourceHit, switchesOf } from './related';
import type { InspectorState } from './state';

/** THE INSPECTOR'S "RELATED": the switches that hide the object (flipped from here), the optimisations of its system, its draws in the GPU tab's last capture, its memory, and where in the code it is made, each place opened in the editor. */

interface OptRow { readonly id: string; readonly system: string; readonly title: string; readonly value: unknown; readonly default: unknown }

export function relatedSection(state: InspectorState, object: Object3D): HTMLElement {
  const ctx = state.ctx;
  const box = el('div');
  box.appendChild(heading('Related', 'toggle'));

  // ---- the switches
  const switches = switchesOf(object);
  const settings = ctx.effects.snapshot();
  const switchList = el('div', 'insp-fields');
  for (const s of switches) {
    const on = settings[s.key];
    const row = el('div', 'insp-field');
    const b = button('', typeof on === 'boolean' ? (on ? 'on' : 'off') : '—', `Flips the ${s.key} switch`, () => {
      const now = ctx.effects.snapshot()[s.key];
      if (typeof now !== 'boolean') return;
      ctx.effects.setMany({ [s.key]: !now });
      b.querySelector('span')!.textContent = !now ? 'on' : 'off';
      b.classList.toggle('on', !now);
      ctx.requestDraw();
    });
    b.classList.toggle('on', on === true);
    row.append(el('span', 'insp-field-name', s.key), b, el('span', 'lab-muted', s.why));
    switchList.appendChild(row);
  }
  if (!switches.length) switchList.appendChild(el('span', 'lab-muted', 'No layer switch hides this object.'));
  const toSwitches = button('toggle', 'Open Switches', 'Opens the switches tab', () => ctx.navigate('switches'));
  box.appendChild(fold(`Switches (${switches.length})`, true, switchList, toSwitches));

  // ---- the optimisations of its systems
  const opt = (window as unknown as { __labOpt?: { list(): OptRow[] } }).__labOpt;
  const systems = optimizationSystemsOf(switches, object);
  const rows = opt ? opt.list().filter((r) => systems.includes(r.system)) : [];
  const table = createLabTable<OptRow>({
    columns: [
      { key: 'system', label: 'System', value: (r) => r.system },
      { key: 'title', label: 'Optimization', value: (r) => r.title },
      { key: 'value', label: 'Value', value: (r) => String(r.value) },
      { key: 'changed', label: 'Changed', value: (r) => (r.value === r.default ? '' : 'yes') },
    ],
    rows: () => rows,
    sort: { key: 'changed', desc: true },
    categoryKey: 'system',
    onRow: (r) => ctx.navigate('optimizations', { filter: r.title }),
  });
  table.refresh();
  box.appendChild(fold(`Optimizations of its systems (${rows.length})`, false, opt ? table.element : el('span', 'lab-muted', 'Optimizations tab missing (window.__labOpt).')));

  // ---- its draws in the last GPU capture
  const gpu = gpuDrawsOf(object);
  const gpuBox = el('div');
  if (gpu.draws.length) {
    const draws = createLabTable({
      columns: [
        { key: 'i', label: '#', value: (d: (typeof gpu.draws)[number]) => d.index },
        { key: 'pass', label: 'Pass', value: (d) => d.pass },
        { key: 'program', label: 'Program', value: (d) => d.program },
        { key: 'tri', label: 'Triangles', value: (d) => d.triangles },
        { key: 'inst', label: 'Instances', value: (d) => d.instances },
        { key: 'calls', label: 'Calls', value: (d) => d.calls },
        { key: 'target', label: 'Target', value: (d) => d.target },
      ],
      rows: () => gpu.draws,
      sort: { key: 'i', desc: false },
    });
    draws.refresh();
    gpuBox.appendChild(draws.element);
  } else {
    gpuBox.appendChild(el('p', 'lab-muted', gpu.captured ? 'No draw calls of this object in the last captured frame.' : 'No frame captured yet: capture one in the GPU Frame tab and select again.'));
  }
  gpuBox.appendChild(button('camera', 'Capture in GPU tab', 'Opens the GPU frame capture', () => ctx.navigate('gpu-frame')));
  box.appendChild(fold(`Draw calls in the last capture (${gpu.draws.length})`, gpu.draws.length > 0, gpuBox));

  // ---- its memory
  try {
    const uniformsOf = (material: object): Record<string, { value: unknown }> | undefined =>
      (ctx.scene.gl.properties.get(material as Material) as { uniforms?: Record<string, { value: unknown }> } | undefined)?.uniforms;
    const mem = memoryOf(object, uniformsOf);
    box.appendChild(fold('Memory (the object and its subtree)', false, kv([
      ['geometry on the GPU', bytes(mem.geometryBytes)], ['geometry still on the CPU', bytes(mem.geometryCpuBytes)], ['buffers', mem.buffers], ['buffers released from the CPU', mem.releasedBuffers],
      ['textures', `${mem.textures} · ${bytes(mem.textureBytes)}`],
    ])));
  } catch (error) {
    console.warn('lab inspector: memory count failed', error);
  }

  // ---- the code that makes it
  const names = [...new Set([object.name, object.parent?.name ?? ''].filter((n) => n && n.length > 1))];
  const source = el('div');
  const status = el('p', 'lab-muted', names.length ? `Searching for ${names.map((n) => `"${n}"`).join(', ')} in src/…` : 'Unnamed object: nothing to search for.');
  source.appendChild(status);
  box.appendChild(fold('Code that creates it', true, source));
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
  status.textContent = all.length ? `${all.length} place(s), most likely first:` : 'No place found (the name may be built from very common parts).';
  const preview = el('pre', 'lab-code insp-source');
  preview.hidden = true;
  const list = el('div', 'insp-sources');
  for (const h of all.slice(0, 30)) {
    const row = el('div', 'insp-source-row');
    const where = el('button', 'insp-link', `${h.file}:${h.line}`);
    where.type = 'button';
    where.title = 'Show the surrounding lines';
    where.onclick = () => {
      preview.hidden = false;
      preview.textContent = h.context.split('\n').map((line, i) => `${String(h.start + i).padStart(5)}${h.start + i === h.line ? ' ▶ ' : '   '}${line}`).join('\n');
    };
    const open = button('code', 'open in editor', `Opens ${h.file}:${h.line} in the editor (Vite /__open-in-editor)`, () => openInEditor(h.file, h.line));
    const code = button('', 'Code', 'Shows this file in the code profiler (Code tab)', () => state.ctx.navigate('code', { filter: h.file.split('/').pop() ?? h.file }));
    row.append(where, el('span', 'lab-muted', ` ${h.how} · "${h.q}"`), open, code, el('code', 'insp-source-text', h.text));
    list.appendChild(row);
  }
  host.append(list, preview);
}
