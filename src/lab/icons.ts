/** THE LAB'S ICONS: line drawings on a 24-unit grid, stroked in the text's colour (no font, no package). */

const PATHS: Readonly<Record<string, string>> = {
  gauge: 'M12 14l4-4 M3.3 18a10 10 0 1 1 17.4 0 M7 18h10',
  toggle: 'M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7z M16 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0',
  zap: 'M13 2L4 14h7l-1 8 9-12h-7z',
  bars: 'M4 20V10 M10 20V4 M16 20v-7 M22 20H2',
  code: 'M8 7l-5 5 5 5 M16 7l5 5-5 5 M14 4l-4 16',
  coverage: 'M4 4h16v16H4z M8 12l3 3 5-6',
  chip: 'M7 7h10v10H7z M10 10h4v4h-4z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4',
  camera: 'M3 8h4l2-3h6l2 3h4v11H3z M12 13m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0',
  boxes: 'M3 7l5-3 5 3v6l-5 3-5-3z M13 13l4-2.5 4 2.5v5l-4 2.5-4-2.5z',
  info: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0 M12 11v6 M12 7.5v.5',
  record: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M12 12m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0',
  flask: 'M9 3h6 M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3 M7 15h10',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
  crosshair: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0 M12 2v5 M12 17v5 M2 12h5 M17 12h5',
  terminal: 'M4 5h16v14H4z M7 10l3 2-3 2 M12 15h5',
  sliders: 'M4 6h10 M18 6h2 M16 4v4 M4 12h4 M12 12h8 M10 10v4 M4 18h12 M20 18h0 M18 16v4',
  tree: 'M5 4h5v5H5z M14 15h5v5h-5z M7.5 9v8.5H14 M14 7h5',
  memory: 'M4 8h16v8H4z M7 8V5 M11 8V5 M15 8V5 M7 16v3 M11 16v3 M15 16v3',
  close: 'M6 6l12 12 M18 6L6 18',
  left: 'M3 4h18v16H3z M9 4v16',
  right: 'M3 4h18v16H3z M15 4v16',
  center: 'M3 4h18v16H3z M7 8h10v8H7z',
  max: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5',
  mini: 'M4 18h16',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
  minus: 'M5 12h14',
  plus: 'M12 5v14 M5 12h14',
  copy: 'M8 8h12v12H8z M4 16V4h12',
  play: 'M7 4l13 8-13 8z',
  stop: 'M6 6h12v12H6z',
  pause: 'M7 5v14 M17 5v14',
  search: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0 M16 16l5 5',
  pointer: 'M5 3l14 7-6 2-2 6z',
  download: 'M12 4v11 M7 10l5 5 5-5 M4 20h16',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6 M20 4v5h-5',
};

/** The icon `name` (a blank square if unknown), `size` px. */
export function icon(name: string, size = 15): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('lab-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name] ?? 'M4 4h16v16H4z');
  svg.appendChild(path);
  return svg;
}

/** The icon a tab is shown with, by its id (or a word in it). */
export function tabIcon(id: string): string {
  const exact: Record<string, string> = {
    overview: 'gauge', switches: 'toggle', optimizations: 'zap', consumers: 'bars', code: 'code', coverage: 'coverage',
    gpu: 'chip', 'gpu-frame': 'camera', 'gpu-objects': 'boxes', 'gpu-webgl': 'info', diagnostics: 'pulse',
    inspector: 'crosshair', console: 'terminal', tweaks: 'sliders', scene: 'tree', memory: 'memory',
  };
  if (exact[id]) return exact[id];
  if (/rec/.test(id)) return 'record';
  if (/test|bench|sweep/.test(id)) return 'flask';
  if (/probe/.test(id)) return 'search';
  if (/diag/.test(id)) return 'pulse';
  return 'info';
}
