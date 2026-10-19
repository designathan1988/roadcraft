import type { LabTab } from '../labTypes';
import { createLabTable } from '../table';
import type { GpuLab } from './controller';
import type { GeometryRow, TargetRow, TextureRow } from './memory';
import type { ProgramRow } from './programs';
import { readCapabilities, type CapRow } from './caps';
import { button, bytes, el, filterOf } from './dom';

/** THE "OBJETOS GPU" TAB (the programs and the textures, targets and geometries alive) and THE "WEBGL" TAB (the context's limits, extensions and attributes, its losses). */

const age = (t: number): string => `${((performance.now() - t) / 1000).toFixed(0)} s`;

export function createObjectsTab(lab: GpuLab): LabTab {
  const root = el('div');
  const programLine = el('div', 'lab-muted');
  const growth = el('div', 'lab-code');
  const programs = createLabTable<ProgramRow>({
    columns: [
      { key: 'id', label: 'id', value: (r) => r.id },
      { key: 'name', label: 'Programa', value: (r) => r.name },
      { key: 'key', label: 'Chave', value: (r) => r.key, title: 'FNV-1a da cacheKey' },
      { key: 'usedTimes', label: 'usos', value: (r) => r.usedTimes, title: 'Materiais que usam o programa (usedTimes)' },
      { key: 'alive', label: 'vivo', value: (r) => (r.alive ? 'sim' : 'liberado') },
      { key: 'firstSeen', label: 'visto há', value: (r) => -r.firstSeen, format: (_v, r) => age(r.firstSeen) },
      { key: 'trigger', label: 'Logo depois de', value: (r) => r.trigger },
    ],
    rows: () => lab.programs.rows,
    sort: { key: 'firstSeen', desc: false },
    categoryKey: 'alive',
  });

  const memoryLine = el('div', 'lab-muted');
  const scan = button('Ler de novo', 'Percorre a cena outra vez (texturas, alvos, geometrias)', () => { lab.refreshObjects(); drawMemory(); });
  const textures = createLabTable<TextureRow>({
    columns: [
      { key: 'name', label: 'Textura', value: (r) => r.name },
      { key: 'kind', label: 'Tipo', value: (r) => r.kind },
      { key: 'size', label: 'Tamanho', value: (r) => r.size },
      { key: 'format', label: 'Formato', value: (r) => r.format },
      { key: 'mipmaps', label: 'Mips', value: (r) => r.mipmaps },
      { key: 'anisotropy', label: 'aniso', value: (r) => r.anisotropy },
      { key: 'bytes', label: 'bytes (est.)', value: (r) => r.bytes, format: (v) => bytes(v), bar: true },
      { key: 'users', label: 'usos', value: (r) => r.users },
      { key: 'uploaded', label: 'na GPU', value: (r) => (r.uploaded ? 'sim' : 'não') },
    ],
    rows: () => lab.objects().textures,
    sort: { key: 'bytes', desc: true },
    categoryKey: 'kind',
  });
  const targets = createLabTable<TargetRow>({
    columns: [
      { key: 'name', label: 'Alvo', value: (r) => r.name },
      { key: 'size', label: 'Tamanho', value: (r) => r.size },
      { key: 'samples', label: 'MSAA', value: (r) => r.samples },
      { key: 'textures', label: 'texturas', value: (r) => r.textures },
      { key: 'depth', label: 'Profundidade', value: (r) => r.depth },
      { key: 'bytes', label: 'bytes (est.)', value: (r) => r.bytes, format: (v) => bytes(v), bar: true },
      { key: 'live', label: 'na GPU', value: (r) => (r.live ? 'sim' : 'não') },
    ],
    rows: () => lab.objects().targets,
    sort: { key: 'bytes', desc: true },
  });
  const geometries = createLabTable<GeometryRow>({
    columns: [
      { key: 'holder', label: 'Objeto', value: (r) => r.holder },
      { key: 'name', label: 'Geometria', value: (r) => r.name },
      { key: 'attributes', label: 'atributos', value: (r) => r.attributes },
      { key: 'vertices', label: 'vértices', value: (r) => r.vertices },
      { key: 'indices', label: 'índices', value: (r) => r.indices },
      { key: 'bytes', label: 'bytes', value: (r) => r.bytes, format: (v) => bytes(v), bar: true },
      { key: 'gpuOnlyBytes', label: 'só na GPU', value: (r) => r.gpuOnlyBytes, format: (v) => bytes(v), title: 'Arrays soltos após o envio (gpuOnly)' },
      { key: 'users', label: 'usos', value: (r) => r.users },
    ],
    rows: () => lab.objects().geometries,
    sort: { key: 'bytes', desc: true },
    limit: 300,
  });

  root.append(
    el('h3', '', 'Programas'), programLine, growth, programs.element,
    el('h3', '', 'Objetos na GPU'), row(scan, memoryLine),
    el('div', 'lab-muted', 'Alvos: mapas de sombra e os alvos do último quadro capturado (aba Quadro). Tamanhos estimados, não os do driver.'),
    el('h3', '', 'Texturas'), textures.element,
    el('h3', '', 'Alvos de renderização'), targets.element,
    el('h3', '', 'Geometrias'), geometries.element,
  );
  function row(...children: HTMLElement[]): HTMLElement {
    const r = el('div', 'lab-row');
    r.append(...children);
    return r;
  }
  function drawPrograms(): void {
    const p = lab.programs;
    const live = p.rows.filter((r) => r.alive).length;
    programLine.textContent = `${live} vivos · ${p.made} novos desde a abertura · ${p.released} liberados`;
    growth.textContent = p.counts.slice(-12).map(([t, n]) => `há ${age(t).padStart(6)}  ${n} programas`).join('\n');
    programs.refresh();
  }
  function drawMemory(): void {
    const o = lab.objects();
    const sum = (list: readonly { bytes: number }[]): number => list.reduce((a, r) => a + r.bytes, 0);
    memoryLine.textContent = `${o.textures.length} texturas ${bytes(sum(o.textures))} · ${o.targets.length} alvos ${bytes(sum(o.targets))} · ${o.geometries.length} geometrias ${bytes(sum(o.geometries))}`;
    textures.refresh();
    targets.refresh();
    geometries.refresh();
  }
  return {
    id: 'gpu-objects',
    title: 'Objetos GPU',
    mount(host) { host.appendChild(root); lab.refreshObjects(); drawMemory(); drawPrograms(); },
    refresh: drawPrograms,
    focus(params) {
      // `{ filter }` every list's text (a texture's, a program's, a geometry's name).
      if (params['filter'] === undefined) return;
      for (const t of [programs, textures, targets, geometries]) t.setFilter({ text: params['filter'] });
    },
  };
}

export function createWebglTab(lab: GpuLab): LabTab {
  const root = el('div');
  const events = el('div', 'lab-muted');
  let rows: CapRow[] = [];
  const table = createLabTable<CapRow>({
    columns: [
      { key: 'group', label: 'Grupo', value: (r) => r.group },
      { key: 'name', label: 'Nome', value: (r) => r.name },
      { key: 'value', label: 'Valor', value: (r) => r.value },
    ],
    rows: () => rows,
    sort: { key: 'group', desc: false },
    categoryKey: 'group',
    limit: 1000,
  });
  root.append(el('h3', '', 'Contexto'), events, table.element);
  const draw = (): void => {
    const e = lab.contextEvents;
    events.textContent = e.length ? e.map((x) => `${x.kind} há ${age(x.t)}`).join(' · ') : 'Contexto nunca perdido desde que o laboratório começou.';
  };
  return {
    id: 'gpu-webgl',
    title: 'WebGL',
    mount(host) { rows = readCapabilities(lab.ctx.scene.gl); host.appendChild(root); draw(); table.refresh(); },
    refresh: draw,
    focus(params) { table.setFilter(filterOf(params)); },
  };
}
