/** CLOTH, as CLO 3D and Marvelous Designer make a garment: flat pattern pieces triangulated, placed round the body, sewn edge to edge, and draped by
 *  position based dynamics (XPBD, Müller et al.; the Ten Minute Physics cloth: substeps, compliant distance and bending constraints) with the body pushing
 *  the cloth out. Units: the base mesh's decimetres. */

/** A pattern piece: an outline in its own plane (dm), a grid inside it, and where it is placed round the body. */
export interface Pattern {
  readonly name: string;
  /** The outline, counter-clockwise, [x, y] in dm. */
  readonly outline: readonly (readonly [number, number])[];
  /** Placement: the piece's plane is bent round a cylinder about the body's axis at `radius`, its middle at `angle` (0 the front), its top at `top`. */
  readonly angle: number;
  readonly radius: number;
  readonly top: number;
  /** A waistband: the top edge held round the body at this radius (dm), gathered. */
  readonly band?: number;
}

/** A seam: an edge of one piece sewn to an edge of another, as outline vertex ranges [from, to] (inclusive, in outline order; the second runs reversed). */
export interface Seam { readonly a: number; readonly ea: readonly [number, number]; readonly b: number; readonly eb: readonly [number, number] }

export interface Garment { readonly name: string; readonly patterns: readonly Pattern[]; readonly seams: readonly Seam[] }

/** Is (x, y) inside the polygon. */
function inside(poly: readonly (readonly [number, number])[], x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** The fastest a particle moves, dm/s. */
const MAX_SPEED = 12;

/** A simulated garment: particles, triangles, constraints. */
export class ClothSim {
  pos: Float32Array;
  prev: Float32Array;
  vel: Float32Array;
  invMass: Float32Array;
  tris: Uint32Array;
  /** Pairs and rest lengths: stretch (edges), bend (across triangle pairs), seams (pulled to zero). */
  private readonly stretch: Uint32Array;
  private readonly stretchLen: Float32Array;
  private readonly bend: Uint32Array;
  private readonly bendLen: Float32Array;
  private readonly seams: Uint32Array;
  /** Which piece each particle belongs to (for colouring), and each particle's flat pattern coordinates (u v, dm). */
  readonly piece: Uint8Array;
  readonly uv: Float32Array;
  stretchCompliance = 0;
  bendCompliance = 0.4;
  /** How hard seams pull, 0..1 a substep. */
  seamPull = 0.08;

  constructor(readonly garment: Garment, readonly cell: number, axis: readonly [number, number]) {
    const pts: number[] = [], uv: number[] = [], piece: number[] = [], tris: number[] = [];
    const edgeIndex: Map<string, number>[] = [];
    const outlineVert: number[][] = [];
    garment.patterns.forEach((pat, pi) => {
      // A grid over the outline's box, kept where inside, plus the outline's own vertices (sampled along each edge) so seams have exact points.
      const xs = pat.outline.map((p) => p[0]), ys = pat.outline.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const base = pts.length / 3;
      const local: [number, number][] = [];
      const map = new Map<string, number>();
      const nx = Math.ceil((x1 - x0) / cell), ny = Math.ceil((y1 - y0) / cell);
      for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
        const x = x0 + i * cell, y = y0 + j * cell;
        if (!inside(pat.outline, x, y)) continue;
        map.set(`${i},${j}`, local.length);
        local.push([x, y]);
      }
      for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        const a = map.get(`${i},${j}`), b = map.get(`${i + 1},${j}`), c = map.get(`${i},${j + 1}`), d = map.get(`${i + 1},${j + 1}`);
        if (a !== undefined && b !== undefined && c !== undefined) tris.push(base + a, base + b, base + c);
        if (b !== undefined && d !== undefined && c !== undefined) tris.push(base + b, base + d, base + c);
      }
      // The outline's vertices: snapped to the nearest grid particle (each outline vertex is a seam's anchor).
      outlineVert.push(pat.outline.map(([x, y]) => {
        let best = 0, bd = Infinity;
        local.forEach(([lx, ly], k) => { const d = (lx - x) ** 2 + (ly - y) ** 2; if (d < bd) { bd = d; best = k; } });
        return base + best;
      }));
      edgeIndex.push(map as unknown as Map<string, number>);
      // Placed: bent round the body's axis.
      const width = x1 - x0;
      // The body's width at the edge of the wrap: past it (sleeves) the piece goes straight out and down along the arm.
      const half = Math.PI / 2 * pat.radius;
      const front = Math.cos(pat.angle) >= 0 ? 1 : -1;
      for (const [x, y] of local) {
        const u = x - (x0 + width / 2);
        const out = Math.abs(u) - half;
        if (out > 0) {
          pts.push(axis[0] + Math.sign(u) * front * (pat.radius + out * 0.8), pat.top - (y1 - y) - out * 0.55, axis[1] + front * 0.12);
        } else {
          const a = pat.angle + u / pat.radius;
          // The waistband's row drawn in to the body's own girth.
          const r = pat.band && y1 - y < cell * 1.5 ? pat.band : pat.radius;
          pts.push(axis[0] + Math.sin(a) * r, pat.top - (y1 - y), axis[1] + Math.cos(a) * r);
        }
        uv.push(x, y);
        piece.push(pi);
      }
    });
    this.pos = Float32Array.from(pts);
    this.prev = Float32Array.from(pts);
    this.vel = new Float32Array(pts.length);
    this.invMass = new Float32Array(pts.length / 3).fill(1);
    // The waistband held where it was placed.
    let k;
    garment.patterns.forEach((pat, pi) => {
      if (!pat.band) return;
      const ys = pat.outline.map((q) => q[1]);
      const y1 = Math.max(...ys);
      for (k = 0; k < piece.length; k++) if (piece[k] === pi && y1 - uv[k * 2 + 1]! < cell * 1.5) this.invMass[k] = 0;
    });
    this.tris = Uint32Array.from(tris);
    this.piece = Uint8Array.from(piece);
    this.uv = Float32Array.from(uv);
    // Stretch: every triangle edge once; bend: the far corners of each pair of triangles sharing an edge.
    const edges = new Map<string, number[]>();
    for (let t = 0; t < tris.length; t += 3) for (let k = 0; k < 3; k++) {
      const a = tris[t + k]!, b = tris[t + (k + 1) % 3]!, c = tris[t + (k + 2) % 3]!;
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const list = edges.get(key);
      if (list) list.push(c); else edges.set(key, [c]);
    }
    const s: number[] = [], sl: number[] = [], bd: number[] = [], bl: number[] = [];
    const dist = (a: number, b: number): number => Math.hypot(this.uv[a * 2]! - this.uv[b * 2]!, this.uv[a * 2 + 1]! - this.uv[b * 2 + 1]!);
    for (const [key, opp] of edges) {
      const [a, b] = key.split(',').map(Number) as [number, number];
      s.push(a, b); sl.push(dist(a, b));
      if (opp.length === 2) { bd.push(opp[0]!, opp[1]!); bl.push(dist(opp[0]!, opp[1]!)); }
    }
    this.stretch = Uint32Array.from(s); this.stretchLen = Float32Array.from(sl);
    this.bend = Uint32Array.from(bd); this.bendLen = Float32Array.from(bl);
    // Seams: the two edges walked together, as many pairs as the longer has points, particles along each picked from the grid boundary.
    const sp: number[] = [];
    for (const seam of garment.seams) {
      const A = this.edgeParticles(seam.a, seam.ea, outlineVert[seam.a]!), B = this.edgeParticles(seam.b, seam.eb, outlineVert[seam.b]!).reverse();
      const n = Math.max(A.length, B.length);
      const start = sp.length;
      for (let i = 0; i < n; i++) sp.push(A[Math.round(i * (A.length - 1) / Math.max(1, n - 1))]!, B[Math.round(i * (B.length - 1) / Math.max(1, n - 1))]!);
      // A strip of triangles along the seam between the two edges: the grid's stair-stepped borders never close by themselves (a slit at the side).
      for (let i = start; i + 3 < sp.length; i += 2) {
        const a1 = sp[i]!, b1 = sp[i + 1]!, a2 = sp[i + 2]!, b2 = sp[i + 3]!;
        if (a1 !== a2) tris.push(a1, a2, b1);
        if (b1 !== b2) tris.push(b1, a2, b2);
      }
    }
    this.seams = Uint32Array.from(sp);
    this.tris = Uint32Array.from(tris);
  }

  /** The particles along an outline edge of a piece (outline vertices `from`..`to`), in order: boundary particles nearest the straight line between them. */
  private edgeParticles(pi: number, [from, to]: readonly [number, number], outline: number[]): number[] {
    const pat = this.garment.patterns[pi]!;
    const out: number[] = [];
    for (let k = from; k < to; k++) {
      const L = pat.outline.length;
      const [ax, ay] = pat.outline[k % L]!, [bx, by] = pat.outline[(k + 1) % L]!;
      const len = Math.hypot(bx - ax, by - ay);
      // Sampled finer than the grid: every border particle along the edge is in the seam (none left out to open a hole).
      const steps = Math.max(1, Math.round(len / (this.cell * 0.4)));
      for (let s = 0; s <= steps; s++) {
        const x = ax + (bx - ax) * s / steps, y = ay + (by - ay) * s / steps;
        let best = -1, bd = Infinity;
        for (let p = 0; p < this.piece.length; p++) {
          if (this.piece[p] !== pi) continue;
          const d = (this.uv[p * 2]! - x) ** 2 + (this.uv[p * 2 + 1]! - y) ** 2;
          if (d < bd) { bd = d; best = p; }
        }
        if (best >= 0 && out[out.length - 1] !== best) out.push(best);
      }
    }
    void outline;
    return out;
  }

  private solve(pairs: Uint32Array, rest: Float32Array, compliance: number, dt: number): void {
    const p = this.pos, w = this.invMass;
    const alpha = compliance / dt / dt;
    for (let c = 0; c < rest.length; c++) {
      const a = pairs[c * 2]!, b = pairs[c * 2 + 1]!;
      const wa = w[a]!, wb = w[b]!, ws = wa + wb;
      if (ws === 0) continue;
      const dx = p[b * 3]! - p[a * 3]!, dy = p[b * 3 + 1]! - p[a * 3 + 1]!, dz = p[b * 3 + 2]! - p[a * 3 + 2]!;
      const len = Math.hypot(dx, dy, dz);
      if (len === 0) continue;
      const s = -(len - rest[c]!) / (ws + alpha) / len;
      p[a * 3] = p[a * 3]! - dx * s * wa; p[a * 3 + 1] = p[a * 3 + 1]! - dy * s * wa; p[a * 3 + 2] = p[a * 3 + 2]! - dz * s * wa;
      p[b * 3] = p[b * 3]! + dx * s * wb; p[b * 3 + 1] = p[b * 3 + 1]! + dy * s * wb; p[b * 3 + 2] = p[b * 3 + 2]! + dz * s * wb;
    }
  }

  private sew(): void {
    const p = this.pos, k = this.seamPull;
    for (let c = 0; c < this.seams.length; c += 2) {
      const a = this.seams[c]!, b = this.seams[c + 1]!;
      for (let i = 0; i < 3; i++) {
        const m = (p[a * 3 + i]! + p[b * 3 + i]!) / 2;
        p[a * 3 + i] = p[a * 3 + i]! + (m - p[a * 3 + i]!) * k;
        p[b * 3 + i] = p[b * 3 + i]! + (m - p[b * 3 + i]!) * k;
      }
    }
  }

  /** One frame: `substeps` of integrate, solve (stretch, bend, seams), collide, update velocities (the Ten Minute Physics loop). */
  simulate(dt: number, substeps: number, gravity: number, collide: (p: Float32Array, i: number) => void): void {
    const h = dt / substeps;
    const p = this.pos, v = this.vel, prev = this.prev, w = this.invMass;
    const n = p.length / 3;
    for (let s = 0; s < substeps; s++) {
      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        v[i * 3 + 1] = v[i * 3 + 1]! - gravity * h;
        prev[i * 3] = p[i * 3]!; prev[i * 3 + 1] = p[i * 3 + 1]!; prev[i * 3 + 2] = p[i * 3 + 2]!;
        p[i * 3] = p[i * 3]! + v[i * 3]! * h; p[i * 3 + 1] = p[i * 3 + 1]! + v[i * 3 + 1]! * h; p[i * 3 + 2] = p[i * 3 + 2]! + v[i * 3 + 2]! * h;
      }
      this.solve(this.stretch, this.stretchLen, this.stretchCompliance, h);
      this.solve(this.bend, this.bendLen, this.bendCompliance, h);
      this.sew();
      for (let i = 0; i < n; i++) collide(p, i * 3);
      for (let i = 0; i < n; i++) {
        if (w[i] === 0) continue;
        // Velocities from the move, damped a little (air), as PBD does.
        v[i * 3] = (p[i * 3]! - prev[i * 3]!) / h * 0.99; v[i * 3 + 1] = (p[i * 3 + 1]! - prev[i * 3 + 1]!) / h * 0.99; v[i * 3 + 2] = (p[i * 3 + 2]! - prev[i * 3 + 2]!) / h * 0.99;
        // Seams closing and the body pushing are corrections, not motion: their speed is capped (Marvelous calls the closing 'sewing', not a throw).
        const sp = Math.hypot(v[i * 3]!, v[i * 3 + 1]!, v[i * 3 + 2]!);
        if (sp > MAX_SPEED) { const k = MAX_SPEED / sp; v[i * 3] = v[i * 3]! * k; v[i * 3 + 1] = v[i * 3 + 1]! * k; v[i * 3 + 2] = v[i * 3 + 2]! * k; }
      }
    }
    // Each seam's two sides drawn together once it is nearly closed: the garment shows sewn, not gaping.
    const p2 = this.pos;
    for (let c = 0; c < this.seams.length; c += 2) {
      const a = this.seams[c]!, b = this.seams[c + 1]!;
      const d = Math.hypot(p2[a * 3]! - p2[b * 3]!, p2[a * 3 + 1]! - p2[b * 3 + 1]!, p2[a * 3 + 2]! - p2[b * 3 + 2]!);
      if (d > 0.25) continue;
      for (let k = 0; k < 3; k++) { const m = (p2[a * 3 + k]! + p2[b * 3 + k]!) / 2; p2[a * 3 + k] = m; p2[b * 3 + k] = m; }
    }
  }

  /** The particle nearest to `x` (a grab). */
  nearest(x: number, y: number, z: number): number {
    let best = -1, bd = Infinity;
    for (let i = 0; i < this.pos.length / 3; i++) {
      const d = (this.pos[i * 3]! - x) ** 2 + (this.pos[i * 3 + 1]! - y) ** 2 + (this.pos[i * 3 + 2]! - z) ** 2;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
}

/** Ready patterns, measured on the body (`girth` round the chest, `waist`, `hips`, heights in dm), as a pattern maker drafts them. */
export interface Measures { readonly chestY: number; readonly waistY: number; readonly hipY: number; readonly kneeY: number; readonly shoulderY: number; readonly radius: number; readonly axis: readonly [number, number] }

/** Front and back of one outline, wrapped round the body and sewn at the listed edge pairs (each front range to the back's mirrored range, and back to front). */
function pair(name: string, outline: readonly (readonly [number, number])[], m: Measures, top: number, ease: number, sides: readonly (readonly [readonly [number, number], readonly [number, number]])[], band?: number): Garment {
  const r = m.radius * ease;
  const seams: Seam[] = [];
  for (const [ea, eb] of sides) { seams.push({ a: 0, ea, b: 1, eb }); seams.push({ a: 1, ea, b: 0, eb }); }
  const b = band !== undefined ? { band } : {};
  return { name, patterns: [{ name: `${name}-frente`, outline, angle: 0, radius: r, top, ...b }, { name: `${name}-costas`, outline, angle: Math.PI, radius: r, top, ...b }], seams };
}

/** Pattern options: length added (dm), ease (fullness, 1 snug), flare at the hem (dm); the sleeve's length past the shoulder (dm, 0 a tank top,
 *  1.6 a T-shirt, 2 to the elbow) and the neckline's depth (dm), as the bodice blocks of pattern making (FreeSewing's Brian/Teagan) take them. */
export interface Cut { readonly length: number; readonly ease: number; readonly flare: number; readonly sleeve?: number; readonly neck?: number }

export const PATTERNS: Readonly<Record<string, (m: Measures, c: Cut) => Garment>> = {
  // Hem at y 0, waist at the top; corners 0 hem-left, 1 hem-right, 2 waist-right, 3 waist-left.
  saia: (m, c) => {
    const w = m.radius * Math.PI * c.ease, len = m.hipY - m.kneeY + 1.0 + c.length, f = c.flare;
    return pair('saia', [[-w / 2 - f, 0], [w / 2 + f, 0], [w / 2, len], [-w / 2, len]], m, m.waistY + 0.2, c.ease, [[[1, 2], [3, 4]]], m.radius * 0.98);
  },
  // 0 hem-left, 1 hem-right, 2 underarm-right, 3 sleeve-bottom-right, 4 sleeve-top-right, 5 neck-right, 6 neck-left, 7 sleeve-top-left, 8 sleeve-bottom-left, 9 underarm-left.
  camiseta: (m, c) => {
    const w = m.radius * Math.PI * c.ease, len = m.shoulderY - m.hipY + 0.5 + c.length;
    // Drafted before sleeves and necklines were options: its outline as it was, so a garment kept then still matches its particles.
    if (c.sleeve === undefined && c.neck === undefined) {
      const sl = 1.6;
      return pair('camiseta', [[-w / 2 - c.flare * 0.3, 0], [w / 2 + c.flare * 0.3, 0], [w / 2, len - 1.5], [w / 2 + sl, len - 1.0], [w / 2 + sl * 0.7, len], [w / 4, len + 0.1],
        [-w / 4, len + 0.1], [-w / 2 - sl * 0.7, len], [-w / 2 - sl, len - 1.0], [-w / 2, len - 1.5]], m, m.shoulderY + 0.35, c.ease,
      [[[1, 2], [9, 10]], [[2, 3], [8, 9]], [[4, 5], [6, 7]]]);
    }
    // 0 hem-left, 1 hem-right, 2 underarm-right, 3 sleeve-bottom-right, 4 sleeve-top-right, 5 neck-right, 6 neck-middle, 7 neck-left, 8 sleeve-top-left, 9 sleeve-bottom-left, 10 underarm-left.
    // A longer sleeve hangs down the arm: its bottom edge drops as it reaches out.
    const sl = Math.max(0.15, c.sleeve ?? 1.6), neck = c.neck ?? 0.1, drop = Math.min(1.0, 0.5 + sl * 0.1), top = sl > 2 ? 0.3 : 0;
    return pair('camiseta', [[-w / 2 - c.flare * 0.3, 0], [w / 2 + c.flare * 0.3, 0], [w / 2, len - 1.5], [w / 2 + sl, len - 0.5 - drop], [w / 2 + sl * 0.85, len - top], [w / 4, len + 0.1],
      [0, len + 0.1 - neck], [-w / 4, len + 0.1], [-w / 2 - sl * 0.85, len - top], [-w / 2 - sl, len - 0.5 - drop], [-w / 2, len - 1.5]], m, m.shoulderY + 0.35, c.ease,
    [[[1, 2], [10, 11]], [[2, 3], [9, 10]], [[4, 5], [7, 8]]]);
  },
  // 0 hem-left, 1 hem-right, 2 underarm-right, 3 shoulder-right, 4 neck-right, (neck-middle,) neck-left, shoulder-left, underarm-left.
  vestido: (m, c) => {
    const w = m.radius * Math.PI * c.ease, len = m.shoulderY - m.kneeY + 0.6 + c.length, f = c.flare;
    if (c.neck === undefined) {
      return pair('vestido', [[-w / 2 - f, 0], [w / 2 + f, 0], [w / 2, len - 2.0], [w / 2 - 0.3, len], [w / 5, len + 0.1], [-w / 5, len + 0.1], [-w / 2 + 0.3, len], [-w / 2, len - 2.0]],
        m, m.shoulderY + 0.3, c.ease, [[[1, 2], [7, 8]], [[3, 4], [5, 6]]]);
    }
    return pair('vestido', [[-w / 2 - f, 0], [w / 2 + f, 0], [w / 2, len - 2.0], [w / 2 - 0.3, len], [w / 5, len + 0.1], [0, len + 0.1 - c.neck], [-w / 5, len + 0.1], [-w / 2 + 0.3, len], [-w / 2, len - 2.0]],
      m, m.shoulderY + 0.3, c.ease, [[[1, 2], [8, 9]], [[3, 4], [6, 7]]]);
  },
  // A tube top: 0 hem-left, 1 hem-right, 2 top-right, 3 top-left.
  top: (m, c) => {
    const w = m.radius * Math.PI * c.ease, len = m.chestY - m.waistY + 1.2 + c.length;
    return pair('top', [[-w / 2, 0], [w / 2, 0], [w / 2, len], [-w / 2, len]], m, m.chestY + 0.5, c.ease, [[[1, 2], [3, 4]]], m.radius * 1.02);
  },
};
