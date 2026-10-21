import { nearestThree } from '@people/hair/procedural';
import type { ProxyPack } from '@people/body/proxy';

/** A GROOM: hair made of guide strands, as the grooming tools build it (Blender's hair curves, XGen and Ornatrix guides).
 *  Each guide grows from a scalp vertex as a chain of points a fixed length apart; it is drawn as a clump (a tapered, flattened tube, the solid
 *  "Maxis Match" hair of The Sims) and moved by Dynamic Follow-The-Leader (Müller, Kim, Chentanez 2012), which keeps every segment its length in one pass,
 *  with the body pushing the points out of it. All in the base mesh's frame, decimetres. */

export interface Guide {
  /** The scalp vertex it grows from. */
  root: number;
  /** Its points, x y z each, the first at the root. */
  pts: Float32Array;
  /** The style it springs back to (the points relative to the root), set when a stroke ends. */
  rest: Float32Array;
  /** Velocities, for the dynamics. */
  vel: Float32Array;
  /** Segment length, dm. */
  seg: number;
  /** The clump's half width at the root, dm. */
  radius: number;
  /** A tie it passes through: the tie's index and the point held there. */
  tie: { id: number; k: number } | null;
  /** Its curtain: the ring round the head it was planted in (0 at the crown), and its angle round the head (0 at the brow); -1 when planted by hand. */
  row: number;
  theta: number;
}

export interface Tie { x: number; y: number; z: number; radius: number }

/** The body the hair lives on: its positions and normals (dm), the skin's vertices on a grid for collision, the scalp. */
export class GroomBody {
  readonly normals: Float32Array;
  private readonly grid = new Map<number, number[]>();
  private static readonly CELL = 0.35;
  /** The skull's middle, for 'out from the head'. */
  readonly skull: [number, number, number];
  /** The scalp's vertices: where hair may grow. */
  readonly scalp: number[];
  readonly top: number;

  constructor(readonly positions: Float32Array, readonly skin: readonly number[], faces: Uint16Array, faceGroup: Uint8Array, skinGroup: number) {
    const n = positions.length / 3;
    this.normals = new Float32Array(n * 3);
    const P = positions, N = this.normals;
    for (let f = 0; f < faceGroup.length; f++) {
      if (faceGroup[f] !== skinGroup) continue;
      const q = [faces[f * 4]!, faces[f * 4 + 1]!, faces[f * 4 + 2]!, faces[f * 4 + 3]!];
      for (const [a, b, c] of q[3] !== q[2] ? [[q[0]!, q[1]!, q[2]!], [q[0]!, q[2]!, q[3]!]] : [[q[0]!, q[1]!, q[2]!]]) {
        const ux = P[b! * 3]! - P[a! * 3]!, uy = P[b! * 3 + 1]! - P[a! * 3 + 1]!, uz = P[b! * 3 + 2]! - P[a! * 3 + 2]!;
        const vx = P[c! * 3]! - P[a! * 3]!, vy = P[c! * 3 + 1]! - P[a! * 3 + 1]!, vz = P[c! * 3 + 2]! - P[a! * 3 + 2]!;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        for (const v of [a!, b!, c!]) { N[v * 3] = N[v * 3]! + nx; N[v * 3 + 1] = N[v * 3 + 1]! + ny; N[v * 3 + 2] = N[v * 3 + 2]! + nz; }
      }
    }
    for (let v = 0; v < n; v++) {
      const l = Math.hypot(N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!) || 1;
      N[v * 3] = N[v * 3]! / l; N[v * 3 + 1] = N[v * 3 + 1]! / l; N[v * 3 + 2] = N[v * 3 + 2]! / l;
    }
    for (const v of skin) {
      const key = this.key(P[v * 3]!, P[v * 3 + 1]!, P[v * 3 + 2]!);
      const list = this.grid.get(key);
      if (list) list.push(v); else this.grid.set(key, [v]);
    }
    let top = -Infinity;
    for (const v of skin) top = Math.max(top, P[v * 3 + 1]!);
    this.top = top;
    let sx = 0, sz = 0, c = 0;
    for (const v of skin) if (P[v * 3 + 1]! > top - 1.4) { sx += P[v * 3]!; sz += P[v * 3 + 2]!; c++; }
    this.skull = [c ? sx / c : 0, top - 1.0, c ? sz / c : 0];
    // The scalp: above the hairline at the front (~7 cm under the crown), down to the nape behind the head's middle.
    // The scalp: above the game's own hairline (`procedural.ts` hairlineY) round the skull - high on the brow, down over the ears' tops, low at the nape.
    // The skull as the game measures it: the head's box (skin above the chin), its middle a little back, its height a fifth of the way up.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of skin) {
      if (P[v * 3 + 1]! < top - 2.45) continue;
      for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, P[v * 3 + a]!); hi[a] = Math.max(hi[a]!, P[v * 3 + a]!); }
    }
    const ry = (hi[1]! - lo[1]!) * 0.39;
    const mid = [(lo[0]! + hi[0]!) / 2, hi[1]! - ry, lo[2]! + (hi[1]! - lo[1]!) * 0.36];
    this.scalp = skin.filter((v) => {
      const x = P[v * 3]! - mid[0]!, y = (P[v * 3 + 1]! - mid[1]!) / ry, z = P[v * 3 + 2]! - mid[2]!;
      if (P[v * 3 + 1]! < top - 2.45) return false;
      return y > hairline(Math.atan2(x, z));
    });
    // The face: from the brow (the hairline's front, a little lower) to the chin, as wide as the head less the temples, its front the skull's middle.
    this.face = { x: mid[0]!, half: (hi[0]! - lo[0]!) * 0.36, front: mid[2]! + 0.25, top: mid[1]! + ry * 0.2, bottom: lo[1]! - 0.2 };
  }

  private key(x: number, y: number, z: number): number {
    const c = GroomBody.CELL;
    return ((Math.floor(x / c) + 512) * 1024 + (Math.floor(y / c) + 512)) * 1024 + (Math.floor(z / c) + 512);
  }

  /** The face's box (dm): hair kept out of it, round to the sides, as hair is worn off the face. Set from the skull and the hairline. */
  face = { x: 0, half: 0.7, front: 0, top: 0, bottom: 0 };

  /** A point in front of the face moved out to its side (unless above the brow, where a fringe may lie). */
  private clearFace(p: Float32Array, i: number): void {
    const f = this.face;
    const y = p[i + 1]!, z = p[i + 2]!;
    if (z < f.front || y > f.top || y < f.bottom) return;
    const dx = p[i]! - f.x;
    if (Math.abs(dx) >= f.half) return;
    p[i] = f.x + Math.sign(dx || 1) * f.half;
  }

  /** The point pushed out of the body to `margin` above the skin (the nearest skin vertex's tangent plane, as a signed distance near the surface). */
  collide(p: Float32Array, i: number, margin: number): void {
    const P = this.positions, N = this.normals, c = GroomBody.CELL;
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    const cx = Math.floor(x / c), cy = Math.floor(y / c), cz = Math.floor(z / c);
    let best = -1, bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = this.grid.get(((cx + dx + 512) * 1024 + (cy + dy + 512)) * 1024 + (cz + dz + 512));
      if (!list) continue;
      for (const v of list) {
        const d = (P[v * 3]! - x) ** 2 + (P[v * 3 + 1]! - y) ** 2 + (P[v * 3 + 2]! - z) ** 2;
        if (d < bestD) { bestD = d; best = v; }
      }
    }
    this.clearFace(p, i);
    if (best < 0) return;
    const d = (x - P[best * 3]!) * N[best * 3]! + (y - P[best * 3 + 1]!) * N[best * 3 + 1]! + (z - P[best * 3 + 2]!) * N[best * 3 + 2]!;
    if (d < margin) {
      const push = margin - d;
      p[i] = x + N[best * 3]! * push; p[i + 1] = y + N[best * 3 + 1]! * push; p[i + 2] = z + N[best * 3 + 2]! * push;
    }
  }
}

/** Where hair grows from, as height on the skull (its middle 0, its top 1) by the angle round it (0 at the brow): the game's hairline, `procedural.ts`. */
function hairline(theta: number): number {
  const a = Math.abs(theta);
  const knots: [number, number][] = [[0, 0.36], [0.6, 0.3], [1.0, 0.0], [1.3, -0.35], [1.55, -0.1], [1.85, -0.35], [2.2, -0.62], [2.6, -0.78], [Math.PI, -0.82]];
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1]!, [x1, y1] = knots[i]!;
    if (a <= x1) return y0 + (y1 - y0) * (a - x0) / (x1 - x0);
  }
  return -0.55;
}

/** THE HAIR AS ONE MASS, as the catalogue's mesh hair is: each guide joined to its nearest neighbours by a ribbon along their lengths.
 *  Seen from outside only the outermost ribbons show, a continuous surface; where strands part (a parting, a tie) ribbons that would stretch across the gap are left out.
 *  The vertices are the guides' own points, so moving the guides moves the surface. */
export function shellTopology(guides: readonly Guide[], body: GroomBody): Uint32Array {
  const P = body.positions;
  const roots = guides.map((g) => [P[g.root * 3]!, P[g.root * 3 + 1]!, P[g.root * 3 + 2]!] as const);
  const start: number[] = [];
  let base = 0;
  for (const g of guides) { start.push(base); base += g.pts.length / 3; }
  const index: number[] = [];
  const seen = new Set<string>();
  const NEIGHBOURS = 5;
  for (let a = 0; a < guides.length; a++) {
    const near = roots.map((r, b) => [b, (r[0] - roots[a]![0]) ** 2 + (r[1] - roots[a]![1]) ** 2 + (r[2] - roots[a]![2]) ** 2] as const)
      .filter(([b]) => b !== a).sort((x, y) => x[1] - y[1]).slice(0, NEIGHBOURS);
    for (const [b, d2] of near) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (seen.has(key) || d2 > 0.5 * 0.5) continue;
      seen.add(key);
      const ga = guides[a]!, gb = guides[b]!;
      const n = Math.min(ga.pts.length, gb.pts.length) / 3;
      const rootGap = Math.sqrt(d2);
      for (let i = 0; i < n - 1; i++) {
        // A ribbon stops where its two strands have drifted apart (a parting, a tie, a strand pulled away).
        const gap = Math.hypot(ga.pts[(i + 1) * 3]! - gb.pts[(i + 1) * 3]!, ga.pts[(i + 1) * 3 + 1]! - gb.pts[(i + 1) * 3 + 1]!, ga.pts[(i + 1) * 3 + 2]! - gb.pts[(i + 1) * 3 + 2]!);
        if (gap > Math.max(0.55, rootGap * 3)) break;
        const a0 = start[a]! + i, a1 = a0 + 1, b0 = start[b]! + i, b1 = b0 + 1;
        index.push(a0, b0, a1, a1, b0, b1);
      }
    }
  }
  return Uint32Array.from(index);
}

/** THE HAIR AS CURTAINS, as mesh hair is modelled: each ring of guides round the head joined into one continuous sheet, the rings stacked
 *  from the crown (outside) down to the hairline (inside) like shingles; the centre parting at the brow left open. Guides planted by hand join their neighbours. */
export function curtainTopology(guides: readonly Guide[], body: GroomBody): Uint32Array {
  const start: number[] = [];
  let base = 0;
  for (const g of guides) { start.push(base); base += g.pts.length / 3; }
  const rows = new Map<number, number[]>();
  guides.forEach((g, i) => { if (g.row >= 0) (rows.get(g.row) ?? rows.set(g.row, []).get(g.row)!).push(i); });
  const index: number[] = [];
  const join = (a: number, b: number, maxGap: number, segments = Infinity): void => {
    const ga = guides[a]!, gb = guides[b]!;
    const n = Math.min(ga.pts.length / 3, gb.pts.length / 3, segments + 1);
    for (let i = 0; i < n - 1; i++) {
      const gap = Math.hypot(ga.pts[(i + 1) * 3]! - gb.pts[(i + 1) * 3]!, ga.pts[(i + 1) * 3 + 1]! - gb.pts[(i + 1) * 3 + 1]!, ga.pts[(i + 1) * 3 + 2]! - gb.pts[(i + 1) * 3 + 2]!);
      if (gap > maxGap) break;
      const a0 = start[a]! + i, a1 = a0 + 1, b0 = start[b]! + i, b1 = b0 + 1;
      index.push(a0, b0, a1, a1, b0, b1);
    }
  };
  for (const list of rows.values()) {
    list.sort((x, y) => guides[x]!.theta - guides[y]!.theta);
    for (let k = 0; k < list.length; k++) {
      const a = list[k]!, b = list[(k + 1) % list.length]!;
      if (a === b) continue;
      // Not across the parting at the brow (between the last strand left of it and the first right of it).
      const ta = guides[a]!.theta, tb = guides[b]!.theta;
      if (k === list.length - 1 && Math.abs(ta - tb) > Math.PI) {
        const wrap = 2 * Math.PI - Math.abs(ta - tb);
        if (Math.abs(ta) > 2.4 && wrap < 1) join(a, b, 0.9);
        continue;
      }
      if (ta < 0 && tb >= 0) continue;
      join(a, b, 0.9);
    }
  }
  // Across the rings: each guide joined to the nearest of the next ring along the stretch that lies on the scalp, closing the crown and the gaps between curtains.
  const P = body.positions;
  const rootDist = (a: number, b: number): number => {
    const ra = guides[a]!.root, rb = guides[b]!.root;
    return Math.hypot(P[ra * 3]! - P[rb * 3]!, P[ra * 3 + 1]! - P[rb * 3 + 1]!, P[ra * 3 + 2]! - P[rb * 3 + 2]!);
  };
  const ringIds = [...rows.keys()].sort((x, y) => x - y);
  for (let r = 0; r + 1 < ringIds.length; r++) {
    const here = rows.get(ringIds[r]!)!, next = rows.get(ringIds[r + 1]!)!;
    for (const a of here) {
      let best = -1, bestD = Infinity;
      for (const b of next) { const d = rootDist(a, b); if (d < bestD) { bestD = d; best = b; } }
      if (best >= 0 && bestD < 0.6) join(a, best, 0.7, 4);
    }
  }
  const loose = guides.map((g, i) => (g.row < 0 ? i : -1)).filter((i) => i >= 0);
  if (loose.length) {
    const sub = shellTopology(loose.map((i) => guides[i]!), body);
    const offset: number[] = loose.map((i) => start[i]!);
    // Re-indexed from the loose guides' own numbering to the whole mesh's.
    const localStart: number[] = [];
    let lb = 0;
    for (const i of loose) { localStart.push(lb); lb += guides[i]!.pts.length / 3; }
    for (const v of sub) {
      let g = 0;
      while (g + 1 < localStart.length && localStart[g + 1]! <= v) g++;
      index.push(offset[g]! + (v - localStart[g]!));
    }
  }
  return Uint32Array.from(index);
}

/** The guides' points, all of them, as the shell's vertices. */
export function shellPositions(guides: readonly Guide[], out?: Float32Array): Float32Array {
  let count = 0;
  for (const g of guides) count += g.pts.length;
  const pos = out && out.length === count ? out : new Float32Array(count);
  let o = 0;
  for (const g of guides) { pos.set(g.pts, o); o += g.pts.length; }
  return pos;
}

/** A guide planted at `root`: out along the skin's normal a little, then falling (as hair lies before it is styled). */
export function plant(body: GroomBody, root: number, length: number, radius: number, points = 14): Guide {
  const P = body.positions, N = body.normals;
  const seg = length / (points - 1);
  const pts = new Float32Array(points * 3);
  const o = [P[root * 3]! + N[root * 3]! * 0.04, P[root * 3 + 1]! + N[root * 3 + 1]! * 0.04, P[root * 3 + 2]! + N[root * 3 + 2]! * 0.04];
  // Combed from a centre parting: to the left or right of it, down and a little back, along the scalp, lifted a little off it.
  const n = [N[root * 3]!, N[root * 3 + 1]!, N[root * 3 + 2]!];
  const side = Math.sign(o[0]! - body.skull[0]) || 1;
  let fx = side * 0.8, fy = -0.6, fz = -0.45;
  const along = fx * n[0]! + fy * n[1]! + fz * n[2]!;
  fx -= n[0]! * along; fy -= n[1]! * along; fz -= n[2]! * along;
  const fl = Math.hypot(fx, fy, fz) || 1;
  let d = [n[0]! * 0.3 + fx / fl * 0.7, n[1]! * 0.3 + fy / fl * 0.7 - 0.1, n[2]! * 0.3 + fz / fl * 0.7];
  const dl = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
  d = [d[0]! / dl, d[1]! / dl, d[2]! / dl];
  for (let i = 0; i < points; i++) {
    pts[i * 3] = o[0]!; pts[i * 3 + 1] = o[1]!; pts[i * 3 + 2] = o[2]!;
    o[0] = o[0]! + d[0]! * seg; o[1] = o[1]! + d[1]! * seg; o[2] = o[2]! + d[2]! * seg;
    // Bending down: each segment a little more towards gravity.
    d = [d[0]! * 0.86, d[1]! * 0.86 - 0.18, d[2]! * 0.86];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    d = [d[0]! / l, d[1]! / l, d[2]! / l];
  }
  const g: Guide = { root, pts, rest: new Float32Array(points * 3), vel: new Float32Array(points * 3), seg, radius, tie: null, row: -1, theta: 0 };
  settle(g, body, 0.06 + radius * 0.5);
  remember(g);
  return g;
}

/** Follow-The-Leader: every point brought to its segment's length from the one before (the root fixed), then out of the body. */
export function settle(g: Guide, body: GroomBody, margin: number, from = 1): void {
  const p = g.pts;
  const n = p.length / 3;
  for (let i = from; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    const dx = p[b]! - p[a]!, dy = p[b + 1]! - p[a + 1]!, dz = p[b + 2]! - p[a + 2]!;
    const l = Math.hypot(dx, dy, dz) || 1;
    p[b] = p[a]! + dx / l * g.seg; p[b + 1] = p[a + 1]! + dy / l * g.seg; p[b + 2] = p[a + 2]! + dz / l * g.seg;
    body.collide(p, b, margin * (1 - 0.5 * i / n));
  }
}

/** The guide's current shape kept as the style it springs back to. */
export function remember(g: Guide): void {
  const p = g.pts;
  for (let i = 0; i < p.length; i += 3) { g.rest[i] = p[i]! - p[0]!; g.rest[i + 1] = p[i + 1]! - p[1]!; g.rest[i + 2] = p[i + 2]! - p[2]!; }
}

/** One step of Dynamic Follow-The-Leader (Müller et al. 2012): predict under gravity, FTL-project, correct the velocities with
 *  the next point's correction (v_i = (p_i - x_i)/dt + s * -d_{i+1}/dt), so a chain of equal masses swings as one. `hold` pulls towards the style. */
export function step(g: Guide, body: GroomBody, ties: readonly Tie[], dt: number, gravity: number, hold: number, margin: number): void {
  const p = g.pts, v = g.vel;
  const n = p.length / 3;
  const x = Float32Array.from(p);
  const d = new Float32Array(n * 3);
  for (let i = 1; i < n; i++) {
    const b = i * 3;
    v[b + 1] = v[b + 1]! - gravity * dt;
    p[b] = p[b]! + v[b]! * dt; p[b + 1] = p[b + 1]! + v[b + 1]! * dt; p[b + 2] = p[b + 2]! + v[b + 2]! * dt;
    // The style: towards the remembered shape from the root, by `hold`.
    if (hold > 0) {
      const t = hold * (1 - 0.6 * i / n);
      p[b] = p[b]! + (p[0]! + g.rest[b]! - p[b]!) * t; p[b + 1] = p[b + 1]! + (p[1]! + g.rest[b + 1]! - p[b + 1]!) * t; p[b + 2] = p[b + 2]! + (p[2]! + g.rest[b + 2]! - p[b + 2]!) * t;
    }
  }
  const tie = g.tie ? ties[g.tie.id] : undefined;
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    const ox = p[b]!, oy = p[b + 1]!, oz = p[b + 2]!;
    if (tie && g.tie!.k === i) {
      // Held in the tie: on a small disc round its middle, spread by the guide's own root.
      const s = ((g.root * 2654435761) >>> 0) / 4294967296 * Math.PI * 2;
      p[b] = tie.x + Math.cos(s) * tie.radius * 0.6; p[b + 1] = tie.y + Math.sin(s) * tie.radius * 0.6; p[b + 2] = tie.z;
    } else {
      const dx = p[b]! - p[a]!, dy = p[b + 1]! - p[a + 1]!, dz = p[b + 2]! - p[a + 2]!;
      const l = Math.hypot(dx, dy, dz) || 1;
      // Before a tie the strand may stretch to reach it; after, never.
      const len = tie && i < g.tie!.k ? Math.min(l, g.seg * 1.6) : g.seg;
      p[b] = p[a]! + dx / l * len; p[b + 1] = p[a + 1]! + dy / l * len; p[b + 2] = p[a + 2]! + dz / l * len;
      body.collide(p, b, margin * (1 - 0.5 * i / n));
    }
    d[b] = p[b]! - ox; d[b + 1] = p[b + 1]! - oy; d[b + 2] = p[b + 2]! - oz;
  }
  const S = 0.9;
  for (let i = 1; i < n; i++) {
    const b = i * 3, nb = (i + 1) * 3;
    for (let k = 0; k < 3; k++) {
      const next = i + 1 < n ? d[nb + k]! : 0;
      v[b + k] = ((p[b + k]! - x[b + k]!) - S * next) / dt * 0.985;
    }
  }
}

/** The clumps as one mesh: a flattened, tapered tube of `SIDES` round each guide. Positions only when `index` is given back. */
export const SIDES = 6;

export function clumpTopology(guides: readonly Guide[]): Uint32Array {
  const index: number[] = [];
  let base = 0;
  for (const g of guides) {
    const n = g.pts.length / 3;
    for (let i = 0; i < n - 1; i++) for (let s = 0; s < SIDES; s++) {
      const a = base + i * SIDES + s, b = base + i * SIDES + (s + 1) % SIDES, c = a + SIDES, d = b + SIDES;
      index.push(a, c, b, b, c, d);
    }
    base += n * SIDES;
  }
  return Uint32Array.from(index);
}

export function clumpPositions(guides: readonly Guide[], body: GroomBody, out?: Float32Array): Float32Array {
  let count = 0;
  for (const g of guides) count += g.pts.length / 3;
  const pos = out && out.length === count * SIDES * 3 ? out : new Float32Array(count * SIDES * 3);
  const [sx, sy, sz] = body.skull;
  let o = 0;
  for (const g of guides) {
    const p = g.pts, n = p.length / 3;
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1) * 3, b = Math.min(n - 1, i + 1) * 3;
      let tx = p[b]! - p[a]!, ty = p[b + 1]! - p[a + 1]!, tz = p[b + 2]! - p[a + 2]!;
      const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
      // Out from the head: the clump lies flat against the hair beneath it (wide across, thin outwards).
      let ox = p[i * 3]! - sx, oy = p[i * 3 + 1]! - sy, oz = p[i * 3 + 2]! - sz;
      let bx = ty * oz - tz * oy, by = tz * ox - tx * oz, bz = tx * oy - ty * ox;
      const bl = Math.hypot(bx, by, bz) || 1; bx /= bl; by /= bl; bz /= bl;
      ox = by * tz - bz * ty; oy = bz * tx - bx * tz; oz = bx * ty - by * tx;
      const t = i / (n - 1);
      // Wide and flat, tapering late: the clumps overlap like shingles into one surface, the tips still pointed.
      const w = g.radius * (1 - 0.6 * t ** 1.8), h = w * 0.3;
      for (let s = 0; s < SIDES; s++) {
        const ang = (s / SIDES) * Math.PI * 2, c = Math.cos(ang), si = Math.sin(ang);
        pos[o++] = p[i * 3]! + bx * c * w + ox * si * h;
        pos[o++] = p[i * 3 + 1]! + by * c * w + oy * si * h;
        pos[o++] = p[i * 3 + 2]! + bz * c * w + oz * si * h;
      }
    }
  }
  return pos;
}

/** The groom as a game item (`ProxyPack`): every clump vertex pinned to its three nearest head and neck skin vertices, as MakeHuman items are. */
export function groomPack(guides: readonly Guide[], body: GroomBody, anchors: readonly number[]): ProxyPack {
  const positions = shellPositions(guides);
  const index = curtainTopology(guides, body);
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
      const r = best[k]![1];
      refs[i * 3 + k] = r; weights[i * 3 + k] = w[k]! / total;
      fx += P[r * 3]! * w[k]! / total; fy += P[r * 3 + 1]! * w[k]! / total; fz += P[r * 3 + 2]! * w[k]! / total;
    }
    offsets[i * 3] = positions[i * 3]! - fx; offsets[i * 3 + 1] = positions[i * 3 + 1]! - fy; offsets[i * 3 + 2] = positions[i * 3 + 2]! - fz;
  }
  // Scale axes measured across the head, as the stock hair has them (`procedural.ts` pinned).
  const scaleRefs = [5399, 11998, 791, 881, 962, 5320];
  const axis = (i: number): number => Math.abs(P[scaleRefs[i * 2]! * 3 + i]! - P[scaleRefs[i * 2 + 1]! * 3 + i]!) || 1;
  return { name: 'groom', kind: 'hair', scaleRefs, scaleBase: [axis(0), axis(1), axis(2)], refs, weights, offsets, index, deleteVerts: new Uint32Array(0), colour: 0xffffff, zDepth: 50 };
}

/** A groom as saved: each guide's root vertex, radius and points relative to the root, in hundredths of a millimetre (int16), base64. */
export interface GroomRecord { readonly guides: string; readonly ties: readonly Tie[]; /** Each guide's curtain row and angle (hundredths of a radian). */ readonly rows?: readonly (readonly [number, number])[] }

export function encodeGroom(guides: readonly Guide[], ties: readonly Tie[]): GroomRecord {
  let bytes = 4;
  for (const g of guides) bytes += 8 + g.pts.length * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  view.setUint32(0, guides.length, true);
  let o = 4;
  for (const g of guides) {
    view.setUint16(o, g.root, true); view.setUint16(o + 2, g.pts.length / 3, true);
    view.setUint16(o + 4, Math.round(g.radius * 1000), true); view.setInt16(o + 6, g.tie ? g.tie.id * 64 + g.tie.k : -1, true);
    o += 8;
    for (let i = 0; i < g.pts.length; i++) {
      const rel = g.pts[i]! - g.pts[i % 3]!;
      view.setInt16(o, Math.max(-32767, Math.min(32767, Math.round(rel * 1000))), true);
      o += 2;
    }
  }
  const u8 = new Uint8Array(view.buffer);
  let text = '';
  for (let i = 0; i < u8.length; i += 0x8000) text += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { guides: btoa(text), ties: ties.map((t) => ({ x: +t.x.toFixed(3), y: +t.y.toFixed(3), z: +t.z.toFixed(3), radius: +t.radius.toFixed(3) })),
    rows: guides.map((g) => [g.row, Math.round(g.theta * 100)] as const) };
}

/** A saved groom on a body: each guide's points from its root vertex as this body has it. */
export function decodeGroom(record: GroomRecord, body: GroomBody): Guide[] {
  const raw = atob(record.guides);
  const u8 = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  const view = new DataView(u8.buffer);
  const count = view.getUint32(0, true);
  const out: Guide[] = [];
  let o = 4;
  const P = body.positions, N = body.normals;
  for (let k = 0; k < count && o + 8 <= u8.length; k++) {
    const root = view.getUint16(o, true), n = view.getUint16(o + 2, true), radius = view.getUint16(o + 4, true) / 1000, tie = view.getInt16(o + 6, true);
    o += 8;
    const pts = new Float32Array(n * 3);
    const base = [P[root * 3]! + N[root * 3]! * 0.04, P[root * 3 + 1]! + N[root * 3 + 1]! * 0.04, P[root * 3 + 2]! + N[root * 3 + 2]! * 0.04];
    for (let i = 0; i < n * 3; i++) { pts[i] = base[i % 3]! + view.getInt16(o, true) / 1000; o += 2; }
    let seg = 0;
    for (let i = 1; i < n; i++) seg += Math.hypot(pts[i * 3]! - pts[i * 3 - 3]!, pts[i * 3 + 1]! - pts[i * 3 - 2]!, pts[i * 3 + 2]! - pts[i * 3 - 1]!);
    const g: Guide = { root, pts, rest: new Float32Array(n * 3), vel: new Float32Array(n * 3), seg: seg / Math.max(1, n - 1), radius,
      tie: tie >= 0 ? { id: tie >> 6, k: tie & 63 } : null, row: -1, theta: 0 };
    const rt = record.rows?.[k];
    if (rt) { g.row = rt[0]; g.theta = rt[1] / 100; }
    remember(g);
    out.push(g);
  }
  return out;
}
