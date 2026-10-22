import { nearestThree } from '@people/hair/procedural';
import type { ProxyPack } from '@people/body/proxy';
import { MeshStandardMaterial } from 'three';
import { FLAT, HairVolume, type Cap } from './hairVolume';

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
  /** How near the hairline it grows (1 on it, 0 a few centimetres in): there the clump starts fine and flat on the skin, a thin edge as on real hair. */
  edge?: number;
  /** Cut straight across (a blunt end, as a bob is cut), not tapering to a point. */
  blunt?: boolean;
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

  /** The scalp's skin quads (as triangles): the hair cap. */
  capTris: number[] = [];
  /** The skin's triangles across the hairline (some corners on the scalp): the cap reaches into them up to the hairline's own curve. */
  rimTris: number[] = [];
  /** How far above the hairline a point is (dm; negative below it): the game's smooth curve, not the scalp's staircase of quads. */
  aboveHairline: (x: number, y: number, z: number) => number = () => 1;

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
    this.aboveHairline = (x, y, z) => (y - mid[1]!) - hairline(Math.atan2(x - mid[0]!, z - mid[2]!)) * ry;
    this.scalp = skin.filter((v) => {
      const x = P[v * 3]! - mid[0]!, y = (P[v * 3 + 1]! - mid[1]!) / ry, z = P[v * 3 + 2]! - mid[2]!;
      if (P[v * 3 + 1]! < top - 2.45) return false;
      return y > hairline(Math.atan2(x, z));
    });
    // No hair grows from the ears: the hairline dips over them, so an ear's top counted as scalp and a lock grew out of it, a lump over the ear.
    // An ear is skin standing out sideways past the skull (its width above the ears), between the brow and the jaw, round the head's middle.
    const skullHalf = Math.max(...this.scalp.filter((v) => P[v * 3 + 1]! > mid[1]! + ry * 0.35).map((v) => Math.abs(P[v * 3]! - mid[0]!)));
    const ear = (v: number): boolean => Math.abs(P[v * 3]! - mid[0]!) > skullHalf + 0.02 && P[v * 3 + 1]! < mid[1]! + ry * 0.35 && P[v * 3 + 1]! > mid[1]! - ry * 1.7
      && Math.abs(P[v * 3 + 2]! - mid[2]!) < 0.6;
    this.scalp = this.scalp.filter((v) => !ear(v));
    // Nor do the ears' polygons stop hair (lying over them it showed their relief): each ear is wrapped in a smooth ellipsoid instead, hair over it a soft bulge.
    for (const sgn of [-1, 1]) {
      const vs = skin.filter((v) => ear(v) && Math.sign(P[v * 3]! - mid[0]!) === sgn);
      if (!vs.length) continue;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of vs) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, P[v * 3 + a]!); hi[a] = Math.max(hi[a]!, P[v * 3 + a]!); }
      // Centred at the ear's root on the skull, reaching just past its outer edge.
      const cx = mid[0]! + sgn * skullHalf;
      const rx = Math.max(Math.abs(hi[0]! - cx), Math.abs(lo[0]! - cx)) + 0.03;
      this.ears.push({ c: [cx, (lo[1]! + hi[1]!) / 2, (lo[2]! + hi[2]!) / 2], r: [rx, (hi[1]! - lo[1]!) / 2 + 0.08, (hi[2]! - lo[2]!) / 2 + 0.05] });
    }
    for (const [key, list] of this.grid) this.grid.set(key, list.filter((v) => !ear(v)));
    // The face: from the brow (the hairline's front, a little lower) to the chin, as wide as the head less the temples, its front the skull's middle.
    const inScalp = new Set(this.scalp);
    const border = new Set<number>();
    for (let f = 0; f < faceGroup.length; f++) {
      if (faceGroup[f] !== skinGroup) continue;
      const q = [faces[f * 4]!, faces[f * 4 + 1]!, faces[f * 4 + 2]!, faces[f * 4 + 3]!];
      if (!q.every((v) => inScalp.has(v))) {
        if (q.some((v) => inScalp.has(v))) {
          for (const v of q) if (inScalp.has(v)) border.add(v);
          // Not where the ear meets the head: a corner off the scalp standing out from it is the ear, and the cap climbed onto it as a ledge.
          const out = (v: number): number => Math.hypot(P[v * 3]! - mid[0]!, P[v * 3 + 2]! - mid[2]!);
          const onScalp = Math.max(...q.filter((v) => inScalp.has(v)).map(out));
          if (q.some((v) => !inScalp.has(v) && out(v) > onScalp + 0.05)) continue;
          this.rimTris.push(q[0]!, q[1]!, q[2]!);
          if (q[3] !== q[2]) this.rimTris.push(q[0]!, q[2]!, q[3]!);
        }
        continue;
      }
      this.capTris.push(q[0]!, q[1]!, q[2]!);
      if (q[3] !== q[2]) this.capTris.push(q[0]!, q[2]!, q[3]!);
    }
    // Each scalp vertex's nearness to the hairline (the scalp's border), over 3 cm.
    const rim = [...border];
    for (const v of this.scalp) {
      let best = Infinity;
      for (const b of rim) best = Math.min(best, (P[v * 3]! - P[b * 3]!) ** 2 + (P[v * 3 + 1]! - P[b * 3 + 1]!) ** 2 + (P[v * 3 + 2]! - P[b * 3 + 2]!) ** 2);
      const e = 1 - Math.sqrt(best) / 0.3;
      if (e > 0) this.edges.set(v, e);
    }
    // The skull's middle from the head's box (the mean of the skin was pulled forward by the face's dense vertices).
    this.skull = [mid[0]!, top - 1.0, mid[2]!];
    this.face = { x: mid[0]!, half: (hi[0]! - lo[0]!) * 0.36, front: mid[2]! + 0.25, top: mid[1]! + ry * 0.12, bottom: lo[1]! - 0.2 };
    // Hair lies on the head down to the ears' middle; below it hangs free.
    this.hugFloor = mid[1]! - ry * 0.55;
  }

  /** The hair's cap over the scalp (`hairVolume.ts`): points just off the skin every 6 mm or so over the scalp's triangles (its vertices alone are too
   *  sparse - their spheres showed as teeth along the nape), where hair grows (a guide's root within 2.5 cm), finer towards the hairline. */
  cap(guides: readonly Guide[]): Cap {
    const P = this.positions, N = this.normals, T = [...this.capTris, ...this.rimTris];
    const roots = guides.map((g) => [P[g.root * 3]!, P[g.root * 3 + 1]!, P[g.root * 3 + 2]!]);
    const pts: number[] = [], rad: number[] = [];
    const step = 0.06;
    for (let t = 0; t < T.length; t += 3) {
      const a = T[t]!, b = T[t + 1]!, c = T[t + 2]!;
      const longest = Math.max(dist(P, a, b), dist(P, b, c), dist(P, c, a));
      const m = Math.max(1, Math.ceil(longest / step));
      for (let i = 0; i <= m; i++) for (let j = 0; j <= m - i; j++) {
        // Barycentric samples; points on a shared edge are made twice, harmless under the max-blend.
        const u = i / m, v = j / m, w = 1 - u - v;
        const q = [0, 1, 2].map((k) => P[a * 3 + k]! * u + P[b * 3 + k]! * v + P[c * 3 + k]! * w);
        if (!roots.some((r) => (r[0]! - q[0]!) ** 2 + (r[1]! - q[1]!) ** 2 + (r[2]! - q[2]!) ** 2 < 0.0625)) continue;
        const n = [0, 1, 2].map((k) => N[a * 3 + k]! * u + N[b * 3 + k]! * v + N[c * 3 + k]! * w);
        const nl = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
        // Up to the hairline's curve, finer over its last 3 cm.
        const above = this.aboveHairline(q[0]!, q[1]!, q[2]!);
        if (above < 0) continue;
        const e = Math.max(0, 1 - above / 0.3);
        pts.push(q[0]! + n[0]! / nl * 0.02, q[1]! + n[1]! / nl * 0.02, q[2]! + n[2]! / nl * 0.02);
        // Its surface about level with the hair lying over it (`groomMargin` plus a lock's depth), thinner at the hairline.
        rad.push(0.17 * (1 - 0.4 * e));
      }
    }
    return { points: Float32Array.from(pts), radius: Float32Array.from(rad) };
  }

  /** The ears as smooth ellipsoids for the hair's collision (centre, radii; dm). */
  readonly ears: { c: number[]; r: number[] }[] = [];

  /** Whether a point lies over an ear (within its outline seen from the side, on its side of the head). */
  overEar(x: number, y: number, z: number): boolean {
    return this.ears.some((e) => {
      const dy = (y - e.c[1]!) / (e.r[1]! - 0.04), dz = (z - e.c[2]!) / (e.r[2]! - 0.04);
      return dy * dy + dz * dz < 1 && Math.sign(x - this.skull[0]) === Math.sign(e.c[0]! - this.skull[0]);
    });
  }

  /** Scalp vertices near the hairline: how near (1 on it). */
  readonly edges = new Map<number, number>();

  /** Down to here (dm) hair lies combed on the head; below it hangs. */
  hugFloor = 0;

  private key(x: number, y: number, z: number): number {
    const c = GroomBody.CELL;
    return ((Math.floor(x / c) + 512) * 1024 + (Math.floor(y / c) + 512)) * 1024 + (Math.floor(z / c) + 512);
  }

  /** The face's box (dm): hair kept out of it, round to the sides, as hair is worn off the face. Set from the skull and the hairline. */
  face = { x: 0, half: 0.7, front: 0, top: 0, bottom: 0 };

  /** The skin vertex nearest a point, within a cell or so of the grid (-1 when none). */
  nearest(x: number, y: number, z: number): number {
    const P = this.positions, c = GroomBody.CELL;
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
    return best;
  }

  /** A point in front of the face moved out to its side (unless above the brow, where a fringe may lie). */
  private clearFace(p: Float32Array, i: number, margin: number, side: number): void {
    const f = this.face;
    const y = p[i + 1]!, z = p[i + 2]!;
    if (z < f.front || y > f.top || y < f.bottom) return;
    const dx = p[i]! - f.x;
    // The clump's own thickness beyond its middle (`hairVolume.ts`, about its margin) kept off the eyes too.
    const half = f.half + margin;
    if (Math.abs(dx) >= half) return;
    // Eased in below the brow line (no shelf where the face begins): strands slide aside like curtain bangs.
    const below = Math.min(1, (f.top - y) / 0.3);
    const ease = below * below * (3 - 2 * below);
    // To the strand's own side of the parting (a strand never zigzags across the face).
    p[i] = p[i]! + (f.x + (side || Math.sign(dx || 1)) * half - p[i]!) * ease;
  }

  /** The point pushed out of the body to `margin` above the skin (the nearest skin vertex's tangent plane, as a signed distance near the surface). */
  /** With `hug`, a point near the head above `hugFloor` is also drawn in to `margin`: hair lies on the skull, it does not stand off it. */
  collide(p: Float32Array, i: number, margin: number, face = true, hug = false, side = 0): void {
    const P = this.positions, N = this.normals;
    const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!;
    const best = this.nearest(x, y, z);
    if (best >= 0) {
      const d = (x - P[best * 3]!) * N[best * 3]! + (y - P[best * 3 + 1]!) * N[best * 3 + 1]! + (z - P[best * 3 + 2]!) * N[best * 3 + 2]!;
      // Drawn onto the head only off the face: never down onto the brow or the eyes.
      const f = this.face, onFace = P[best * 3 + 2]! > f.front - 0.1 && P[best * 3 + 1]! < f.top;
      const lies = hug && !onFace && y > this.hugFloor && P[best * 3 + 1]! > this.hugFloor && d < margin + 0.35;
      if (d < margin || lies) {
        const push = margin - d;
        p[i] = x + N[best * 3]! * push; p[i + 1] = y + N[best * 3 + 1]! * push; p[i + 2] = z + N[best * 3 + 2]! * push;
      }
    }
    // Over the ears' ellipsoids: only sideways, out to their surface plus the margin - hair passes over an ear as a soft bulge, never parts round it.
    // Not for hair combed to a tie (`face` off): pulled tight above the ears, the dome only lifted it into flaps at the temples.
    if (face) for (const e of this.ears) {
      const dy = (p[i + 1]! - e.c[1]!) / (e.r[1]! + margin), dz = (p[i + 2]! - e.c[2]!) / (e.r[2]! + margin);
      const across = 1 - dy * dy - dz * dz;
      if (across <= 0) continue;
      const sgn = Math.sign(e.c[0]! - this.skull[0]) || 1;
      const out = e.c[0]! + sgn * (e.r[0]! + margin) * Math.sqrt(across);
      if (sgn * (p[i]! - out) < 0 && sgn * (p[i]! - e.c[0]!) > -0.3) p[i] = out;
    }
    // Last, so nothing draws hair back over the eyes.
    if (face) this.clearFace(p, i, margin, side);
  }
}

/** The distance between two vertices (dm). */
function dist(P: Float32Array, a: number, b: number): number {
  return Math.hypot(P[a * 3]! - P[b * 3]!, P[a * 3 + 1]! - P[b * 3 + 1]!, P[a * 3 + 2]! - P[b * 3 + 2]!);
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

/** A guide planted at `root`: out along the skin's normal a little, then falling (as hair lies before it is styled). */
export function plant(body: GroomBody, root: number, length: number, radius: number, points = 14): Guide {
  const P = body.positions, N = body.normals;
  const seg = length / (points - 1);
  const pts = new Float32Array(points * 3);
  const o = [P[root * 3]! + N[root * 3]! * 0.04, P[root * 3 + 1]! + N[root * 3 + 1]! * 0.04, P[root * 3 + 2]! + N[root * 3 + 2]! * 0.04];
  // Combed from a centre parting: to the left or right of it, down and a little back, along the scalp.
  const side = Math.sign(o[0]! - body.skull[0]) || 1;
  // From the centre parting to the sides: across the top of the forehead (not along its edge) and down in front of the ears, framing the face.
  const front = Math.max(0, Math.min(1, (o[2]! - body.skull[2]) / 0.8));
  // The parting runs from the brow to the crown; behind the crown hair falls straight down the back, not away from a line.
  const parted = Math.max(0, Math.min(1, (o[2]! - body.skull[2] + 0.4) / 0.5));
  const comb = [side * 0.9 * parted, 0, -0.25 - 0.35 * front];
  let d = [0, -1, 0];
  for (let i = 0; i < points; i++) {
    pts[i * 3] = o[0]!; pts[i * 3 + 1] = o[1]!; pts[i * 3 + 2] = o[2]!;
    // On the head: along the comb's direction laid on the skin there (the whole lock combed one way, as a brush leaves it);
    // off it: bending a little more towards gravity each segment.
    const v = o[1]! > body.hugFloor ? body.nearest(o[0]!, o[1]!, o[2]!) : -1;
    if (v >= 0) {
      const m = [N[v * 3]!, N[v * 3 + 1]!, N[v * 3 + 2]!];
      // On the top and the forehead combed from the parting (in front of the skull's middle a little up: down there is down the forehead);
      // on the sides and the back of the head falling straight down - in front of the ears, framing the face, not swept behind them.
      const up = -0.6 + 0.85 * Math.max(0, Math.min(1, (o[2]! - body.skull[2]) / 0.8));
      const w = Math.max(0, Math.min(1, (m[1]! + Math.max(0, m[2]!) - 0.3) / 0.5));
      const want = [comb[0]! * w, up * w - (1 - w), comb[2]! * w - 0.15 * (1 - w)];
      const a = want[0]! * m[0]! + want[1]! * m[1]! + want[2]! * m[2]!;
      d = [want[0]! - m[0]! * a, want[1]! - m[1]! * a, want[2]! - m[2]! * a];
    } else d = [d[0]! * 0.86, d[1]! * 0.86 - 0.18, d[2]! * 0.86];
    const l = Math.hypot(d[0]!, d[1]!, d[2]!) || 1;
    d = [d[0]! / l, d[1]! / l, d[2]! / l];
    o[0] = o[0]! + d[0]! * seg; o[1] = o[1]! + d[1]! * seg; o[2] = o[2]! + d[2]! * seg;
  }
  const g: Guide = { root, pts, rest: new Float32Array(points * 3), vel: new Float32Array(points * 3), seg, radius, tie: null, row: -1, theta: 0, edge: body.edges.get(root) ?? 0 };
  settle(g, body, groomMargin(radius));
  remember(g);
  return g;
}

/** A clump's width near its root as a share of its full width, by the distance from the root (dm): at the hairline it grows from a fine edge over 4 cm. */
export function rootWidth(g: Guide, s: number): number {
  const e = g.edge ?? 0;
  return e > 0 ? Math.min(1, 1 - 0.45 * e + 0.45 * e * s / 0.4) : 1;
}

/** How far a guide's middle lies off the skin: its clump's inner edge (`hairVolume.ts`, about 0.6 of its radius) just on the scalp. */
export function groomMargin(radius: number): number { return radius * 0.6 * FLAT; }

/** Follow-The-Leader: every point brought to its segment's length from the one before (the root fixed), then out of the body. */
export function settle(g: Guide, body: GroomBody, margin: number, from = 1): void {
  const p = g.pts;
  const n = p.length / 3;
  const side = Math.sign(p[0]! - body.face.x) || 1;
  // A tied strand's stretch up to the tie is laid along the head (`gather`): only the tail after it is settled.
  for (let i = Math.max(from, g.tie ? g.tie.k + 1 : 1); i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    const dx = p[b]! - p[a]!, dy = p[b + 1]! - p[a + 1]!, dz = p[b + 2]! - p[a + 2]!;
    const l = Math.hypot(dx, dy, dz) || 1;
    p[b] = p[a]! + dx / l * g.seg; p[b + 1] = p[a + 1]! + dy / l * g.seg; p[b + 2] = p[a + 2]! + dz / l * g.seg;
    body.collide(p, b, margin * rootWidth(g, i * g.seg), true, true, side);
  }
}

/** A strand cut straight across at height `y` (dm): ended where it first goes below it, its end blunt. False when it does not reach it. */
export function levelCut(g: Guide, y: number): boolean {
  const p = g.pts, n = p.length / 3;
  for (let i = 1; i < n; i++) {
    if (p[i * 3 + 1]! >= y) continue;
    const a = (i - 1) * 3, t = (p[a + 1]! - y) / (p[a + 1]! - p[i * 3 + 1]!);
    const keep = i + 1;
    g.pts = p.slice(0, keep * 3);
    for (let k = 0; k < 3; k++) g.pts[i * 3 + k] = p[a + k]! + (p[i * 3 + k]! - p[a + k]!) * t;
    g.vel = new Float32Array(keep * 3); g.rest = new Float32Array(keep * 3);
    g.blunt = true;
    remember(g);
    return true;
  }
  return false;
}

/** A strand trimmed along the hairline, as short hair is cut round the ears and at the nape: ended where it first hangs `below` dm under the hairline's curve (negative: that far above it)
 *  or passes over an ear. False when nothing of it is left (it grows pointing out of the hairline at once). */
export function hairlineCut(g: Guide, body: GroomBody, below: number): boolean {
  const p = g.pts, n = p.length / 3;
  for (let i = 1; i < n; i++) {
    const x = p[i * 3]!, y = p[i * 3 + 1]!, z = p[i * 3 + 2]!;
    if (body.aboveHairline(x, y, z) > -below && !body.overEar(x, y, z)) continue;
    if (i < 3) return false;
    g.pts = p.slice(0, i * 3); g.vel = new Float32Array(i * 3); g.rest = new Float32Array(i * 3);
    // Tapering into the cap, not a blunt end (blunt ends made a row of beads along the nape).
    g.blunt = false;
    remember(g);
    return true;
  }
  // Never reaches the hairline: left as it is.
  return true;
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
  // Up to its tie a tied strand lies combed along the head (`gather`) and does not move.
  const fixed = g.tie ? g.tie.k : 0;
  const side = Math.sign(p[0]! - body.face.x) || 1;
  const back = Math.max(0, Math.min(1, (body.skull[2] - p[2]!) / 0.4));
  for (let i = fixed + 1; i < n; i++) {
    const b = i * 3;
    // On the head hair lies as combed (friction holds it against the scalp); gravity only drapes what hangs below it, eased in over 4 cm.
    const hang = Math.max(0, Math.min(1, (body.hugFloor + 0.2 - p[b + 1]!) / 0.4));
    v[b + 1] = v[b + 1]! - gravity * hang * dt;
    // Hair growing behind the ears hangs down the back (it slides off the shoulders' tops behind them, not over them).
    v[b + 2] = v[b + 2]! - gravity * hang * back * 0.35 * dt;
    p[b] = p[b]! + v[b]! * dt; p[b + 1] = p[b + 1]! + v[b + 1]! * dt; p[b + 2] = p[b + 2]! + v[b + 2]! * dt;
    // The style: towards the remembered shape from the root, by `hold`.
    if (hold > 0) {
      const t = hold * (1 - 0.6 * i / n);
      p[b] = p[b]! + (p[0]! + g.rest[b]! - p[b]!) * t; p[b + 1] = p[b + 1]! + (p[1]! + g.rest[b + 1]! - p[b + 1]!) * t; p[b + 2] = p[b + 2]! + (p[2]! + g.rest[b + 2]! - p[b + 2]!) * t;
    }
  }
  void ties;
  for (let i = fixed + 1; i < n; i++) {
    const a = (i - 1) * 3, b = i * 3;
    const ox = p[b]!, oy = p[b + 1]!, oz = p[b + 2]!;
    const dx = p[b]! - p[a]!, dy = p[b + 1]! - p[a + 1]!, dz = p[b + 2]! - p[a + 2]!;
    const l = Math.hypot(dx, dy, dz) || 1;
    p[b] = p[a]! + dx / l * g.seg; p[b + 1] = p[a + 1]! + dy / l * g.seg; p[b + 2] = p[a + 2]! + dz / l * g.seg;
    body.collide(p, b, margin * rootWidth(g, i * g.seg), true, true, side);
    d[b] = p[b]! - ox; d[b + 1] = p[b + 1]! - oy; d[b + 2] = p[b + 2]! - oz;
  }
  const S = 0.9;
  for (let i = fixed + 1; i < n; i++) {
    const b = i * 3, nb = (i + 1) * 3;
    // Friction where it lies on the head: most of its motion there lost each step, so it stays as combed (no jitter from the scalp's pushes).
    const hang = Math.max(0, Math.min(1, (body.hugFloor + 0.2 - p[b + 1]!) / 0.4));
    const keep = 0.985 * (0.15 + 0.85 * hang);
    for (let k = 0; k < 3; k++) {
      const next = i + 1 < n ? d[nb + k]! : 0;
      v[b + k] = ((p[b + k]! - x[b + k]!) - S * next) / dt * keep;
    }
  }
}

/** A strand gathered into a tie, as hair is brushed back into a ponytail: from its root along the head to the tie (an arc round the skull's middle,
 *  kept just off the scalp), held there at its own place in the tie's bunch; the rest of it the tail, hanging from the tie. Returns false when the strand is too short. */
export function gather(g: Guide, body: GroomBody, tie: Tie, id: number, margin: number): boolean {
  const p = g.pts, n = p.length / 3;
  const [cx, cy, cz] = body.skull;
  const root = [p[0]!, p[1]!, p[2]!];
  const dist = Math.hypot(tie.x - root[0]!, tie.y - root[1]!, tie.z - root[2]!);
  const k = Math.min(n - 2, Math.max(2, Math.round(dist / g.seg)));
  if (n < 4) return false;
  // Its place in the bunch: spread on a small disc by the root's angle round the head (so the tail has thickness, and strands stay in order).
  const a = Math.atan2(root[0]! - cx, root[1]! - cy);
  const held = [tie.x + Math.sin(a) * tie.radius * 0.55, tie.y + Math.cos(a) * tie.radius * 0.55, tie.z];
  const r0 = Math.hypot(root[0]! - cx, root[1]! - cy, root[2]! - cz), r1 = Math.hypot(held[0]! - cx, held[1]! - cy, held[2]! - cz);
  const u0 = [(root[0]! - cx) / r0, (root[1]! - cy) / r0, (root[2]! - cz) / r0], u1 = [(held[0]! - cx) / r1, (held[1]! - cy) / r1, (held[2]! - cz) / r1];
  const c = [u0[0]!, (u0[1]! + u1[1]!) / 2, (u0[2]! + u1[2]!) / 2];
  for (let i = 1; i <= k; i++) {
    const t = i / k;
    // The direction from the skull's middle along a curve that leaves the root parallel to the parting (its side-to-side unchanged at first),
    // then turns to the tie: strands either side of a parting lie side by side along it instead of opening a crack.
    const a0 = (1 - t) * (1 - t), a1 = 2 * t * (1 - t), a2 = t * t;
    let ux = u0[0]! * a0 + c[0]! * a1 + u1[0]! * a2, uy = u0[1]! * a0 + c[1]! * a1 + u1[1]! * a2, uz = u0[2]! * a0 + c[2]! * a1 + u1[2]! * a2;
    const ul = Math.hypot(ux, uy, uz) || 1; ux /= ul; uy /= ul; uz /= ul;
    const r = r0 * (1 - t) + r1 * t;
    p[i * 3] = cx + ux * r; p[i * 3 + 1] = cy + uy * r; p[i * 3 + 2] = cz + uz * r;
    if (i < k) body.collide(p, i * 3, margin * rootWidth(g, i * g.seg), false);
  }
  g.tie = { id, k };
  // The tail: straight down from the tie, then settled.
  for (let i = k + 1; i < n; i++) { p[i * 3] = p[(i - 1) * 3]!; p[i * 3 + 1] = p[(i - 1) * 3 + 1]! - g.seg; p[i * 3 + 2] = p[(i - 1) * 3 + 2]! - 0.02; }
  g.vel.fill(0);
  settle(g, body, margin);
  return true;
}

/** The groom as a game item (`ProxyPack`): every clump vertex pinned to its three nearest head and neck skin vertices, as MakeHuman items are. */
export function groomPack(guides: readonly Guide[], body: GroomBody, anchors: readonly number[]): ProxyPack {
  // The surface the studio shows (`hairVolume.ts`), at a resolution light enough for the street.
  const volume = new HairVolume(new MeshStandardMaterial(), 84);
  volume.build(guides, body.skull, body.cap(guides));
  const { positions, index } = volume.geometry();
  volume.mesh.geometry.dispose();
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
    view.setUint16(o + 4, Math.round(g.radius * 1000) | (g.blunt ? 0x8000 : 0), true); view.setInt16(o + 6, g.tie ? g.tie.id * 64 + g.tie.k : -1, true);
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
    const root = view.getUint16(o, true), n = view.getUint16(o + 2, true), packed = view.getUint16(o + 4, true), tie = view.getInt16(o + 6, true);
    // The radius in thousandths of a dm, its top bit a blunt cut.
    const radius = (packed & 0x7fff) / 1000;
    o += 8;
    const pts = new Float32Array(n * 3);
    const base = [P[root * 3]! + N[root * 3]! * 0.04, P[root * 3 + 1]! + N[root * 3 + 1]! * 0.04, P[root * 3 + 2]! + N[root * 3 + 2]! * 0.04];
    for (let i = 0; i < n * 3; i++) { pts[i] = base[i % 3]! + view.getInt16(o, true) / 1000; o += 2; }
    let seg = 0;
    for (let i = 1; i < n; i++) seg += Math.hypot(pts[i * 3]! - pts[i * 3 - 3]!, pts[i * 3 + 1]! - pts[i * 3 - 2]!, pts[i * 3 + 2]! - pts[i * 3 - 1]!);
    const g: Guide = { root, pts, rest: new Float32Array(n * 3), vel: new Float32Array(n * 3), seg: seg / Math.max(1, n - 1), radius,
      tie: tie >= 0 ? { id: tie >> 6, k: tie & 63 } : null, row: -1, theta: 0, edge: body.edges.get(root) ?? 0, blunt: (packed & 0x8000) !== 0 };
    const rt = record.rows?.[k];
    if (rt) { g.row = rt[0]; g.theta = rt[1] / 100; }
    remember(g);
    out.push(g);
  }
  return out;
}
