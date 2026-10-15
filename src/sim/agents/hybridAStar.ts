import { Heap } from '@core/heap';
import { reedsShepp, reedsSheppLength, sampleReedsShepp } from './reedsShepp';
import { m } from '@world/units';

/**
 * A long vehicle's way through a tight yard: forward and in reverse, never
 * turning tighter than it can, its body clear of everything solid - a lorry
 * shunting to a loading dock.
 *
 * Hybrid-state A* (Dolgov, Thrun, Montemerlo and Diebel, "Practical Search
 * Techniques in Path Planning for Autonomous Driving", STAIR 2008: the
 * planner Stanford's Junior drove the Urban Challenge's car parks with). The
 * search runs over cells of (x, y, heading) like A*, but each cell keeps the
 * continuous pose that reached it, so the way found is drivable and not a
 * chain of cell centres. A pose is the REAR AXLE's (the bicycle model: the
 * rear axle moves along its heading, and turns at most at `radius`); each
 * step drives an arc a little longer than a cell's diagonal, forward or in
 * reverse, at one of five curvatures - full lock either way, half lock, and
 * straight. Reversing and changing direction cost extra, as the paper's
 * search penalises them, and so does turning the wheel, as PythonRobotics'
 * `hybrid_a_star.py` weighs its steer and steer-change terms.
 *
 * Guided by the paper's "holonomic-with-obstacles" heuristic: the shortest
 * way for the rear axle alone round the obstacles, by Dijkstra over the cells
 * from the goal, which turns the search away from dead ends. The body is
 * tested as discs and points that cover its rectangle, against a clearance field
 * (the distance from every cell to the nearest solid one, Felzenszwalb and
 * Huttenlocher, "Distance Transforms of Sampled Functions", 2012): one look
 * per disc.
 *
 * Near the goal it tries the paper's analytic expansion, a Reeds-Shepp shot
 * to the goal (`reedsShepp.ts`, `WaySearch.shot`), taken when nothing stands
 * on it; otherwise the goal is reached within a tolerance, and the caller
 * settles the last few centimetres with a short leg.
 */

/** A vehicle as the planner sees it. World units. */
export interface Steered {
  readonly length: number;
  readonly width: number;
  /** How far the body's centre is ahead of the rear axle. */
  readonly rear: number;
  /** The least radius the rear axle turns at (full lock). */
  readonly radius: number;
  /** Kept clear of anything solid, besides the body itself. */
  readonly margin: number;
}

/** A pose of the rear axle: where it is and where the body points. */
export interface AxlePose { readonly x: number; readonly y: number; readonly angle: number }

/** A pose on the way, and whether it is reached backing. */
export interface Waypoint extends AxlePose { readonly reverse: boolean }

/** What is solid, on a grid: 1 for a cell a body may not touch. */
export interface Solid {
  readonly x0: number;
  readonly y0: number;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly blocked: Uint8Array;
}

/** Distance from each cell's centre to the nearest solid cell's centre (0 in one), world units. */
export interface Clearance extends Solid {
  readonly clear: Float32Array;
}

/** The clearance field of a grid of solid cells: an exact Euclidean distance transform. */
export function clearanceOf(solid: Solid): Clearance {
  const steps = clearanceSteps(solid, Infinity);
  for (;;) {
    const next = steps.next();
    if (next.done) return next.value;
  }
}

/**
 * `clearanceOf` in slices: it yields after about `slice` cells of work, so
 * a yard's field (a third of a million cells) is worked out over several
 * ticks, not in one (a 30 ms tick in the game, 2026-10-13). The work is
 * counted in cells, so the slicing is the same on every machine.
 */
export function* clearanceSteps(solid: Solid, slice: number): Generator<void, Clearance, void> {
  const { nx, ny, blocked, cell } = solid;
  const INF = Infinity;
  const sq = new Float64Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) sq[i] = blocked[i] ? 0 : INF;
  const n = Math.max(nx, ny);
  const f = new Float64Array(n), d = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  let work = 0;
  // Along the columns, then along the rows (the transform is separable).
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = sq[j * nx + i]!;
    transform1d(f, ny, d, v, z);
    for (let j = 0; j < ny; j++) sq[j * nx + i] = d[j]!;
    if ((work += ny) >= slice) { work = 0; yield; }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) f[i] = sq[j * nx + i]!;
    transform1d(f, nx, d, v, z);
    for (let i = 0; i < nx; i++) sq[j * nx + i] = d[i]!;
    if ((work += nx) >= slice) { work = 0; yield; }
  }
  const clear = new Float32Array(nx * ny);
  for (let i = 0; i < nx * ny; i++) clear[i] = Math.sqrt(sq[i]!) * cell;
  return { ...solid, clear };
}

/**
 * One row of the squared distance transform (Felzenszwalb and Huttenlocher's
 * Algorithm 1, the lower envelope of the parabolas rooted at each sample):
 * `f` in, `d` out, the first `n` of each. Samples at infinity root no
 * parabola (their sums would lose the squares).
 */
function transform1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] === Infinity) continue;
    for (;;) {
      if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; break; }
      const p = v[k]!;
      const s = ((f[q]! + q * q) - (f[p]! + p * p)) / (2 * q - 2 * p);
      if (s <= z[k]!) { k--; continue; }
      k++;
      v[k] = q; z[k] = s; z[k + 1] = Infinity;
      break;
    }
  }
  if (k < 0) { for (let q = 0; q < n; q++) d[q] = Infinity; return; }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1]! < q) j++;
    const p = v[j]!;
    d[q] = (q - p) * (q - p) + f[p]!;
  }
}

/**
 * What a body is tested with: discs along its axis as wide as the body and a
 * little, between the points half a width in from either end, and at each end
 * two discs a quarter width either side of the axis, half a width in, whose
 * radius reaches the corners - together they cover the rectangle and reach
 * no more than a quarter of a width past its ends. `at` are the axis discs'
 * offsets ahead of the rear axle; `pu`, `pv` the end discs' offsets ahead and
 * to the left.
 */
export interface Discs {
  readonly at: Float64Array;
  readonly r: number;
  readonly pu: Float64Array;
  readonly pv: Float64Array;
  readonly pr: number;
  /** The body's centre ahead of the rear axle, and the disc round the whole body (one look in the open). */
  readonly centre: number;
  readonly whole: number;
}

/** Most spacing of the axis discs. */
const DISC_STEP = m(1);

export function discsOf(body: Steered): Discs {
  const back = body.length / 2 - body.rear, front = body.length / 2 + body.rear, hw = body.width / 2;
  const u0 = -back + hw, u1 = front - hw;
  // Two discs of radius hw + margin this far apart still cover the side between them.
  const r = hw + body.margin;
  const spacing = Math.min(DISC_STEP, 1.9 * Math.sqrt(r * r - hw * hw));
  const n = Math.max(1, Math.ceil((u1 - u0) / spacing)) + 1;
  const at = new Float64Array(n);
  for (let i = 0; i < n; i++) at[i] = u0 + ((u1 - u0) * i) / (n - 1);
  const pu = [-back + hw / 2, -back + hw / 2, front - hw / 2, front - hw / 2];
  const pv = [-hw / 2, hw / 2, -hw / 2, hw / 2];
  return {
    at, r, pu: Float64Array.from(pu), pv: Float64Array.from(pv), pr: Math.SQRT1_2 * hw + body.margin,
    centre: body.rear, whole: Math.hypot(body.length / 2, hw) + body.margin,
  };
}

/** Whether the body at the rear-axle pose `(x, y, angle)` touches nothing solid (nor leaves the grid). */
export function bodyClear(field: Clearance, discs: Discs, x: number, y: number, angle: number): boolean {
  return bodyClearCS(field, discs, x, y, Math.cos(angle), Math.sin(angle));
}

/** `bodyClear` with the heading as its cosine and sine (the search turns them without trigonometry). */
function bodyClearCS(field: Clearance, discs: Discs, x: number, y: number, c: number, s: number): boolean {
  // The field holds the distance at a cell's centre: a point anywhere in the cell is up to half a diagonal off it.
  const slack = field.cell * Math.SQRT1_2;
  if (clearAt(field, x + c * discs.centre, y + s * discs.centre) - slack >= discs.whole) return true;
  for (let k = 0; k < discs.at.length; k++) {
    if (clearAt(field, x + c * discs.at[k]!, y + s * discs.at[k]!) - slack < discs.r) return false;
  }
  for (let k = 0; k < discs.pu.length; k++) {
    const u = discs.pu[k]!, v = discs.pv[k]!;
    if (clearAt(field, x + c * u - s * v, y + s * u + c * v) - slack < discs.pr) return false;
  }
  return true;
}

function clearAt(field: Clearance, px: number, py: number): number {
  const i = Math.floor((px - field.x0) / field.cell), j = Math.floor((py - field.y0) / field.cell);
  if (i < 0 || j < 0 || i >= field.nx || j >= field.ny) return -Infinity;
  return field.clear[j * field.nx + i]!;
}

/**
 * Whether the body's rectangle at the pose covers no solid cell: every cell
 * under it looked at, for the last few centimetres into a dock where the
 * discs' margins would not let it go.
 */
export function bodyClearExact(field: Solid, body: Steered, x: number, y: number, angle: number, margin = 0): boolean {
  const c = Math.cos(angle), s = Math.sin(angle);
  const back = body.length / 2 - body.rear + margin, front = body.length / 2 + body.rear + margin, hw = body.width / 2 + margin;
  const step = field.cell / 2;
  for (let u = -back; u <= front + 1e-9; u += step) {
    for (let v = -hw; v <= hw + 1e-9; v += step) {
      const px = x + c * u - s * v, py = y + s * u + c * v;
      const i = Math.floor((px - field.x0) / field.cell), j = Math.floor((py - field.y0) / field.cell);
      if (i < 0 || j < 0 || i >= field.nx || j >= field.ny || field.blocked[j * field.nx + i]) return false;
    }
  }
  return true;
}

/** The search's own cells: this much across, and this many headings round. */
const XY_CELL = m(0.5);
const HEADINGS = 72;
/** One step's arc: a little longer than a cell's diagonal, so a step always leaves its cell. */
const STEP = m(0.8);
/** Poses tested along a step. */
const SUBSTEPS = 2;
/** Costs, per unit of length driven: backing, and a change of direction (a stop and a start), and the wheel. */
const REVERSE_COST = 1.6;
const SWITCH_COST = m(15);
const STEER_COST = 0.6;
const STEER_CHANGE_COST = m(2);
/** The heuristic's weight: a little over one finds a way sooner, a little longer than the shortest. */
const H_WEIGHT = 1.4;
/** A Reeds-Shepp shot to the goal is tried from poses this near it (every pose within the inner reach, one in `SHOT_EVERY` beyond). */
const SHOT_REACH = m(30);
const SHOT_NEAR = m(8);
const SHOT_EVERY = 8;
/** The Reeds-Shepp length guides the search this near the goal. */
const H_RS_REACH = m(30);
/** Spacing of the poses a shot is tested and driven at. */
const SHOT_STEP = m(0.25);
/** Most poses expanded before giving up. */
const MAX_EXPANDED = 80_000;

export interface PlanOptions {
  /** How near the goal's position and heading a pose must come. */
  readonly reach?: number;
  readonly turn?: number;
  /** Whether the goal is to be reached backing (true), driving forward (false), or either (absent). */
  readonly arriveReversing?: boolean;
  /**
   * A goal that is a region (through a gate, say) rather than a pose: whether
   * a pose reached is in it. `goal` then only guides the search there.
   */
  readonly arrived?: (x: number, y: number, angle: number, reverse: boolean) => boolean;
}

interface Node {
  x: number; y: number; a: number;
  g: number;
  parent: number;
  reverse: boolean;
  kappa: number;
  closed: boolean;
}

/** Poses expanded and searches made, all told (for probes and measures). */
const searchStats = { expanded: 0, searches: 0, found: 0 };

/**
 * The search, run a slice at a time: the simulation gives it a few hundred
 * poses a tick (`run`) instead of stalling a frame on a whole yard.
 */
export class WaySearch {
  state: 'running' | 'found' | 'failed' = 'running';
  way: Waypoint[] | null = null;
  /** Poses expanded so far. */
  expanded = 0;
  private readonly discs: Discs;
  private readonly reach: number;
  private readonly turn: number;
  private readonly h: { nx: number; ny: number; cell: number; dist: Float64Array } | null;
  private readonly nx: number;
  private readonly nodes: Node[] = [];
  private readonly byKey = new Map<number, number>();
  private readonly open = new Heap();
  private readonly kappas: number[];
  /** Cosine and sine of each curvature's turn over a forward substep. */
  private readonly turnCos: number[];
  private readonly turnSin: number[];

  constructor(private readonly field: Clearance, private readonly body: Steered, start: AxlePose,
    private readonly goal: AxlePose, private readonly options: PlanOptions = {}) {
    searchStats.searches++;
    this.discs = discsOf(body);
    this.reach = options.reach ?? m(0.3);
    this.turn = options.turn ?? (5 * Math.PI) / 180;
    this.nx = Math.ceil((field.nx * field.cell) / XY_CELL);
    this.kappas = [-1, -0.5, 0, 0.5, 1].map((k) => k / body.radius);
    this.turnCos = this.kappas.map((k) => Math.cos((k * STEP) / SUBSTEPS));
    this.turnSin = this.kappas.map((k) => Math.sin((k * STEP) / SUBSTEPS));
    if (!bodyClear(field, this.discs, start.x, start.y, start.angle) || (!options.arrived && !bodyClear(field, this.discs, goal.x, goal.y, goal.angle))) {
      this.state = 'failed';
      this.h = null;
      return;
    }
    this.h = holonomic(field, goal, body.width / 2);
    this.push({ x: start.x, y: start.y, a: start.angle, g: 0, parent: -1, reverse: false, kappa: 0, closed: false });
  }

  /** Expands up to `budget` more poses; the state says whether it is over. */
  run(budget: number): void {
    if (this.state !== 'running') return;
    const { field, discs, goal, body, nodes, open } = this;
    const stop = this.expanded + budget;
    while (open.size && this.expanded < stop && this.expanded < MAX_EXPANDED) {
      const id = open.pop();
      const n = nodes[id]!;
      if (n.closed) continue;
      n.closed = true;
      this.expanded++;
      searchStats.expanded++;
      const there = this.options.arrived ? n.parent >= 0 && this.options.arrived(n.x, n.y, n.a, n.reverse)
        : Math.hypot(n.x - goal.x, n.y - goal.y) <= this.reach && Math.abs(wrap(n.a - goal.angle)) <= this.turn;
      if (there && (this.options.arriveReversing === undefined || n.parent < 0 || n.reverse === this.options.arriveReversing)) {
        this.way = trace(nodes, id);
        this.state = 'found';
        searchStats.found++;
        return;
      }
      // The analytic expansion (Dolgov et al.): the shortest Reeds-Shepp way
      // from here to the goal, taken if nothing stands on it - the search then
      // ends exactly on the goal, not near it. Tried more often nearer.
      if (!this.options.arrived) {
        const far = Math.hypot(n.x - goal.x, n.y - goal.y);
        if (far <= SHOT_NEAR || (far <= SHOT_REACH && this.expanded % SHOT_EVERY === 0)) {
          const shot = this.shot(n);
          if (shot) {
            this.way = [...trace(nodes, id), ...shot];
            this.state = 'found';
            searchStats.found++;
            return;
          }
        }
      }
      const c0 = Math.cos(n.a), s0 = Math.sin(n.a);
      for (let d = 0; d < 2; d++) {
        const dir = d === 0 ? 1 : -1;
        for (let q = 0; q < this.kappas.length; q++) {
          const kappa = this.kappas[q]!;
          let x = n.x, y = n.y, c = c0, sn = s0, ok = true;
          const ds = (STEP / SUBSTEPS) * dir;
          // The heading turned by kappa * ds a substep, as a rotation.
          const cd = this.turnCos[q]!, sd = this.turnSin[q]! * dir;
          for (let k = 0; k < SUBSTEPS && ok; k++) {
            // Exact arc of the bicycle's rear axle over the substep.
            if (kappa === 0) { x += c * ds; y += sn * ds; }
            else {
              const c1 = c * cd - sn * sd, s1 = sn * cd + c * sd;
              x += (s1 - sn) / kappa;
              y -= (c1 - c) / kappa;
              c = c1; sn = s1;
            }
            ok = bodyClearCS(field, discs, x, y, c, sn);
          }
          if (!ok) continue;
          const a = n.a + STEP * dir * kappa;
          const reverse = dir < 0;
          let g = n.g + STEP * (reverse ? REVERSE_COST : 1) + STEP * STEER_COST * Math.abs(kappa) * body.radius
            + STEER_CHANGE_COST * Math.abs(kappa - n.kappa) * body.radius;
          if (n.parent >= 0 && reverse !== n.reverse) g += SWITCH_COST;
          this.push({ x, y, a, g, parent: id, reverse, kappa, closed: false });
        }
      }
    }
    if (!open.size || this.expanded >= MAX_EXPANDED) this.state = 'failed';
  }

  /** The Reeds-Shepp way from a pose to the goal as poses, if its body touches nothing (and it arrives the way asked). */
  private shot(n: Node): Waypoint[] | null {
    const { goal, body } = this;
    const path = reedsShepp(n.x, n.y, n.a, goal.x, goal.y, goal.angle, body.radius);
    if (!path) return null;
    let lastSign = 0;
    for (const len of path.lengths) if (Math.abs(len) > 1e-9) lastSign = Math.sign(len);
    if (this.options.arriveReversing !== undefined && (lastSign < 0) !== this.options.arriveReversing) return null;
    const poses = sampleReedsShepp(path, n.x, n.y, n.a, body.radius, SHOT_STEP);
    for (const p of poses) if (!bodyClear(this.field, this.discs, p.x, p.y, p.angle)) return null;
    return poses;
  }

  private keyOf(x: number, y: number, a: number): number {
    const i = Math.floor((x - this.field.x0) / XY_CELL), j = Math.floor((y - this.field.y0) / XY_CELL);
    let k = Math.round((wrap(a) / (2 * Math.PI)) * HEADINGS) % HEADINGS;
    if (k < 0) k += HEADINGS;
    return (j * this.nx + i) * HEADINGS + k;
  }

  /**
   * The cost still to go, at least: the paper's two heuristics' larger -
   * round the obstacles for the axle alone, and (near the goal, where the
   * heading matters) the Reeds-Shepp length, which knows the turning.
   */
  private hAt(x: number, y: number, a: number): number {
    const h = this.h!;
    const i = Math.floor((x - this.field.x0) / h.cell), j = Math.floor((y - this.field.y0) / h.cell);
    if (i < 0 || j < 0 || i >= h.nx || j >= h.ny) return Infinity;
    const far = Math.hypot(this.goal.x - x, this.goal.y - y);
    let best = Math.max(h.dist[j * h.nx + i]!, far);
    if (!this.options.arrived && far <= H_RS_REACH) {
      best = Math.max(best, reedsSheppLength(x, y, a, this.goal.x, this.goal.y, this.goal.angle, this.body.radius));
    }
    return best;
  }

  private push(n: Node): void {
    const key = this.keyOf(n.x, n.y, n.a);
    const at = this.byKey.get(key);
    if (at !== undefined) {
      const old = this.nodes[at]!;
      if (old.closed || old.g <= n.g) return;
      this.nodes[at] = n;
      this.open.push(at, n.g + H_WEIGHT * this.hAt(n.x, n.y, n.a));
      return;
    }
    const id = this.nodes.length;
    this.nodes.push(n);
    this.byKey.set(key, id);
    this.open.push(id, n.g + H_WEIGHT * this.hAt(n.x, n.y, n.a));
  }
}

/** The poses from the start to node `id`. */
function trace(nodes: readonly Node[], id: number): Waypoint[] {
  const out: Waypoint[] = [];
  for (let at = id; at >= 0; at = nodes[at]!.parent) {
    const n = nodes[at]!;
    out.push({ x: n.x, y: n.y, angle: n.a, reverse: n.reverse });
  }
  out.reverse();
  // The start is driven in the direction of the first step.
  if (out.length > 1) out[0] = { ...out[0]!, reverse: out[1]!.reverse };
  return out;
}

/**
 * Shortest distance from every cell to the goal for the rear axle alone (a
 * disc of the body's half width), round the obstacles: Dijkstra over the
 * search cells, eight neighbours.
 */
function holonomic(field: Clearance, goal: AxlePose, half: number): { nx: number; ny: number; cell: number; dist: Float64Array } {
  const cell = XY_CELL;
  const nx = Math.ceil((field.nx * field.cell) / cell), ny = Math.ceil((field.ny * field.cell) / cell);
  const dist = new Float64Array(nx * ny).fill(Infinity);
  const free = (i: number, j: number): boolean => {
    const x = field.x0 + (i + 0.5) * cell, y = field.y0 + (j + 0.5) * cell;
    const fi = Math.floor((x - field.x0) / field.cell), fj = Math.floor((y - field.y0) / field.cell);
    if (fi < 0 || fj < 0 || fi >= field.nx || fj >= field.ny) return false;
    return field.clear[fj * field.nx + fi]! >= half;
  };
  const gi = Math.floor((goal.x - field.x0) / cell), gj = Math.floor((goal.y - field.y0) / cell);
  if (gi < 0 || gj < 0 || gi >= nx || gj >= ny) return { nx, ny, cell, dist };
  const heap = new Heap();
  dist[gj * nx + gi] = 0;
  heap.push(gj * nx + gi, 0);
  const done = new Uint8Array(nx * ny);
  while (heap.size) {
    const c = heap.pop();
    if (done[c]) continue;
    done[c] = 1;
    const i = c % nx, j = (c - i) / nx;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di, b = j + dj;
        if (a < 0 || b < 0 || a >= nx || b >= ny) continue;
        const nc = b * nx + a;
        if (done[nc] || !free(a, b)) continue;
        const nd = dist[c]! + (di && dj ? Math.SQRT2 : 1) * cell;
        if (nd < dist[nc]!) { dist[nc] = nd; heap.push(nc, nd); }
      }
    }
  }
  return { nx, ny, cell, dist };
}

const wrap = (a: number): number => {
  let r = a % (2 * Math.PI);
  if (r > Math.PI) r -= 2 * Math.PI;
  if (r < -Math.PI) r += 2 * Math.PI;
  return r;
};

/**
 * Sets every cell of the grid whose centre lies inside the polygon (its rings
 * in the grid's frame, holes by the even-odd rule) to `value`: a scanline
 * fill, each row's crossings sorted and filled between pairs.
 */
export function fillRings(grid: Solid, rings: readonly (readonly { readonly x: number; readonly y: number }[])[], value: 0 | 1): void {
  const { x0, y0, cell, nx, ny } = grid;
  const blocked = grid.blocked;
  let lo = Infinity, hi = -Infinity;
  for (const ring of rings) for (const p of ring) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
  const j0 = Math.max(0, Math.ceil((lo - y0) / cell - 0.5)), j1 = Math.min(ny - 1, Math.floor((hi - y0) / cell - 0.5));
  const xs: number[] = [];
  for (let j = j0; j <= j1; j++) {
    const y = y0 + (j + 0.5) * cell;
    xs.length = 0;
    for (const ring of rings) {
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const p = ring[a]!, q = ring[b]!;
        if ((p.y > y) !== (q.y > y)) xs.push(p.x + ((y - p.y) * (q.x - p.x)) / (q.y - p.y));
      }
    }
    xs.sort((u, v) => u - v);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k]! - x0) / cell - 0.5)), i1 = Math.min(nx - 1, Math.floor((xs[k + 1]! - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) blocked[j * nx + i] = value;
    }
  }
}

/** `fillRings` of one ring. */
export function fillRing(grid: Solid, ring: readonly { readonly x: number; readonly y: number }[], value: 0 | 1): void {
  fillRings(grid, [ring], value);
}
