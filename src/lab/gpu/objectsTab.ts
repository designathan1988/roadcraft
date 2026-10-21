import type { LabTab } from '../labTypes';
import { createLabTable } from '../table';
import type { GpuLab } from './controller';
import type { GeometryRow, TargetRow, TextureRow } from './memory';
import type { ProgramRow } from './programs';
import { readCapabilities, type CapRow } from './caps';
import { button, bytes, el, filterOf } from './dom';

/** THE "GPU OBJECTS" TAB (the programs and the textures, targets and geometries alive) and THE "WEBGL" TAB (the context's limits, extensions and attributes, its losses). */

const age = (t: number): string => `${((performance.now() - t) / 1000).toFixed(0)} s`;

export function createObjectsTab(lab: GpuLab): LabTab {
  const root = el('div');
  const programLine = el('div', 'lab-muted');
  const growth = el('div', 'lab-code');
  const programs = createLabTable<ProgramRow>({
    columns: [
      { key: 'id', label: 'id', value: (r) => r.id },
      { key: 'name', label: 'Program', value: (r) => r.name },
      { key: 'key', label: 'Key', value: (r) => r.key, title: 'FNV-1a of the cacheKey' },
      { key: 'usedTimes', label: 'uses', value: (r) => r.usedTimes, title: 'Materials using the program (usedTimes)' },
      { key: 'alive', label: 'alive', value: (r) => (r.alive ? 'yes' : 'released') },
      { key: 'firstSeen', label: 'seen', value: (r) => -r.firstSeen, format: (_v, r) => age(r.firstSeen) },
      { key: 'trigger', label: 'Right after', value: (r) => r.trigger },
    ],
    rows: () => lab.programs.rows,
    sort: { key: 'firstSeen', desc: false },
    categoryKey: 'alive',
  });

  const memoryLine = el('div', 'lab-muted');
  const scan = button('Rescan', 'Walks the scene again (textures, targets, geometries)', () => { lab.refreshObjects(); drawMemory(); });
  const textures = createLabTable<TextureRow>({
    columns: [
      { key: 'name', label: 'Texture', value: (r) => r.name },
      { key: 'kind', label: 'Type', value: (r) => r.kind },
      { key: 'size', label: 'Size', value: (r) => r.size },
      { key: 'format', label: 'Format', value: (r) => r.format },
      { key: 'mipmaps', label: 'Mips', value: (r) => r.mipmaps },
      { key: 'anisotropy', label: 'aniso', value: (r) => r.anisotropy },
      { key: 'bytes', label: 'bytes (est.)', value: (r) => r.bytes, format: (v) => bytes(v), bar: true },
      { key: 'users', label: 'uses', value: (r) => r.users },
      { key: 'uploaded', label: 'on GPU', value: (r) => (r.uploaded ? 'yes' : 'no') },
    ],
    rows: () => lab.objects().textures,
    sort: { key: 'bytes', desc: true },
    categoryKey: 'kind',
  });
  const targets = createLabTable<TargetRow>({
    columns: [
      { key: 'name', label: 'Target', value: (r) => r.name },
      { key: 'size', label: 'Size', value: (r) => r.size },
      { key: 'samples', label: 'MSAA', value: (r) => r.samples },
      { key: 'textures', label: 'textures', value: (r) => r.textures },
      { key: 'depth', label: 'Depth', value: (r) => r.depth },
      { key: 'bytes', label: 'bytes (est.)', value: (r) => r.bytes, format: (v) => bytes(v), bar: true },
      { key: 'live', label: 'on GPU', value: (r) => (r.live ? 'yes' : 'no') },
    ],
    rows: () => lab.objects().targets,
    sort: { key: 'bytes', desc: true },
  });
  const geometries = createLabTable<GeometryRow>({
    columns: [
      { key: 'holder', label: 'Object', value: (r) => r.holder },
      { key: 'name', label: 'Geometry', value: (r) => r.name },
      { key: 'attributes', label: 'attributes', value: (r) => r.attributes },
      { key: 'vertices', label: 'vertices', value: (r) => r.vertices },
      { key: 'indices', label: 'indices', value: (r) => r.indices },
      { key: 'bytes', label: 'bytes', value: (r) => r.bytes, format: (v) => bytes(v), bar: true },
      { key: 'gpuOnlyBytes', label: 'GPU only', value: (r) => r.gpuOnlyBytes, format: (v) => bytes(v), title: 'Arrays released after upload (gpuOnly)' },
      { key: 'users', label: 'uses', value: (r) => r.users },
    ],
    rows: () => lab.objects().geometries,
    sort: { key: 'bytes', desc: true },
    limit: 300,
  });

  root.append(
    el('h3', '', 'Programs'), programLine, growth, programs.element,
    el('h3', '', 'Objects on the GPU'), row(scan, memoryLine),
    el('div', 'lab-muted', 'Targets: the shadow maps and the targets of the last captured frame (Frame tab). Sizes are estimates, not the driver sizes.'),
    el('h3', '', 'Textures'), textures.element,
    el('h3', '', 'Render targets'), targets.element,
    el('h3', '', 'Geometries'), geometries.element,
  );
  function row(...children: HTMLElement[]): HTMLElement {
    const r = el('div', 'lab-row');
    r.append(...children);
    return r;
  }
  function drawPrograms(): void {
    const p = lab.programs;
    const live = p.rows.filter((r) => r.alive).length;
    programLine.textContent = `${live} alive · ${p.made} new since opening · ${p.released} released`;
    growth.textContent = p.counts.slice(-12).map(([t, n]) => `${age(t).padStart(6)} ago  ${n} programs`).join('\n');
    programs.refresh();
  }
  function drawMemory(): void {
    const o = lab.objects();
    const sum = (list: readonly { bytes: number }[]): number => list.reduce((a, r) => a + r.bytes, 0);
    memoryLine.textContent = `${o.textures.length} textures ${bytes(sum(o.textures))} · ${o.targets.length} targets ${bytes(sum(o.targets))} · ${o.geometries.length} geometries ${bytes(sum(o.geometries))}`;
    textures.refresh();
    targets.refresh();
    geometries.refresh();
  }
  return {
    id: 'gpu-objects',
    title: 'GPU objects',
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
      { key: 'group', label: 'Group', value: (r) => r.group },
      { key: 'name', label: 'Name', value: (r) => r.name },
      { key: 'value', label: 'Value', value: (r) => r.value },
    ],
    rows: () => rows,
    sort: { key: 'group', desc: false },
    categoryKey: 'group',
    limit: 1000,
  });
  root.append(el('h3', '', 'Context'), events, table.element);
  const draw = (): void => {
    const e = lab.contextEvents;
    events.textContent = e.length ? e.map((x) => `${x.kind} ${age(x.t)} ago`).join(' · ') : 'Context never lost since the lab started.';
  };
  return {
    id: 'gpu-webgl',
    title: 'WebGL',
    mount(host) { rows = readCapabilities(lab.ctx.scene.gl); host.appendChild(root); draw(); table.refresh(); },
    refresh: draw,
    focus(params) { table.setFilter(filterOf(params)); },
  };
}
