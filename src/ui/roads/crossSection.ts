import type { ProfileElement, RoadProfileSpec } from '@world/roads/profile';
import { METERS_PER_UNIT } from '@world/units';
import { formatDecimal } from '../i18n';

/**
 * A road's CROSS-SECTION drawn as a street section (docs/VIAS.md V2), the way
 * Streetmix illustrates a street (docs.streetmix.net, "Segments"): each
 * element as itself, at its width - asphalt with its lane lines and the
 * direction it runs, a car seen from behind in each lane, a raised footway
 * with its paving and somebody on it, a planted median with its tree, a
 * parked car in a bay, a cyclist on a green cycle lane - with the width of each
 * element written under it. People, cars and trees are drawn to the same
 * metre scale as the road (a car 1.8 m wide, a person 1.7 m tall), so a
 * narrow lane looks narrow.
 *
 * One SVG string, built in well under a millisecond for a road of a dozen
 * elements: the editor redraws only this picture while a width or an order
 * is dragged, never the panel round it. Each element is a group `data-index`
 * and each boundary a handle `data-edge` (between element i and i + 1).
 */
export interface SectionDrawing {
  readonly svg: string;
  /** Each element's left and right edge, in SVG pixels. */
  readonly spans: readonly (readonly [number, number])[];
  /** Pixels per world unit. */
  readonly scale: number;
}

export interface SectionOptions {
  readonly width: number;
  readonly height: number;
  readonly selected?: number;
  /** Elements with a problem (a warning badge). */
  readonly flagged?: ReadonlySet<number>;
  /** A thumbnail: no people, cars, labels or handles. */
  readonly compact?: boolean;
  /** Draw the widths under the elements (not in a thumbnail). */
  readonly labels?: boolean;
  /** Grab handles on the boundaries (default: when not compact). */
  readonly handles?: boolean;
  /** The element being dragged to a new place, drawn faded. */
  readonly dragging?: number;
  /** Pixels per unit to keep (while a width is dragged); default: fit the width. */
  readonly scale?: number;
  /** Which edge stays put when `scale` is kept: the left (default) or the right. */
  readonly anchor?: 'left' | 'right';
  /** Accessible name of the picture. */
  readonly title?: string;
}

const COLOUR = {
  asphalt: '#3a3f44', concrete: '#8d8c86', cobble: '#6b5f52',
  pavers: '#a39f95', footConcrete: '#b8b6ae', stone: '#b59b77',
  kerb: '#dedbd3', grass: '#4f7d43', earth: '#2a2420', earthLine: '#3a322c',
  white: '#f2efe6', yellow: '#e5c14c', cycle: '#3f8f57', bus: '#7a3a34', accent: '#4fe0bf', danger: '#ff6f61',
} as const;

/** The row of signs (a lane's arrow, the P, the bicycle), clear of the end labels. */
const ICON_Y = 36;

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const r1 = (v: number): number => Math.round(v * 10) / 10;

/** A width in metres as the panels write it: whole metres plain, else one decimal in the interface language's notation. */
export function metresText(units: number): string {
  const v = units * METERS_PER_UNIT;
  return Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : formatDecimal(v, 1);
}

export function drawSection(profile: RoadProfileSpec, options: SectionOptions): SectionDrawing {
  const { width, height } = options;
  const compact = options.compact === true;
  const labels = options.labels !== false && !compact;
  const handles = options.handles ?? !compact;
  const pad = compact ? 3 : 12;
  const total = Math.max(1e-6, profile.elements.reduce((sum, e) => sum + e.width, 0));
  const scale = options.scale ?? (width - pad * 2) / total;
  const ppm = scale / METERS_PER_UNIT;
  // The road surface line; raised elements stand `rise` above it.
  // The depth of the road slab drawn under its surface, so its paving reads.
  const depth = compact ? 4 : 12;
  const base = compact ? Math.round(height * 0.66) : height - depth - (labels ? 30 : 4);
  const rise = compact ? 3 : Math.max(5, Math.min(9, 0.15 * ppm));
  // Room above the road for what stands on it.
  const headroom = base - (compact ? 4 : 30);
  const parts: string[] = [];
  const spans: [number, number][] = [];
  let x = options.scale !== undefined && options.anchor === 'right' ? width - pad - total * scale : pad;
  for (const e of profile.elements) {
    spans.push([r1(x), r1(x + e.width * scale)]);
    x += e.width * scale;
  }
  // The ground under the whole road, with a darker line at the surface.
  parts.push(`<rect x="0" y="${base}" width="${width}" height="${height - base}" fill="${COLOUR.earth}"/>`);
  parts.push(`<rect x="0" y="${base + depth}" width="${width}" height="1" fill="${COLOUR.earthLine}"/>`);
  profile.elements.forEach((e, i) => {
    const [x0, x1] = spans[i]!;
    const w = x1 - x0;
    const top = raised(e) ? base - rise : base;
    const g: string[] = [];
    // The whole column above the element picks it (not only its slab): the air over a lane is the lane.
    if (handles) g.push(`<rect class="xs-hit" x="${x0}" y="0" width="${r1(w)}" height="${base + depth}" fill="transparent"/>`);
    // The slab: the surface and a band of its depth.
    g.push(`<rect x="${x0}" y="${r1(top)}" width="${r1(w)}" height="${r1(base - top + depth)}" fill="${surface(e, profile)}"/>`);
    if (raised(e)) {
      // The kerb: a light edge where the heights differ.
      const prev = profile.elements[i - 1], next = profile.elements[i + 1];
      const kw = Math.min(compact ? 1.5 : 3, w);
      if (prev && !raised(prev)) g.push(`<rect x="${x0}" y="${r1(top)}" width="${kw}" height="${r1(rise + 1)}" fill="${COLOUR.kerb}"/>`);
      if (next && !raised(next)) g.push(`<rect x="${r1(x1 - kw)}" y="${r1(top)}" width="${kw}" height="${r1(rise + 1)}" fill="${COLOUR.kerb}"/>`);
    }
    if (!compact) g.push(...decoration(e, x0, x1, top, base, depth, ppm, headroom, profile));
    else if (e.kind === 'median' && !e.flush && (e.material ?? 'grass') === 'grass') {
      const r = Math.min(w * 0.42, height * 0.2);
      g.push(`<circle cx="${r1((x0 + x1) / 2)}" cy="${r1(top - r * 1.15)}" r="${r1(r)}" fill="#5f9a4f"/>`);
    }
    parts.push(`<g data-index="${i}" class="xs-el${options.dragging === i ? ' xs-dragging' : ''}">${g.join('')}</g>`);
  });
  // Lane lines on the carriageway, between neighbours.
  const lineH = compact ? 1.5 : 3;
  for (let i = 0; i + 1 < profile.elements.length; i++) {
    const line = laneLine(profile.elements[i]!, profile.elements[i + 1]!);
    if (!line) continue;
    const xb = spans[i]![1];
    const y = base - (compact ? 0.5 : 1.5);
    if (line === 'centre') {
      parts.push(`<rect x="${r1(xb - 3.5)}" y="${y}" width="2.5" height="${lineH}" fill="${COLOUR.yellow}"/><rect x="${r1(xb + 1)}" y="${y}" width="2.5" height="${lineH}" fill="${COLOUR.yellow}"/>`);
    } else if (line === 'solid') {
      // A solid line (no lane change, or a bus lane's): wider, full white.
      parts.push(`<rect x="${r1(xb - 2.5)}" y="${y - (compact ? 0 : 1)}" width="5" height="${lineH + (compact ? 0 : 1)}" fill="${COLOUR.white}" class="xs-solid"/>`);
    } else {
      parts.push(`<rect x="${r1(xb - 1.5)}" y="${y}" width="3" height="${lineH}" fill="${COLOUR.white}"${line === 'lane' ? ' opacity="0.6"' : ''}/>`);
    }
  }
  if (labels) {
    // The widths, each under its element, between dimension ticks.
    const y = base + depth + 9;
    profile.elements.forEach((e, i) => {
      const [x0, x1] = spans[i]!;
      parts.push(`<line x1="${x0 + 1}" y1="${y}" x2="${x1 - 1}" y2="${y}" stroke="#ffffff38" stroke-width="1"/>`);
      parts.push(`<line x1="${x0 + 0.5}" y1="${y - 4}" x2="${x0 + 0.5}" y2="${y + 4}" stroke="#ffffff50"/>`);
      const text = `${metresText(e.width)} m`;
      // Written only where it fits (a 12 px figure is about 7 px a character).
      if (x1 - x0 >= text.length * 7 + 4) parts.push(`<text x="${r1((x0 + x1) / 2)}" y="${y + 17}" text-anchor="middle" class="xs-label">${text}</text>`);
    });
    const last = spans[spans.length - 1];
    if (last) parts.push(`<line x1="${last[1] - 0.5}" y1="${y - 4}" x2="${last[1] - 0.5}" y2="${y + 4}" stroke="#ffffff50"/>`);
  }
  const picked = options.selected !== undefined ? spans[options.selected] : undefined;
  if (picked) {
    const [x0, x1] = picked;
    parts.push(`<rect x="${x0 + 1.5}" y="3" width="${r1(Math.max(2, x1 - x0 - 3))}" height="${base + depth - 2}" rx="7" fill="${COLOUR.accent}" fill-opacity="0.09" stroke="${COLOUR.accent}" stroke-width="2.5" class="xs-selected" pointer-events="none"/>`);
  }
  for (const i of options.flagged ?? []) {
    const span = spans[i];
    if (!span) continue;
    // In the element's top right corner, clear of the lane's arrow.
    const k = compact ? 0.6 : 1;
    const cx = r1(Math.max(span[0] + 9 * k, span[1] - 12 * k)), cy = compact ? 7 : ICON_Y + 22;
    parts.push(`<g class="xs-flag" pointer-events="none"><circle cx="${cx}" cy="${cy}" r="${8 * k}" fill="${COLOUR.danger}" stroke="#1b0b09" stroke-width="1.5"/>` +
      `<rect x="${r1(cx - 1.2 * k)}" y="${r1(cy - 5 * k)}" width="${r1(2.4 * k)}" height="${r1(6 * k)}" rx="1" fill="#1b0b09"/><circle cx="${cx}" cy="${r1(cy + 4 * k)}" r="${r1(1.3 * k)}" fill="#1b0b09"/></g>`);
  }
  if (handles) {
    // Grab handles on every boundary: dragged, they move the width.
    for (let i = 0; i + 1 < profile.elements.length; i++) {
      const xb = spans[i]![1];
      parts.push(`<rect data-edge="${i}" class="xs-edge" x="${r1(xb - 6)}" y="0" width="12" height="${base + depth}" fill="transparent"/>`);
    }
  }
  const title = options.title ? `<title>${esc(options.title)}</title>` : '';
  const svg = `<svg class="xs" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet" role="img">${title}${parts.join('')}</svg>`;
  return { svg, spans, scale };
}

function raised(e: ProfileElement): boolean {
  return (e.kind === 'footway' || e.kind === 'median') && !e.flush;
}

function surface(e: ProfileElement, profile: RoadProfileSpec): string {
  switch (e.kind) {
    case 'footway': return e.material === 'stone' ? COLOUR.stone : e.material === 'concrete' ? COLOUR.footConcrete : COLOUR.pavers;
    case 'median':
      if (e.flush) return carriageway(profile);
      return e.material === 'concrete' ? COLOUR.footConcrete : e.material === 'pavers' ? COLOUR.pavers : COLOUR.grass;
    case 'cycle': return COLOUR.cycle;
    case 'lane': return e.use === 'bus' ? COLOUR.bus : carriageway(profile);
    default: return carriageway(profile);
  }
}

const carriageway = (profile: RoadProfileSpec): string =>
  profile.carriageway === 'concrete' ? COLOUR.concrete : profile.carriageway === 'cobble' ? COLOUR.cobble : COLOUR.asphalt;

/** The colour an element is drawn in (the swatch beside its name in the editor). */
export const elementColour = (e: ProfileElement, profile: RoadProfileSpec): string => surface(e, profile);

/** The line painted between two neighbours: between directions, between lanes of one, at the carriageway's edge. */
function laneLine(a: ProfileElement, b: ProfileElement): 'centre' | 'lane' | 'solid' | 'edge' | null {
  const road = (e: ProfileElement): boolean => e.kind === 'lane' || e.kind === 'parking' || e.kind === 'cycle' || (e.kind === 'median' && !!e.flush);
  if (a.kind === 'lane' && b.kind === 'lane') {
    if (a.dir !== b.dir) return 'centre';
    return a.line === 'solid' || (a.use === 'bus') !== (b.use === 'bus') ? 'solid' : 'lane';
  }
  if (road(a) && road(b)) return 'edge';
  return null;
}

/** What stands on each element, to the road's metre scale: people, cars, a tree, a cyclist, a lane's arrow, paving. */
function decoration(e: ProfileElement, x0: number, x1: number, top: number, base: number, depth: number, ppm: number, headroom: number, profile: RoadProfileSpec): string[] {
  const out: string[] = [];
  const w = x1 - x0, cx = (x0 + x1) / 2;
  // A car's width: to scale, inside its lane, and short enough to leave the lane's arrow clear.
  const car = (share: number): number => Math.min(1.8 * ppm, w * share, (headroom * 0.66) / 0.78);
  switch (e.kind) {
    case 'footway': {
      // Paving joints, one every half metre.
      const step = Math.max(5, 0.5 * ppm);
      for (let x = x0 + step; x < x1 - 2; x += step) out.push(`<rect x="${r1(x)}" y="${r1(top)}" width="1" height="${r1(base - top + depth)}" fill="#00000026"/>`);
      if (w >= 12) out.push(person(cx, top, Math.min(1.7 * ppm, headroom * 0.74)));
      break;
    }
    case 'lane': {
      // Seen from A towards B: a lane towards B shows a car's back, a lane towards A its front.
      if (w >= 14 && e.use === 'bus') out.push(busRear(cx, base, Math.min(2.5 * ppm, w * 0.86, (headroom * 0.95) / 1.25), e.dir === 'backward'));
      else if (w >= 14) out.push(carRear(cx, base, car(0.78), '#c9d2d6', e.dir === 'backward'));
      out.push(arrow(cx, ICON_Y, Math.min(26, w * 0.55), e.dir));
      if (profile.carriageway === 'cobble') {
        for (let x = x0 + 3; x < x1 - 2; x += Math.max(4, 0.2 * ppm)) out.push(`<rect x="${r1(x)}" y="${base}" width="1" height="${depth}" fill="#00000040"/>`);
      }
      break;
    }
    case 'parking': {
      if (w >= 12) out.push(carRear(cx, base, car(0.82), '#7f8a93'));
      out.push(`<rect x="${r1(cx - 8)}" y="${ICON_Y - 8}" width="16" height="16" rx="3" fill="#2f6fd0"/><text x="${r1(cx)}" y="${ICON_Y + 5}" text-anchor="middle" class="xs-glyph">P</text>`);
      break;
    }
    case 'cycle': {
      if (w >= 10) out.push(cyclist(cx, base, Math.min(1.75 * ppm, headroom * 0.8)));
      // The cycle lane's sign: a bicycle on a green square, like the parking bay's P.
      out.push(`<rect x="${r1(cx - 9)}" y="${ICON_Y - 9}" width="18" height="18" rx="3" fill="#2c7a45"/>` + bicycleGlyph(cx, ICON_Y));
      break;
    }
    case 'median': {
      if (e.flush) {
        // Painted: a hatch on the carriageway.
        for (let x = x0 + 2; x < x1 - 3; x += 5) out.push(`<rect x="${r1(x)}" y="${base - 1}" width="2.5" height="2.5" fill="${COLOUR.white}" opacity="0.8"/>`);
      } else if ((e.material ?? 'grass') === 'grass' && w >= 8) {
        out.push(tree(cx, top, Math.min(w * 0.46, 1.6 * ppm), Math.min(headroom * 0.95, 5 * ppm)));
      } else if (w >= 8) {
        // A paved median: a bollard or two.
        out.push(`<rect x="${r1(cx - 2)}" y="${r1(top - 0.9 * ppm)}" width="4" height="${r1(0.9 * ppm)}" rx="2" fill="#c9c4b8"/>`);
      }
      break;
    }
  }
  return out;
}

/** The direction a lane runs, as the arrow painted in it (towards B: right). */
function arrow(cx: number, cy: number, len: number, dir: 'forward' | 'backward'): string {
  const s = dir === 'forward' ? 1 : -1;
  const h = len / 2, head = Math.min(9, len * 0.45);
  const p = [
    [-h, -2], [h - head, -2], [h - head, -6], [h, 0], [h - head, 6], [h - head, 2], [-h, 2],
  ].map(([px, py]) => `${r1(cx + s * px!)},${r1(cy + py!)}`).join(' ');
  return `<polygon class="xs-arrow" points="${p}" fill="${COLOUR.white}"/>`;
}

/** A car seen from behind (or from the front: headlights and a grille), `w` pixels wide, standing on `base`. */
function carRear(cx: number, base: number, w: number, paint: string, front = false): string {
  const h = w * 0.78;
  const x = r1(cx - w / 2), y = base - h;
  const v = (n: number): number => r1(n);
  return `<g class="xs-car"><rect x="${x}" y="${v(y + h * 0.36)}" width="${v(w)}" height="${v(h * 0.5)}" rx="${v(w * 0.12)}" fill="${paint}"/>` +
    `<rect x="${v(x + w * 0.14)}" y="${v(y)}" width="${v(w * 0.72)}" height="${v(h * 0.46)}" rx="${v(w * 0.14)}" fill="${paint}"/>` +
    `<rect x="${v(x + w * 0.21)}" y="${v(y + h * 0.07)}" width="${v(w * 0.58)}" height="${v(h * 0.28)}" rx="${v(w * 0.06)}" fill="#2a3a44"/>` +
    `<rect x="${v(x + w * 0.05)}" y="${v(y + h * 0.5)}" width="${v(w * 0.17)}" height="${v(h * 0.09)}" rx="1" fill="${front ? '#fff4c8' : '#d9483b'}"/>` +
    `<rect x="${v(x + w * 0.78)}" y="${v(y + h * 0.5)}" width="${v(w * 0.17)}" height="${v(h * 0.09)}" rx="1" fill="${front ? '#fff4c8' : '#d9483b'}"/>` +
    (front
      ? `<rect x="${v(x + w * 0.3)}" y="${v(y + h * 0.52)}" width="${v(w * 0.4)}" height="${v(h * 0.1)}" rx="1" fill="#2a3138"/>`
      : `<rect x="${v(x + w * 0.36)}" y="${v(y + h * 0.66)}" width="${v(w * 0.28)}" height="${v(h * 0.09)}" fill="#e9e6da"/>`) +
    `<rect x="${v(x + w * 0.04)}" y="${v(base - h * 0.16)}" width="${v(w * 0.19)}" height="${v(h * 0.16)}" rx="2" fill="#15191c"/>` +
    `<rect x="${v(x + w * 0.77)}" y="${v(base - h * 0.16)}" width="${v(w * 0.19)}" height="${v(h * 0.16)}" rx="2" fill="#15191c"/></g>`;
}

/** Somebody walking, `k` pixels tall, standing on `top`. */
function person(cx: number, top: number, k: number): string {
  const v = r1;
  return `<g class="xs-person"><circle cx="${v(cx)}" cy="${v(top - k * 0.9)}" r="${v(k * 0.1)}" fill="#e2c3a1"/>` +
    `<rect x="${v(cx - k * 0.13)}" y="${v(top - k * 0.79)}" width="${v(k * 0.26)}" height="${v(k * 0.4)}" rx="${v(k * 0.08)}" fill="#3f6fa8"/>` +
    `<rect x="${v(cx - k * 0.11)}" y="${v(top - k * 0.42)}" width="${v(k * 0.09)}" height="${v(k * 0.42)}" fill="#2d3238"/>` +
    `<rect x="${v(cx + k * 0.02)}" y="${v(top - k * 0.42)}" width="${v(k * 0.09)}" height="${v(k * 0.42)}" fill="#2d3238"/></g>`;
}

/** A cyclist from behind, `k` pixels tall, on `base`. */
function cyclist(cx: number, base: number, k: number): string {
  const v = r1;
  return `<g class="xs-cyclist"><rect x="${v(cx - k * 0.035)}" y="${v(base - k * 0.4)}" width="${v(k * 0.07)}" height="${v(k * 0.4)}" rx="2" fill="#15191c"/>` +
    `<rect x="${v(cx - k * 0.2)}" y="${v(base - k * 0.5)}" width="${v(k * 0.4)}" height="${v(k * 0.04)}" rx="1" fill="#c0c6ca"/>` +
    `<rect x="${v(cx - k * 0.14)}" y="${v(base - k * 0.92)}" width="${v(k * 0.28)}" height="${v(k * 0.42)}" rx="${v(k * 0.09)}" fill="#e2a33b"/>` +
    `<circle cx="${v(cx)}" cy="${v(base - k * 1.0)}" r="${v(k * 0.1)}" fill="#e2c3a1"/>` +
    `<path d="M${v(cx - k * 0.11)} ${v(base - k * 1.04)} a${v(k * 0.11)} ${v(k * 0.11)} 0 0 1 ${v(k * 0.22)} 0z" fill="#3a8f5f"/></g>`;
}

/** A street tree: crown radius `r`, `h` pixels tall, on `top`. */
function tree(cx: number, top: number, r: number, h: number): string {
  const v = r1;
  const crownY = top - h + r;
  return `<g class="xs-tree"><rect x="${v(cx - Math.max(1.5, r * 0.09))}" y="${v(crownY)}" width="${v(Math.max(3, r * 0.18))}" height="${v(top - crownY)}" fill="#6b4a2f"/>` +
    `<circle cx="${v(cx)}" cy="${v(crownY)}" r="${v(r)}" fill="#4f8a42"/>` +
    `<circle cx="${v(cx - r * 0.38)}" cy="${v(crownY - r * 0.22)}" r="${v(r * 0.62)}" fill="#64a353"/>` +
    `<circle cx="${v(cx + r * 0.42)}" cy="${v(crownY + r * 0.12)}" r="${v(r * 0.5)}" fill="#5a9a4b"/></g>`;
}

/** A bicycle pictogram, 14 pixels wide, centred on (cx, cy). */
function bicycleGlyph(cx: number, cy: number): string {
  const v = r1;
  return `<g fill="none" stroke="#f2efe6" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">` +
    `<circle cx="${v(cx - 4.2)}" cy="${v(cy + 2.5)}" r="3"/><circle cx="${v(cx + 4.2)}" cy="${v(cy + 2.5)}" r="3"/>` +
    `<path d="M${v(cx - 4.2)} ${v(cy + 2.5)}L${v(cx - 1)} ${v(cy - 2.5)}H${v(cx + 2.5)}L${v(cx + 4.2)} ${v(cy + 2.5)}M${v(cx - 1)} ${v(cy - 2.5)}L${v(cx + 0.6)} ${v(cy + 2.5)}M${v(cx + 1.6)} ${v(cy - 4.5)}h2"/></g>`;
}

/** A bus seen from behind (or the front), `w` pixels wide, standing on `base`: what a bus lane carries. */
function busRear(cx: number, base: number, w: number, front: boolean): string {
  const h = w * 1.25, x = r1(cx - w / 2), y = base - h, v = r1;
  const lamp = front ? '#fff4c8' : '#d9483b';
  return `<g class="xs-bus"><rect x="${x}" y="${v(y)}" width="${v(w)}" height="${v(h * 0.9)}" rx="${v(w * 0.1)}" fill="#e6b53c"/>` +
    `<rect x="${v(x + w * 0.1)}" y="${v(y + h * 0.08)}" width="${v(w * 0.8)}" height="${v(h * 0.34)}" rx="${v(w * 0.05)}" fill="#2a3a44"/>` +
    `<rect x="${v(x + w * 0.08)}" y="${v(y + h * 0.66)}" width="${v(w * 0.16)}" height="${v(h * 0.07)}" fill="${lamp}"/>` +
    `<rect x="${v(x + w * 0.76)}" y="${v(y + h * 0.66)}" width="${v(w * 0.16)}" height="${v(h * 0.07)}" fill="${lamp}"/>` +
    `<rect x="${v(x + w * 0.06)}" y="${v(base - h * 0.12)}" width="${v(w * 0.18)}" height="${v(h * 0.12)}" rx="2" fill="#15191c"/>` +
    `<rect x="${v(x + w * 0.76)}" y="${v(base - h * 0.12)}" width="${v(w * 0.18)}" height="${v(h * 0.12)}" rx="2" fill="#15191c"/></g>`;
}
