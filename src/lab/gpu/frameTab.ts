import type { LabTab } from '../labTypes';
import { createLabTable, type LabTable } from '../table';
import { aggregate, PASS_LABELS, type AggregateRow, type GpuLab } from './controller';
import type { DrawRecord } from './probe';
import { button, el, filterOf } from './dom';

/** THE "FRAME" TAB: one frame's every draw call (`renderer.renderBufferDirect`, the shadow maps' and the passes' quads too), and the same draws grouped by layer, material, program, pass or target. */

const GROUPS: readonly { readonly id: string; readonly label: string; key(r: DrawRecord): string }[] = [
  { id: 'layer', label: 'layer', key: (r) => r.layer },
  { id: 'material', label: 'material', key: (r) => `${r.material}${r.materialName ? ` · ${r.materialName}` : ''}` },
  { id: 'program', label: 'program', key: (r) => r.program },
  { id: 'pass', label: 'pass', key: (r) => PASS_LABELS[r.pass] ?? r.pass },
  { id: 'target', label: 'target', key: (r) => r.target },
  { id: 'kind', label: 'mesh type', key: (r) => r.kind },
];

export function createFrameTab(lab: GpuLab): LabTab {
  const root = el('div');
  const totals = el('div', 'lab-muted', 'No frame captured.');
  const go = button('Capture frame', 'Records every draw call of the next frame', () => {
    go.disabled = true;
    void lab.capture().then(() => { go.disabled = false; drawAll(); });
  });
  let group = GROUPS[0]!;
  const pick = el('select');
  for (const g of GROUPS) pick.add(new Option(g.label, g.id));
  const groupHost = el('div');
  let grouped: LabTable | null = null;
  const makeGrouped = (): void => {
    let rows: AggregateRow[] = [];
    let at: object | null = null;
    grouped = createLabTable<AggregateRow>({
      columns: [
        { key: 'key', label: group.label, value: (r) => r.key },
        { key: 'draws', label: 'draws', value: (r) => r.draws },
        { key: 'triangles', label: 'triangles', value: (r) => r.triangles, bar: true },
        { key: 'vertices', label: 'vertices', value: (r) => r.vertices },
        { key: 'instances', label: 'instances', value: (r) => r.instances },
        { key: 'programs', label: 'programs', value: (r) => r.programs.size },
        { key: 'materials', label: 'materials', value: (r) => r.materials.size },
      ],
      rows: () => {
        const capture = lab.lastCapture;
        if (capture !== at) { at = capture; rows = capture ? aggregate(capture.records, group.key) : []; }
        return rows;
      },
      sort: { key: 'triangles', desc: true },
    });
    groupHost.replaceChildren(grouped.element);
    grouped.refresh();
  };
  pick.onchange = () => { group = GROUPS.find((g) => g.id === pick.value) ?? GROUPS[0]!; makeGrouped(); };
  const yes = (v: boolean): string => (v ? 'yes' : 'no');
  const draws = createLabTable<DrawRecord>({
    columns: [
      { key: 'index', label: '#', value: (r) => r.index },
      { key: 'name', label: 'Object', value: (r) => r.name },
      { key: 'layer', label: 'Layer', value: (r) => r.layer },
      { key: 'path', label: 'Path', value: (r) => r.path },
      { key: 'kind', label: 'Type', value: (r) => r.kind },
      { key: 'instances', label: 'inst.', value: (r) => r.instances },
      { key: 'triangles', label: 'tris', value: (r) => r.triangles, bar: true },
      { key: 'vertices', label: 'verts', value: (r) => r.vertices },
      { key: 'material', label: 'Material', value: (r) => r.material },
      { key: 'materialName', label: 'Mat. name', value: (r) => r.materialName },
      { key: 'program', label: 'Program', value: (r) => r.program },
      { key: 'programKey', label: 'Key', value: (r) => r.programKey, title: 'FNV-1a of the program cacheKey' },
      { key: 'pass', label: 'Pass', value: (r) => PASS_LABELS[r.pass] ?? r.pass },
      { key: 'target', label: 'Target', value: (r) => r.target },
      { key: 'transparent', label: 'transp.', value: (r) => yes(r.transparent) },
      { key: 'depthWrite', label: 'depth write', value: (r) => yes(r.depthWrite) },
      { key: 'side', label: 'face', value: (r) => r.side },
      { key: 'lines', label: 'lines', value: (r) => r.lines },
      { key: 'points', label: 'points', value: (r) => r.points },
    ],
    rows: () => lab.lastCapture?.records ?? [],
    sort: { key: 'index', desc: false },
    categoryKey: 'pass',
  });

  root.append(el('h3', '', 'Frame capture'), row(go, totals), row(el('span', '', 'Group by'), pick), groupHost, el('h3', '', 'Every draw'), draws.element);
  makeGrouped();

  function row(...children: HTMLElement[]): HTMLElement {
    const r = el('div', 'lab-row');
    r.append(...children);
    return r;
  }
  function drawAll(): void {
    const capture = lab.lastCapture;
    if (capture) {
      const r = capture.records;
      const sum = (f: (d: DrawRecord) => number): number => r.reduce((a, d) => a + f(d), 0);
      const programs = new Set(r.map((d) => d.programKey)).size;
      const materials = new Set(r.map((d) => `${d.material}:${d.materialName}`)).size;
      totals.textContent = `${r.length} draws (${sum((d) => d.calls)} calls) · ${Math.round(sum((d) => d.triangles)).toLocaleString('en-US')} triangles · ${programs} programs · ${materials} materials · ${capture.targets.length} targets · ${((performance.now() - capture.t) / 1000).toFixed(0)} s ago`;
    }
    grouped?.refresh();
    draws.refresh();
  }

  return {
    id: 'gpu-frame',
    title: 'Frame',
    mount(host) {
      host.appendChild(root);
      drawAll();
      // Nothing captured yet: one frame taken at once (a meter of draws clicked lands here).
      if (!lab.lastCapture && !go.disabled) go.click();
    },
    focus(params) {
      // `{ filter }` the draws' text, `{ category }` a pass (scene, shadows, smaa...), `{ group }` the grouping.
      const g = GROUPS.find((x) => x.id === params['group']);
      if (g) { pick.value = g.id; group = g; makeGrouped(); }
      draws.setFilter(filterOf(params));
      grouped?.setFilter(filterOf(params, false));
    },
  };
}
