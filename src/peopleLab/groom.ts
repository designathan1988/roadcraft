
/** THE BODY HAIR LIVES ON (`hairShell.ts`): the head's skin as a grid for collision, its scalp (the game's hairline), the face kept clear,
 *  the ears passed over, the skull's middle. All in the base mesh's frame, decimetres. */

export interface Tie { x: number; y: number; z: number; radius: number }

/** A person's body for the editors that work on it (the hair builder, the atelier): positions (dm), quads, the skin's vertices, the head and neck's. */
export interface StudioBody {
  readonly positions: Float32Array;
  readonly faces: Uint16Array;
  readonly faceGroup: Uint8Array;
  readonly skinGroup: number;
  /** The skin's vertices (the body's own range). */
  readonly skin: readonly number[];
  /** Head and neck skin vertices: what worn hair is pinned to. */
  readonly anchors: readonly number[];
}

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
    // First roughly (anything past the skull's width in the ear's zone), then truly: standing out more than 4 mm from the head's side there - the
    // side as it is just in front of and just behind the ear at the same height, between them interpolated (the head is wider at the ears than above).
    const near = (v: number): boolean => Math.abs(P[v * 3]! - mid[0]!) > skullHalf + 0.02 && P[v * 3 + 1]! < mid[1]! + ry * 0.2 && P[v * 3 + 1]! > mid[1]! - ry * 1.7
      && Math.abs(P[v * 3 + 2]! - mid[2]!) < 0.6;
    const out = (v: number): number => Math.abs(P[v * 3]! - mid[0]!);
    const ears = new Set<number>();
    const head = skin.filter((v) => P[v * 3 + 1]! > top - 2.45);
    for (const sgn of [-1, 1]) {
      const rough = head.filter((v) => near(v) && Math.sign(P[v * 3]! - mid[0]!) === sgn);
      if (!rough.length) continue;
      const z0 = Math.min(...rough.map((v) => P[v * 3 + 2]!)), z1 = Math.max(...rough.map((v) => P[v * 3 + 2]!));
      const side = head.filter((v) => Math.sign(P[v * 3]! - mid[0]!) === sgn && !near(v));
      for (const v of rough) {
        const y = P[v * 3 + 1]!;
        const band = side.filter((u) => Math.abs(P[u * 3 + 1]! - y) < 0.08);
        const before = band.filter((u) => P[u * 3 + 2]! > z1 && P[u * 3 + 2]! < z1 + 0.15).map(out);
        const behind = band.filter((u) => P[u * 3 + 2]! < z0 && P[u * 3 + 2]! > z0 - 0.15).map(out);
        const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
        const f = before.length ? mean(before) : skullHalf, b = behind.length ? mean(behind) : skullHalf;
        const t = (P[v * 3 + 2]! - z0) / Math.max(1e-6, z1 - z0);
        if (out(v) > b + (f - b) * t + 0.04) ears.add(v);
      }
    }
    const ear = (v: number): boolean => ears.has(v);
    this.scalp = this.scalp.filter((v) => !ear(v));
    // Nor do the ears' polygons stop hair (lying over them it showed their relief): hair passes over each ear's box, rounded (`collide`).
    for (const sgn of [-1, 1]) {
      const vs = skin.filter((v) => ear(v) && Math.sign(P[v * 3]! - mid[0]!) === sgn);
      if (!vs.length) continue;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const v of vs) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a]!, P[v * 3 + a]!); hi[a] = Math.max(hi[a]!, P[v * 3 + a]!); }
      // The ear's box: its middle and half sizes.
      this.ears.push({ c: [0, 1, 2].map((a) => (lo[a]! + hi[a]!) / 2), r: [0, 1, 2].map((a) => (hi[a]! - lo[a]!) / 2) });
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
    this.hairlineY = (theta) => mid[1]! + hairline(theta) * ry;
    this.head = headProxy(P, skin, mid, top, this.face);
  }

  /** The ears' boxes: middle and half sizes (dm). */
  readonly ears: { c: number[]; r: number[] }[] = [];

  /** Whether a point lies over an ear (within its outline seen from the side, on its side of the head). */
  overEar(x: number, y: number, z: number): boolean {
    return this.ears.some((e) => {
      const dy = (y - e.c[1]!) / (e.r[1]! + 0.02), dz = (z - e.c[2]!) / (e.r[2]! + 0.02);
      return dy * dy + dz * dz < 1 && Math.sign(x - this.skull[0]) === Math.sign(e.c[0]! - this.skull[0]);
    });
  }

  /** Scalp vertices near the hairline: how near (1 on it). */
  readonly edges = new Map<number, number>();

  /** The hairline's height (dm) at an angle round the head (0 at the brow, positive to the left). */
  hairlineY: (theta: number) => number = () => 0;
  /** The smooth head the hair is fitted to (`headProxy`). */
  head: HeadProxy = { c: [0, 0, 0], radius: () => 1 };

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
  private clearFace(p: Float32Array | number[], i: number, margin: number, side: number): void {
    const f = this.face;
    const y = p[i + 1]!, z = p[i + 2]!;
    if (z < f.front || y > f.top || y < f.bottom) return;
    const dx = p[i]! - f.x;
    // The clump's own width beyond its middle (`hairStrips.ts`, about its margin) kept off the eyes too.
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
  collide(p: Float32Array | number[], i: number, margin: number, face = true, hug = false, side = 0): void {
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
    // Over the ears: only sideways, out to a smooth dome over each ear's box plus the margin - hair passes over an ear as a soft bulge, never parts
    // round it. Not for hair combed to a tie (`face` off): pulled tight above the ears, it would only lift into flaps at the temples.
    if (face) for (const e of this.ears) {
      const ry = e.r[1]! + 0.25, rz = e.r[2]! + 0.22;
      const dy = (p[i + 1]! - e.c[1]!) / ry, dz = (p[i + 2]! - e.c[2]!) / rz;
      const across = 1 - dy * dy - dz * dz;
      if (across <= 0) continue;
      const sgn = Math.sign(e.c[0]! - this.skull[0]) || 1;
      // A smooth bump (flat at its rim, not an ellipsoid's steep edge): strands bend over it gradually instead of kinking.
      const out = e.c[0]! + sgn * ((e.r[0]! + margin) * across * (2 - across));
      if (sgn * (p[i]! - out) < 0 && sgn * (p[i]! - e.c[0]!) > -0.4) p[i] = out;
    }
    // Last, so nothing draws hair back over the eyes.
    if (face) this.clearFace(p, i, margin, side);
  }
}

/** The smooth head the hair is fitted to (VRoid's "fit to head"): the head's own shape round the skull's middle as a radial map (the farthest
 *  skin in each direction, the face in front of the brow left out), blurred so the ears are a soft rise and the skull's small relief is gone; hair
 *  laid on it follows the head closely, never enters it and passes over the ears in one sheet. */
export interface HeadProxy { readonly c: number[]; radius(d: readonly number[]): number }

const AROUND = 48, UPDOWN = 24;

function headProxy(P: Float32Array, skin: readonly number[], mid: number[], top: number, face: { front: number; top: number }): HeadProxy {
  const c = [mid[0]!, top - 1.0, mid[2]!];
  const map = new Float32Array(AROUND * UPDOWN);
  const bin = (d: readonly number[]): [number, number] => {
    const lon = Math.atan2(d[0]!, d[2]!), lat = Math.asin(Math.max(-1, Math.min(1, d[1]!)));
    return [((lon / (Math.PI * 2) + 1) % 1) * AROUND, (lat / Math.PI + 0.5) * (UPDOWN - 1)];
  };
  for (const v of skin) {
    const x = P[v * 3]! - c[0]!, y = P[v * 3 + 1]! - c[1]!, z = P[v * 3 + 2]! - c[2]!;
    if (P[v * 3 + 1]! < top - 2.6 || (P[v * 3 + 2]! > face.front && P[v * 3 + 1]! < face.top)) continue;
    const l = Math.hypot(x, y, z);
    const [i, j] = bin([x / l, y / l, z / l]);
    const q = Math.round(j) * AROUND + (Math.floor(i) % AROUND);
    map[q] = Math.max(map[q]!, l);
  }
  // Empty bins (under the jaw, the face) from their neighbours; then the ears' rise softened: a few passes of a max-then-mean filter.
  for (let pass = 0; pass < 30; pass++) {
    let empty = 0;
    for (let j = 0; j < UPDOWN; j++) for (let i = 0; i < AROUND; i++) {
      if (map[j * AROUND + i]! > 0) continue;
      let sum = 0, n = 0;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const jj = j + dj; if (jj < 0 || jj >= UPDOWN) continue;
        const w = map[jj * AROUND + ((i + di + AROUND) % AROUND)]!;
        if (w > 0) { sum += w; n++; }
      }
      if (n) map[j * AROUND + i] = sum / n; else empty++;
    }
    if (!empty) break;
  }
  for (let pass = 0; pass < 3; pass++) {
    const src = Float32Array.from(map);
    for (let j = 0; j < UPDOWN; j++) for (let i = 0; i < AROUND; i++) {
      let sum = 0, n = 0, most = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const jj = j + dj; if (jj < 0 || jj >= UPDOWN) continue;
        const w = src[jj * AROUND + ((i + di + AROUND) % AROUND)]!;
        sum += w; n++; most = Math.max(most, w);
      }
      // Never under the head's own surface (the max), smoothed towards the mean round it.
      map[j * AROUND + i] = Math.max(src[j * AROUND + i]!, 0.5 * most + 0.5 * sum / n);
    }
  }
  return {
    c,
    radius(d) {
      const [fi, fj] = bin(d);
      const i0 = Math.floor(fi), j0 = Math.max(0, Math.min(UPDOWN - 2, Math.floor(fj))), u = fi - i0, w = Math.max(0, Math.min(1, fj - j0));
      const at = (i: number, j: number): number => map[j * AROUND + ((i % AROUND) + AROUND) % AROUND]!;
      return (at(i0, j0) * (1 - u) + at(i0 + 1, j0) * u) * (1 - w) + (at(i0, j0 + 1) * (1 - u) + at(i0 + 1, j0 + 1) * u) * w + 0.015;
    },
  };
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
