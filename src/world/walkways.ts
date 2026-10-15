import { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import { Digest } from '@core/digest';
import type { NodeId, SegmentId } from './ids';
import type { RoadDoc } from './doc';
import { m } from './units';
import type { Network } from './network';
import { footwayPath } from './footwayPath';
import { Level } from './roadTypes';
import { bandMid, sectionOf } from './section';
import { orientedPolyline } from './geometry';
import { CROSSWALK_DEPTH } from './approach';
import { CellFiling } from './cells';
import type { ChangeRect } from './changes';
import type { RoadStructure } from './structures';
import { bulbLine } from './junction/bulb';
import { rebuildWork } from './rebuildWork';
import { LocalLines, cornerPath, resample, stretch } from './walkingLines';

/**
 * WHERE PEOPLE WALK, as lanes: the pedestrian network of the city.
 *
 * Built from the cross-section (`section.ts`) and the junctions, the way a
 * traffic simulator builds it (SUMO: sidewalks are lanes, "walkingareas" join
 * them at a junction's corners, "crossings" take them over the carriageway):
 *
 *  - a FOOTWAY runs down the middle of the through zone on each side of a
 *    road, from one junction mouth to the other;
 *  - a CORNER joins, round each corner of a junction, the footway that leaves
 *    it on one leg to the footway on the next: the two walking lines
 *    filleted about the kerb return's own centre, so the line keeps its
 *    distance from the kerb all the way round. Where a road only bends (a
 *    node of two legs and no junction) a short corner joins its two halves;
 *  - a CROSSING runs over the carriageway on the zebra, from one footway (or
 *    corner) to the other side's.
 *
 * Walkways are joined by TOPOLOGY - the ends of footways at the same road
 * node, on the same side - never by being close: a footway on a viaduct
 * passes over one on the ground without touching it, and a footway on a ramp
 * joins the one at its foot.
 *
 * Every walkway is a centreline with a usable width. A person walks ALONG
 * one, at a distance `s` that only grows, and keeps a lateral offset within
 * its width: there is no point to overshoot and no corner to choose. The two
 * pedestrian models before this one each rebuilt their paths from the paving
 * left over by polygon booleans, and both walked erratically for it (study
 * of 2026-10-01).
 */

export type WalkwayKind = 'footway' | 'corner' | 'crossing';

export interface WalkNode {
  readonly id: number;
  readonly x: number;
  readonly y: number;
}

export interface Walkway {
  readonly id: number;
  readonly kind: WalkwayKind;
  /** Centreline, from node `a` to node `b`. People walk it either way. */
  readonly path: Polyline;
  /** Usable width, world units: the lateral room a walker keeps within (`hi - lo`). */
  readonly width: number;
  /**
   * How far a walker's centreline position may lie either side of the path,
   * u, measured along the path's LEFT normal (walking from `a` to `b`):
   * from `lo` (negative, its right) to `hi`. A footway reaches from the
   * kerb's outer edge to the footway's outer edge - street furniture stands
   * in part of it and is walked round - so people normally keep to the
   * through zone the path runs down, and step aside into the rest to pass.
   */
  readonly lo: number;
  readonly hi: number;
  /** For a footway or corner, the side the kerb is on (-1 at `lo`, +1 at `hi`); 0 for a crossing. */
  readonly kerb: -1 | 0 | 1;
  readonly a: number;
  readonly b: number;
  /** The road a footway or crossing belongs to. */
  readonly segment?: SegmentId;
  /** The road node a corner or crossing belongs to. */
  readonly node?: NodeId;
  /** Which deck it is on. */
  readonly structure: RoadStructure;
  /**
   * A crossing with no zebra painted: across the end of a road that leads
   * nowhere. Walkers take a gap in the traffic there; nothing stops for them.
   */
  readonly unmarked?: true;
}

/** A road at grade lifted more than this by its own heights is a viaduct for whoever walks it, u. */
export const RAISED_BY_HAND = m(2.5);

/**
 * The deck a road's footways belong to. A road at grade raised by hand is a
 * viaduct for whoever walks it: kept with the raised decks, never joined to
 * the ground footways it passes over.
 */
export function deckOf(doc: RoadDoc, id: SegmentId): RoadStructure {
  const seg = doc.segment(id);
  const structure = seg?.structure ?? 'ground';
  if (!seg || structure !== 'ground') return structure;
  const lift = ((doc.node(seg.a)?.heightOffset ?? 0) + (doc.node(seg.b)?.heightOffset ?? 0)) / 2;
  return lift > RAISED_BY_HAND ? 'elevated' : 'ground';
}

/** Passes of smoothing over a corner's line. */
const SMOOTH_PASSES = 3;

/** Length over which a corner eases off its footway's straight run onto the walking contour, u. */
const EASE = m(0.6);
const smooth = (t: number): number => t * t * (3 - 2 * t);

/** Ends of two footways at one road node closer than this are one point, u. */
const JOIN = m(0.02);
/** A crossing lands on a walkway no further than this beyond its usable width, u. */
const LAND_REACH = m(0.8);

/** What one update of the walkways took away and put in (`WalkGraph.changesSince`). */
export interface WalkChange {
  readonly removed: readonly Walkway[];
  readonly added: readonly Walkway[];
}

/** How many updates the graph remembers; a reader further behind reads it whole again. */
const KEPT_CHANGES = 64;

/**
 * The walkways and their nodes, by id. An edit takes out what it changed and
 * puts in what it made (`Walkways.update`): a walkway or a node made again
 * just as it was is handed back with its id - the same object - so whoever
 * holds it (a walker's route) goes on with it; ids taken away and not made
 * again are given to the next ones made, so the arrays are as long as the
 * graph, not as its history.
 */
export class WalkGraph {
  /** By id; a hole where an edit took one away (`holds`). */
  readonly nodes: (WalkNode | undefined)[] = [];
  readonly ways: (Walkway | undefined)[] = [];
  /** The walkways meeting at each node. */
  readonly at = new Map<number, number[]>();
  private readonly freeNodes: number[] = [];
  private readonly freeWays: number[] = [];
  /** What the update under way took out, by what it is: made again, it comes back as it was. */
  private spareNodes = new Map<string, WalkNode[]>();
  private spareWays = new Map<number, Walkway[]>();
  private added: Walkway[] = [];
  private readonly log: { readonly from: object; readonly change: WalkChange }[] = [];
  private token: object = {};
  private readonly none: readonly WalkChange[] = [];

  /** The graph's state now, for `changesSince`. */
  get state(): object { return this.token; }

  /**
   * What changed since the graph was in `state`, an update at a time, in
   * order; null when it is too far behind (read it whole again).
   */
  changesSince(state: object): readonly WalkChange[] | null {
    if (state === this.token) return this.none;
    const i = this.log.findIndex((e) => e.from === state);
    return i < 0 ? null : this.log.slice(i).map((e) => e.change);
  }

  /** The walkways in the graph now, in id order (a new array: for a reader of them all, as a test). */
  walkways(): Walkway[] {
    return this.ways.filter((w): w is Walkway => w !== undefined);
  }

  /** Whether this walkway is in the graph as it is now (a route may hold one an edit took out). */
  holds(way: Walkway): boolean {
    return this.ways[way.id] === way;
  }

  node(p: Vec2): number {
    const spare = this.spareNodes.get(nodeKey(p))?.pop();
    if (spare) {
      this.nodes[spare.id] = spare;
      return spare.id;
    }
    const id = this.freeNodes.pop() ?? this.nodes.length;
    this.nodes[id] = { id, x: p.x, y: p.y };
    return id;
  }

  add(way: Omit<Walkway, 'id'>): Walkway {
    const key = wayKey(way);
    const spares = this.spareWays.get(key);
    const k = spares ? spares.findIndex((w) => sameWay(w, way)) : -1;
    let w: Walkway;
    if (k >= 0) {
      w = spares![k]!;
      spares!.splice(k, 1);
    } else {
      w = { ...way, id: this.freeWays.pop() ?? this.ways.length };
      this.added.push(w);
    }
    this.ways[w.id] = w;
    this.link(w.a, w.id);
    this.link(w.b, w.id);
    return w;
  }

  /** Takes a walkway out; it comes back, the same object, if the update makes it again (`add`). */
  drop(id: number): void {
    const w = this.ways[id];
    if (!w) return;
    this.unlink(w.a, id);
    this.unlink(w.b, id);
    this.ways[id] = undefined;
    const key = wayKey(w);
    const spares = this.spareWays.get(key);
    if (spares) spares.push(w); else this.spareWays.set(key, [w]);
  }

  /** Takes a node out; it comes back with its id if the update makes one at the same point (`node`). */
  dropNode(id: number): void {
    const n = this.nodes[id];
    if (!n) return;
    this.nodes[id] = undefined;
    this.at.delete(id);
    const key = nodeKey(n);
    const spares = this.spareNodes.get(key);
    if (spares) spares.push(n); else this.spareNodes.set(key, [n]);
  }

  /** The update done: what it took out and did not make again lets its id go, and the change is logged. */
  settle(): void {
    const removed: Walkway[] = [];
    for (const spares of this.spareWays.values()) for (const w of spares) { removed.push(w); this.freeWays.push(w.id); }
    for (const spares of this.spareNodes.values()) for (const n of spares) this.freeNodes.push(n.id);
    this.spareWays = new Map();
    this.spareNodes = new Map();
    const added = this.added;
    this.added = [];
    if (!removed.length && !added.length) return;
    this.log.push({ from: this.token, change: { removed, added } });
    this.token = {};
    if (this.log.length > KEPT_CHANGES) this.log.shift();
  }

  private link(node: number, way: number): void {
    const list = this.at.get(node);
    if (list) list.push(way);
    else this.at.set(node, [way]);
  }

  private unlink(node: number, way: number): void {
    const list = this.at.get(node);
    const i = list ? list.indexOf(way) : -1;
    if (i >= 0) list!.splice(i, 1);
  }
}

const nodeKey = (p: Vec2): string => `${p.x},${p.y}`;

/** A walkway's digest: everything it is (`sameWay` settles a clash). */
function wayKey(w: Omit<Walkway, 'id'>): number {
  return new Digest().addText(w.kind).add(w.segment ?? -1).add(w.node ?? -1).add(w.a).add(w.b).add(w.kerb)
    .addText(w.structure).add(w.unmarked ? 1 : 0).add(w.lo).add(w.hi).add(w.width).addAll(w.path.xy).value();
}

function sameWay(p: Omit<Walkway, 'id'>, q: Omit<Walkway, 'id'>): boolean {
  if (p.kind !== q.kind || p.segment !== q.segment || p.node !== q.node || p.a !== q.a || p.b !== q.b || p.kerb !== q.kerb
    || p.structure !== q.structure || p.unmarked !== q.unmarked || p.lo !== q.lo || p.hi !== q.hi || p.width !== q.width) return false;
  const a = p.path.xy, b = q.path.xy;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** One side's footway of one road, mouth to mouth, before the crossings cut it (`Walkways.cut`). */
interface RawFootway {
  readonly segment: SegmentId;
  /** Side of the road: +1 left of the centreline as stored (a to b), -1 right. */
  readonly side: 1 | -1;
  readonly path: Polyline;
  readonly width: number;
  readonly lo: number;
  readonly hi: number;
  readonly kerb: -1 | 1;
  readonly structure: RoadStructure;
  /** How far the walking line lies beyond the kerb's outer edge, and the footway beyond it, u. */
  readonly inset: number;
  readonly outer: number;
  /** Its two ends in the graph, and the path's frame there. */
  readonly a: number;
  readonly b: number;
  readonly first: { readonly p: Vec2; readonly t: Vec2 };
  readonly last: { readonly p: Vec2; readonly t: Vec2 };
}

interface FootwayEnd {
  readonly way: RawFootway;
  readonly node: number;
  /** Side of the road: +1 left of the centreline as stored (a to b), -1 right. */
  readonly side: 1 | -1;
  /** How far the walking line lies beyond the kerb's outer edge, u. */
  readonly inset: number;
  /** How far the footway reaches beyond the walking line, away from the road, u. */
  readonly outer: number;
  /** Which side of a walker walking INTO the node the kerb is on: -1 its right, +1 its left. */
  readonly kerbSide: 1 | -1;
  /** The end at this road node, and the direction walking INTO the node. */
  readonly p: Vec2;
  readonly into: Vec2;
}

/** The pedestrian network of the whole map, from nothing. Pure: the same network gives the same walkways. */
export function buildWalkways(net: Network): WalkGraph {
  return new Walkways().update(net);
}

/** A road's footways: what its corners and crossings join, and the pieces the crossings cut them into. */
interface SegmentUnit {
  /** Its nodes when it was built: what a change of it builds again. */
  readonly ends: readonly [NodeId, NodeId];
  readonly raws: readonly RawFootway[];
  pieces: number[];
}

/** Where a crossing of a node lands on a road's footway: a node of the graph, `s` along it. */
interface Landing {
  readonly raw: RawFootway;
  readonly s: number;
  readonly node: number;
}

/** What one road node made: its corners, crossings and road end, and the nodes it cut them at. */
interface NodeUnit {
  readonly ways: number[];
  readonly nodes: number[];
  readonly landings: Landing[];
}

/** How far round a node's footway ends its corners may run, u: the box its walking lines are read from. */
const NODE_REACH = m(12);
/** How far beyond that the kerbs and paving are read: more than any walking line's inset. */
const LINES_REACH = m(6);

/**
 * The walkways kept up with the network by what each edit changed (SUMO
 * builds a junction's walking areas from that junction's own sidewalks and
 * crossings, sumo.dlr.de/docs/Simulation/Pedestrians.html). A ROAD makes its
 * two footways; a NODE makes its corners from the footways meeting there, its
 * crossings landing on those footways and corners, and the crossing across a
 * road end; a road's footways are then cut where the crossings at its two
 * ends landed. An edit (`Network.changesSince`) builds again the roads it
 * changed and the nodes it changed, at their ends, or whose walking lines it
 * reached; every road at those nodes is cut again. The rest stands, its ids
 * and objects with it.
 * DO NOT build the walkways of the whole map for an edit: every road drawn
 * built the town's footways, corners and crossings again, and the walkers'
 * index and the people placed along them read them all again.
 */
export class Walkways {
  readonly graph = new WalkGraph();
  private readonly segments = new Map<SegmentId, SegmentUnit>();
  private readonly nodeUnits = new Map<NodeId, NodeUnit>();
  /** The box each node read its walking lines from: an edit reaching it builds the node again. */
  private readonly reads = new CellFiling<NodeId, NodeUnit>();
  private netState: object | null = null;

  /** The walkways of the network as it is now. */
  update(net: Network): WalkGraph {
    if (this.netState === net.state) return this.graph;
    const doc = net.doc;
    const delta = this.netState === null ? null : net.changesSince(this.netState);
    this.netState = net.state;
    const rawSegs = new Set<SegmentId>(), nodes = new Set<NodeId>();
    if (delta === null) {
      // @rebuild Everything: the first build, a map opened, a network further behind than it remembers.
      for (const id of this.segments.keys()) rawSegs.add(id);
      for (const id of doc.segments.keys()) rawSegs.add(id);
      for (const id of this.nodeUnits.keys()) nodes.add(id);
      for (const id of doc.nodes.keys()) nodes.add(id);
    } else {
      // A node's record (its height: the deck of its roads) is read by every road at it.
      for (const id of delta.segments) rawSegs.add(id);
      for (const id of delta.nodes) {
        nodes.add(id);
        for (const seg of doc.node(id)?.incident ?? []) rawSegs.add(seg);
      }
      for (const rect of delta.rects) for (const id of this.reads.idsMeeting(rect)) nodes.add(id);
    }
    // A road's footways end at its nodes, before and now: their corners and crossings are made again.
    for (const id of rawSegs) {
      const before = this.segments.get(id);
      if (before) { nodes.add(before.ends[0]); nodes.add(before.ends[1]); }
      const now = doc.segment(id);
      if (now) { nodes.add(now.a); nodes.add(now.b); }
    }
    // Every road at a node made again is cut again where its crossings land.
    const cutSegs = new Set<SegmentId>(rawSegs);
    for (const id of nodes) for (const seg of doc.node(id)?.incident ?? []) cutSegs.add(seg);

    const g = this.graph;
    for (const id of cutSegs) {
      const unit = this.segments.get(id);
      if (!unit) continue;
      for (const way of unit.pieces) g.drop(way);
      unit.pieces = [];
    }
    for (const id of rawSegs) {
      const unit = this.segments.get(id);
      if (!unit) continue;
      for (const raw of unit.raws) { g.dropNode(raw.a); g.dropNode(raw.b); }
      this.segments.delete(id);
    }
    for (const id of nodes) {
      const unit = this.nodeUnits.get(id);
      if (!unit) continue;
      for (const way of unit.ways) g.drop(way);
      for (const node of unit.nodes) g.dropNode(node);
      this.nodeUnits.delete(id);
      this.reads.remove(id);
    }
    const ascending = (a: number, b: number): number => a - b;
    for (const id of [...rawSegs].sort(ascending)) if (doc.segment(id)) this.segments.set(id, this.footways(net, id));
    for (const id of [...nodes].sort(ascending)) if (doc.node(id)) this.buildNode(net, id);
    for (const id of [...cutSegs].sort(ascending)) {
      const unit = this.segments.get(id);
      if (unit) this.cut(doc, id, unit);
    }
    g.settle();
    return g;
  }

  /** A road's two footways, down the middle of each side's through zone. */
  private footways(net: Network, segId: SegmentId): SegmentUnit {
    rebuildWork.walkways++;
    const doc = net.doc;
    const seg = doc.requireSegment(segId);
    const raws: RawFootway[] = [];
    const unit: SegmentUnit = { ends: [seg.a, seg.b], raws, pieces: [] };
    const ribbon = net.ribbons.get(segId);
    if (!ribbon) return unit;
    const section = sectionOf(ribbon.road, seg.direction);
    if (!section.walkable) return unit;
    for (const side of [1, -1] as const) {
      // Each side's own footway (an asymmetric road, docs/VIAS.md V1).
      const path = footwayPath(ribbon, seg.direction, side);
      if (!path) continue;
      const zones = side > 0 ? section.left : section.right;
      const mid = bandMid(zones.through);
      const inset = mid - zones.curb.outer;
      const outer = zones.frontage.outer - mid;
      const first = path.sampleAt(0), last = path.sampleAt(path.length);
      // Along a to b, the path's left is away from the road on the left
      // side (+1), towards it on the right side (-1).
      const lo = side > 0 ? -inset : -outer, hi = side > 0 ? outer : inset;
      raws.push({ segment: segId, side, path, width: hi - lo, lo, hi, kerb: side > 0 ? -1 : 1, structure: deckOf(doc, segId),
        inset, outer, a: this.graph.node(first.p), b: this.graph.node(last.p),
        first: { p: first.p, t: first.t }, last: { p: last.p, t: last.t } });
    }
    return unit;
  }

  /** A road's footways cut where the crossings at its two ends landed on them. */
  private cut(doc: RoadDoc, segId: SegmentId, unit: SegmentUnit): void {
    const seg = doc.requireSegment(segId);
    const ends = seg.a === seg.b ? [this.nodeUnits.get(seg.a)] : [this.nodeUnits.get(seg.a), this.nodeUnits.get(seg.b)];
    for (const raw of unit.raws) {
      const marks = ends.flatMap((u) => u?.landings.filter((l) => l.raw === raw) ?? []).sort((p, q) => p.s - q.s);
      let s0 = 0, from = raw.a;
      const piece = (path: Polyline, to: number): void => {
        unit.pieces.push(this.graph.add({ kind: 'footway', path, width: raw.width, lo: raw.lo, hi: raw.hi, kerb: raw.kerb,
          segment: segId, structure: raw.structure, a: from, b: to }).id);
      };
      for (const mark of marks) {
        if (mark.node === from) continue;
        piece(raw.path.sub(s0, mark.s), mark.node);
        s0 = mark.s;
        from = mark.node;
      }
      piece(s0 > 0 ? raw.path.sub(s0, raw.path.length) : raw.path, raw.b);
    }
  }

  /** A road node's corners, crossings and road end. */
  private buildNode(net: Network, nodeId: NodeId): void {
    rebuildWork.walkways++;
    const g = this.graph, doc = net.doc;
    const node = doc.requireNode(nodeId);
    const unit: NodeUnit = { ways: [], nodes: [], landings: [] };
    this.nodeUnits.set(nodeId, unit);
    // The footway ends here, road by road in id order, each road's left side then its right.
    const here: FootwayEnd[] = [];
    for (const segId of [...new Set(node.incident)].sort((a, b) => a - b)) {
      const seg = doc.requireSegment(segId);
      for (const raw of this.segments.get(segId)?.raws ?? []) {
        // Walking into b along the path the kerb is on the right of the left
        // footway; walking into a, the other way, on its left.
        if (seg.a === nodeId) here.push({ way: raw, node: raw.a, side: raw.side, inset: raw.inset, outer: raw.outer,
          kerbSide: raw.side > 0 ? 1 : -1, p: raw.first.p, into: { x: -raw.first.t.x, y: -raw.first.t.y } });
        if (seg.b === nodeId) here.push({ way: raw, node: raw.b, side: raw.side, inset: raw.inset, outer: raw.outer,
          kerbSide: raw.side > 0 ? -1 : 1, p: raw.last.p, into: raw.last.t });
      }
    }
    let x0 = node.x, y0 = node.y, x1 = node.x, y1 = node.y;
    for (const e of here) { x0 = Math.min(x0, e.p.x); y0 = Math.min(y0, e.p.y); x1 = Math.max(x1, e.p.x); y1 = Math.max(y1, e.p.y); }
    const pad = NODE_REACH + LINES_REACH;
    const rect: ChangeRect = [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
    this.reads.file(nodeId, unit, rect);
    let lines: LocalLines | null = null;
    const walking = (): LocalLines => (lines ??= new LocalLines(net, rect, (id) => deckOf(doc, id)));

    // --- corners: round each corner of the junction, from one leg's footway to the next's
    const corners: Omit<Walkway, 'id'>[] = [];
    const join = (from: FootwayEnd, to: FootwayEnd, kerb: Vec2 | null, drawn: Polyline | null = null): void => {
      const out = { x: -to.into.x, y: -to.into.y };
      // The corner keeps the kerb on the side it is on walking into the node
      // along `from`, and the narrower of the two footways' reaches.
      const inset = Math.min(from.inset, to.inset), outer = Math.min(from.outer, to.outer);
      const lo = from.kerbSide < 0 ? -inset : -outer, hi = from.kerbSide < 0 ? outer : inset;
      if (Math.hypot(from.p.x - to.p.x, from.p.y - to.p.y) < JOIN) {
        // The same point: the two footways simply meet (a road carried straight on).
        corners.push({ kind: 'corner', path: Polyline.fromPoints([from.p, { x: from.p.x + out.x * JOIN, y: from.p.y + out.y * JOIN }]),
          width: hi - lo, lo, hi, kerb: from.kerbSide < 0 ? -1 : 1, node: nodeId, structure: from.way.structure, a: from.node, b: to.node });
        return;
      }
      // Concentric with the kerb return: the radius is the walking line's own
      // distance from the return's centre - less than the kerb's round the
      // inside of a corner, more round the outside of a bend.
      const radius = kerb ? Math.abs((kerb.x - from.p.x) * from.into.y - (kerb.y - from.p.y) * from.into.x) : 0;
      const path = drawn ?? cornerPath(from.p, from.into, to.p, out, radius);
      corners.push({ kind: 'corner', path, width: hi - lo, lo, hi, kerb: from.kerbSide < 0 ? -1 : 1, node: nodeId,
        structure: from.way.structure, a: from.node, b: to.node });
    };
    if (here.length) {
      const byLevel = net.junctions.get(nodeId);
      const junction = byLevel?.get(Level.Sidewalk);
      if (junction && junction.legs.length >= 2 && !junction.transition) {
        // Each leg's footway joins the next leg's round the node, in angular
        // order, whatever the angle between them (SUMO's netconvert,
        // `NBNode::buildWalkingAreas`: sidewalks are grouped by their order
        // round the junction, never by the angle). A shallow merge has no
        // carriageway corners (`junction/build.ts`, legs under 25 degrees
        // apart): read off them, none of its footways joined any other, and
        // everything beyond it was an island nobody could walk to.
        const pairs = junction.corners.length ? junction.corners
          : junction.legs.map((_, i) => ({ i, j: (i + 1) % junction.legs.length }));
        for (const corner of pairs) {
          const li = junction.legs[corner.i]!, lj = junction.legs[corner.j]!;
          // Leg i's LEFT boundary feeds the corner, leg j's RIGHT boundary leaves it.
          const from = sideOf(here, li.seg, node, li.nrm, 1);
          const to = sideOf(here, lj.seg, node, lj.nrm, -1);
          if (!from || !to || from === to) continue;
          const kerb = byLevel?.get(Level.Curb)?.corners.find((c) => c.i === corner.i && c.j === corner.j)?.fillet ?? null;
          join(from, to, kerb?.c ?? null, roundCorner(from, to, here, walking));
        }
      } else if (node.incident.length === 2) {
        // A node of two roads drawn as a taper or a bend, or not drawn at all:
        // each side's footway runs on into the other road's on the same side.
        const [s0, s1] = node.incident as [SegmentId, SegmentId];
        for (const e0 of here.filter((e) => e.way.segment === s0)) {
          let best: FootwayEnd | null = null, bestD = Infinity;
          for (const e1 of here.filter((e) => e.way.segment === s1)) {
            const d = Math.hypot(e1.p.x - e0.p.x, e1.p.y - e0.p.y);
            if (d < bestD) { best = e1; bestD = d; }
          }
          if (best) join(e0, best, null, roundCorner(e0, best, here, walking));
        }
      }
    }

    // --- crossings: over the carriageway on each zebra
    const others: Omit<Walkway, 'id'>[] = [];
    /**
     * The node on the walkway nearest `p` among this road's footways and this
     * node's corners - cut there - or null when none is near.
     */
    const landOn = (p: Vec2, segId: SegmentId): number | null => {
      let best: { raw: RawFootway | null; corner: number; s: number; distance: number; width: number } | null = null;
      for (const raw of this.segments.get(segId)?.raws ?? []) {
        const c = raw.path.closestPoint(p);
        if (!best || c.distance < best.distance) best = { raw, corner: -1, s: c.s, distance: c.distance, width: raw.width };
      }
      for (let k = 0; k < corners.length; k++) {
        const c = corners[k]!.path.closestPoint(p);
        if (!best || c.distance < best.distance) best = { raw: null, corner: k, s: c.s, distance: c.distance, width: corners[k]!.width };
      }
      if (!best || best.distance > best.width / 2 + LAND_REACH) return null;
      const way = best.raw ?? corners[best.corner]!;
      if (best.s <= JOIN) return way.a;
      if (best.s >= way.path.length - JOIN) return way.b;
      const mid = g.node(way.path.sampleAt(best.s).p);
      unit.nodes.push(mid);
      if (best.raw) unit.landings.push({ raw: best.raw, s: best.s, node: mid });
      else {
        const corner = corners[best.corner]!;
        corners[best.corner] = { ...corner, path: corner.path.sub(0, best.s), b: mid };
        corners.push({ ...corner, path: corner.path.sub(best.s, corner.path.length), a: mid });
      }
      return mid;
    };
    if (node.incident.length >= 2) {
      for (const segId of node.incident) {
        const d = net.crosswalkDistanceAt(segId, nodeId);
        if (d <= 0) continue;
        const seg = doc.requireSegment(segId);
        const ribbon = net.ribbons.get(segId);
        if (!ribbon) continue;
        const section = sectionOf(ribbon.road, seg.direction);
        if (!section.walkable) continue;
        const f = orientedPolyline(doc, seg, nodeId).sampleAt(d);
        // Looking away from the node: from `a` its left is the road's left, from `b` its right.
        const fromA = seg.a === nodeId;
        const midLeft = bandMid((fromA ? section.left : section.right).through);
        const midRight = bandMid((fromA ? section.right : section.left).through);
        const left = { x: f.p.x + f.n.x * midLeft, y: f.p.y + f.n.y * midLeft };
        const right = { x: f.p.x - f.n.x * midRight, y: f.p.y - f.n.y * midRight };
        // Each end lands on the walkway nearest it on its own side - this
        // road's footway or the corner beside it - cut there.
        const a = landOn(left, segId);
        const b = landOn(right, segId);
        if (a === null || b === null || a === b) continue;
        const pa = g.nodes[a]!, pb = g.nodes[b]!;
        // As wide as the zebra painted.
        others.push({ kind: 'crossing', path: Polyline.fromPoints([pa, pb]), width: CROSSWALK_DEPTH, lo: -CROSSWALK_DEPTH / 2, hi: CROSSWALK_DEPTH / 2, kerb: 0,
          segment: segId, node: nodeId, structure: deckOf(doc, segId), a, b });
      }
    }

    // --- road end: across the end of a road that leads nowhere, an unmarked
    // crossing joins its two footways, or each side of a street that ends would
    // be an island to whoever walks it (a cul-de-sac, a road off the map).
    const left = here.find((e) => e.side > 0), right = here.find((e) => e.side < 0);
    if (node.incident.length === 1 && left && right && left.way.structure === right.way.structure
      && Math.hypot(left.p.x - right.p.x, left.p.y - right.p.y) >= JOIN) {
      // A turning circle (docs/VIAS.md V8): its footway runs round it, and so
      // does the walk from one side of the street to the other - on the
      // footway's walking line, nobody crossing the circle's carriageway.
      let line = node.end === 'bulb' ? bulbLine(doc, net.polylines, nodeId, Math.abs((left.p.x - node.x) * -left.into.y + (left.p.y - node.y) * left.into.x)) : null;
      if (line) {
        const first = line[0]!, last = line[line.length - 1]!;
        if (Math.hypot(first.x - left.p.x, first.y - left.p.y) > Math.hypot(last.x - left.p.x, last.y - left.p.y)) line = [...line].reverse();
        const inset = Math.min(left.inset, right.inset), outer = Math.min(left.outer, right.outer);
        const lo = left.kerbSide < 0 ? -inset : -outer, hi = left.kerbSide < 0 ? outer : inset;
        others.push({ kind: 'corner', path: Polyline.fromPoints([left.p, ...line, right.p]), width: hi - lo, lo, hi,
          kerb: left.kerbSide < 0 ? -1 : 1, node: nodeId, structure: left.way.structure, a: left.node, b: right.node });
      } else {
        others.push({ kind: 'crossing', path: Polyline.fromPoints([left.p, right.p]), width: m(2), lo: -m(1), hi: m(1), kerb: 0,
          segment: left.way.segment, node: nodeId, structure: left.way.structure, a: left.node, b: right.node, unmarked: true });
      }
    }
    for (const way of corners) unit.ways.push(g.add(way).id);
    for (const way of others) unit.ways.push(g.add(way).id);
  }
}

/** The walking line round from one footway end to another, as drawn, or null. */
function roundCorner(from: FootwayEnd, to: FootwayEnd, all: readonly FootwayEnd[], lines: () => LocalLines): Polyline | null {
  if (from.way.structure !== to.way.structure) return null;
  const walking = lines();
  const avoid = all.filter((e) => e !== from && e !== to).map((e) => e.p);
  // The stretch round the corner at each footway's own inset: where two
  // roads with footways of different widths meet, the walking line moves
  // from one inset to the other along the corner, easing in and out so it
  // leaves each footway along it.
  const a = stretch(walking.at(from.way.structure, from.inset), from.p, to.p, avoid);
  const b = from.inset === to.inset ? a : stretch(walking.at(to.way.structure, to.inset), from.p, to.p, avoid);
  if (!a || !b) return null;
  const count = Math.max(a.length, b.length) - 1;
  const ra = resample(a, count), rb = resample(b, count);
  const pts: Vec2[] = [];
  for (let q = 0; q <= count; q++) {
    const u = q / count, w = u * u * (3 - 2 * u);
    pts.push({ x: ra[q]!.x + (rb[q]!.x - ra[q]!.x) * w, y: ra[q]!.y + (rb[q]!.y - ra[q]!.y) * w });
  }
  // Where the footway narrows below the walking line's inset (its outer
  // edge tapering faster than the kerb, at a change of road width), the
  // line keeps half its usable width clear of the outer edge instead: it
  // moves towards the kerb by as much as the footway is narrower there.
  for (let q = 1; q < count; q++) {
    const p = pts[q]!;
    const u = q / count, half = (from.way.width + (to.way.width - from.way.width) * u) / 2;
    const edge = walking.nearestOuter(from.way.structure, p);
    if (!edge) continue;
    const kd = Math.hypot(p.x - edge.point.x, p.y - edge.point.y);
    const lack = half - kd;
    const beyond = !walking.onPaving(from.way.structure, p);
    if (lack <= 0 && !beyond) continue;
    // Towards the kerb: away from the outer edge.
    const ax = p.x - edge.point.x, ay = p.y - edge.point.y, al = Math.hypot(ax, ay) || 1;
    const dir = beyond ? { x: -ax / al, y: -ay / al } : { x: ax / al, y: ay / al };
    const move = beyond ? kd + half : lack;
    pts[q] = { x: p.x + dir.x * move, y: p.y + dir.y * move };
  }
  // Leaving each footway exactly along it: over the first and last stretch
  // the line eases from the footway's own straight run onto the contour,
  // so a hair's difference between the two (an offset polyline against a
  // rounded polygon offset) never shows as a kink.
  const total = pts.reduce((sum, p, q) => (q ? sum + Math.hypot(p.x - pts[q - 1]!.x, p.y - pts[q - 1]!.y) : 0), 0);
  const ease = Math.min(EASE, total / 3);
  let run = 0;
  const out = { x: -to.into.x, y: -to.into.y };
  const eased = pts.map((p, q) => {
    if (q) run += Math.hypot(p.x - pts[q - 1]!.x, p.y - pts[q - 1]!.y);
    const fromStart = run, fromEnd = total - run;
    if (fromStart < ease) {
      const w = smooth(fromStart / ease);
      const line = { x: from.p.x + from.into.x * fromStart, y: from.p.y + from.into.y * fromStart };
      return { x: line.x + (p.x - line.x) * w, y: line.y + (p.y - line.y) * w };
    }
    if (fromEnd < ease) {
      const w = smooth(fromEnd / ease);
      const line = { x: to.p.x - out.x * fromEnd, y: to.p.y - out.y * fromEnd };
      return { x: line.x + (p.x - line.x) * w, y: line.y + (p.y - line.y) * w };
    }
    return p;
  });
  eased[0] = from.p;
  eased[count] = to.p;
  // A few passes of neighbour averaging, the ends and their first steps
  // held: the line's direction must not turn in one step anywhere, or a
  // walker off its centre is thrown sideways there.
  for (let pass = 0; pass < SMOOTH_PASSES; pass++) {
    const prev = eased.map((p) => ({ x: p.x, y: p.y }));
    for (let q = 2; q < count - 1; q++) {
      eased[q] = { x: (prev[q - 1]!.x + 2 * prev[q]!.x + prev[q + 1]!.x) / 4, y: (prev[q - 1]!.y + 2 * prev[q]!.y + prev[q + 1]!.y) / 4 };
    }
  }
  // The first and last chord define the tangent seen by walkers. Blending
  // positions toward a tangent line does not constrain that chord: the
  // contour can still pull its first sample sideways by several degrees.
  if (count >= 3) {
    const first = Math.min(EASE / 3, Math.hypot(eased[1]!.x - from.p.x, eased[1]!.y - from.p.y));
    const last = Math.min(EASE / 3, Math.hypot(eased[count - 1]!.x - to.p.x, eased[count - 1]!.y - to.p.y));
    eased[1] = { x: from.p.x + from.into.x * first, y: from.p.y + from.into.y * first };
    eased[count - 1] = { x: to.p.x - out.x * last, y: to.p.y - out.y * last };
  } else {
    // At a sub-metre junction the sampled contour has only one interior
    // point. It cannot define both endpoint derivatives; use short tangent
    // chords before joining the two footway ends.
    const chord = Math.min(JOIN, Math.hypot(to.p.x - from.p.x, to.p.y - from.p.y) / 4);
    return Polyline.fromPoints([
      from.p,
      { x: from.p.x + from.into.x * chord, y: from.p.y + from.into.y * chord },
      { x: to.p.x - out.x * chord, y: to.p.y - out.y * chord },
      to.p,
    ]);
  }
  const clean = eased.filter((p, q) => q === 0 || Math.hypot(p.x - eased[q - 1]!.x, p.y - eased[q - 1]!.y) > 1e-6);
  return clean.length >= 2 ? Polyline.fromPoints(clean) : null;
}

/** The footway end of `seg` at this node on the given side of the leg (its normal `nrm`, sign +1 left). */
function sideOf(ends: readonly FootwayEnd[], seg: SegmentId, node: Vec2, nrm: Vec2, sign: 1 | -1): FootwayEnd | null {
  let best: FootwayEnd | null = null, bestSide = 0;
  for (const e of ends) {
    if (e.way.segment !== seg) continue;
    const side = ((e.p.x - node.x) * nrm.x + (e.p.y - node.y) * nrm.y) * sign;
    if (side > bestSide) { best = e; bestSide = side; }
  }
  return best;
}
