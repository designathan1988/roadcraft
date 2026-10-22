import type { LabTab } from '../labTypes';
import { createLabTable } from '../table';
import { PASS_LABELS, PASS_ORDER, type GpuLab, type PassRow } from './controller';
import { DEBUG_VIEWS } from './views';
import { button, el, ms, PASS_COLOURS } from './dom';

/** THE "GPU" TAB: the GPU time of each pass (avg/p95/max and the frames as stacked bars), the debug views, and the draws by layer live. */

const BAR_FRAMES = 160;

export function createPassesTab(lab: GpuLab): LabTab {
  const root = el('div');
  /** What this tab switched on when shown, switched off again when left. */
  let startedTiming = false, startedLayers = false;
  const timing = button('Time per pass', 'Times each pass with GPU timer queries, one after another; the whole-frame timer is paused and the game redraws nonstop while on', () => {
    lab.setPassTiming(!lab.passTiming);
    draw();
  });
  const status = el('span', 'lab-muted');
  const table = createLabTable<PassRow>({
    columns: [
      { key: 'label', label: 'Pass', value: (r) => r.label },
      { key: 'avg', label: 'avg ms', value: (r) => r.avg, format: ms, bar: true },
      { key: 'p95', label: 'p95 ms', value: (r) => r.p95, format: ms, bar: true },
      { key: 'max', label: 'max ms', value: (r) => r.max, format: ms },
      { key: 'share', label: '%', value: (r) => r.share, format: (v) => v.toFixed(1), title: 'Share of the summed averages' },
      { key: 'frames', label: 'frames', value: (r) => r.frames, title: 'Frames in which the pass was drawn' },
    ],
    rows: () => lab.passRows(),
    sort: { key: 'avg', desc: true },
  });
  const canvas = el('canvas');
  canvas.width = 520;
  canvas.height = 120;
  canvas.style.cssText = 'width:100%;height:120px;background:var(--lab-bg3);border-radius:6px;display:block';
  const legend = el('div', 'lab-row');
  for (const pass of PASS_ORDER) {
    const s = el('span', '', PASS_LABELS[pass]);
    s.style.cssText = `border-left:10px solid ${PASS_COLOURS[pass]};padding-left:4px`;
    legend.appendChild(s);
  }

  const viewButtons = DEBUG_VIEWS.map((v) => {
    const b = button(v.label, v.title, () => { lab.views.set(v.id); draw(); });
    b.dataset['view'] = v.id;
    return b;
  });

  const live = button('Count by layer', 'Counts the draws and triangles of each frame by the top-level group of the scene', () => {
    lab.setLiveLayers(!lab.liveLayers);
    draw();
  });
  const layers = createLabTable<{ layer: string; calls: number; triangles: number }>({
    columns: [
      { key: 'layer', label: 'Layer', value: (r) => r.layer },
      { key: 'calls', label: 'draws', value: (r) => r.calls },
      { key: 'triangles', label: 'triangles', value: (r) => r.triangles, bar: true },
    ],
    rows: () => lab.layerRows(),
    sort: { key: 'triangles', desc: true },
  });

  root.append(
    el('h3', '', 'GPU time per pass'),
    wrapRow(timing, status),
    table.element,
    legend,
    canvas,
    el('h3', '', 'Debug views'),
    wrapRow(...viewButtons),
    el('div', 'lab-muted', 'Overdraw, wireframe and normals change the material of each object in the scene pass (the object vertex code kept); UV and mips put one material over the whole scene. Shadows and the chain passes keep running.'),
    el('h3', '', 'Draws by layer (live)'),
    wrapRow(live),
    layers.element,
  );

  function wrapRow(...children: HTMLElement[]): HTMLElement {
    const row = el('div', 'lab-row');
    row.append(...children);
    return row;
  }

  function drawBars(): void {
    const g = canvas.getContext('2d');
    if (!g) return;
    const frames = lab.passFrames().slice(-BAR_FRAMES);
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!frames.length) return;
    const totals = frames.map((f) => [...f.values()].reduce((a, b) => a + b, 0));
    const top = Math.max(1, ...totals) * 1.05;
    const w = canvas.width / BAR_FRAMES;
    // The newest at the right.
    const from = BAR_FRAMES - frames.length;
    frames.forEach((f, n) => {
      const i = from + n;
      let y = canvas.height;
      const keys = [...PASS_ORDER, ...[...f.keys()].filter((k) => !PASS_ORDER.includes(k))];
      for (const pass of keys) {
        const v = f.get(pass);
        if (!v) continue;
        const h = (v / top) * canvas.height;
        g.fillStyle = PASS_COLOURS[pass] ?? '#ccc';
        g.fillRect(i * w, y - h, Math.max(1, w - 1), h);
        y -= h;
      }
    });
    g.fillStyle = '#c9d6db';
    g.font = '11px sans-serif';
    g.fillText(`${top.toFixed(2)} ms`, 4, 12);
  }

  function draw(): void {
    timing.classList.toggle('on', lab.passTiming);
    live.classList.toggle('on', lab.liveLayers);
    for (const b of viewButtons) b.classList.toggle('on', b.dataset['view'] === lab.views.current);
    const t = lab.timer;
    if (!lab.ctx.scene.gpu.supported) { status.textContent = 'no EXT_disjoint_timer_query_webgl2: cannot measure'; timing.disabled = true; }
    else status.textContent = t ? `${lab.ctx.scene.opening ? 'the game is still opening (the chain does not draw) · ' : ''}${t.frames.length} frames measured · ${t.skipped} segments without a query · ${t.disjoint} frames dropped (disjoint)` : 'off (the whole-frame timer measures)';
    table.refresh();
    layers.refresh();
    drawBars();
  }

  return {
    id: 'gpu',
    title: 'GPU',
    mount(host) {
      host.appendChild(root);
      // Shown, it measures at once (nothing to switch on to see something): the passes timed and the layers counted while the tab is open.
      if (lab.ctx.scene.gpu.supported && !lab.passTiming) { lab.setPassTiming(true); startedTiming = true; }
      if (!lab.liveLayers) { lab.setLiveLayers(true); startedLayers = true; }
      draw();
    },
    unmount() {
      if (startedTiming) lab.setPassTiming(false);
      if (startedLayers) lab.setLiveLayers(false);
      startedTiming = startedLayers = false;
    },
    refresh: draw,
    focus(params) {
      // `{ filter }` (a pass or a layer), `{ view }` a debug view, `{ timing: 'on' }` the per-pass mode.
      if (params['filter'] !== undefined) { table.setFilter({ text: params['filter'] }); layers.setFilter({ text: params['filter'] }); }
      const view = DEBUG_VIEWS.find((v) => v.id === params['view']);
      if (view) lab.views.set(view.id);
      if (params['timing'] !== undefined) lab.setPassTiming(params['timing'] === 'on');
      draw();
    },
  };
}
