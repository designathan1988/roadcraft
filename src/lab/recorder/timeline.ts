import type { Recording } from './recording';

/** THE RECORDING DRAWN: frame interval, CPU and GPU over time (each pixel column the worst of its frames), a line at every change and marker. */

const SERIES = [
  { key: 'interval', color: '#d8e2e6', label: 'intervalo' },
  { key: 'cpu', color: '#2fc2ab', label: 'CPU' },
  { key: 'gpu', color: '#ff9f43', label: 'GPU' },
] as const;

export function timelineLegend(): HTMLElement {
  const legend = document.createElement('div');
  legend.className = 'lab-row lab-muted';
  for (const s of SERIES) {
    const item = document.createElement('span');
    item.innerHTML = `<span style="display:inline-block;width:10px;height:3px;background:${s.color};vertical-align:middle"></span> ${s.label}`;
    legend.appendChild(item);
  }
  const marks = document.createElement('span');
  marks.innerHTML = '<span style="color:#ffd84a">┃</span> mudança <span style="color:#e86bff">┃</span> marcador <span style="color:#ff5d5d">▴</span> tarefa longa';
  legend.appendChild(marks);
  return legend;
}

export function drawTimeline(canvas: HTMLCanvasElement, rec: Recording | null): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(100, canvas.clientWidth), h = Math.max(60, canvas.clientHeight);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  // The lab's own panel colour (`lab.css` --lab-bg3), a dark fallback outside it.
  g.fillStyle = getComputedStyle(canvas).getPropertyValue('--lab-bg3').trim() || '#1c2830';
  g.fillRect(0, 0, w, h);
  g.font = '10px ui-monospace, Consolas, monospace';
  if (!rec || !rec.frames.t.length) {
    g.fillStyle = '#8a9ba3';
    g.fillText('Sem gravação', 8, h / 2);
    return;
  }
  const f = rec.frames;
  const span = Math.max(1, rec.endMs);
  const left = 28, plotW = w - left - 4, top = 4, plotH = h - top - 12;
  const cols = Math.max(1, Math.floor(plotW));
  const peaks = SERIES.map(() => new Float32Array(cols).fill(-1));
  let top99 = 0;
  for (let i = 0; i < f.t.length; i++) {
    const c = Math.min(cols - 1, Math.floor((f.t[i]! / span) * cols));
    const values = [f.gap[i] ? -1 : f.interval[i]!, f.cpu[i]!, f.gpu[i] ?? -1];
    for (let k = 0; k < 3; k++) if (values[k]! > peaks[k]![c]!) peaks[k]![c] = values[k]!;
    top99 = Math.max(top99, Math.min(values[0]!, 100), Math.min(values[1]!, 100));
  }
  const yMax = Math.max(20, Math.min(100, top99 * 1.1));
  const y = (v: number): number => top + plotH - (Math.min(v, yMax) / yMax) * plotH;
  // Guides: 60, 30 and 20 Hz.
  g.strokeStyle = 'rgb(255 255 255 / 0.12)';
  g.fillStyle = '#8a9ba3';
  for (const guide of [16.7, 33.3, 50]) {
    if (guide > yMax) continue;
    g.beginPath(); g.moveTo(left, y(guide)); g.lineTo(left + plotW, y(guide)); g.stroke();
    g.fillText(guide.toFixed(0), 2, y(guide) + 3);
  }
  g.lineWidth = 1;
  SERIES.forEach((s, k) => {
    g.strokeStyle = s.color;
    g.beginPath();
    let drawing = false;
    for (let c = 0; c < cols; c++) {
      const v = peaks[k]![c]!;
      if (v < 0) { drawing = false; continue; }
      if (drawing) g.lineTo(left + c, y(v)); else g.moveTo(left + c, y(v));
      drawing = true;
    }
    g.stroke();
  });
  const x = (t: number): number => left + (t / span) * plotW;
  for (const e of rec.events) {
    if (e.kind === 'longtask') {
      g.fillStyle = '#ff5d5d';
      g.fillRect(x(e.t) - 1, top + plotH + 2, 3, 6);
    } else if (e.split) {
      g.strokeStyle = e.kind === 'rec.marker' ? '#e86bff' : '#ffd84a';
      g.beginPath(); g.moveTo(x(e.t) + 0.5, top); g.lineTo(x(e.t) + 0.5, top + plotH); g.stroke();
    }
  }
  g.fillStyle = '#8a9ba3';
  g.fillText(`${(span / 1000).toFixed(1)} s`, left + plotW - 40, h - 2);
}
