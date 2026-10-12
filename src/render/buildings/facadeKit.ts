import { BoxGeometry, ConeGeometry, CylinderGeometry, ExtrudeGeometry, Shape, type BufferGeometry } from 'three';

/**
 * The facade kit: architecture built as geometry - a window is a hole in a
 * wall with its reveal, frame, glass set back, sill and head, not a picture
 * of one on a flat face. The facades are composed as a shape grammar does it
 * (Müller, Wonka et al., "Procedural Modeling of Buildings", SIGGRAPH 2006;
 * Esri CityEngine's CGA `split` with floating sizes and repeats): a face is
 * split into storeys, each storey into bays of a target width that share
 * what is left over, and each bay takes a module - a punched window, a
 * glazed bay of a curtain wall, a door, a pier.
 *
 * Every module works on a `Face`: an axis-aligned wall of a mass, `u` running
 * along it left to right as seen from the street side it faces, `o` the
 * distance out of the wall plane (negative: into the wall), `z` up. The
 * pieces go to the same accumulator as the signature buildings
 * (`signature.ts` `Parts`), merged per material: a building is a handful of
 * draws whatever its windows.
 *
 * Metres in the building's frame: x along the front, y back from it, z up.
 */

/** What the kit draws into (`signature.ts` `Parts`). */
export interface Sink {
  box(mat: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void;
  pushRaw(mat: string, g: BufferGeometry): void;
  rail(x0: number, x1: number, y0: number, y1: number, z: number, h?: number): void;
  plant(x: number, y: number, z: number, size?: number): void;
  bush(x: number, y: number, z: number, r: number, dark?: boolean): void;
  tree(x: number, y: number, r?: number, h?: number): void;
  hip(mat: string, x0: number, x1: number, y0: number, y1: number, z: number, h: number, top?: number): void;
  gable(mat: string, x0: number, x1: number, y0: number, y1: number, z: number, h: number, along?: 'x' | 'y'): void;
  cylinder(mat: string, x: number, y: number, z0: number, z1: number, r: number): void;
  Y(y: number): number;
}

export type Side = 'front' | 'back' | 'left' | 'right';
export const SIDES: readonly Side[] = ['front', 'right', 'back', 'left'];

/** A wall of a rectangular mass `[x0, x1] x [y0, y1]`. */
export interface Face {
  readonly side: Side;
  readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number;
}

export const faceOf = (side: Side, x0: number, x1: number, y0: number, y1: number): Face => ({ side, x0, x1, y0, y1 });
/** The four faces of a mass. */
export const facesOf = (x0: number, x1: number, y0: number, y1: number): Face[] => SIDES.map((s) => faceOf(s, x0, x1, y0, y1));
/** The length of a face along `u`. */
export const span = (f: Face): number => (f.side === 'front' || f.side === 'back' ? f.x1 - f.x0 : f.y1 - f.y0);

/** A box on a face: `u0..u1` along it, `o0..o1` out of it, `z0..z1` up. */
export function fbox(p: Sink, f: Face, mat: string, u0: number, u1: number, o0: number, o1: number, z0: number, z1: number): void {
  switch (f.side) {
    case 'front': p.box(mat, f.x0 + u0, f.x0 + u1, f.y0 - o1, f.y0 - o0, z0, z1); break;
    case 'back': p.box(mat, f.x1 - u1, f.x1 - u0, f.y1 + o0, f.y1 + o1, z0, z1); break;
    case 'left': p.box(mat, f.x0 - o1, f.x0 - o0, f.y1 - u1, f.y1 - u0, z0, z1); break;
    case 'right': p.box(mat, f.x1 + o0, f.x1 + o1, f.y0 + u0, f.y0 + u1, z0, z1); break;
  }
}

/** A point on a face, in the building's frame. */
export function fpoint(f: Face, u: number, o: number): { x: number; y: number } {
  switch (f.side) {
    case 'front': return { x: f.x0 + u, y: f.y0 - o };
    case 'back': return { x: f.x1 - u, y: f.y1 + o };
    case 'left': return { x: f.x0 - o, y: f.y1 - u };
    case 'right': return { x: f.x1 + o, y: f.y0 + u };
  }
}

/** The angle (radians about three's up axis) that turns a part made facing -y (the front) to face `f`. */
const turn = (f: Face): number => (f.side === 'front' ? 0 : f.side === 'back' ? Math.PI : f.side === 'left' ? -Math.PI / 2 : Math.PI / 2);

/**
 * A floating split with repeats (CGA `split(x){ ~w : Bay }*`): as many bays
 * of about `target` as fit, sharing the length exactly. Returns the edges.
 */
export function repeat(length: number, target: number, min = 1): number[] {
  const n = Math.max(min, Math.round(length / target));
  return Array.from({ length: n + 1 }, (_, i) => (i * length) / n);
}

/** Wall depth: how far the glass and the inner mass stand behind the face. */
export const WALL = 0.32;

export type Head = 'none' | 'cornice' | 'pediment' | 'arch' | 'keystone';

export interface WindowSpec {
  /** Wall material round the opening. */
  readonly wall: string;
  /** Opening width as a share of the bay, height as a share of the storey, sill height (m). */
  readonly w: number;
  readonly h: number;
  readonly sill: number;
  readonly glass?: string;
  readonly frame?: string;
  /** Vertical glazing bars; 1 = a central mullion. */
  readonly mullions?: number;
  /** A horizontal transom at this share of the opening, or none. */
  readonly transom?: number;
  /** A stone surround (architrave) round the opening, in this material. */
  readonly surround?: string;
  readonly head?: Head;
  /** The material of the sill, head and keystone; the surround's when absent. */
  readonly trim?: string;
  /** A small iron balcony (a balconette) at the sill. */
  readonly balconette?: boolean;
}

/**
 * A punched window in one bay of one storey: the wall round the opening
 * (piers, the panel under the sill, the lintel), the reveal, the glass set
 * back with its frame and bars, a projecting sill, and the dressing a style
 * asks for - a surround, a cornice or pediment over it, an arched head.
 */
export function punched(p: Sink, f: Face, u0: number, u1: number, z0: number, z1: number, w: WindowSpec): void {
  const bay = u1 - u0, st = z1 - z0;
  const ow = Math.min(bay - 0.3, bay * w.w), oh = Math.min(st - w.sill - 0.25, st * w.h);
  const a = u0 + (bay - ow) / 2, b = a + ow;
  const s0 = z0 + w.sill, s1 = s0 + oh;
  const arch = w.head === 'arch';
  const archR = ow / 2;
  // The wall round the opening, the face plane at o = 0 and WALL deep.
  fbox(p, f, w.wall, u0, a, -WALL, 0, z0, z1);
  fbox(p, f, w.wall, b, u1, -WALL, 0, z0, z1);
  fbox(p, f, w.wall, a, b, -WALL, 0, z0, s0);
  fbox(p, f, w.wall, a, b, -WALL, 0, arch ? s1 + archR : s1, z1);
  if (arch) archFill(p, f, w.wall, a, b, s1, archR);
  // The glass, set back, and its frame and bars.
  const glass = w.glass ?? 'glass', frame = w.frame ?? 'frame';
  const gTop = arch ? s1 + archR * 0.98 : s1;
  fbox(p, f, glass, a, b, -WALL + 0.02, -WALL + 0.06, s0, gTop);
  const t = 0.07, fo0 = -WALL + 0.06, fo1 = -WALL + 0.12;
  fbox(p, f, frame, a, b, fo0, fo1, s0, s0 + t);
  fbox(p, f, frame, a, a + t, fo0, fo1, s0, s1);
  fbox(p, f, frame, b - t, b, fo0, fo1, s0, s1);
  if (!arch) fbox(p, f, frame, a, b, fo0, fo1, s1 - t, s1);
  for (let k = 1; k <= (w.mullions ?? 1); k++) {
    const x = a + (ow * k) / ((w.mullions ?? 1) + 1);
    fbox(p, f, frame, x - 0.03, x + 0.03, fo0, fo1, s0, gTop);
  }
  if (w.transom !== undefined) {
    const zt = s0 + oh * w.transom;
    fbox(p, f, frame, a, b, fo0, fo1, zt - 0.03, zt + 0.03);
  }
  // The dressing.
  const trim = w.trim ?? w.surround ?? w.wall;
  fbox(p, f, trim, a - 0.12, b + 0.12, 0, 0.1, s0 - 0.12, s0);
  if (w.surround) {
    const sw = 0.16;
    fbox(p, f, w.surround, a - sw, a, 0, 0.06, s0, s1);
    fbox(p, f, w.surround, b, b + sw, 0, 0.06, s0, s1);
    if (!arch) fbox(p, f, w.surround, a - sw, b + sw, 0, 0.06, s1, s1 + sw);
  }
  if (w.head === 'cornice') {
    fbox(p, f, trim, a - 0.25, b + 0.25, 0, 0.12, s1 + 0.16, s1 + 0.26);
    fbox(p, f, trim, a - 0.32, b + 0.32, 0, 0.2, s1 + 0.26, s1 + 0.34);
  } else if (w.head === 'pediment') {
    fbox(p, f, trim, a - 0.3, b + 0.3, 0, 0.18, s1 + 0.16, s1 + 0.26);
    pediment(p, f, trim, a - 0.3, b + 0.3, s1 + 0.26, Math.min(0.55, ow * 0.28), 0.16);
  } else if (w.head === 'keystone' || arch) {
    const c = (a + b) / 2, top = arch ? s1 + archR : s1;
    fbox(p, f, trim, c - 0.14, c + 0.14, 0, 0.1, top - 0.08, top + 0.3);
    if (arch) archRing(p, f, trim, a, b, s1, archR);
  }
  if (w.balconette) {
    fbox(p, f, trim, a - 0.2, b + 0.2, 0, 0.45, s0 - 0.12, s0);
    railFace(p, f, a - 0.15, b + 0.15, 0.42, s0, 0.9);
  }
}

/**
 * A flat piece on a face made from a 2D outline in the face's own plane
 * (`u` across, `z` up), extruded from `o0` to `o1` out of it.
 */
function extrudeOnFace(p: Sink, f: Face, mat: string, shape: Shape, o0: number, o1: number, segments = 16): void {
  const g = new ExtrudeGeometry(shape, { depth: o1 - o0, bevelEnabled: false, curveSegments: segments });
  g.translate(0, 0, o0);
  // UVs in metres on the face (u, z), as the boxes have.
  const pos = g.attributes['position']!, uv = g.attributes['uv']!;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, pos.getX(i), pos.getY(i));
  g.rotateY(turn(f));
  const q = fpoint(f, 0, 0);
  g.translate(q.x, 0, -p.Y(q.y));
  p.pushRaw(mat, g);
}

/** The wall above an arched head: the rectangle over the opening with the round head cut out of it. */
function archFill(p: Sink, f: Face, mat: string, a: number, b: number, z: number, r: number): void {
  const c = (a + b) / 2;
  const s = new Shape();
  s.moveTo(a, z); s.lineTo(a, z + r); s.lineTo(b, z + r); s.lineTo(b, z);
  s.absarc(c, z, r, 0, Math.PI, false);
  extrudeOnFace(p, f, mat, s, -WALL, 0);
}

/** A stone ring round an arched head (an archivolt), a little proud of the wall. */
function archRing(p: Sink, f: Face, mat: string, a: number, b: number, z: number, r: number): void {
  const c = (a + b) / 2, w = 0.22;
  const s = new Shape();
  s.moveTo(c + r, z);
  s.absarc(c, z, r + w, 0, Math.PI, false);
  s.lineTo(c - r, z);
  s.absarc(c, z, r, Math.PI, 0, true);
  extrudeOnFace(p, f, mat, s, 0, 0.08);
}

/** A triangular pediment on a face: a gable `h` high over `u0..u1`, `depth` out. */
export function pediment(p: Sink, f: Face, mat: string, u0: number, u1: number, z: number, h: number, depth: number): void {
  const A = fpoint(f, u0, 0), B = fpoint(f, u1, 0);
  const x0 = Math.min(A.x, B.x), x1 = Math.max(A.x, B.x), y0 = Math.min(A.y, B.y), y1 = Math.max(A.y, B.y);
  if (f.side === 'front') p.gable(mat, x0, x1, f.y0 - depth, f.y0, z, h, 'x');
  else if (f.side === 'back') p.gable(mat, x0, x1, f.y1, f.y1 + depth, z, h, 'x');
  else if (f.side === 'left') p.gable(mat, f.x0 - depth, f.x0, y0, y1, z, h, 'y');
  else p.gable(mat, f.x1, f.x1 + depth, y0, y1, z, h, 'y');
}

/** A railing along a face, `o` out of it. */
export function railFace(p: Sink, f: Face, u0: number, u1: number, o: number, z: number, h = 1.05): void {
  const A = fpoint(f, u0, o), B = fpoint(f, u1, o);
  const horizontal = f.side === 'front' || f.side === 'back';
  if (horizontal) p.rail(Math.min(A.x, B.x), Math.max(A.x, B.x), A.y - 0.03, A.y + 0.03, z, h);
  else p.rail(A.x - 0.03, A.x + 0.03, Math.min(A.y, B.y), Math.max(A.y, B.y), z, h);
}

/**
 * A cornice: a stepped profile of `steps` courses growing out to `depth`
 * (a cyma's silhouette in boxes), with dentils under it when asked.
 */
export function cornice(p: Sink, f: Face, mat: string, u0: number, u1: number, z: number, h: number, depth: number, dentils = false): void {
  const steps = 4;
  for (let k = 0; k < steps; k++) {
    const o = (depth * (k + 1)) / steps;
    const za = z + (h * k) / steps, zb = z + (h * (k + 1)) / steps;
    fbox(p, f, mat, u0 - o * 0.6, u1 + o * 0.6, -0.05, o, za, zb);
  }
  if (dentils) {
    for (let u = u0 + 0.15; u < u1 - 0.1; u += 0.32) fbox(p, f, mat, u, u + 0.16, 0, depth * 0.35, z - 0.18, z);
  }
}

/** A plain band (a string course, a slab edge) across a face. */
export function band(p: Sink, f: Face, mat: string, u0: number, u1: number, z0: number, z1: number, out = 0.08): void {
  fbox(p, f, mat, u0, u1, -0.05, out, z0, z1);
}

/** A pier or pilaster standing proud of a face. */
export function pier(p: Sink, f: Face, mat: string, u: number, w: number, z0: number, z1: number, out = 0.2): void {
  fbox(p, f, mat, u - w / 2, u + w / 2, -0.05, out, z0, z1);
}

/**
 * Rusticated stone: courses with deep joints (the base of a classical
 * front), drawn as blocks a little proud of the wall with gaps between.
 */
export function rustication(p: Sink, f: Face, mat: string, u0: number, u1: number, z0: number, z1: number, course = 0.6): void {
  for (let z = z0; z < z1 - 0.05; z += course) {
    fbox(p, f, mat, u0, u1, -0.05, 0.06, z + 0.05, Math.min(z1, z + course));
  }
}

/** Quoins: alternating long and short stones up a corner of the face (`at` 'start' or 'end' of u). */
export function quoins(p: Sink, f: Face, mat: string, at: 'start' | 'end', z0: number, z1: number, course = 0.55): void {
  const L = span(f);
  let k = 0;
  for (let z = z0; z < z1 - 0.05; z += course, k++) {
    const len = k % 2 ? 0.55 : 0.9;
    const u0 = at === 'start' ? 0 : L - len, u1 = at === 'start' ? len : L;
    fbox(p, f, mat, u0, u1, -0.05, 0.08, z + 0.04, Math.min(z1, z + course));
  }
}

export interface CurtainSpec {
  readonly glass: string;
  readonly mullion: string;
  /** Bay width (m) between vertical mullions. */
  readonly bay: number;
  /** Mullion width and how far it stands out (a fin). */
  readonly mw: number;
  readonly fin: number;
  /** A spandrel panel at each slab, this tall, in this material (absent: glass floor to floor). */
  readonly spandrel?: { readonly h: number; readonly mat: string };
  /** Every `bold`-th mullion is wider (a major mullion), or none. */
  readonly bold?: number;
}

/** A curtain wall over a face: glass, mullions (fins), transoms at the slabs, spandrel panels. */
export function curtain(p: Sink, f: Face, u0: number, u1: number, z0: number, z1: number, storey: number, c: CurtainSpec): void {
  fbox(p, f, c.glass, u0, u1, -0.1, -0.02, z0, z1);
  const edges = repeat(u1 - u0, c.bay);
  edges.forEach((e, i) => {
    const w = c.bold && i % c.bold === 0 ? c.mw * 2 : c.mw;
    fbox(p, f, c.mullion, u0 + e - w / 2, u0 + e + w / 2, -0.05, c.fin, z0, z1);
  });
  for (let z = z0; z < z1 - 0.1; z += storey) {
    if (c.spandrel) fbox(p, f, c.spandrel.mat, u0, u1, -0.06, 0.01, z, z + c.spandrel.h);
    fbox(p, f, c.mullion, u0, u1, -0.05, c.fin * 0.5, z - 0.04, z + 0.04);
  }
}

export type BalconyKind = 'glass' | 'iron' | 'solid';

/** A balcony on a face: a slab out from the wall, its railing (glass panels, iron bars, a solid parapet). */
export function balcony(p: Sink, f: Face, u0: number, u1: number, z: number, depth: number, kind: BalconyKind, slab = 'slab', parapet = 'white'): void {
  fbox(p, f, slab, u0, u1, 0, depth, z - 0.18, z);
  if (kind === 'solid') {
    fbox(p, f, parapet, u0, u1, depth - 0.12, depth, z, z + 1.0);
    fbox(p, f, parapet, u0, u0 + 0.12, 0, depth, z, z + 1.0);
    fbox(p, f, parapet, u1 - 0.12, u1, 0, depth, z, z + 1.0);
    return;
  }
  if (kind === 'glass') {
    fbox(p, f, 'glassRail', u0 + 0.05, u1 - 0.05, depth - 0.06, depth - 0.03, z, z + 1.05);
    fbox(p, f, 'frame', u0, u1, depth - 0.08, depth, z + 1.0, z + 1.06);
    fbox(p, f, 'glassRail', u0, u0 + 0.03, 0.05, depth - 0.05, z, z + 1.05);
    fbox(p, f, 'glassRail', u1 - 0.03, u1, 0.05, depth - 0.05, z, z + 1.05);
    return;
  }
  railFace(p, f, u0, u1, depth - 0.05, z, 1.05);
  for (const u of [u0, u1]) {
    const A = fpoint(f, u, 0.05), B = fpoint(f, u, depth - 0.05);
    if (f.side === 'front' || f.side === 'back') p.rail(A.x - 0.03, A.x + 0.03, Math.min(A.y, B.y), Math.max(A.y, B.y), z, 1.05);
    else p.rail(Math.min(A.x, B.x), Math.max(A.x, B.x), A.y - 0.03, A.y + 0.03, z, 1.05);
  }
}

/** A marquise: a thin canopy out from the wall, hung on rods. */
export function marquise(p: Sink, f: Face, u0: number, u1: number, z: number, depth: number, mat = 'metal'): void {
  fbox(p, f, mat, u0, u1, 0, depth, z, z + 0.16);
  fbox(p, f, 'sconce', u0 + 0.3, u1 - 0.3, depth * 0.3, depth * 0.7, z - 0.03, z);
  for (const u of [u0 + 0.4, u1 - 0.4]) {
    for (let k = 0; k < 6; k++) {
      const t = k / 5;
      fbox(p, f, 'frame', u - 0.025, u + 0.025, depth * t * 0.9, depth * t * 0.9 + 0.05, z + 0.16 + 1.2 * (1 - t), z + 0.16 + 1.2 * (1 - t) + 0.22);
    }
  }
}

/** A shop awning: a sloped fabric hood out from the wall over an opening. */
export function awning(p: Sink, f: Face, u0: number, u1: number, z: number, depth: number, mat: string): void {
  const len = u1 - u0;
  const slope = Math.atan2(0.7, depth);
  const g = new BoxGeometry(len, 0.06, Math.hypot(depth, 0.7));
  // Made facing the front (out = three's +z): the outer edge tips down.
  g.rotateX(slope);
  const c = fpoint(f, (u0 + u1) / 2, depth / 2);
  g.rotateY(turn(f));
  g.translate(c.x, z - 0.35, -p.Y(c.y));
  p.pushRaw(mat, g);
  // The valance: a short drop at the front edge.
  fbox(p, f, mat, u0, u1, depth - 0.04, depth, z - 0.95, z - 0.7);
}

/**
 * A door bay: a glazed double door (or a timber one) in a deep frame, a
 * transom light over it, an arched head for a classical portal.
 */
export function door(p: Sink, f: Face, u0: number, u1: number, z0: number, h: number, opts: { wall: string; trim: string; leaf?: string; frame?: string; arch?: boolean; portal?: boolean }): void {
  const w = u1 - u0;
  const a = u0 + 0.15, b = u1 - 0.15;
  fbox(p, f, opts.wall, u0 - 0.01, a, -WALL, 0, z0, z0 + h);
  fbox(p, f, opts.wall, b, u1 + 0.01, -WALL, 0, z0, z0 + h);
  const dh = Math.min(h - 0.4, 2.8);
  const leaf = opts.leaf ?? 'glassLit', frame = opts.frame ?? 'frame';
  // The leaves: glass in a frame, the lobby lit behind; a frame round each leaf, a push bar.
  fbox(p, f, leaf, a, b, -WALL + 0.01, -WALL + 0.05, z0, z0 + dh);
  const t = 0.09, mid = (a + b) / 2;
  for (const [x0, x1] of [[a, a + t], [mid - t, mid + t], [b - t, b]] as const) fbox(p, f, frame, x0, x1, -WALL + 0.05, -WALL + 0.14, z0, z0 + dh);
  fbox(p, f, frame, a, b, -WALL + 0.05, -WALL + 0.14, z0, z0 + 0.2);
  fbox(p, f, frame, a, b, -WALL + 0.05, -WALL + 0.14, z0 + dh - t, z0 + dh);
  // Handles.
  for (const s of [-1, 1]) fbox(p, f, 'gold', mid + s * 0.18 - 0.03, mid + s * 0.18 + 0.03, -WALL + 0.14, -WALL + 0.2, z0 + 0.9, z0 + 1.4);
  if (opts.arch) {
    const r = (b - a) / 2;
    fbox(p, f, leaf, a, b, -WALL + 0.01, -WALL + 0.05, z0 + dh, z0 + dh + r);
    for (let k = 1; k < 4; k++) { const u = a + ((b - a) * k) / 4; fbox(p, f, frame, u - 0.035, u + 0.035, -WALL + 0.05, -WALL + 0.12, z0 + dh, z0 + dh + r * 0.95); }
    archFill(p, f, opts.wall, a, b, z0 + dh, r);
    archRing(p, f, opts.trim, a, b, z0 + dh, r);
    fbox(p, f, opts.wall, a, b, -WALL, 0, z0 + dh + r, z0 + h);
  } else {
    fbox(p, f, leaf, a, b, -WALL + 0.01, -WALL + 0.05, z0 + dh, z0 + h - 0.15);
    fbox(p, f, frame, a, b, -WALL + 0.05, -WALL + 0.14, z0 + h - 0.15, z0 + h);
  }
  if (opts.portal) {
    fbox(p, f, opts.trim, u0 - 0.35, u0 + 0.05, 0, 0.25, z0, z0 + h);
    fbox(p, f, opts.trim, u1 - 0.05, u1 + 0.35, 0, 0.25, z0, z0 + h);
    fbox(p, f, opts.trim, u0 - 0.45, u1 + 0.45, 0, 0.3, z0 + h, z0 + h + 0.4);
  }
  void w;
}

/** A shopfront bay: glass from a low stallriser to a fascia, mullions, a sign band. */
export function shopfront(p: Sink, f: Face, u0: number, u1: number, z0: number, z1: number, wall: string, fascia: string): void {
  fbox(p, f, wall, u0, u1, -WALL, 0, z0, z0 + 0.45);
  fbox(p, f, fascia, u0, u1, -WALL, 0.05, z1 - 0.7, z1);
  fbox(p, f, 'podiumGlass', u0, u1, -WALL + 0.02, -WALL + 0.06, z0 + 0.45, z1 - 0.7);
  const n = Math.max(1, Math.round((u1 - u0) / 1.6));
  for (let k = 0; k <= n; k++) {
    const u = u0 + ((u1 - u0) * k) / n;
    fbox(p, f, 'frame', u - 0.04, u + 0.04, -WALL + 0.04, -WALL + 0.12, z0 + 0.45, z1 - 0.7);
  }
  fbox(p, f, 'frame', u0, u1, -WALL + 0.04, -WALL + 0.12, z1 - 1.3, z1 - 1.24);
}

/**
 * A mansard roof over a rectangle: a steep lower slope (a frustum) with
 * dormers through it, a low upper slope, a crest rail at the curb; the
 * dormers on every side, `every` metres apart.
 */
export function mansard(p: Sink, x0: number, x1: number, y0: number, y1: number, z: number, h: number, mat: string, trim: string, every = 3.2): void {
  const inset = h * 0.32;
  // The lower, steep slope: a frustum from the full plan to the inset curb.
  p.hip(mat, x0, x1, y0, y1, z, h, 1 - (2 * inset) / Math.min(x1 - x0, y1 - y0));
  // The upper slope, almost flat.
  p.hip(mat, x0 + inset, x1 - inset, y0 + inset, y1 - inset, z + h, h * 0.18, 0.55);
  // Cresting at the curb.
  for (const f of facesOf(x0 + inset, x1 - inset, y0 + inset, y1 - inset)) fbox(p, f, trim, 0, span(f), 0, 0.06, z + h, z + h + 0.12);
  // Dormers: a box with a window and a pediment, standing out of the slope.
  for (const f of facesOf(x0, x1, y0, y1)) {
    const L = span(f);
    const edges = repeat(L - 2 * inset, every);
    for (let i = 0; i + 1 < edges.length; i++) {
      const c = inset + (edges[i]! + edges[i + 1]!) / 2;
      const dw = Math.min(1.5, every * 0.42);
      const zb = z + h * 0.18, zt = zb + h * 0.55;
      fbox(p, f, trim, c - dw / 2 - 0.12, c + dw / 2 + 0.12, -inset * 0.6, 0.1 - inset * 0.25, zb, zt);
      fbox(p, f, 'glass', c - dw / 2 + 0.1, c + dw / 2 - 0.1, -inset * 0.25 + 0.06, -inset * 0.25 + 0.12, zb + 0.15, zt - 0.1);
      fbox(p, f, 'frame', c - 0.03, c + 0.03, -inset * 0.25 + 0.1, -inset * 0.25 + 0.16, zb + 0.15, zt - 0.1);
      const pf = { ...f, x0: f.x0 + (f.side === 'left' ? inset * 0.25 : 0), x1: f.x1 - (f.side === 'right' ? inset * 0.25 : 0),
        y0: f.y0 + (f.side === 'front' ? inset * 0.25 : 0), y1: f.y1 - (f.side === 'back' ? inset * 0.25 : 0) };
      pediment(p, pf, trim, c - dw / 2 - 0.2, c + dw / 2 + 0.2, zt, 0.45, inset * 0.5);
    }
  }
}

/** A spire: a tapering mast of stacked prisms ending in a needle (an Art Deco crown's top). */
export function spire(p: Sink, x: number, y: number, z: number, h: number, mat: string, r = 0.9): void {
  let zz = z, rr = r;
  for (let k = 0; k < 4; k++) {
    const hh = h * 0.12;
    const g = new CylinderGeometry(rr * 0.85, rr, hh, 8);
    g.translate(x, zz + hh / 2, -p.Y(y));
    p.pushRaw(mat, g);
    zz += hh; rr *= 0.72;
  }
  const needle = new ConeGeometry(rr, h - (zz - z), 8);
  needle.translate(x, zz + (h - (zz - z)) / 2, -p.Y(y));
  p.pushRaw(mat, needle);
}

/** Roof plant: a lift overrun, units and a water tank, kept back from the edge. */
export function roofPlant(p: Sink, x0: number, x1: number, y0: number, y1: number, z: number, mat = 'concreteLight'): void {
  const w = x1 - x0, d = y1 - y0;
  p.box(mat, x0 + w * 0.3, x0 + w * 0.62, y0 + d * 0.35, y0 + d * 0.7, z, z + 2.8);
  p.box('roofing', x0 + w * 0.28, x0 + w * 0.64, y0 + d * 0.33, y0 + d * 0.72, z + 2.8, z + 2.95);
  for (const fx of [0.15, 0.75]) p.box('metal', x0 + w * fx, x0 + w * fx + 1.4, y0 + d * 0.2, y0 + d * 0.2 + 1.1, z, z + 1.2);
}

/** A finial: a pedestal, a ball and a point (on a mansard's corners, a parapet's posts). */
export function finial(p: Sink, x: number, y: number, z: number, h: number, mat: string, cap = mat): void {
  p.box(mat, x - h * 0.12, x + h * 0.12, y - h * 0.12, y + h * 0.12, z, z + h * 0.3);
  const ball = new CylinderGeometry(h * 0.1, h * 0.14, h * 0.2, 8);
  ball.translate(x, z + h * 0.4, -p.Y(y));
  p.pushRaw(cap, ball);
  const point = new ConeGeometry(h * 0.08, h * 0.5, 8);
  point.translate(x, z + h * 0.75, -p.Y(y));
  p.pushRaw(cap, point);
}

/**
 * A curved (bell) mansard over a rectangle: the lower slope bowed out, in
 * `n` frustums whose pitch flattens as they rise, a flat top inside a stone
 * curb. Returns the inset of the top.
 */
export function bellMansard(p: Sink, x0: number, x1: number, y0: number, y1: number, z: number, h: number, inset: number, mat: string): number {
  // The profile of a bell: steep at the eaves, flattening to the curb (a quarter ellipse).
  const n = 4;
  let zz = z;
  let prev = 0;
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const inNow = inset * (1 - Math.cos((t * Math.PI) / 2));
    const hh = h * (Math.sin((t * Math.PI) / 2) - Math.sin(((k - 1) / n * Math.PI) / 2));
    const a = Math.min(x1 - x0, y1 - y0) - 2 * prev;
    p.hip(mat, x0 + prev, x1 - prev, y0 + prev, y1 - prev, zz, hh, Math.max(0.05, 1 - (2 * (inNow - prev)) / a));
    zz += hh; prev = inNow;
  }
  return inset;
}

/**
 * A dormer through a roof slope on face `f`: a stone frame with a
 * round-headed window, its sides, a small hood, a finial over it. `out` is
 * how far its face stands out of the face's plane (negative: back in the slope).
 */
export function archedDormer(p: Sink, f: Face, c: number, w: number, z: number, h: number, out: number, depth: number, frame: string, glass = 'glassLit'): void {
  const r = w / 2;
  // The cheeks and the face.
  fbox(p, f, frame, c - r - 0.15, c + r + 0.15, out - depth, out, z, z + h - r);
  // The round head, in slices.
  for (let k = 0; k < 5; k++) {
    const za = z + h - r + (r * k) / 5, zb = z + h - r + (r * (k + 1)) / 5;
    const half = Math.sqrt(Math.max(0, (r + 0.15) * (r + 0.15) - ((za - (z + h - r)) ** 2))) ;
    fbox(p, f, frame, c - half, c + half, out - depth, out, za, zb);
  }
  // The window, set in.
  fbox(p, f, glass, c - r + 0.12, c + r - 0.12, out + 0.01, out + 0.04, z + 0.15, z + h - r * 0.35);
  fbox(p, f, 'frame', c - 0.03, c + 0.03, out + 0.03, out + 0.06, z + 0.15, z + h - r * 0.35);
  // The hood and the finial.
  fbox(p, f, frame, c - r - 0.25, c + r + 0.25, out - depth, out + 0.12, z + h - 0.05, z + h + 0.12);
  const q = fpoint(f, c, out - depth / 2);
  finial(p, q.x, q.y, z + h + 0.1, 0.7, frame);
}

/** A balustrade along a face: a base, a rail, pedestals every `every` m, balusters between. */
export function balustrade(p: Sink, f: Face, u0: number, u1: number, z: number, h: number, o: number, mat: string, every = 3, filled?: string): void {
  fbox(p, f, mat, u0, u1, o - 0.3, o, z, z + 0.15);
  fbox(p, f, mat, u0, u1, o - 0.32, o + 0.02, z + h - 0.15, z + h);
  const posts = repeat(u1 - u0, every);
  for (const e of posts) fbox(p, f, mat, u0 + e - 0.3, u0 + e + 0.3, o - 0.34, o + 0.04, z, z + h + 0.12);
  for (let i = 0; i + 1 < posts.length; i++) {
    const a = u0 + posts[i]! + 0.3, b = u0 + posts[i + 1]! - 0.3;
    if (filled) { fbox(p, f, filled, a, b, o - 0.25, o - 0.1, z + 0.15, z + h - 0.15); continue; }
    for (let u = a + 0.12; u < b - 0.05; u += 0.24) fbox(p, f, mat, u - 0.05, u + 0.05, o - 0.22, o - 0.08, z + 0.15, z + h - 0.15);
  }
}

/** Consoles (modillions) under a cornice, every `every` m. */
export function consoles(p: Sink, f: Face, mat: string, u0: number, u1: number, z: number, out: number, every = 0.9): void {
  for (let u = u0 + every / 2; u < u1; u += every) {
    fbox(p, f, mat, u - 0.09, u + 0.09, 0, out, z - 0.3, z);
    fbox(p, f, mat, u - 0.09, u + 0.09, 0, out * 0.5, z - 0.55, z - 0.3);
  }
}

/**
 * A carved panel (a cartouche) on a face, in relief: a raised frame, an oval
 * boss in the middle and a round boss either side.
 */
export function cartouche(p: Sink, f: Face, u0: number, u1: number, z0: number, z1: number, mat = 'stoneLight'): void {
  const t = 0.06;
  fbox(p, f, mat, u0, u1, 0, 0.06, z0, z0 + t);
  fbox(p, f, mat, u0, u1, 0, 0.06, z1 - t, z1);
  fbox(p, f, mat, u0, u0 + t, 0, 0.06, z0, z1);
  fbox(p, f, mat, u1 - t, u1, 0, 0.06, z0, z1);
  const h = z1 - z0, c = (u0 + u1) / 2, zc = (z0 + z1) / 2;
  const boss = (u: number, rx: number, rz: number, out: number): void => {
    const g = new CylinderGeometry(1, 1, out, 14);
    g.rotateX(Math.PI / 2);
    g.scale(rx, rz, 1);
    const q = fpoint(f, u, out / 2);
    g.rotateY(turn(f));
    g.translate(q.x, zc, -p.Y(q.y));
    p.pushRaw(mat, g);
  };
  boss(c, Math.min(0.28, (u1 - u0) * 0.2), h * 0.36, 0.12);
  for (const sx of [-1, 1]) boss(c + sx * (u1 - u0) * 0.3, h * 0.16, h * 0.16, 0.08);
}

/** A square planter on the ground with a tree, or a hedge in a long trough. */
export function plantedTree(p: Sink, x: number, y: number, z = 0.2, h = 4.5): void {
  p.box('stoneLight', x - 0.75, x + 0.75, y - 0.75, y + 0.75, z, z + 0.5);
  p.box('soil', x - 0.62, x + 0.62, y - 0.62, y + 0.62, z + 0.5, z + 0.52);
  p.cylinder('woodDark', x, y, z + 0.5, z + h * 0.5, 0.09);
  p.bush(x, y, z + h * 0.42, h * 0.22, false);
  p.bush(x + 0.25, y - 0.15, z + h * 0.62, h * 0.17, true);
  p.bush(x - 0.3, y + 0.1, z + h * 0.55, h * 0.16, false);
}
export function hedge(p: Sink, x0: number, x1: number, y0: number, y1: number, z = 0.2): void {
  p.box('stoneLight', x0, x1, y0, y1, z, z + 0.45);
  p.box('leafDark', x0 + 0.1, x1 - 0.1, y0 + 0.1, y1 - 0.1, z + 0.45, z + 0.95);
}
/** A black street lamp with a lantern. */
export function lampPost(p: Sink, x: number, y: number, z = 0.2, h = 3.4): void {
  p.cylinder('blackSteel', x, y, z, z + 0.3, 0.12);
  p.cylinder('blackSteel', x, y, z + 0.3, z + h, 0.05);
  p.box('blackSteel', x - 0.16, x + 0.16, y - 0.16, y + 0.16, z + h, z + h + 0.06);
  p.box('sconce', x - 0.12, x + 0.12, y - 0.12, y + 0.12, z + h + 0.06, z + h + 0.45);
  p.box('blackSteel', x - 0.17, x + 0.17, y - 0.17, y + 0.17, z + h + 0.45, z + h + 0.52);
}

/** A planted terrace edge: planters along it with shrubs and small trees. */
export function terraceGarden(p: Sink, f: Face, u0: number, u1: number, z: number, trees = true): void {
  fbox(p, f, 'pot', u0, u1, -1.0, -0.2, z, z + 0.55);
  for (let u = u0 + 0.6; u < u1 - 0.3; u += 1.2) {
    const q = fpoint(f, u, -0.6);
    p.bush(q.x, q.y, z + 0.45, 0.42, Math.round(u) % 2 === 0);
  }
  if (trees) {
    for (let u = u0 + 1.5; u < u1 - 1; u += 4.5) {
      const q = fpoint(f, u, -0.6);
      p.cylinder('woodDark', q.x, q.y, z + 0.5, z + 1.8, 0.07);
      p.bush(q.x, q.y, z + 1.5, 0.75, false);
      p.bush(q.x + 0.2, q.y, z + 2.0, 0.5, true);
    }
  }
}
