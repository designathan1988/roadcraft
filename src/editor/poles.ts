import { type Vec2, dist } from '@core/vec2';
import type { PoleId } from '@world/ids';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { CrossingAccess } from '@world/landscape';
import { CROSSWALK_DEPTH } from '@world/approach';
import { nearestOnContour, onFootway, poleLinesAt, poleLinesIn, poleLinesOf, type OnContour, type PoleLines } from '@world/poleLines';
import { type RouteGraph, buildRouteGraph, route } from './poleRoutes';
import { CELL } from '@world/cells';
import type { ChangeRect } from '@world/changes';
import { DEFAULT_POLE_SPACING, MAX_POLE_SPACING, MIN_POLE_SPACING, poleCarriesLamp, type PoleLampMode } from '@world/utilities';
import { m } from '@world/units';

/** Where a pole line goes: on the footway, just behind the kerb, and nowhere else */

/** Pick radius for an existing pole, in screen pixels. */
export const POLE_PICK_PIXELS = 34;

/** A pointer this far from the line, or anywhere on a footway, takes the line. */
const LINE_CATCH = m(2.5);

/** An existing pole off the line (drawn by an older version) joins it within this. */
const POLE_TO_LINE = m(5);

/** Douglas-Peucker tolerance for a corner of the route: a turn that bows the line this far. */
const CORNER_TOLERANCE = m(1.5);

/** Two poles of one run never stand closer than this; corners closer merge into one. */
const MIN_POLE_GAP = m(10);

/** A planned pole this close to a pole already standing is that pole. */
const REUSE_RADIUS = m(6);

export { onFootway };

function lampFor(index: number, mode: PoleLampMode): boolean {
  return mode === 'all' ? true : mode === 'none' ? false : poleCarriesLamp(index);
}

type PoleSnapKind = 'pole' | 'footway' | 'free';

export interface PoleSnap {
  readonly at: Vec2;
  readonly kind: PoleSnapKind;
  /** The existing pole this snapped onto, when `kind` is `pole`. */
  readonly pole?: PoleId;
}

/** Snaps one end of a pole run: onto a pole already standing */
export function snapPole(doc: RoadDoc, net: Network, at: Vec2, reach: number): PoleSnap {
  return snapOn(doc, net, poleLinesAt(net, at), at, reach);
}

/** `snapPole` onto the contours of `lines` (any set of lines holding the point's cell). */
function snapOn(doc: RoadDoc, net: Network, lines: PoleLines, at: Vec2, reach: number): PoleSnap {
  const hit = doc.poleNear(at, reach);
  if (hit) return { at: hit, kind: 'pole', pole: hit.id };
  // Anywhere on the pavement takes its line; off it, only just beside the line.
  const footway = onFootway(net, at);
  const on = nearestOnContour(lines, at, footway ? m(12) : LINE_CATCH);
  if (on && onFootway(net, on.at)) return { at: on.at, kind: 'footway' };
  return { at: { x: at.x, y: at.y }, kind: 'free' };
}

interface PlannedPole {
  readonly at: Vec2;
  /** The pole already standing here, which the run will reuse. */
  readonly existing: PoleId | null;
  readonly lamp: boolean;
}

type PoleRunRefusal = 'offFootway' | 'noPath';

export interface PoleRunPlan {
  readonly from: PoleSnap;
  readonly to: PoleSnap;
  readonly poles: readonly PlannedPole[];
  /** Set when nothing would be built, and why. */
  readonly refused?: PoleRunRefusal;
}

/** Where a snapped end lies on the contours, or null when no contour is near it. */
function placeOf(lines: PoleLines, snap: PoleSnap): OnContour | null {
  return nearestOnContour(lines, snap.at, snap.kind === 'pole' ? POLE_TO_LINE : m(0.5));
}

/** THE ROUTE GRAPH of a network's pole lines */
/** A run's end off its contour: the pole it starts or ends at, put before or after the route. */
const endOff = (snap: PoleSnap, on: OnContour): Vec2 | null => (snap.kind === 'pole' && on.distance > 1e-3 ? snap.at : null);

/** The graph of one set of lines (`poleLinesIn`): made again only with them. */
const graphs = new WeakMap<PoleLines, RouteGraph>();

/** The route graph of the lines of `region` (`poleLinesIn`), made once per set of lines. */
function routeGraph(net: Network, lines: PoleLines, region: ChangeRect): RouteGraph {
  const known = graphs.get(lines);
  if (known) return known;
  const graph = buildRouteGraph(net, lines, region);
  graphs.set(lines, graph);
  return graph;
}

/** A route searched first this far round its two ends, then twice as far, and so on. */
const ROUTE_MARGIN = m(96);
/** How near the region's edge the lines a run's start reaches must come for a larger region to join them to its end (`routeRun`). */
const CLOSED_PAD = m(24);
/** Past this margin a route is taken as found (a run is never planned across a whole city). */
const ROUTE_MARGIN_MOST = m(4096);
/** What the route search did: regions read. A count for the budgets (`core/perfBudget.ts`). */
export const poleRouteWork = { regions: 0 };

/** The run's route, read from the lines of a region round its ends only (`poleLinesIn`), as exact as the whole map's */
function routeRun(net: Network, from: PoleSnap, to: PoleSnap, first = ROUTE_MARGIN):
  { readonly path: Vec2[]; readonly lines: PoleLines } | 'noPlace' | 'noPath' {
  const x0 = Math.min(from.at.x, to.at.x), y0 = Math.min(from.at.y, to.at.y);
  const x1 = Math.max(from.at.x, to.at.x), y1 = Math.max(from.at.y, to.at.y);
  for (let margin = Math.max(first, dist(from.at, to.at)); ; margin *= 2) {
    const region: ChangeRect = [
      Math.floor((x0 - margin) / CELL) * CELL, Math.floor((y0 - margin) / CELL) * CELL,
      Math.ceil((x1 + margin) / CELL) * CELL, Math.ceil((y1 + margin) / CELL) * CELL,
    ];
    poleRouteWork.regions++;
    const lines = poleLinesIn(net, region);
    const a = placeOf(lines, from);
    const b = placeOf(lines, to);
    if (!a || !b) return 'noPlace';
    const reached = { x0: 0, y0: 0, x1: 0, y1: 0 };
    const found = route(routeGraph(net, lines, region), a, b, endOff(from, a), endOff(to, b), reached);
    // DO NOT grow the region up to 4 km for ends no line joins: what the start reaches closes in itself, short of the region's edge.
    if (!found && reached.x0 > region[0] + CLOSED_PAD && reached.y0 > region[1] + CLOSED_PAD && reached.x1 < region[2] - CLOSED_PAD && reached.y1 < region[3] - CLOSED_PAD) return 'noPath';
    // How far the region reaches past the ends, on its nearest side.
    const reach = Math.min(x0 - region[0], y0 - region[1], region[2] - x1, region[3] - y1);
    const last = margin >= ROUTE_MARGIN_MOST;
    if (found && (found.cost < 2 * reach || last)) return { path: found.path, lines };
    if (last) return 'noPath';
  }
}

/** How a run is planned: the lines its ends snap onto, and its route. */
interface Routing {
  linesAt(at: Vec2): PoleLines;
  route(from: PoleSnap, to: PoleSnap): { readonly path: Vec2[]; readonly lines: PoleLines } | 'noPlace' | 'noPath';
}

/** The pole tool's planning: each end on its cell's lines, the route over a region round the run (`routeRun`). */
const regional = (net: Network, first: number): Routing => ({
  linesAt: (at) => poleLinesAt(net, at),
  route: (from, to) => routeRun(net, from, to, first),
});

/** The side of a planner's tile, world units (whole cells). */
const TILE = CELL * 4;

/** Plans many runs over the same streets (`poleRunPlanner`). */
export interface PoleRunPlanner {
  plan(doc: RoadDoc, rawFrom: Vec2, rawTo: Vec2, reach: number, spacing?: number, lamps?: PoleLampMode): PoleRunPlan;
}

/** DO NOT plan a batch of runs one region each: the lines are the same. */
export function poleRunPlanner(net: Network): PoleRunPlanner {
  const tiles = new Map<string, { readonly region: ChangeRect; readonly lines: PoleLines; readonly graph: RouteGraph }>();
  const tileAt = (p: Vec2): { readonly region: ChangeRect; readonly lines: PoleLines; readonly graph: RouteGraph } => {
    const tx = Math.floor(p.x / TILE), ty = Math.floor(p.y / TILE);
    const key = `${tx},${ty}`;
    let tile = tiles.get(key);
    if (!tile) {
      const region: ChangeRect = [tx * TILE - CELL, ty * TILE - CELL, (tx + 1) * TILE + CELL, (ty + 1) * TILE + CELL];
      const lines = poleLinesOf(net, region);
      tile = { region, lines, graph: buildRouteGraph(net, lines, region) };
      tiles.set(key, tile);
    }
    return tile;
  };
  const inner = (r: ChangeRect, p: Vec2): boolean =>
    p.x >= r[0] + ROUTE_MARGIN && p.x <= r[2] - ROUTE_MARGIN && p.y >= r[1] + ROUTE_MARGIN && p.y <= r[3] - ROUTE_MARGIN;
  return {
    plan(doc, rawFrom, rawTo, reach, spacing = DEFAULT_POLE_SPACING, lamps = 'alternate') {
      const tile = tileAt(rawFrom);
      if (!inner(tile.region, rawFrom) || !inner(tile.region, rawTo)) {
        return computePoleRun(doc, net, rawFrom, rawTo, reach, spacing, lamps, regional(net, ROUTE_MARGIN));
      }
      return computePoleRun(doc, net, rawFrom, rawTo, reach, spacing, lamps, {
        linesAt: () => tile.lines,
        route: (from, to) => {
          const a = placeOf(tile.lines, from);
          const b = placeOf(tile.lines, to);
          if (!a || !b) return 'noPlace';
          const found = route(tile.graph, a, b, endOff(from, a), endOff(to, b));
          const r = tile.region;
          const x0 = Math.min(from.at.x, to.at.x), y0 = Math.min(from.at.y, to.at.y);
          const x1 = Math.max(from.at.x, to.at.x), y1 = Math.max(from.at.y, to.at.y);
          // As in `routeRun`: a way out of the lines and back is longer than twice the distance to their border.
          if (found && found.cost < 2 * Math.min(x0 - r[0], y0 - r[1], r[2] - x1, r[3] - y1)) return { path: found.path, lines: tile.lines };
          return routeRun(net, from, to, ROUTE_MARGIN);
        },
      });
    },
  };
}

/** Indices of the points Ramer-Douglas-Peucker keeps at `tolerance`. */
function corners(points: readonly Vec2[], tolerance: number): number[] {
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop()!;
    const a = points[i]!, b = points[j]!;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    let far = -1, farD = tolerance;
    for (let k = i + 1; k < j; k++) {
      const p = points[k]!;
      const d = len > 1e-9 ? Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len : dist(p, a);
      if (d > farD) { farD = d; far = k; }
    }
    if (far >= 0) {
      keep[far] = 1;
      stack.push([i, far], [far, j]);
    }
  }
  const out: number[] = [];
  keep.forEach((k, i) => { if (k) out.push(i); });
  return out;
}

/** Whether a point stands in a crossing's landing (any street's: a corner belongs to none). */
function inLanding(accesses: readonly CrossingAccess[], p: Vec2): boolean {
  const margin = m(0.3) + m(0.2);
  return accesses.some((access) => {
    if (access.structure !== 'ground') return false;
    const dx = p.x - access.x, dy = p.y - access.y;
    return Math.abs(dx * access.tx + dy * access.ty) < CROSSWALK_DEPTH / 2 + margin &&
      Math.abs(-dx * access.ty + dy * access.tx) < access.across + margin;
  });
}

/** Everything the run WOULD build, from the two raw ends of the gesture. */
export function planPoleRun(
  doc: RoadDoc,
  net: Network,
  rawFrom: Vec2,
  rawTo: Vec2,
  reach: number,
  spacing = DEFAULT_POLE_SPACING,
  lamps: PoleLampMode = 'alternate',
): PoleRunPlan {
  // The preview asks for the plan every frame (`main.ts`), and the same plan while the pointer stands still
  const poles = doc.changes.serialOf('utilities');
  const k = lastPlan;
  if (k && k.doc === doc && k.net === net && k.revision === net.revision && k.poles === poles &&
      k.fx === rawFrom.x && k.fy === rawFrom.y && k.tx === rawTo.x && k.ty === rawTo.y &&
      k.reach === reach && k.spacing === spacing && k.lamps === lamps) return k.plan;
  const plan = computePoleRun(doc, net, rawFrom, rawTo, reach, spacing, lamps, regional(net, ROUTE_MARGIN));
  lastPlan = { doc, net, revision: net.revision, poles, fx: rawFrom.x, fy: rawFrom.y, tx: rawTo.x, ty: rawTo.y, reach, spacing, lamps, plan };
  return plan;
}

/** The last plan made, and what it was made from (`planPoleRun`). */
let lastPlan: {
  readonly doc: RoadDoc; readonly net: Network; readonly revision: number; readonly poles: number;
  readonly fx: number; readonly fy: number; readonly tx: number; readonly ty: number;
  readonly reach: number; readonly spacing: number; readonly lamps: PoleLampMode; readonly plan: PoleRunPlan;
} | null = null;

/** `planPoleRun` routed over the lines of a region covering the whole map (every street within `ROUTE_MARGIN_MOST`) */
export function planPoleRunWhole(
  doc: RoadDoc, net: Network, rawFrom: Vec2, rawTo: Vec2, reach: number,
  spacing = DEFAULT_POLE_SPACING, lamps: PoleLampMode = 'alternate',
): PoleRunPlan {
  return computePoleRun(doc, net, rawFrom, rawTo, reach, spacing, lamps, regional(net, ROUTE_MARGIN_MOST));
}

function computePoleRun(
  doc: RoadDoc,
  net: Network,
  rawFrom: Vec2,
  rawTo: Vec2,
  reach: number,
  spacing: number,
  lamps: PoleLampMode,
  routing: Routing,
): PoleRunPlan {
  const from = snapOn(doc, net, routing.linesAt(rawFrom), rawFrom, reach);
  const to = snapOn(doc, net, routing.linesAt(rawTo), rawTo, reach);
  const refuse = (refused: PoleRunRefusal): PoleRunPlan => ({ from, to, poles: [], refused });
  if (from.kind === 'free' || to.kind === 'free') return refuse('offFootway');
  if (from.pole !== undefined && from.pole === to.pole) return { from, to, poles: [] };
  if (dist(from.at, to.at) < 1e-3) return { from, to, poles: [] };
  const routed = routing.route(from, to);
  if (routed === 'noPlace' || routed === 'noPath') return refuse('noPath');
  const { path, lines } = routed;
  if (path.length < 2) return refuse('noPath');

  // Arc length along the route.
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1]! + dist(path[i - 1]!, path[i]!));
  const total = cum[cum.length - 1]!;
  const at = (s: number): Vec2 => {
    let i = 1;
    while (i < cum.length - 1 && cum[i]! < s) i++;
    const s0 = cum[i - 1]!, s1 = cum[i]!;
    const t = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
    const p = path[i - 1]!, q = path[i]!;
    return { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t };
  };

  // Corner stations; corners closer than a pole gap merge into one, and none stands within a gap of either end.
  const keys: number[] = [0];
  for (const index of corners(path, CORNER_TOLERANCE).slice(1, -1)) {
    const s = cum[index]!;
    if (s < MIN_POLE_GAP || total - s < MIN_POLE_GAP) continue;
    const last = keys[keys.length - 1]!;
    if (keys.length > 1 && s - last < MIN_POLE_GAP) keys[keys.length - 1] = (last + s) / 2;
    else keys.push(s);
  }
  keys.push(total);

  // Evenly between corners, nudged off crossing landings along the route.
  const { accesses } = lines;
  const step = Math.max(MIN_POLE_SPACING, Math.min(MAX_POLE_SPACING, spacing));
  const stations: number[] = [0];
  for (let k = 1; k < keys.length; k++) {
    const s0 = keys[k - 1]!, s1 = keys[k]!;
    const spans = Math.max(1, Math.round((s1 - s0) / step));
    for (let i = 1; i <= spans; i++) stations.push(s0 + ((s1 - s0) * i) / spans);
  }
  const clear = (s: number, lo: number, hi: number): number | null => {
    const ok = (t: number): boolean => { const p = at(t); return !inLanding(accesses, p) && onFootway(net, p); };
    if (ok(s)) return s;
    for (let d = m(1); d <= m(12); d += m(1)) {
      if (s + d < hi && ok(s + d)) return s + d;
      if (s - d > lo && ok(s - d)) return s - d;
    }
    return null;
  };
  const kept: number[] = [0];
  for (let i = 1; i < stations.length - 1; i++) {
    const s = clear(stations[i]!, kept[kept.length - 1]! + MIN_POLE_GAP / 2, total - MIN_POLE_GAP / 2);
    if (s !== null) kept.push(s);
  }
  kept.push(total);

  // Poles: the ends exactly where they snapped, existing poles reused.
  const points = kept.map((s, i) => (i === 0 ? from.at : i === kept.length - 1 ? to.at : at(s)));
  const poles: PlannedPole[] = [];
  points.forEach((p, index) => {
    const existing = index === 0 && from.pole !== undefined ? doc.pole(from.pole)
      : index === points.length - 1 && to.pole !== undefined ? doc.pole(to.pole)
        : doc.poleNear(p, REUSE_RADIUS);
    const planned: PlannedPole = {
      at: existing ? { x: existing.x, y: existing.y } : p,
      existing: existing?.id ?? null,
      // A pole that already exists keeps the lamp it has.
      lamp: existing ? existing.lamp : lampFor(index, lamps),
    };
    const prev = poles[poles.length - 1];
    // The same standing pole twice in a row is one pole.
    if (prev && planned.existing !== null && prev.existing === planned.existing) return;
    poles.push(planned);
  });
  if (poles.length < 2) return { from, to, poles: [] };
  return { from, to, poles };
}

/** Applies a plan to the document. */
export function commitPoleRun(doc: RoadDoc, plan: PoleRunPlan): boolean {
  return commitPoleRunPoles(doc, plan) !== null;
}

/** `commitPoleRun`, giving the run's poles in order (null when nothing was built). */
export function commitPoleRunPoles(doc: RoadDoc, plan: PoleRunPlan): PoleId[] | null {
  if (plan.refused || plan.poles.length < 2) return null;

  const ids: PoleId[] = plan.poles.map(
    (pole) => pole.existing ?? doc.addPole({ x: pole.at.x, y: pole.at.y }, pole.lamp).id,
  );

  let built = false;
  for (let i = 1; i < ids.length; i++) {
    const a = ids[i - 1];
    const b = ids[i];
    if (a === undefined || b === undefined || a === b) continue;
    if (doc.addPoleSpan(a, b)) built = true;
  }
  return built ? ids : null;
}

/** What the pole tool reads of the game and does to it. */
export interface PoleToolHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  zoom(): number;
  /** The tool's verb ('build' or 'remove', `ui/toolChoices.ts`) and its lamps. */
  mode(): string;
  lamps(): PoleLampMode;
  /** Whether the pole tool is the tool in hand. */
  inHand(): boolean;
  /** An edit of the document, one undo step; whether it changed it. */
  mutate(fn: () => boolean): boolean;
  hint(key: string): void;
  redraw(): void;
}

/** THE POLE TOOL: a distribution line traced as straight stretches, each a drag */
export class PoleTool {
  /** The stretch being dragged. */
  private draft: { readonly from: Vec2; to: Vec2; readonly chained: boolean } | null = null;
  /** The end of the last committed run, while the tool is still on it */
  private chain: Vec2 | null = null;
  /** The pointer over the map while the tool is in hand, unsnapped. */
  private hover: Vec2 | null = null;
  private lastMode = '';

  constructor(private readonly host: PoleToolHost) {}

  /** Pick radius for a pole, in WORLD units at the current zoom */
  reach(): number {
    return POLE_PICK_PIXELS / this.host.zoom();
  }

  gesture(): string | null {
    return this.draft || this.chain ? 'gesture.pole.tracing' : null;
  }

  inProgress(): boolean {
    return this.draft !== null || this.chain !== null;
  }

  cancel(): void {
    this.draft = null;
    this.chain = null;
  }

  /** What the current gesture would build, snapped: drawn and committed alike. */
  plan(): PoleRunPlan | null {
    const { host } = this;
    // A change of the tool's verb ends the line being traced.
    if (host.mode() !== this.lastMode) {
      this.lastMode = host.mode();
      this.cancel();
    }
    if (this.draft) return planPoleRun(host.doc, host.net, this.draft.from, this.draft.to, this.reach(), undefined, host.lamps());
    if (host.inHand() && host.mode() === 'build' && this.chain && this.hover) {
      return planPoleRun(host.doc, host.net, this.chain, this.hover, this.reach(), undefined, host.lamps());
    }
    return null;
  }

  down(world: Vec2, shift: boolean): void {
    const { host } = this;
    const hit = host.doc.poleNear(world, this.reach());
    const remove = (): void => {
      if (!hit) return;
      host.mutate(() => { host.doc.removePole(hit.id); return true; });
      host.hint('hint.pole.removed');
    };
    if (host.mode() === 'remove') {
      // The Remove verb: a click takes the pole under it, and its wires.
      remove();
      this.chain = null;
    } else if (hit && shift) {
      // Shift-click removes.
      remove();
      this.chain = null;
    } else {
      this.draft = { from: this.chain ?? world, to: world, chained: this.chain !== null };
    }
  }

  /** @perInput The pointer moved; true when a stretch being dragged took it. */
  move(world: Vec2): boolean {
    if (this.draft) {
      this.draft.to = world;
      this.host.redraw();
      return true;
    }
    if (this.host.inHand()) {
      // The bare pointer, not a road anchor
      this.hover = world;
      this.host.redraw();
    }
    return false;
  }

  /** @perInput The pointer let go: the stretch is built (`commit`), or dropped. */
  up(commit: boolean): void {
    const { host } = this;
    const run = this.draft;
    if (!run) return;
    const plan = planPoleRun(host.doc, host.net, run.from, run.to, this.reach(), undefined, host.lamps());
    this.draft = null;
    if (!commit) { this.chain = null; return; }
    const last = plan.poles[plan.poles.length - 1];
    // A run with an end off the footways builds nothing, and says why.
    if (plan.refused) host.hint(`hint.pole.${plan.refused}`);
    const built = host.mutate(() => commitPoleRun(host.doc, plan));
    // The line goes on from where it ended.
    if (built && last) this.chain = { x: last.at.x, y: last.at.y };
    else if (!run.chained) this.chain = { x: plan.from.at.x, y: plan.from.at.y };
    else this.chain = null;
  }

  /** What the overlay marks besides the run drawn in 3D: with the Remove verb, the pole under the pointer */
  marks(): { removing: Vec2 | null; first: PoleSnap | null } {
    const { host } = this;
    if (!host.inHand() || !this.hover) return { removing: null, first: null };
    if (host.mode() === 'remove') {
      const hit = host.doc.poleNear(this.hover, this.reach());
      return { removing: hit ? { x: hit.x, y: hit.y } : null, first: null };
    }
    return { removing: null, first: this.draft ? null : snapPole(host.doc, host.net, this.hover, this.reach()) };
  }
}
