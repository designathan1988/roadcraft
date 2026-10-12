/**
 * The shortest way between two poses for a vehicle that turns no tighter
 * than a radius and drives forward and in reverse alike (Reeds and Shepp,
 * "Optimal paths for a car that goes both forwards and backwards", Pacific
 * Journal of Mathematics 145(2), 1990): at most five pieces, each a full-lock
 * arc or a straight, from the families CSC, CCC, CCCC, CCSC and CCSCC, each
 * tried as written, time-flipped, reflected and backwards. Written after
 * OMPL's `ReedsSheppStateSpace.cpp`, which carries the paper's formulas 8.1 to
 * 8.11 with its two typos corrected.
 *
 * The hybrid A* (`hybridAStar.ts`) uses it as Dolgov et al. do: its length is
 * a lower bound of the way still to drive, and a way found free of obstacles
 * from a pose of the search to the goal ends the search exactly on the goal.
 */

const PI = Math.PI;
const TWO_PI = 2 * Math.PI;
const ZERO = 10 * Number.EPSILON;

type Piece = 'L' | 'R' | 'S' | '';
const TYPES: readonly (readonly Piece[])[] = [
  ['L', 'R', 'L', '', ''], ['R', 'L', 'R', '', ''], ['L', 'R', 'L', 'R', ''], ['R', 'L', 'R', 'L', ''],
  ['L', 'R', 'S', 'L', ''], ['R', 'L', 'S', 'R', ''], ['L', 'S', 'R', 'L', ''], ['R', 'S', 'L', 'R', ''],
  ['L', 'R', 'S', 'R', ''], ['R', 'L', 'S', 'L', ''], ['R', 'S', 'R', 'L', ''], ['L', 'S', 'L', 'R', ''],
  ['L', 'S', 'R', '', ''], ['R', 'S', 'L', '', ''], ['L', 'S', 'L', '', ''], ['R', 'S', 'R', '', ''],
  ['L', 'R', 'S', 'L', 'R'], ['R', 'L', 'S', 'R', 'L'],
];

/** A Reeds-Shepp way: its pieces and their signed lengths (radians or radii; negative is backing), on a unit radius. */
export interface RsPath {
  readonly type: readonly Piece[];
  readonly lengths: readonly number[];
  readonly total: number;
}

const mod2pi = (x: number): number => {
  let v = x % TWO_PI;
  if (v < -PI) v += TWO_PI;
  else if (v > PI) v -= TWO_PI;
  return v;
};

/** The pieces' lengths, written by the formulas. */
const T = { t: 0, u: 0, v: 0 };

/** `polar`'s answer, written in place. */
const P = { r: 0, theta: 0 };
function polar(x: number, y: number): typeof P {
  P.r = Math.sqrt(x * x + y * y);
  P.theta = Math.atan2(y, x);
  return P;
}

/** `tauOmega`'s answer, written in place. */
const TO = { tau: 0, omega: 0 };
function tauOmega(u: number, v: number, xi: number, eta: number, phi: number): typeof TO {
  const delta = mod2pi(u - v), A = Math.sin(u) - Math.sin(delta), B = Math.cos(u) - Math.cos(delta) - 1;
  const t1 = Math.atan2(eta * A - xi * B, xi * A + eta * B), t2 = 2 * (Math.cos(delta) - Math.cos(v) - Math.cos(u)) + 3;
  TO.tau = t2 < 0 ? mod2pi(t1 + PI) : mod2pi(t1);
  TO.omega = mod2pi(TO.tau - u + v - phi);
  return TO;
}

// formula 8.1
function LpSpLp(x: number, y: number, phi: number): boolean {
  const p = polar(x - Math.sin(phi), y - 1 + Math.cos(phi));
  T.u = p.r; T.t = p.theta;
  if (T.t >= -ZERO) {
    T.v = mod2pi(phi - T.t);
    if (T.v >= -ZERO) return true;
  }
  return false;
}
// formula 8.2
function LpSpRp(x: number, y: number, phi: number): boolean {
  const p = polar(x + Math.sin(phi), y - 1 - Math.cos(phi));
  const u1 = p.r * p.r;
  if (u1 >= 4) {
    T.u = Math.sqrt(u1 - 4);
    const theta = Math.atan2(2, T.u);
    T.t = mod2pi(p.theta + theta);
    T.v = mod2pi(T.t - phi);
    return T.t >= -ZERO && T.v >= -ZERO;
  }
  return false;
}
// formula 8.3 / 8.4 (the paper's typo corrected)
function LpRmL(x: number, y: number, phi: number): boolean {
  const xi = x - Math.sin(phi), eta = y - 1 + Math.cos(phi);
  const p = polar(xi, eta);
  if (p.r <= 4) {
    T.u = -2 * Math.asin(0.25 * p.r);
    T.t = mod2pi(p.theta + 0.5 * T.u + PI);
    T.v = mod2pi(phi - T.t + T.u);
    return T.t >= -ZERO && T.u <= ZERO;
  }
  return false;
}
// formula 8.7
function LpRupLumRm(x: number, y: number, phi: number): boolean {
  const xi = x + Math.sin(phi), eta = y - 1 - Math.cos(phi), rho = 0.25 * (2 + Math.sqrt(xi * xi + eta * eta));
  if (rho <= 1) {
    T.u = Math.acos(rho);
    const to = tauOmega(T.u, -T.u, xi, eta, phi);
    T.t = to.tau; T.v = to.omega;
    return T.t >= -ZERO && T.v <= ZERO;
  }
  return false;
}
// formula 8.8
function LpRumLumRp(x: number, y: number, phi: number): boolean {
  const xi = x + Math.sin(phi), eta = y - 1 - Math.cos(phi), rho = (20 - xi * xi - eta * eta) / 16;
  if (rho >= 0 && rho <= 1) {
    T.u = -Math.acos(rho);
    if (T.u >= -0.5 * PI) {
      const to = tauOmega(T.u, T.u, xi, eta, phi);
      T.t = to.tau; T.v = to.omega;
      return T.t >= -ZERO && T.v >= -ZERO;
    }
  }
  return false;
}
// formula 8.9
function LpRmSmLm(x: number, y: number, phi: number): boolean {
  const xi = x - Math.sin(phi), eta = y - 1 + Math.cos(phi);
  const p = polar(xi, eta);
  if (p.r >= 2) {
    const r = Math.sqrt(p.r * p.r - 4);
    T.u = 2 - r;
    T.t = mod2pi(p.theta + Math.atan2(r, -2));
    T.v = mod2pi(phi - 0.5 * PI - T.t);
    return T.t >= -ZERO && T.u <= ZERO && T.v <= ZERO;
  }
  return false;
}
// formula 8.10
function LpRmSmRm(x: number, y: number, phi: number): boolean {
  const xi = x + Math.sin(phi), eta = y - 1 - Math.cos(phi);
  const p = polar(-eta, xi);
  if (p.r >= 2) {
    T.t = p.theta;
    T.u = 2 - p.r;
    T.v = mod2pi(T.t + 0.5 * PI - phi);
    return T.t >= -ZERO && T.u <= ZERO && T.v <= ZERO;
  }
  return false;
}
// formula 8.11 (the paper's typo corrected)
function LpRmSLmRp(x: number, y: number, phi: number): boolean {
  const xi = x + Math.sin(phi), eta = y - 1 - Math.cos(phi);
  const p = polar(xi, eta);
  if (p.r >= 2) {
    T.u = 4 - Math.sqrt(p.r * p.r - 4);
    if (T.u <= ZERO) {
      T.t = mod2pi(Math.atan2((4 - T.u) * xi - 2 * eta, -2 * xi + (T.u - 4) * eta));
      T.v = mod2pi(T.t - phi);
      return T.t >= -ZERO && T.v >= -ZERO;
    }
  }
  return false;
}

/** The best so far, while the families are tried (no garbage: a search asks a few hundred thousand times). */
let bestType = -1, bestN = 0, bestTotal = Infinity;
const bestL = [0, 0, 0, 0, 0];
function take(type: number, n: number, a: number, b: number, c: number, d = 0, e = 0): void {
  const total = Math.abs(a) + Math.abs(b) + Math.abs(c) + Math.abs(d) + Math.abs(e);
  if (total >= bestTotal) return;
  bestType = type; bestN = n; bestTotal = total;
  bestL[0] = a; bestL[1] = b; bestL[2] = c; bestL[3] = d; bestL[4] = e;
}

function CSC(x: number, y: number, phi: number): void {
  if (LpSpLp(x, y, phi)) take(14, 3, T.t, T.u, T.v);
  if (LpSpLp(-x, y, -phi)) take(14, 3, -T.t, -T.u, -T.v);
  if (LpSpLp(x, -y, -phi)) take(15, 3, T.t, T.u, T.v);
  if (LpSpLp(-x, -y, phi)) take(15, 3, -T.t, -T.u, -T.v);
  if (LpSpRp(x, y, phi)) take(12, 3, T.t, T.u, T.v);
  if (LpSpRp(-x, y, -phi)) take(12, 3, -T.t, -T.u, -T.v);
  if (LpSpRp(x, -y, -phi)) take(13, 3, T.t, T.u, T.v);
  if (LpSpRp(-x, -y, phi)) take(13, 3, -T.t, -T.u, -T.v);
}

function CCC(x: number, y: number, phi: number): void {
  if (LpRmL(x, y, phi)) take(0, 3, T.t, T.u, T.v);
  if (LpRmL(-x, y, -phi)) take(0, 3, -T.t, -T.u, -T.v);
  if (LpRmL(x, -y, -phi)) take(1, 3, T.t, T.u, T.v);
  if (LpRmL(-x, -y, phi)) take(1, 3, -T.t, -T.u, -T.v);
  // backwards
  const xb = x * Math.cos(phi) + y * Math.sin(phi), yb = x * Math.sin(phi) - y * Math.cos(phi);
  if (LpRmL(xb, yb, phi)) take(0, 3, T.v, T.u, T.t);
  if (LpRmL(-xb, yb, -phi)) take(0, 3, -T.v, -T.u, -T.t);
  if (LpRmL(xb, -yb, -phi)) take(1, 3, T.v, T.u, T.t);
  if (LpRmL(-xb, -yb, phi)) take(1, 3, -T.v, -T.u, -T.t);
}

function CCCC(x: number, y: number, phi: number): void {
  if (LpRupLumRm(x, y, phi)) take(2, 4, T.t, T.u, -T.u, T.v);
  if (LpRupLumRm(-x, y, -phi)) take(2, 4, -T.t, -T.u, T.u, -T.v);
  if (LpRupLumRm(x, -y, -phi)) take(3, 4, T.t, T.u, -T.u, T.v);
  if (LpRupLumRm(-x, -y, phi)) take(3, 4, -T.t, -T.u, T.u, -T.v);
  if (LpRumLumRp(x, y, phi)) take(2, 4, T.t, T.u, T.u, T.v);
  if (LpRumLumRp(-x, y, -phi)) take(2, 4, -T.t, -T.u, -T.u, -T.v);
  if (LpRumLumRp(x, -y, -phi)) take(3, 4, T.t, T.u, T.u, T.v);
  if (LpRumLumRp(-x, -y, phi)) take(3, 4, -T.t, -T.u, -T.u, -T.v);
}

function CCSC(x: number, y: number, phi: number): void {
  const h = 0.5 * PI;
  if (LpRmSmLm(x, y, phi)) take(4, 4, T.t, -h, T.u, T.v);
  if (LpRmSmLm(-x, y, -phi)) take(4, 4, -T.t, h, -T.u, -T.v);
  if (LpRmSmLm(x, -y, -phi)) take(5, 4, T.t, -h, T.u, T.v);
  if (LpRmSmLm(-x, -y, phi)) take(5, 4, -T.t, h, -T.u, -T.v);
  if (LpRmSmRm(x, y, phi)) take(8, 4, T.t, -h, T.u, T.v);
  if (LpRmSmRm(-x, y, -phi)) take(8, 4, -T.t, h, -T.u, -T.v);
  if (LpRmSmRm(x, -y, -phi)) take(9, 4, T.t, -h, T.u, T.v);
  if (LpRmSmRm(-x, -y, phi)) take(9, 4, -T.t, h, -T.u, -T.v);
  // backwards
  const xb = x * Math.cos(phi) + y * Math.sin(phi), yb = x * Math.sin(phi) - y * Math.cos(phi);
  if (LpRmSmLm(xb, yb, phi)) take(6, 4, T.v, T.u, -h, T.t);
  if (LpRmSmLm(-xb, yb, -phi)) take(6, 4, -T.v, -T.u, h, -T.t);
  if (LpRmSmLm(xb, -yb, -phi)) take(7, 4, T.v, T.u, -h, T.t);
  if (LpRmSmLm(-xb, -yb, phi)) take(7, 4, -T.v, -T.u, h, -T.t);
  if (LpRmSmRm(xb, yb, phi)) take(10, 4, T.v, T.u, -h, T.t);
  if (LpRmSmRm(-xb, yb, -phi)) take(10, 4, -T.v, -T.u, h, -T.t);
  if (LpRmSmRm(xb, -yb, -phi)) take(11, 4, T.v, T.u, -h, T.t);
  if (LpRmSmRm(-xb, -yb, phi)) take(11, 4, -T.v, -T.u, h, -T.t);
}

function CCSCC(x: number, y: number, phi: number): void {
  const h = 0.5 * PI;
  if (LpRmSLmRp(x, y, phi)) take(16, 5, T.t, -h, T.u, -h, T.v);
  if (LpRmSLmRp(-x, y, -phi)) take(16, 5, -T.t, h, -T.u, h, -T.v);
  if (LpRmSLmRp(x, -y, -phi)) take(17, 5, T.t, -h, T.u, -h, T.v);
  if (LpRmSLmRp(-x, -y, phi)) take(17, 5, -T.t, h, -T.u, h, -T.v);
}

/**
 * The shortest Reeds-Shepp way from pose `a` to pose `b` (positions in world
 * units, headings in radians) for a turning radius `radius`; null only if no
 * family fits, which the theorem says does not happen.
 */
export function reedsShepp(ax: number, ay: number, aAngle: number, bx: number, by: number, bAngle: number, radius: number): RsPath | null {
  const dx = bx - ax, dy = by - ay, c = Math.cos(aAngle), s = Math.sin(aAngle);
  const x = (c * dx + s * dy) / radius, y = (-s * dx + c * dy) / radius, phi = bAngle - aAngle;
  if (!search(x, y, phi)) return null;
  return { type: TYPES[bestType]!.slice(0, bestN), lengths: bestL.slice(0, bestN), total: bestTotal };
}

/** The length (world units) of the shortest Reeds-Shepp way between two poses; Infinity if none. */
export function reedsSheppLength(ax: number, ay: number, aAngle: number, bx: number, by: number, bAngle: number, radius: number): number {
  const dx = bx - ax, dy = by - ay, c = Math.cos(aAngle), s = Math.sin(aAngle);
  return search((c * dx + s * dy) / radius, (-s * dx + c * dy) / radius, bAngle - aAngle) ? bestTotal * radius : Infinity;
}

function search(x: number, y: number, phi: number): boolean {
  bestType = -1; bestN = 0; bestTotal = Infinity;
  CSC(x, y, phi);
  CCC(x, y, phi);
  CCCC(x, y, phi);
  CCSC(x, y, phi);
  CCSCC(x, y, phi);
  return bestType >= 0;
}

/**
 * Poses along a Reeds-Shepp way from pose `a`, one every `step` (world
 * units) and at every piece's end, each with whether it is reached backing.
 */
export function sampleReedsShepp(path: RsPath, ax: number, ay: number, aAngle: number, radius: number, step: number,
  out: { x: number; y: number; angle: number; reverse: boolean }[] = []): { x: number; y: number; angle: number; reverse: boolean }[] {
  let x = 0, y = 0, phi = aAngle;
  const push = (px: number, py: number, angle: number, reverse: boolean): void => {
    out.push({ x: ax + px * radius, y: ay + py * radius, angle, reverse });
  };
  const unit = step / radius;
  for (let i = 0; i < path.lengths.length; i++) {
    const len = path.lengths[i]!, piece = path.type[i]!;
    if (!piece || Math.abs(len) < 1e-12) continue;
    const n = Math.max(1, Math.ceil(Math.abs(len) / unit));
    const x0 = x, y0 = y, p0 = phi;
    for (let k = 1; k <= n; k++) {
      const v = (len * k) / n;
      if (piece === 'L') { x = x0 + Math.sin(p0 + v) - Math.sin(p0); y = y0 - Math.cos(p0 + v) + Math.cos(p0); phi = p0 + v; }
      else if (piece === 'R') { x = x0 - Math.sin(p0 - v) + Math.sin(p0); y = y0 + Math.cos(p0 - v) - Math.cos(p0); phi = p0 - v; }
      else { x = x0 + v * Math.cos(p0); y = y0 + v * Math.sin(p0); }
      push(x, y, phi, len < 0);
    }
  }
  return out;
}
