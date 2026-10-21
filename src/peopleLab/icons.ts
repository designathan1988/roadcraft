/** THE CREATOR'S ICONS: line drawings on a 24-unit grid, stroked in the text's colour (no emoji, no picture files) */

const PATHS: Readonly<Record<string, string>> = {
  body: 'M12 4.5a2 2 0 1 0 0-.01M8 9h8l-1 6h-2l-.5 5.5h-1L11 15H9z',
  face: 'M12 3a7 8.5 0 1 0 0 17a7 8.5 0 1 0 0-17M9 10.5h.01M15 10.5h.01M9.5 15c1.4 1 3.6 1 5 0',
  style: 'M12 3l1.7 4.6L18 9.3l-4.3 1.7L12 15.6l-1.7-4.6L6 9.3l4.3-1.7zM18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z',
  hair: 'M5 18c0-9 3-14 7-14s7 5 7 14M8.5 18c0-6 1.5-10 3.5-10s3.5 4 3.5 10M12 8v12',
  cloth: 'M8 4l-4 3 2 3 2-1v11h8V9l2 1 2-3-4-3c-.5 1.5-2 2.5-4 2.5S8.5 5.5 8 4z',
  drama: 'M4 6c3-2 6-2 8 0v6c0 3-2 5-4 5s-4-2-4-5zM12 8c2-2 5-2 8 0v5c0 3-2 5-4 5M6.5 10h.01M9.5 10h.01M7 13c.6.6 1.4.6 2 0',
  pose: 'M13 4a1.6 1.6 0 1 0 0-.01M10 21l2-6-2-3 1-4 4 3 3 1M12 8l-4 2-2 3M12 15l3 2 1 4',
  sculpt: 'M14.5 4.5l5 5-9 9H5.5v-5zM13 6l5 5M4 21h16',
  bones: 'M7 4a2 2 0 1 1-2.5 2.5L5 8l11 11 1.5-.5A2 2 0 1 1 20 21a2 2 0 1 1-1-3.5L8 6.5A2 2 0 0 1 7 4z',
  anim: 'M4 6h16v12H4zM4 9h16M8 6v3M12 6v3M16 6v3M10 12l4 2-4 2z',
  save: 'M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6',
  plus: 'M12 5v14M5 12h14',
  shuffle: 'M4 7h3c4 0 6 10 10 10h3M4 17h3c1.6 0 2.8-1.6 3.8-3.5M14 9.5C15 7.8 16 7 17 7h3M18 4l2 3-2 3M18 14l2 3-2 3',
  download: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  upload: 'M12 20V9M7 14l5-5 5 5M5 4h14',
  undo: 'M9 7L5 11l4 4M5 11h9a5 5 0 0 1 0 10h-2',
  redo: 'M15 7l4 4-4 4M19 11h-9a5 5 0 0 0 0 10h2',
  play: 'M7 5l12 7-12 7z',
  stop: 'M6 6h12v12H6z',
  move: 'M12 3v18M3 12h18M12 3l-2.5 2.5M12 3l2.5 2.5M12 21l-2.5-2.5M12 21l2.5-2.5M3 12l2.5-2.5M3 12l2.5 2.5M21 12l-2.5-2.5M21 12l-2.5 2.5',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4',
  check: 'M5 12.5l4.5 4.5L19 7',
  close: 'M6 6l12 12M18 6L6 18',
  trash: 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
  key: 'M12 4l5 8-5 8-5-8z',
  scissors: 'M6 7a2 2 0 1 0 0-.01M6 17a2 2 0 1 0 0-.01M7.6 8.2L19 18M7.6 15.8L19 6',
  comb: 'M4 8h16v3H4zM6 11v8M9 11v8M12 11v8M15 11v8M18 11v8',
  grab: 'M8 11V6a1.5 1.5 0 0 1 3 0v4V4.5a1.5 1.5 0 0 1 3 0V10V6a1.5 1.5 0 0 1 3 0v7c0 4-2.5 7-6 7-3 0-4.5-2-6-5l-1.5-3a1.4 1.4 0 0 1 2.5-1.3z',
  plant: 'M12 21v-8M12 13c0-4 3-7 7-7 0 4-3 7-7 7zM12 15c0-3-2.5-5.5-6-5.5 0 3 2.5 5.5 6 5.5z',
  part: 'M12 3v18M7 7c-2 2-3 5-3 9M17 7c2 2 3 5 3 9',
  tie: 'M12 4v6M9 10h6l-1 4h-4zM10 14l-2 7M14 14l2 7',
  gravity: 'M12 4v12M7 11l5 5 5-5M5 20h14',
  wave: 'M3 12c2-4 4-4 6 0s4 4 6 0 4-4 6 0',
  smooth: 'M3 15c5-6 13-6 18 0M3 19h18',
  grow: 'M12 20V8M8 12l4-4 4 4M6 4h12',
  inflate: 'M12 4a8 8 0 1 0 0 16a8 8 0 1 0 0-16M12 8v8M8 12h8',
  flatten: 'M4 14h16M7 10h10M12 4v4',
  pinch: 'M5 5l5 5M19 5l-5 5M5 19l5-5M19 19l-5-5',
  pattern: 'M5 4h6l2 3h6v13H5zM9 11h6M9 15h4',
  sew: 'M4 20L20 4M6 14l4 4M10 10l4 4M14 6l4 4',
  sim: 'M12 3c3 4 5 7 5 10a5 5 0 0 1-10 0c0-3 2-6 5-10z',
};

/** An icon as an inline SVG element. */
export function icon(name: keyof typeof PATHS | string, size = 18): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.classList.add('icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS['key']!);
  svg.append(path);
  return svg;
}
