import { BufferAttribute, BufferGeometry } from 'three';
import { nearestThree } from '@people/hair/procedural';
import type { ProxyPack } from '@people/body/proxy';
import type { GroomBody, HeadProxy, Tie } from './groom';

/** HAIR ON A GUIDE SURFACE, as VRoid Studio builds it: a hairstyle is a smooth surface round the head (its "guide", rib curves of control points),
 *  and the hair is strands generated side by side on that surface - each strand a flattened, tapering clump whose width is the distance to its
 *  neighbours, so the strands always cover the surface and the scalp never shows. Editing reshapes the surface (lengths, lift off the head, pulls,
 *  waves, the parting, ties) and the strands follow. The hair is the mesh: nothing is painted on the scalp.
 *
 *  The surface here: a ring of columns round the head, starting on the parting (the top midline, front hairline to crown), the left half
 *  combed to the left and the right half to the right; each column a curve laid on the head a little off the skin, down to the ears' middle,
 *  then hanging. Columns 0..C-1 run along the left of the parting front to back, C..2C-1 the right back to front: a closed ring. */

/** Columns each side of the parting. */
export const COLUMNS = 16;
/** Control knots along each column (for pulls and combs). */
export const KNOTS = 6;
/** Points along a column once laid. */
const SAMPLES = 28;
/** Marching step along the head (dm). */
const STEP = 0.05;
/** A strand's depth as a share of its width (a flat lock), and points round its cross-section. */
const FLAT = 0.42;
const RING = 6;
/** A strand's normal: its own share and the surface's (`strand`). */
const SHELL_NORMAL = [0.35, 0.65] as const;

export type ShellPreset = 'short' | 'bob' | 'long' | 'ponytail' | 'bun' | 'pigtails';

/** A hairstyle, saved: the guide surface's parameters per column, its pulls, its ties. Small and exact (rounded to 0.1 mm). */
export interface ShellRecord {
  readonly v: 2;
  readonly preset: ShellPreset;
  /** Per column (2C): length along it (dm), lift off the head (dm), wave amplitude (dm). */
  readonly length: number[];
  readonly lift: number[];
  readonly wave: number[];
  /** Per column per knot: a pull x y z (dm). */
  readonly offsets: number[];
  readonly ties: Tie[];
  /** The parting's place across the head (dm from the middle). */
  readonly part: number;
  /** Strands each side, and their width against their spacing (over 1 they overlap). */
  readonly strands: number;
  readonly overlap: number;
  /** Cut straight across at the ends (a bob) rather than tapering. */
  readonly blunt: boolean;
}

const LENGTHS: Record<ShellPreset, number> = { short: 2.4, bob: 2.6, long: 4.4, ponytail: 4.4, bun: 4.4, pigtails: 3.8 };

/** A preset's record on this body. */
export function presetRecord(preset: ShellPreset, body: GroomBody): ShellRecord {
  const n = COLUMNS * 2;
  const [sx, , sz] = body.skull, top = body.top;
  const ties: Tie[] = preset === 'ponytail' ? [{ x: sx, y: top - 0.95, z: sz - 0.95, radius: 0.2 }]
    : preset === 'bun' ? [{ x: sx, y: top - 0.3, z: sz - 0.85, radius: 0.28 }]
      : preset === 'pigtails' ? [{ x: sx + 0.85, y: top - 1.15, z: sz - 0.35, radius: 0.18 }, { x: sx - 0.85, y: top - 1.15, z: sz - 0.35, radius: 0.18 }] : [];
  return {
    v: 2, preset, length: Array.from({ length: n }, () => LENGTHS[preset]), lift: Array.from({ length: n }, () => preset === 'short' ? 0.04 : 0.06),
    wave: Array.from({ length: n }, () => 0), offsets: Array.from({ length: n * KNOTS * 3 }, () => 0), ties, part: 0,
    strands: 34, overlap: 1.7, blunt: preset === 'bob',
  };
}

/** A saved record checked: the record; an older studio's groom (guide strands, `{ guides, ties }`) converted on this body to the style it was
 *  closest to - its strands' mean length, blunt ends if it was cut, its ties kept; or null. */
export function shellOf(value: unknown, body?: GroomBody): ShellRecord | null {
  const r = value as Partial<ShellRecord> | null;
  if (r && r.v === 2 && Array.isArray(r.length) && r.length.length === COLUMNS * 2) return r as ShellRecord;
  const old = value as { guides?: unknown; ties?: Tie[] } | null;
  if (!body || !old || typeof old.guides !== 'string') return null;
  const { length, blunt } = oldGroomLength(old.guides);
  const ties = Array.isArray(old.ties) ? old.ties : [];
  const preset: ShellPreset = ties.length > 1 ? 'pigtails' : ties.length === 1 ? 'ponytail' : length < 1.6 ? 'short' : length < 3.2 ? 'bob' : 'long';
  const base = presetRecord(preset, body);
  return { ...base, length: base.length.map(() => Math.max(0.5, length)), blunt: blunt || base.blunt, ties: ties.length ? ties.map((t) => ({ ...t })) : base.ties };
}

/** An older groom's strands (`[count u32]` then per strand `[root u16, points u16, radius|blunt u16, tie i16]` and its points from the root in
 *  thousandths of a dm, int16): their mean length (dm) and whether most were cut blunt. */
function oldGroomLength(guides: string): { length: number; blunt: boolean } {
  const raw = atob(guides);
  const view = new DataView(Uint8Array.from(raw, (ch) => ch.charCodeAt(0)).buffer);
  const count = view.byteLength >= 4 ? view.getUint32(0, true) : 0;
  let o = 4, total = 0, blunt = 0, n = 0;
  for (let g = 0; g < count && o + 8 <= view.byteLength; g++) {
    const points = view.getUint16(o + 2, true), packed = view.getUint16(o + 4, true);
    o += 8;
    let len = 0, px = 0, py = 0, pz = 0;
    for (let i = 0; i < points && o + 6 <= view.byteLength; i++, o += 6) {
      const x = view.getInt16(o, true) / 1000, y = view.getInt16(o + 2, true) / 1000, z = view.getInt16(o + 4, true) / 1000;
      if (i) len += Math.hypot(x - px, y - py, z - pz);
      px = x; py = y; pz = z;
    }
    total += len; n++;
    if (packed & 0x8000) blunt++;
  }
  return { length: n ? total / n : LENGTHS.bob, blunt: blunt > n / 2 };
}

/** The record rounded for saving. */
export function compactShell(r: ShellRecord): ShellRecord {
  const q = (xs: number[]): number[] => xs.map((x) => Math.round(x * 1000) / 1000);
  return { ...r, length: q(r.length), lift: q(r.lift), wave: q(r.wave), offsets: q(r.offsets), part: Math.round(r.part * 1000) / 1000,
    ties: r.ties.map((t) => ({ x: +t.x.toFixed(3), y: +t.y.toFixed(3), z: +t.z.toFixed(3), radius: +t.radius.toFixed(3) })) };
}

/** A point on the smooth head (`GroomBody.head`) in direction `d` from its middle, `lift` further out along that direction. */
function onHead(h: HeadProxy, d: number[], lift: number): number[] {
  const u = norm(d);
  const t = h.radius(u) + lift;
  return [h.c[0]! + u[0]! * t, h.c[1]! + u[1]! * t, h.c[2]! + u[2]! * t];
}

/** The smooth head's outward normal at a point near it: across two small steps on its surface. */
function headNormal(h: HeadProxy, p: number[]): number[] {
  const d = norm([p[0]! - h.c[0]!, p[1]! - h.c[1]!, p[2]! - h.c[2]!]);
  const a = norm(Math.abs(d[1]!) < 0.9 ? [d[2]!, 0, -d[0]!] : [1, 0, 0]);
  const b = [d[1]! * a[2]! - d[2]! * a[1]!, d[2]! * a[0]! - d[0]! * a[2]!, d[0]! * a[1]! - d[1]! * a[0]!];
  const p0 = onHead(h, d, 0), e = 0.03;
  const p1 = onHead(h, [d[0]! + a[0]! * e, d[1]! + a[1]! * e, d[2]! + a[2]! * e], 0), p2 = onHead(h, [d[0]! + b[0]! * e, d[1]! + b[1]! * e, d[2]! + b[2]! * e], 0);
  const u = [p1[0]! - p0[0]!, p1[1]! - p0[1]!, p1[2]! - p0[2]!], v = [p2[0]! - p0[0]!, p2[1]! - p0[1]!, p2[2]! - p0[2]!];
  const n = norm([u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!]);
  return n[0]! * d[0]! + n[1]! * d[1]! + n[2]! * d[2]! < 0 ? [-n[0]!, -n[1]!, -n[2]!] : n;
}

/** The comb's direction at a point (a field over the head, the same for every column, so the columns - its flow lines - never cross): away from
 *  the parting on the top, down the sides, down and back behind the crown. */
function combField(h: HeadProxy, p: number[], side: number): number[] {
  const back = Math.max(0, Math.min(1, (h.c[2]! - p[2]!) / h.radius([0, 0, -1]) * 1.6));
  // Behind the crown straight down (the two halves side by side down the back, not parting there).
  return norm([side * (1 - 0.9 * back), -0.5 - 0.9 * back, -0.4 * back]);
}

/** Column k of a loose style: from its root on the parting (the top midline, front hairline to behind the crown, the two halves just crossing it),
 *  following the comb's field over the smooth head `lift` off it, kept above the hairline at the front, down to just under the ears' middle; then
 *  hanging straight, a little out. Short hair ends at the hairline. */
function looseColumn(body: GroomBody, r: ShellRecord, k: number): number[][] {
  const C = COLUMNS, h = body.head, side = k < C ? 1 : -1;
  const t = k < C ? (k + 0.5) / C : (2 * C - k - 0.5) / C;
  const lift = r.lift[k]!;
  // The parting in the side view: from the front hairline (its angle from the top) back to behind the crown.
  const front = Math.acos(Math.max(-1, Math.min(1, (body.hairlineY(0) - h.c[1]!) / h.radius([0, 1, 0]))));
  const a = front + (-0.55 - front) * t;
  const partX = (r.part - side * 0.04) / h.radius([1, 0, 0]);
  let p = onHead(h, [partX, Math.cos(a), Math.sin(a)], lift);
  const pts: number[][] = [p];
  const want = r.length[k]!;
  const hangY = h.c[1]! - h.radius([0, 1, 0]) * 0.2;
  let length = 0;
  while (length < want && (p[1]! > hangY || r.preset === 'short') && pts.length < 300) {
    const n = headNormal(h, p);
    let f = combField(h, p, side);
    const fd = f[0]! * n[0]! + f[1]! * n[1]! + f[2]! * n[2]!;
    f = norm([f[0]! - n[0]! * fd, f[1]! - n[1]! * fd, f[2]! - n[2]! * fd]);
    let q = onHead(h, [p[0]! + f[0]! * STEP - h.c[0]!, p[1]! + f[1]! * STEP - h.c[1]!, p[2]! + f[2]! * STEP - h.c[2]!], lift);
    // Never down over the forehead: kept above the hairline in front of the ears.
    if (q[2]! > h.c[2]! - 0.1) {
      const theta = Math.atan2(q[0]! - h.c[0]!, q[2]! - h.c[2]!);
      const floor = body.hairlineY(theta) + 0.04;
      if (q[1]! < floor && Math.abs(theta) < 1.25) q = onHead(h, [q[0]! - h.c[0]!, floor - h.c[1]!, q[2]! - h.c[2]!], lift);
    }
    if (r.preset === 'short' && body.aboveHairline(q[0]!, q[1]!, q[2]!) < -0.04) break;
    length += dist(q, p);
    p = q;
    pts.push(p);
  }
  // Hanging: straight down from where it leaves the head, leaning out a little, off the shoulders.
  const out = norm([p[0]! - h.c[0]!, 0, p[2]! - h.c[2]!]);
  while (length < want && pts.length < 400 && r.preset !== 'short') {
    const q = [p[0]! + out[0]! * 0.08 * STEP, p[1]! - STEP, p[2]! + out[2]! * 0.08 * STEP];
    body.collide(q, 0, 0.05, false);
    length += STEP;
    p = q;
    pts.push(p);
  }
  return pts;
}

/** Column k of a tied style: rooted on the hairline (front, sides and nape all round, the left half to the left of the midline), across the smooth
 *  head to its tie along the great arc between them (as hair is brushed up into a ponytail), ending in the tie. */
function tiedColumn(body: GroomBody, r: ShellRecord, k: number, fromParting: boolean): number[][] {
  const C = COLUMNS, h = body.head, side = k < C ? 1 : -1;
  const t = k < C ? (k + 0.5) / C : (2 * C - k - 0.5) / C;
  const lift = r.lift[k]!;
  let d0: number[];
  if (fromParting) {
    // On the parting, as a loose style's roots (the top covered).
    const front = Math.acos(Math.max(-1, Math.min(1, (body.hairlineY(0) - h.c[1]!) / h.radius([0, 1, 0]))));
    // Pigtails part the head in two all the way down to the nape (each half to its own tie).
    const back = r.ties.length > 1 ? -Math.acos(Math.max(-1, Math.min(1, (body.hairlineY(Math.PI) + 0.05 - h.c[1]!) / h.radius([0, 0, -1])))) : -0.55;
    const a = front + (back - front) * t;
    d0 = norm([(r.part - side * 0.04) / h.radius([1, 0, 0]), Math.cos(a), Math.sin(a)]);
  } else {
    // On the hairline at its angle round the head, all round (front, sides, nape), just above it.
    // Pigtails: behind the ears and the nape only (the front is the parting ring's, going to the ties over the top).
    const theta = side * (r.ties.length > 1 ? 1.5 + (Math.PI - 1.5) * t : Math.PI * t);
    const root = [h.c[0]! + Math.sin(theta), body.hairlineY(theta) + 0.03, h.c[2]! + Math.cos(theta)];
    d0 = norm([root[0]! - h.c[0]!, (root[1]! - h.c[1]!) / Math.max(0.3, h.radius([Math.sin(theta), 0, Math.cos(theta)])), root[2]! - h.c[2]!]);
  }
  const tie = r.ties.find((t) => Math.sign(t.x - h.c[0]!) === side && Math.abs(t.x - h.c[0]!) > 0.3) ?? r.ties[0]!;
  const d1 = norm([tie.x - h.c[0]!, tie.y - h.c[1]!, tie.z - h.c[2]!]);
  const angle = Math.acos(Math.max(-1, Math.min(1, d0[0]! * d1[0]! + d0[1]! * d1[1]! + d0[2]! * d1[2]!)));
  const steps = Math.max(4, Math.ceil(angle * h.radius(d0) / STEP));
  const pts: number[][] = [];
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    // Spherical interpolation of the direction; lifted towards the tie (hair gathered stands off the head a little there).
    const s0 = Math.sin((1 - u) * angle) / Math.max(1e-6, Math.sin(angle)), s1 = Math.sin(u * angle) / Math.max(1e-6, Math.sin(angle));
    const d = angle < 1e-4 ? d0 : [d0[0]! * s0 + d1[0]! * s1, d0[1]! * s0 + d1[1]! * s1, d0[2]! * s0 + d1[2]! * s1];
    // Close to the head at the root (no ridge along the hairline), lifted towards the tie.
    let q = onHead(h, d, lift * Math.min(1, u * 5) + u * u * 0.08);
    // Never down over the forehead.
    if (q[2]! > h.c[2]! - 0.1) {
      const theta = Math.atan2(q[0]! - h.c[0]!, q[2]! - h.c[2]!);
      const floor = body.hairlineY(theta) + 0.02;
      if (q[1]! < floor && Math.abs(theta) < 1.25 && u > 0.02) q = onHead(h, [q[0]! - h.c[0]!, floor - h.c[1]!, q[2]! - h.c[2]!], lift);
    }
    pts.push(q);
  }
  return pts;
}

/** The surface's rings of columns, each column resampled evenly to SAMPLES points over its own length, its pulls and waves added: one ring from the
 *  parting for a loose style; for a tied one a ring from the parting and one from the hairline, both to the ties (the whole scalp covered). */
export function layShell(body: GroomBody, r: ShellRecord): number[][][][] {
  // A ponytail or a bun: the hairline all round to the tie (the disc between them is the whole scalp). Pigtails: that, and the parting to each
  // side's tie (the top between the two).
  const rings = !r.ties.length ? [layRing(body, r, (k) => looseColumn(body, r, k))]
    : r.ties.length > 1 ? [layRing(body, r, (k) => tiedColumn(body, r, k, true)), layRing(body, r, (k) => tiedColumn(body, r, k, false))]
      : [layRing(body, r, (k) => tiedColumn(body, r, k, false))];
  return rings;
}

function layRing(body: GroomBody, r: ShellRecord, column: (k: number) => number[][]): number[][][] {
  void body;
  const cols: number[][][] = [];
  for (let k = 0; k < COLUMNS * 2; k++) {
    const even = resample(column(k), SAMPLES);
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1);
      // The pull at this point: the knots' pulls, linear between them, nothing at the root.
      const f = t * (KNOTS - 1), j = Math.min(KNOTS - 2, Math.floor(f)), u = f - j;
      for (let a = 0; a < 3; a++) even[i]![a] = even[i]![a]! + (r.offsets[(k * KNOTS + j) * 3 + a]! * (1 - u) + r.offsets[(k * KNOTS + j + 1) * 3 + a]! * u) * Math.min(1, t * 4);
      // The wave: side to side across the column, growing from the root.
      const wv = r.wave[k]!;
      if (wv) even[i]![0] = even[i]![0]! + Math.sin(t * Math.PI * 6) * wv * t * (k < COLUMNS ? 1 : -1);
    }
    cols.push(even);
  }
  return cols;
}

function resample(pts: number[][], count: number): number[][] {
  if (pts.length < 2) return Array.from({ length: count }, () => [...(pts[0] ?? [0, 0, 0])]);
  const acc = [0];
  for (let i = 1; i < pts.length; i++) acc.push(acc[i - 1]! + dist(pts[i]!, pts[i - 1]!));
  const total = acc[acc.length - 1]!;
  const out: number[][] = [];
  let j = 1;
  for (let i = 0; i < count; i++) {
    const s = total * i / (count - 1);
    while (j < pts.length - 1 && acc[j]! < s) j++;
    const u = (s - acc[j - 1]!) / Math.max(1e-9, acc[j]! - acc[j - 1]!);
    out.push([0, 1, 2].map((a) => pts[j - 1]![a]! + (pts[j]![a]! - pts[j - 1]![a]!) * Math.max(0, Math.min(1, u))));
  }
  return out;
}

export interface ShellGeometry { positions: Float32Array; normals: Float32Array; tangents: Float32Array; uvs: Float32Array; index: Uint32Array }

/** The strands on the surface: `strands` a side, two layers (the inner one offset half a strand, a little lower), each a flattened tapering
 *  clump between the neighbouring columns, as wide as its share of the gap between them times the overlap; then the tails at the ties. */
export function shellGeometry(body: GroomBody, r: ShellRecord, rings = layShell(body, r)): ShellGeometry {
  const pos: number[] = [], nor: number[] = [], tan: number[] = [], uv: number[] = [], idx: number[] = [];
  for (const cols of rings) ringStrands(body, r, cols, pos, nor, tan, uv, idx);
  tails(body, r, pos, nor, tan, uv, idx);
  return { positions: Float32Array.from(pos), normals: Float32Array.from(nor), tangents: Float32Array.from(tan), uvs: Float32Array.from(uv), index: Uint32Array.from(idx) };
}

/** The strands of one ring of columns: in each gap between neighbouring columns as many strands as its widest part needs (at least the style's
 *  density), each as wide as its share of the gap there times the overlap, within a lock's width - so no gap is ever left open. Two layers, the inner
 *  one offset half a strand and a little under. */
function ringStrands(body: GroomBody, r: ShellRecord, cols: number[][][], pos: number[], nor: number[], tan: number[], uv: number[], idx: number[]): void {
  const ringN = cols.length;
  const [sx, sy, sz] = body.skull;
  const base = Math.max(1, Math.round(r.strands * 2 / ringN));
  const MAX_HALF = 0.11;
  for (let k0 = 0; k0 < ringN; k0++) {
    const k1 = (k0 + 1) % ringN;
    // Loose, the halves part at the front (left front and right front go opposite ways); pigtails part at the nape too (two ties).
    if (!r.ties.length && k0 === ringN - 1) continue;
    if (r.ties.length > 1 && (k0 === ringN - 1 || k0 === COLUMNS - 1)) continue;
    const a = cols[k0]!, b = cols[k1]!;
    let widest = 0;
    for (let i = 0; i < SAMPLES; i++) widest = Math.max(widest, dist(a[i]!, b[i]!));
    const n = Math.max(base, Math.ceil(widest * r.overlap / (2 * MAX_HALF * 0.85)));
    for (let layer = 0; layer < 2; layer++) {
      for (let s2 = 0; s2 < n; s2++) {
        const f = (s2 + 0.5 + layer * 0.5) / n;
        if (f >= 1) continue;
        const jitter = 0.92 + 0.12 * hash(k0 * 97 + s2 * 31 + layer * 7);
        const pts: number[][] = [], half: number[] = [];
        for (let i = 0; i < SAMPLES; i++) {
          let q = [0, 1, 2].map((c) => a[i]![c]! * (1 - f) + b[i]![c]! * f);
          // A straight line between two columns on a curved head cuts under it: fitted back out to the head, the columns' lift off it.
          const lift = (r.lift[k0 % (COLUMNS * 2)]! * (1 - f) + r.lift[k1 % (COLUMNS * 2)]! * f) * (layer === 1 ? 0.5 : 1);
          const h = body.head, d = [q[0]! - h.c[0]!, q[1]! - h.c[1]!, q[2]! - h.c[2]!];
          const floor = h.radius(norm(d)) + lift;
          if (Math.hypot(d[0]!, d[1]!, d[2]!) < floor) q = onHead(h, d, lift);
          else if (layer === 1) { const o = norm([q[0]! - sx, q[1]! - sy, q[2]! - sz]); for (let c = 0; c < 3; c++) q[c] = q[c]! - o[c]! * 0.025; }
          pts.push(q);
          half.push(Math.max(0.03, Math.min(MAX_HALF, 0.5 * dist(a[i]!, b[i]!) / n * r.overlap)));
        }
        const len = (r.length[k0 % (COLUMNS * 2)]! * (1 - f) + r.length[k1 % (COLUMNS * 2)]! * f) * jitter;
        strand(pts, half, len, r.blunt, body.skull, pos, nor, tan, uv, idx);
      }
    }
  }
}

/** The tails: from each tie down, strands round a small circle (a bun: wound round it). */
function tails(body: GroomBody, r: ShellRecord, pos: number[], nor: number[], tan: number[], uv: number[], idx: number[]): void {
  for (const tie of r.ties) {
    const tail = r.preset === 'bun' ? 0.9 : Math.max(0.8, avg(r.length) - 1.6);
    for (let s = 0; s < 22; s++) {
      const th = (s / 22) * Math.PI * 2, pts: number[][] = [], half: number[] = [];
      for (let i = 0; i < SAMPLES; i++) {
        const t = i / (SAMPLES - 1);
        if (r.preset === 'bun') {
          const ang = th + t * Math.PI * 2.2, rad = tie.radius * (0.4 + 0.9 * Math.sin(t * Math.PI) + 0.2 * t);
          pts.push([tie.x + Math.cos(ang) * rad, tie.y + Math.sin(ang) * rad, tie.z - 0.12 - 0.18 * Math.sin(t * Math.PI)]);
        } else {
          const spread = tie.radius * (0.5 + 0.6 * Math.sin(Math.min(1, t * 1.5) * Math.PI * 0.5));
          pts.push([tie.x + Math.cos(th) * spread, tie.y - t * tail, tie.z + Math.sin(th) * spread - 0.05 - 0.15 * t]);
        }
        half.push(tie.radius * 0.38);
      }
      for (const p of pts) body.collide(p, 0, 0.04, false);
      strand(pts, half, tail, false, [tie.x, tie.y, tie.z + 0.2], pos, nor, tan, uv, idx);
    }
  }
}

/** One strand swept along `pts` (dm): a flattened ellipse `half` wide each side, flat against the head (its face out from `centre`), tapering
 *  over its last part (or cut blunt); `len` its length for the taper's span. */
function strand(pts: number[][], half: number[], len: number, blunt: boolean, centre: readonly number[], pos: number[], nor: number[], tan: number[], uv: number[], idx: number[]): void {
  const n = pts.length, first = pos.length / 3;
  for (let i = 0; i < n; i++) {
    const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(n - 1, i + 1)]!;
    const t3 = norm([b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!]);
    let o = [pts[i]![0]! - centre[0]!, pts[i]![1]! - centre[1]!, pts[i]![2]! - centre[2]!];
    const od = o[0]! * t3[0]! + o[1]! * t3[1]! + o[2]! * t3[2]!;
    o = norm([o[0]! - t3[0]! * od, o[1]! - t3[1]! * od, o[2]! - t3[2]! * od]);
    const sv = [t3[1]! * o[2]! - t3[2]! * o[1]!, t3[2]! * o[0]! - t3[0]! * o[2]!, t3[0]! * o[1]! - t3[1]! * o[0]!];
    const t = i / (n - 1);
    const w = Math.max(0.004, half[i]! * taper(t, len, blunt)), d = Math.max(0.012, w * FLAT);
    for (let k = 0; k <= RING; k++) {
      const ang = (k / RING) * Math.PI * 2, c = Math.cos(ang), s = Math.sin(ang);
      for (let q = 0; q < 3; q++) pos.push(pts[i]![q]! + sv[q]! * c * w + o[q]! * s * d);
      // The strand's own normal mostly replaced by the surface's (out from the head), as hair-card artists transfer normals from a smooth shell:
      // the strands shade as one sheet of hair with only a soft groove between them, not as a row of tubes.
      const own = norm([sv[0]! * c / w + o[0]! * s / d, sv[1]! * c / w + o[1]! * s / d, sv[2]! * c / w + o[2]! * s / d]);
      const nn = norm([own[0]! * SHELL_NORMAL[0] + o[0]! * SHELL_NORMAL[1], own[1]! * SHELL_NORMAL[0] + o[1]! * SHELL_NORMAL[1], own[2]! * SHELL_NORMAL[0] + o[2]! * SHELL_NORMAL[1]]);
      nor.push(nn[0]!, nn[1]!, nn[2]!);
      tan.push(t3[0]!, t3[1]!, t3[2]!, 1);
      uv.push(k / RING, t);
    }
  }
  for (let i = 0; i < n - 1; i++) for (let k = 0; k < RING; k++) {
    const q = first + i * (RING + 1) + k, r = q + RING + 1;
    idx.push(q, q + 1, r, q + 1, r + 1, r);
  }
}

/** A strand's width along it: full, narrowing to a point over its last 4 cm (at most its last 40%); a blunt cut rounds only its very end. */
function taper(t: number, len: number, blunt: boolean): number {
  if (blunt) return t < 0.9 ? 1 : 1 - ((t - 0.9) / 0.1) * 0.3;
  const zone = Math.min(0.4, 0.4 / Math.max(0.1, len));
  return t < 1 - zone ? 1 : Math.max(0.05, 1 - ((t - 1 + zone) / zone) ** 1.3);
}

export function shellBuffer(g: ShellGeometry, into = new BufferGeometry()): BufferGeometry {
  into.setAttribute('position', new BufferAttribute(g.positions, 3));
  into.setAttribute('normal', new BufferAttribute(g.normals, 3));
  into.setAttribute('tangent', new BufferAttribute(g.tangents, 4));
  into.setAttribute('uv', new BufferAttribute(g.uvs, 2));
  into.setIndex(new BufferAttribute(g.index, 1));
  into.computeBoundingSphere();
  return into;
}

/** The hairstyle as a game item (`ProxyPack`): every vertex pinned to its three nearest head and neck skin vertices, as MakeHuman items are. */
export function shellPack(r: ShellRecord, body: GroomBody, anchors: readonly number[]): ProxyPack {
  const { positions, index } = shellGeometry(body, r);
  const P = body.positions;
  const n = positions.length / 3;
  const refs = new Uint32Array(n * 3), weights = new Float32Array(n * 3), offsets = new Float32Array(n * 3);
  const nearest = nearestThree(P, anchors);
  for (let i = 0; i < n; i++) {
    const best = nearest([positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]);
    const w = best.map(([d]) => 1 / (Math.sqrt(d) + 0.05));
    const total = w.reduce((s, x) => s + x, 0);
    let fx = 0, fy = 0, fz = 0;
    for (let k = 0; k < 3; k++) {
      const ref = best[k]![1];
      refs[i * 3 + k] = ref; weights[i * 3 + k] = w[k]! / total;
      fx += P[ref * 3]! * w[k]! / total; fy += P[ref * 3 + 1]! * w[k]! / total; fz += P[ref * 3 + 2]! * w[k]! / total;
    }
    offsets[i * 3] = positions[i * 3]! - fx; offsets[i * 3 + 1] = positions[i * 3 + 1]! - fy; offsets[i * 3 + 2] = positions[i * 3 + 2]! - fz;
  }
  // Scale axes measured across the head, as the stock hair has them (`procedural.ts` pinned).
  const scaleRefs = [5399, 11998, 791, 881, 962, 5320];
  const axis = (i: number): number => Math.abs(P[scaleRefs[i * 2]! * 3 + i]! - P[scaleRefs[i * 2 + 1]! * 3 + i]!) || 1;
  return { name: 'groom', kind: 'hair', scaleRefs, scaleBase: [axis(0), axis(1), axis(2)], refs, weights, offsets, index, deleteVerts: new Uint32Array(0), colour: 0xffffff, zDepth: 50 };
}

const norm = (v: number[]): number[] => { const l = Math.hypot(v[0]!, v[1]!, v[2]!) || 1; return [v[0]! / l, v[1]! / l, v[2]! / l]; };
const dist = (a: number[], b: number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const avg = (xs: readonly number[]): number => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
function hash(i: number): number { return (((i * 2654435761) >>> 0) % 100000) / 100000; }
