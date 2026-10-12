import type { RoadProfileSpec } from '@world/roads/profile';

/**
 * A ready road seen FROM ABOVE, as the game draws it: footways in their
 * paving, the kerb line, asphalt (or concrete, or cobbles), lane lines -
 * dashed white between lanes of one direction, double yellow between the two
 * directions - a red bus lane, a green cycle lane, parked cars in their bays,
 * a grass median with trees, arrows on a one-way road. The road catalogue's
 * tiles (the player, 2026-10-09: the cards with little cars and figures were
 * "horrível"), as the old class gallery's plan-view swatches were
 * (`ui/roadSwatch.ts`): at tile size a plan says what the road IS.
 *
 * Each road fills most of its tile (a wider one a little more, `span` the
 * widest offered); the width in metres is written under it. Drawn once per
 * profile and size, kept as a data URL.
 */

const CACHE = new Map<string, string>();

const GRASS = ['#55753f', '#476536'];
const FOOTWAY: Record<string, string> = { pavers: '#c4c0b4', concrete: '#bdbdb7', stone: '#a9a294' };
const ASPHALT: Record<string, string> = { asphalt: '#3f4245', concrete: '#9a9a94', cobble: '#7d7468' };
const KERB = '#e4e1d8';
const WHITE = '#f2f2ee';
const YELLOW = '#e8c440';
const BUS = '#8f3a33';
const CYCLE = '#3f8f55';
const MEDIAN_GRASS = '#5e8a46';
const CARS = ['#c8ccd0', '#2f4f7a', '#b8382e', '#e8e4dc', '#3d3d3d', '#7a8f4f'];

export function profileSwatch(profile: RoadProfileSpec, span: number, width = 112, height = 64, dpr = 2): string {
  const key = `${JSON.stringify(profile)}|${span}|${width}x${height}@${dpr}`;
  const hit = CACHE.get(key);
  if (hit !== undefined) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.scale(dpr, dpr);
  const g = ctx.createLinearGradient(0, 0, 0, height);
  g.addColorStop(0, GRASS[0]!);
  g.addColorStop(1, GRASS[1]!);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);

  const total = profile.elements.reduce((s, e) => s + e.width, 0);
  // Each road fills most of its tile, a narrow one a little less (between
  // 62% and 86% of the height by its width against the widest): at one scale
  // for all, a street was a thread across a field of grass.
  const fill = 0.62 + 0.24 * Math.min(1, total / Math.max(span, 1e-6));
  const scale = (height * fill) / Math.max(total, 1e-6);
  let y = (height - total * scale) / 2;
  const road = ASPHALT[profile.carriageway ?? 'asphalt'] ?? ASPHALT['asphalt']!;
  const els = profile.elements;
  const lanesFwd = els.filter((e) => e.kind === 'lane' && e.dir === 'forward').length;
  const lanesBack = els.filter((e) => e.kind === 'lane' && e.dir === 'backward').length;
  const oneWay = !lanesFwd || !lanesBack;
  const bands: { kind: string; y0: number; y1: number; dir?: string }[] = [];
  for (const e of els) {
    const h = e.width * scale;
    const y0 = y, y1 = y + h;
    switch (e.kind) {
      case 'footway': {
        ctx.fillStyle = FOOTWAY[e.material ?? 'pavers'] ?? FOOTWAY['pavers']!;
        ctx.fillRect(0, y0, width, h);
        // Paving joints across it, faint.
        ctx.fillStyle = 'rgba(0,0,0,0.08)';
        for (let x = 3; x < width; x += 6) ctx.fillRect(x, y0, 0.6, h);
        break;
      }
      case 'median': {
        ctx.fillStyle = e.material === 'concrete' ? '#a8a69e' : e.material === 'pavers' ? '#b6b0a2' : MEDIAN_GRASS;
        ctx.fillRect(0, y0, width, h);
        if ((e.material ?? 'grass') === 'grass' && h >= 3) {
          for (let x = 8; x < width; x += 18) {
            ctx.fillStyle = '#2f5a2a';
            ctx.beginPath();
            ctx.arc(x, (y0 + y1) / 2, Math.min(h * 0.9, 5), 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = '#4f8a3f';
            ctx.beginPath();
            ctx.arc(x - 1, (y0 + y1) / 2 - 1, Math.min(h * 0.55, 3), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }
      case 'cycle':
        ctx.fillStyle = CYCLE;
        ctx.fillRect(0, y0, width, h);
        break;
      case 'parking':
        ctx.fillStyle = road;
        ctx.fillRect(0, y0, width, h);
        ctx.fillStyle = WHITE;
        for (let x = 0; x < width; x += 14) ctx.fillRect(x, y0, 0.8, h);
        for (let x = 2, k = 0; x + 10 < width; x += 14, k++) {
          if ((k * 7) % 3 === 2) continue;
          ctx.fillStyle = CARS[k % CARS.length]!;
          ctx.fillRect(x + 1, y0 + h * 0.18, 9, h * 0.64);
          ctx.fillStyle = 'rgba(20,30,40,0.55)';
          ctx.fillRect(x + 3, y0 + h * 0.24, 2.5, h * 0.52);
        }
        break;
      case 'lane':
        ctx.fillStyle = e.use === 'bus' ? BUS : road;
        ctx.fillRect(0, y0, width, h);
        break;
    }
    bands.push({ kind: e.kind, y0, y1, ...(e.kind === 'lane' ? { dir: e.dir } : {}) });
    y = y1;
  }
  // Kerbs: a pale line where a footway or median meets the road.
  ctx.fillStyle = KERB;
  for (let i = 0; i + 1 < bands.length; i++) {
    const a = bands[i]!, b = bands[i + 1]!;
    const edge = (k: string): boolean => k === 'footway' || k === 'median';
    if (edge(a.kind) !== edge(b.kind)) ctx.fillRect(0, a.y1 - 0.5, width, 1);
  }
  // Lane lines between neighbouring lanes (and a lane beside a cycle track).
  for (let i = 0; i + 1 < bands.length; i++) {
    const a = bands[i]!, b = bands[i + 1]!;
    if (a.kind !== 'lane' || b.kind !== 'lane') continue;
    const yy = a.y1;
    if (a.dir !== b.dir) {
      ctx.fillStyle = YELLOW;
      ctx.fillRect(0, yy - 1.4, width, 0.9);
      ctx.fillRect(0, yy + 0.5, width, 0.9);
    } else {
      const solid = (profile.elements[i] as { line?: string }).line === 'solid';
      ctx.fillStyle = WHITE;
      if (solid) ctx.fillRect(0, yy - 0.5, width, 1);
      else for (let x = 2; x < width; x += 10) ctx.fillRect(x, yy - 0.5, 5, 1);
    }
  }
  // Arrows on a one-way road, one per lane, so the tile says "mão única".
  if (oneWay) {
    ctx.fillStyle = WHITE;
    for (const b of bands) {
      if (b.kind !== 'lane') continue;
      const cy = (b.y0 + b.y1) / 2, s = Math.min(3, (b.y1 - b.y0) * 0.35);
      const back = b.dir === 'backward';
      for (const x of [width * 0.3, width * 0.72]) {
        ctx.beginPath();
        ctx.moveTo(x + (back ? -s * 1.6 : s * 1.6), cy);
        ctx.lineTo(x + (back ? s : -s), cy - s);
        ctx.lineTo(x + (back ? s : -s), cy + s);
        ctx.closePath();
        ctx.fill();
      }
    }
  }
  const url = canvas.toDataURL('image/png');
  CACHE.set(key, url);
  return url;
}
