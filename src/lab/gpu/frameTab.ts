import type { LabTab } from '../labTypes';
import { createLabTable, type LabTable } from '../table';
import { aggregate, PASS_LABELS, type AggregateRow, type GpuLab } from './controller';
import type { DrawRecord } from './probe';
import { button, el, filterOf } from './dom';

/** THE "QUADRO" TAB: one frame's every draw call (`renderer.renderBufferDirect`, the shadow maps' and the passes' quads too), and the same draws grouped by layer, material, program, pass or target. */

const GROUPS: readonly { readonly id: string; readonly label: string; key(r: DrawRecord): string }[] = [
  { id: 'layer', label: 'camada', key: (r) => r.layer },
  { id: 'material', label: 'material', key: (r) => `${r.material}${r.materialName ? ` · ${r.materialName}` : ''}` },
  { id: 'program', label: 'programa', key: (r) => r.program },
  { id: 'pass', label: 'passe', key: (r) => PASS_LABELS[r.pass] ?? r.pass },
  { id: 'target', label: 'alvo', key: (r) => r.target },
  { id: 'kind', label: 'tipo de malha', key: (r) => r.kind },
];

export function createFrameTab(lab: GpuLab): LabTab {
  const root = el('div');
  const totals = el('div', 'lab-muted', 'Nenhum quadro capturado.');
  const go = button('Capturar quadro', 'Registra cada chamada de desenho do próximo quadro', () => {
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
        { key: 'draws', label: 'desenhos', value: (r) => r.draws },
        { key: 'triangles', label: 'triângulos', value: (r) => r.triangles, bar: true },
        { key: 'vertices', label: 'vértices', value: (r) => r.vertices },
        { key: 'instances', label: 'instâncias', value: (r) => r.instances },
        { key: 'programs', label: 'programas', value: (r) => r.programs.size },
        { key: 'materials', label: 'materiais', value: (r) => r.materials.size },
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
  const yes = (v: boolean): string => (v ? 'sim' : 'não');
  const draws = createLabTable<DrawRecord>({
    columns: [
      { key: 'index', label: '#', value: (r) => r.index },
      { key: 'name', label: 'Objeto', value: (r) => r.name },
      { key: 'layer', label: 'Camada', value: (r) => r.layer },
      { key: 'path', label: 'Caminho', value: (r) => r.path },
      { key: 'kind', label: 'Tipo', value: (r) => r.kind },
      { key: 'instances', label: 'inst.', value: (r) => r.instances },
      { key: 'triangles', label: 'triâng.', value: (r) => r.triangles, bar: true },
      { key: 'vertices', label: 'vért.', value: (r) => r.vertices },
      { key: 'material', label: 'Material', value: (r) => r.material },
      { key: 'materialName', label: 'Nome mat.', value: (r) => r.materialName },
      { key: 'program', label: 'Programa', value: (r) => r.program },
      { key: 'programKey', label: 'Chave', value: (r) => r.programKey, title: 'FNV-1a da cacheKey do programa' },
      { key: 'pass', label: 'Passe', value: (r) => PASS_LABELS[r.pass] ?? r.pass },
      { key: 'target', label: 'Alvo', value: (r) => r.target },
      { key: 'transparent', label: 'transp.', value: (r) => yes(r.transparent) },
      { key: 'depthWrite', label: 'escreve prof.', value: (r) => yes(r.depthWrite) },
      { key: 'side', label: 'face', value: (r) => r.side },
      { key: 'lines', label: 'linhas', value: (r) => r.lines },
      { key: 'points', label: 'pontos', value: (r) => r.points },
    ],
    rows: () => lab.lastCapture?.records ?? [],
    sort: { key: 'index', desc: false },
    categoryKey: 'pass',
  });

  root.append(el('h3', '', 'Captura de quadro'), row(go, totals), row(el('span', '', 'Agrupar por'), pick), groupHost, el('h3', '', 'Cada desenho'), draws.element);
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
      totals.textContent = `${r.length} desenhos (${sum((d) => d.calls)} chamadas) · ${Math.round(sum((d) => d.triangles)).toLocaleString('pt-BR')} triângulos · ${programs} programas · ${materials} materiais · ${capture.targets.length} alvos · há ${((performance.now() - capture.t) / 1000).toFixed(0)} s`;
    }
    grouped?.refresh();
    draws.refresh();
  }

  return {
    id: 'gpu-frame',
    title: 'Quadro',
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
