import { Digest } from '@core/digest';
import { Polyline } from '@core/polyline';
import { ForkMap, ForkSet } from '@core/forkMap';
import { samePlain } from '@core/plain';
import { MIN_RIBBON } from '@core/scalar';
import type { RoadDoc, RoadNode, RoadSegment } from './doc';
import type { NodeId, SegmentId } from './ids';
import { Level, SURFACE_LEVELS, type SurfaceLevel, flushOn } from './roadTypes';
import { type Junction, buildJunction, surfaceMode } from './junction/build';
import { deriveJunctionLevel } from './junction/derive';
import { JunctionLevels, type JunctionLevelsData } from './junction/levels';
import { SUMMARY, SUMMARY_FLOOR, trimSummary } from './junction/trimSummary';
import { clampSegmentTrims } from './junction/trim';
import { MIN_LEG_ANGLE, legAngles, smallestGap } from './legAngles';
import { CellFiling } from './cells';
import type { ChangeRect } from './changes';
import { m } from './units';
import type { PolylineCache } from './geometry';
import type { NetworkDelta } from './networkDelta';
import { type SegmentRibbon, type SegmentTrims, bendAt, junctionBounds, leanRibbon, makeRibbon, ribbonBounds } from './ribbons';
import { networkWork } from './rebuildWork';

/** What the build writes: the network's own derived maps */
interface Network {
  readonly doc: RoadDoc;
  readonly polylines: PolylineCache;
  readonly junctions: Map<NodeId, JunctionLevels>;
  readonly ribbons: Map<SegmentId, SegmentRibbon>;
  readonly trims: Map<SegmentId, SegmentTrims>;
  readonly plateReach: Map<string, number>;
  readonly transitions: Set<NodeId>;
  readonly impossible: Map<NodeId, number>;
  readonly squeezed: Map<NodeId, number>;
  readonly segmentCells: CellFiling<SegmentId, SegmentRibbon>;
  readonly junctionCells: CellFiling<NodeId, JunctionLevels>;
  readonly flushCells: CellFiling<SegmentId, SegmentRibbon>;
}

/** A mouth cut this little short of where its carriageway separates from the neighbouring leg's is the solver's own */
const SQUEEZE_NOISE = m(0.4);

/**
 * A junction solved for one pass, with what the pass handed it (`junctionKey`), the plate it reaches, how many levels it has and what
 * the reconciling of its roads reads of it (`trimSummary`). A pass's junction a later pass solved again is let go once the rebuild
 * is over (`byLevel` null: DO NOT keep two or three whole junctions a pressured node, ~two thirds of the junctions' memory,
 * 2026-10-22): its summary and plate are all the next rebuilds read of it, and it is solved again should a node fall back to it (`levels3`).
 */
interface MemoEntry {
  readonly key: number;
  readonly byLevel: JunctionLevels | null;
  readonly size: number;
  readonly plate: readonly (readonly [SegmentId, number])[];
  readonly summary: readonly number[];
}

function memoEntry(key: number, byLevel: JunctionLevels, plate: MemoEntry['plate']): MemoEntry {
  return { key, byLevel, size: byLevel.size, plate, summary: trimSummary(byLevel) };
}

interface RibbonMemo {
  readonly ribbon: SegmentRibbon;
  /** The trims it was made with (compared as numbers, `samePlain`). */
  readonly trims: SegmentTrims;
  readonly bendA: number;
  readonly bendB: number;
}

/** A TILE'S JUNCTIONS AND RIBBONS SOLVED OFF THE PAGE (`editor/tileStore.ts` prepareTile, the save worker or the generator's): each node's passes with the key of what they were solved from (`nodeBakeKey`), each road's ribbon with what it was made from; the page's build takes them where its inputs are the same (`takeBakes`) and solves only the nodes with a road of a tile not here. Plain data and typed arrays, cloned by the message. */
export interface NetworkBake {
  readonly nodes: BakedNode[];
  readonly segments: BakedSegment[];
}
export interface BakedNode {
  readonly id: NodeId;
  readonly key: number;
  readonly j1: BakedMemo | null;
  readonly j2: BakedMemo | null;
  readonly j3: BakedMemo | null;
}
/** A pass's junctions as their data (`JunctionLevels.data`: the carriageway, the frames its outer levels are made from, what is kept whole; null: let go, `MemoEntry`). */
interface BakedMemo { readonly key: number; readonly levels: JunctionLevelsData | null; readonly size: number; readonly plate: MemoEntry['plate']; readonly summary: readonly number[] }
/** A ribbon as what it is made from (`ribbons.ts` LeanRibbon): its road, its whole centreline as its flat array (`Polyline.xy`) and its box; its levels made on the thread that reads them (`ribbonFromBake`). */
export type BakedRibbon = Pick<SegmentRibbon, 'id' | 'typeIndex' | 'direction' | 'road' | 'dashOrigin'> & {
  readonly full: Float64Array; readonly bounds: ChangeRect;
};

function memoData(entry: MemoEntry | undefined): BakedMemo | null {
  if (!entry) return null;
  return { key: entry.key, levels: entry.byLevel ? entry.byLevel.data() : null, size: entry.size, plate: entry.plate, summary: entry.summary };
}

function memoOf(baked: BakedMemo): MemoEntry {
  return { key: baked.key, byLevel: baked.levels ? JunctionLevels.fromData(baked.levels) : null, size: baked.size, plate: baked.plate, summary: baked.summary };
}
export interface BakedSegment {
  readonly id: SegmentId;
  /** `segmentSourceKey` of the road the ribbon was made from. */
  readonly source: number;
  readonly trims: SegmentTrims;
  readonly bendA: number;
  readonly bendB: number;
  readonly ribbon: BakedRibbon;
}

function ribbonFromBake(s: BakedSegment): SegmentRibbon {
  const r = s.ribbon;
  return leanRibbon(r.id, r.typeIndex, r.direction, r.road, r.dashOrigin, Polyline.fromFlat(r.full), s.trims, s.bendA, s.bendB, r.bounds);
}

/** What a node's junctions are solved from, whichever thread solves them: its record and its roads' (where their ends stand too), the roads in id order (a road of a tile not on that thread changes it: the page then solves the node itself). */
export function nodeBakeKey(doc: RoadDoc, n: RoadNode): number {
  const incident = n.incident.slice().sort((p, q) => p - q);
  const digest = nodeSourceDigest({ ...n, incident });
  for (const id of incident) {
    const s = doc.segment(id);
    digest.add(s ? segmentSourceKey(doc, s) : NaN);
  }
  return digest.value();
}

// DO NOT keep a road's or a node's inputs as JSON text: a number per record (`Digest`), not a string per record of the map.
/** Everything a segment's polyline, ribbon and junction legs are built from: its record and where its two ends stand. */
function segmentSourceKey(doc: RoadDoc, s: RoadSegment): number {
  const a = doc.node(s.a), b = doc.node(s.b);
  return new Digest().add(s.a).add(s.b).add(s.type).addPlain(s.curve ? [s.curve.t, s.curve.h] : null).add(s.dashOrigin)
    .addText(s.direction).addPlain(s.lanes).addText(s.structure).addPlain(s.section ?? null).addPlain(s.parking ?? null)
    .addPlain(a ? [a.x, a.y] : null).addPlain(b ? [b.x, b.y] : null).add(s.cutWalls ? 1 : 0).value();
}

/** Everything of a node a junction there is built from: its place, height, roads by id, control, crossing and end. */
function nodeSourceKey(n: RoadNode): number {
  return nodeSourceDigest(n).value();
}

function nodeSourceDigest(n: RoadNode): Digest {
  return new Digest().add(n.x).add(n.y).add(n.heightOffset).add(n.smooth ? 1 : 0).addAll(n.incident).addText(n.control)
    .addPlain(n.blockedMovements).addPlain(n.crossing ? [n.crossing.kind, n.crossing.segment] : null)
    .addPlain(n.end ?? null).addPlain(n.uturn ?? null);
}

/** The whole record of a node: what the traffic reads of it besides the geometry (lane links, signal settings, approach rules). */
function nodeRecordKey(n: RoadNode): number {
  return nodeSourceDigest(n).addPlain(n.laneLinks ?? null).addPlain(n.signal ?? null).addPlain(n.approachRules ?? null).value();
}

/** A point's rectangle, for filing a node by where it stands. */
const pointRect = (x: number, y: number): ChangeRect => [x, y, x, y];

/** THE NETWORK'S BUILD, INCREMENTAL */
export class NetworkBuild {
  /** The diary's serial the last rebuild read up to; -1: never built. */
  private seen = -1;
  private segmentSource = new Map<SegmentId, number>();
  private segmentEnds = new Map<SegmentId, readonly [NodeId, NodeId]>();
  private nodeSource = new Map<NodeId, number>();
  private nodeRecord = new Map<NodeId, number>();
  private nodeIncident = new Map<NodeId, readonly SegmentId[]>();
  private nodePlaces = new CellFiling<NodeId, object>();

  private active = new Set<NodeId>();
  private j1 = new Map<NodeId, MemoEntry>();
  private j2 = new Map<NodeId, MemoEntry>();
  private j3 = new Map<NodeId, MemoEntry>();
  private scale1 = new Map<SegmentId, number>();
  private scale2 = new Map<SegmentId, number>();
  private trims2 = new Map<SegmentId, SegmentTrims>();
  private plateRaw = new Map<NodeId, ReadonlyMap<SegmentId, number>>();
  /** The plate keys each road wrote (`node:segment`), to take them out when it changes. */
  private plateKeys = new Map<SegmentId, readonly string[]>();
  private ribbonMemo = new Map<SegmentId, RibbonMemo>();
  /** The tiles' bakes offered since the last rebuild (`offerBake`), taken by it (`takeBakes`). */
  private readonly bakes: NetworkBake[] = [];

  constructor(private readonly net: Network) {}

  /** A tile's junctions and ribbons solved off the page, for the next rebuild (the tile's records just loaded). */
  offerBake(bake: NetworkBake): void {
    this.bakes.push(bake);
  }

  /** The junctions and ribbons of `nodes` and `segments` as this build solved them, for another thread's build (`NetworkBake`). */
  exportBake(nodes: Iterable<NodeId>, segments: Iterable<SegmentId>): NetworkBake {
    const doc = this.net.doc;
    const out: NetworkBake = { nodes: [], segments: [] };
    for (const id of nodes) {
      const node = doc.node(id);
      if (!node) continue;
      out.nodes.push({ id, key: nodeBakeKey(doc, node), j1: memoData(this.j1.get(id)), j2: memoData(this.j2.get(id)), j3: memoData(this.j3.get(id)) });
    }
    for (const id of segments) {
      const memo = this.ribbonMemo.get(id), source = this.segmentSource.get(id);
      if (!memo || source === undefined) continue;
      const r = memo.ribbon;
      out.segments.push({ id, source, trims: memo.trims, bendA: memo.bendA, bendB: memo.bendB,
        ribbon: { id: r.id, typeIndex: r.typeIndex, direction: r.direction, road: r.road, dashOrigin: r.dashOrigin, full: r.full.xy, bounds: ribbonBounds(r) } });
    }
    return out;
  }

  /** The bakes offered: a changed node whose inputs are a bake's takes its passes as solved there (DO NOT solve a tile's thousand junctions on the page at each tile put in: the key tells a node with a road of a tile not here, solved here), a changed road its ribbon (`buildRibbon` still checks the trims and the bends). */
  private takeBakes(nodes: ReadonlySet<NodeId>, segments: ReadonlySet<SegmentId>): void {
    if (this.bakes.length === 0) return;
    const doc = this.net.doc;
    for (const bake of this.bakes.splice(0)) {
      for (const b of bake.nodes) {
        const node = doc.node(b.id);
        if (!node || !nodes.has(b.id) || nodeBakeKey(doc, node) !== b.key) continue;
        if (b.j1) this.j1.set(b.id, memoOf(b.j1));
        if (b.j2) this.j2.set(b.id, memoOf(b.j2));
        if (b.j3) this.j3.set(b.id, memoOf(b.j3));
        networkWork.taken++;
      }
      for (const s of bake.segments) {
        const seg = doc.segment(s.id);
        if (!seg || !segments.has(s.id) || segmentSourceKey(doc, seg) !== s.source) continue;
        this.ribbonMemo.set(s.id, { ribbon: ribbonFromBake(s), trims: s.trims, bendA: s.bendA, bendB: s.bendB });
      }
    }
  }

  /** Forgets everything: the next rebuild builds every piece (a map loaded). */
  forget(): void {
    this.seen = -1;
    this.segmentSource = new Map();
    this.segmentEnds = new Map();
    this.nodeSource = new Map();
    this.nodeRecord = new Map();
    this.nodeIncident = new Map();
    this.nodePlaces.copyFrom(new CellFiling());
    this.active = new Set();
    this.j1 = new Map();
    this.j2 = new Map();
    this.j3 = new Map();
    this.scale1 = new Map();
    this.scale2 = new Map();
    this.trims2 = new Map();
    this.plateRaw = new Map();
    this.plateKeys = new Map();
    this.ribbonMemo = new Map();
    // The bakes offered stay: they are for the next rebuild, from nothing or not.
  }

  /** DO NOT copy every map (`copyFrom`, twice per road drawn): a working copy over `other`'s state that keeps only what it writes */
  forkFrom(other: NetworkBuild): void {
    this.seen = other.seen;
    this.segmentSource = new ForkMap(other.segmentSource);
    this.segmentEnds = new ForkMap(other.segmentEnds);
    this.nodeSource = new ForkMap(other.nodeSource);
    this.nodeRecord = new ForkMap(other.nodeRecord);
    this.nodeIncident = new ForkMap(other.nodeIncident);
    this.nodePlaces = CellFiling.over(other.nodePlaces);
    this.active = new ForkSet(other.active);
    this.j1 = new ForkMap(other.j1);
    this.j2 = new ForkMap(other.j2);
    this.j3 = new ForkMap(other.j3);
    this.scale1 = new ForkMap(other.scale1);
    this.scale2 = new ForkMap(other.scale2);
    this.trims2 = new ForkMap(other.trims2);
    this.plateRaw = new ForkMap(other.plateRaw);
    this.plateKeys = new ForkMap(other.plateKeys);
    this.ribbonMemo = new ForkMap(other.ribbonMemo);
  }

  /** A working copy's state (`forkFrom`) written into this one, up to its document as it stands now: only what the copy wrote. */
  takeBack(fork: NetworkBuild): void {
    const maps = [
      [fork.segmentSource, this.segmentSource], [fork.segmentEnds, this.segmentEnds], [fork.nodeSource, this.nodeSource],
      [fork.nodeRecord, this.nodeRecord], [fork.nodeIncident, this.nodeIncident], [fork.j1, this.j1], [fork.j2, this.j2],
      [fork.j3, this.j3], [fork.scale1, this.scale1], [fork.scale2, this.scale2], [fork.trims2, this.trims2],
      [fork.plateRaw, this.plateRaw], [fork.plateKeys, this.plateKeys], [fork.ribbonMemo, this.ribbonMemo],
    ] as [Map<unknown, unknown>, Map<unknown, unknown>][];
    for (const [from, to] of maps) {
      if (!(from instanceof ForkMap)) throw new Error('NetworkBuild.takeBack: not a working copy');
      from.applyTo(to);
    }
    this.nodePlaces.takeBack(fork.nodePlaces);
    (fork.active as ForkSet<NodeId>).applyTo(this.active);
    this.seen = this.net.doc.changes.version;
  }

  /** Whether a full rebuild must follow (never built, or forgotten). */
  get empty(): boolean {
    return this.seen < 0;
  }

  /** @rebuild Brings the network up to the document; returns what changed (`null`: everything, a build from nothing). */
  rebuild(): NetworkDelta | null {
    const net = this.net, doc = net.doc;
    const fromNothing = this.seen < 0;
    const { segments: changedSegs, nodes: changedNodes, records } = this.findChanges();
    this.seen = doc.changes.version;

    const oldRects: ChangeRect[] = [];
    // DO NOT lay the ribbons and junctions out in id order again when a lower id comes (a tile of lower key loaded after): every tile load re-sorted the region; a reader in id order sorts what it takes.
    const ribbonBefore = new Map<SegmentId, SegmentRibbon | undefined>();
    const junctionBefore = new Map<NodeId, JunctionLevels | undefined>();

    // ---- sources: the polylines and memos of what changed go ---------------
    for (const id of changedSegs) {
      net.polylines.invalidate(id);
      this.ribbonMemo.delete(id);
    }
    for (const id of changedNodes) {
      this.j1.delete(id);
      this.j2.delete(id);
      this.j3.delete(id);
    }
    // The tiles just put in: their junctions and ribbons as a worker solved them, where the inputs are the same.
    this.takeBakes(changedNodes, changedSegs);

    // ---- pass 1 -----------------------------------------------------------
    const n1 = changedNodes;
    for (const node of n1) {
      networkWork.marks++;
      const record = doc.node(node);
      const isActive = !!record && surfaceMode(doc, net.polylines, node) === 'junction';
      if (isActive) {
        this.active.add(node);
        // A pass let go (a bake's) stands while its key does: its summary is what this pass reads.
        this.j1.set(node, this.solveNode(node, new Map(), false, this.j1.get(node), true));
      } else {
        this.active.delete(node);
      }
      // The mark of a node the editor would refuse (`Network.impossible`).
      const gap = record ? smallestGap(legAngles(doc, net.polylines, node)) : Infinity;
      if (gap < MIN_LEG_ANGLE) net.impossible.set(node, gap); else net.impossible.delete(node);
    }

    // ---- reconcile 1: the scales ------------------------------------------
    const s1 = new Set<SegmentId>();
    for (const id of changedSegs) if (doc.segment(id)) s1.add(id);
    for (const node of n1) for (const id of doc.node(node)?.incident ?? []) s1.add(id);
    const scaled1 = new Set<SegmentId>();
    for (const id of s1) {
      networkWork.segments++;
      const { scale } = this.reconcileSegment(id, (n) => this.entry1(n));
      if (scale !== (this.scale1.get(id) ?? 1)) scaled1.add(id);
      if (scale < 1) this.scale1.set(id, scale); else this.scale1.delete(id);
    }
    for (const id of changedSegs) if (!doc.segment(id)) { this.scale1.delete(id); this.scale2.delete(id); this.trims2.delete(id); }

    // ---- pass 2: the nodes under length pressure --------------------------
    const n2 = new Set(n1);
    for (const id of scaled1) this.addEnds(n2, id);
    const moved2 = new Set<NodeId>();
    for (const node of n2) {
      networkWork.junctions++;
      const before = this.entry2(node);
      if (this.active.has(node) && this.pressured(node, this.scale1)) {
        this.j2.set(node, this.solveNode(node, this.scale1, false, this.j2.get(node), true));
      } else {
        this.j2.delete(node);
      }
      if (this.entry2(node) !== before) moved2.add(node);
    }

    // ---- reconcile 2: the trims --------------------------------------------
    const s2 = new Set(s1);
    for (const node of moved2) for (const id of doc.node(node)?.incident ?? []) s2.add(id);
    const retrimmed = new Set<SegmentId>();
    for (const id of s2) {
      networkWork.segments++;
      const { trims, scale } = this.reconcileSegment(id, (n) => this.entry2(n));
      const oldTrims = this.trims2.get(id);
      if (!oldTrims || !samePlain(oldTrims, trims) || scale !== (this.scale2.get(id) ?? 1)) retrimmed.add(id);
      this.trims2.set(id, trims);
      if (scale < 1) this.scale2.set(id, scale); else this.scale2.delete(id);
    }

    // ---- pass 3: the capped junctions --------------------------------------
    const n3 = new Set(n2);
    for (const node of moved2) n3.add(node);
    for (const id of retrimmed) this.addEnds(n3, id);
    const moved3 = new Set<NodeId>();
    for (const node of n3) {
      networkWork.junctions++;
      const before = net.junctions.get(node);
      junctionBefore.set(node, before);
      if (this.active.has(node) && this.pressured(node, this.scale2)) {
        this.j3.set(node, this.solveNode(node, this.scale2, true, this.j3.get(node)));
      } else {
        this.j3.delete(node);
      }
      const after = this.levels3(node);
      if (after) net.junctions.set(node, after); else net.junctions.delete(node);
      if (after !== before) moved3.add(node);
    }

    // ---- plates: what each node's last solve reaches -----------------------
    const plated = new Set<NodeId>();
    for (const node of n3) {
      const plate = new Map<SegmentId, number>();
      if (this.active.has(node)) {
        for (const entry of [this.j1.get(node), this.j2.get(node), this.j3.get(node)]) {
          for (const [seg, reach] of entry?.plate ?? []) plate.set(seg, reach);
        }
      }
      const old = this.plateRaw.get(node);
      if (!old || !samePlate(old, plate)) plated.add(node);
      if (plate.size) this.plateRaw.set(node, plate); else this.plateRaw.delete(node);
    }

    // ---- the roads: final trims, plate reaches, ribbons --------------------
    const s3 = new Set<SegmentId>(s2);
    for (const id of retrimmed) s3.add(id);
    for (const node of moved3) for (const id of doc.node(node)?.incident ?? []) s3.add(id);
    for (const node of plated) for (const id of doc.node(node)?.incident ?? []) s3.add(id);
    for (const node of n1) for (const id of doc.node(node)?.incident ?? []) s3.add(id);
    for (const id of changedSegs) {
      if (doc.segment(id)) continue;
      // A road gone: everything it had.
      const ribbon = net.ribbons.get(id);
      ribbonBefore.set(id, ribbon);
      if (ribbon) oldRects.push(ribbonBounds(ribbon));
      net.ribbons.delete(id);
      net.segmentCells.remove(id);
      net.flushCells.remove(id);
      net.trims.delete(id);
      for (const key of this.plateKeys.get(id) ?? []) net.plateReach.delete(key);
      this.plateKeys.delete(id);
      this.ribbonMemo.delete(id);
    }
    const retrimmedFinal = new Set<SegmentId>();
    for (const id of s3) {
      networkWork.segments++;
      const seg = doc.segment(id);
      if (!seg) continue;
      const trims = this.finalTrims(id, seg);
      const old = net.trims.get(id);
      if (!old || !samePlain(old, trims)) retrimmedFinal.add(id);
      net.trims.set(id, trims);
      this.writePlate(id, seg);
      const before = net.ribbons.get(id);
      ribbonBefore.set(id, before);
      const ribbon = this.buildRibbon(id, seg, trims);
      if (ribbon !== before) {
        if (before) oldRects.push(ribbonBounds(before));
        net.ribbons.set(id, ribbon);
      }
      const bounds = ribbonBounds(ribbon);
      net.segmentCells.file(id, ribbon, bounds);
      if (flushOn(ribbon.road, 'left') || flushOn(ribbon.road, 'right')) net.flushCells.file(id, ribbon, bounds);
      else net.flushCells.remove(id);
    }

    // ---- the nodes: transitions, cells, squeezes ---------------------------
    for (const node of n3) {
      const byLevel = net.junctions.get(node);
      if (byLevel?.get(Level.Asphalt)?.transition) net.transitions.add(node); else net.transitions.delete(node);
      const before = junctionBefore.get(node);
      if (before !== byLevel && before) { const b = junctionBounds(before); if (b) oldRects.push(b); }
      const bounds = byLevel ? junctionBounds(byLevel) : null;
      if (byLevel && bounds) net.junctionCells.file(node, byLevel, bounds); else net.junctionCells.remove(node);
    }
    const marked = new Set<NodeId>(n3);
    for (const id of retrimmedFinal) this.addEnds(marked, id);
    for (const id of changedSegs) this.addEnds(marked, id);
    for (const node of marked) {
      networkWork.marks++;
      const worst = this.squeeze(node);
      if (worst > SQUEEZE_NOISE) net.squeezed.set(node, worst); else net.squeezed.delete(node);
    }

    for (const node of n3) this.letGoEarlierPasses(node);

    // ---- what changed, for whatever is derived from the network ------------
    if (fromNothing) return null;
    const segments = new Set<SegmentId>(changedSegs);
    const rects: ChangeRect[] = oldRects;
    for (const [id, before] of ribbonBefore) {
      const after = net.ribbons.get(id);
      if (after === before && !retrimmedFinal.has(id)) continue;
      segments.add(id);
      if (after) rects.push(ribbonBounds(after));
    }
    for (const id of retrimmedFinal) segments.add(id);
    for (const node of plated) for (const id of doc.node(node)?.incident ?? []) segments.add(id);
    const nodes = new Set<NodeId>(records);
    for (const node of changedNodes) nodes.add(node);
    for (const node of moved3) {
      nodes.add(node);
      const after = net.junctions.get(node);
      const b = after ? junctionBounds(after) : null;
      if (b) rects.push(b);
    }
    return { segments, nodes, rects };
  }

  /** The segments and nodes whose sources differ from what the last rebuild recorded, and the nodes whose record does */
  private findChanges(): { segments: Set<SegmentId>; nodes: Set<NodeId>; records: Set<NodeId> } {
    const doc = this.net.doc;
    const entries = this.seen < 0 ? null : doc.changes.since(this.seen, ['roads', 'traffic']);
    const candSegs = new Set<SegmentId>();
    const candNodes = new Set<NodeId>();
    let everything = entries === null;
    for (const entry of entries ?? []) {
      if (entry.rects === null) { everything = true; break; }
      for (const id of entry.ids ?? []) { candSegs.add(id as SegmentId); candNodes.add(id as NodeId); }
      for (const id of this.nodePlaces.idsMeetingAny(entry.rects)) candNodes.add(id);
    }
    if (everything) {
      // In increasing id order: a build from nothing files in one order whatever order the document holds them in (no reader depends on it).
      for (const id of [...new Set([...doc.segments.keys(), ...this.segmentSource.keys()])].sort((p, q) => p - q)) candSegs.add(id);
      for (const id of [...new Set([...doc.nodes.keys(), ...this.nodeSource.keys()])].sort((p, q) => p - q)) candNodes.add(id);
    } else {
      // A node moved moves its roads.
      for (const node of candNodes) {
        for (const id of doc.node(node)?.incident ?? []) candSegs.add(id);
        for (const id of this.nodeIncident.get(node) ?? []) candSegs.add(id);
      }
    }

    const segments = new Set<SegmentId>();
    for (const id of candSegs) {
      networkWork.sources++;
      const seg = doc.segment(id);
      const key = seg ? segmentSourceKey(doc, seg) : undefined;
      if (this.segmentSource.get(id) === key) continue;
      segments.add(id);
    }
    const nodes = new Set<NodeId>(), records = new Set<NodeId>();
    for (const id of segments) {
      for (const end of this.segmentEnds.get(id) ?? []) candNodes.add(end);
      const seg = doc.segment(id);
      if (seg) { candNodes.add(seg.a); candNodes.add(seg.b); }
    }
    for (const id of candNodes) {
      networkWork.sources++;
      const node = doc.node(id);
      const source = node ? nodeSourceKey(node) : undefined;
      const record = node ? nodeRecordKey(node) : undefined;
      let changed = this.nodeSource.get(id) !== source;
      for (const seg of node?.incident ?? []) if (!changed && segments.has(seg)) changed = true;
      for (const seg of this.nodeIncident.get(id) ?? []) if (!changed && segments.has(seg)) changed = true;
      if (changed) nodes.add(id);
      if (changed || this.nodeRecord.get(id) !== record) records.add(id);
    }

    // The sources recorded as they are now.
    for (const id of segments) {
      const seg = doc.segment(id);
      if (seg) {
        this.segmentSource.set(id, segmentSourceKey(doc, seg));
        this.segmentEnds.set(id, [seg.a, seg.b]);
      } else {
        this.segmentSource.delete(id);
        this.segmentEnds.delete(id);
      }
    }
    for (const id of records) {
      const node = doc.node(id);
      if (node) {
        this.nodeSource.set(id, nodeSourceKey(node));
        this.nodeRecord.set(id, nodeRecordKey(node));
        this.nodeIncident.set(id, node.incident.slice());
        this.nodePlaces.file(id, node, pointRect(node.x, node.y));
      } else {
        this.nodeSource.delete(id);
        this.nodeRecord.delete(id);
        this.nodeIncident.delete(id);
        this.nodePlaces.remove(id);
      }
    }
    return { segments, nodes, records };
  }

  private addEnds(into: Set<NodeId>, id: SegmentId): void {
    const seg = this.net.doc.segment(id);
    if (seg) { into.add(seg.a); into.add(seg.b); }
    for (const end of this.segmentEnds.get(id) ?? []) if (this.net.doc.node(end)) into.add(end);
  }

  private pressured(node: NodeId, scales: ReadonlyMap<SegmentId, number>): boolean {
    for (const id of this.net.doc.node(node)?.incident ?? []) if (scales.has(id)) return true;
    return false;
  }

  /** The junction a node has after each pass (null: none): the last pass that built one. */
  private entry1(node: NodeId): MemoEntry | null {
    const entry = this.j1.get(node);
    return entry && entry.size ? entry : null;
  }

  private entry2(node: NodeId): MemoEntry | null {
    const entry = this.j2.get(node);
    return entry && entry.size ? entry : this.entry1(node);
  }

  private entry3(node: NodeId): MemoEntry | null {
    const entry = this.j3.get(node);
    return entry && entry.size ? entry : this.entry2(node);
  }

  /** The junction a node has after the last pass, whole: a pass let go and fallen back to solved again, the same (its inputs are the ones it was solved from: a change of them re-marks the node). */
  private levels3(node: NodeId): JunctionLevels | null {
    const entry = this.entry3(node);
    if (!entry) return null;
    if (entry.byLevel) return entry.byLevel;
    if (this.j2.get(node) === entry) {
      const whole = this.solveNode(node, this.scale1, false, undefined);
      this.j2.set(node, whole);
      return whole.byLevel;
    }
    const whole = this.solveNode(node, new Map(), false, undefined);
    this.j1.set(node, whole);
    return whole.byLevel;
  }

  /** The passes' junctions a later pass of the node solved again, let go (their summaries and plates kept, `MemoEntry`). */
  private letGoEarlierPasses(node: NodeId): void {
    const first = this.j1.get(node), second = this.j2.get(node), third = this.j3.get(node);
    if (third?.size && second?.byLevel) this.j2.set(node, { ...second, byLevel: null });
    if ((third?.size || second?.size) && first?.byLevel) this.j1.set(node, { ...first, byLevel: null });
  }

  /** One node's junction for one pass: the entry made for the same key before when there is one */
  private solveNode(node: NodeId, scales: ReadonlyMap<SegmentId, number>, capped: boolean, known: MemoEntry | undefined, letGo = false): MemoEntry {
    networkWork.junctions++;
    const net = this.net, doc = net.doc;
    const key = this.junctionKey(node, scales, capped);
    if (known && known.key === key && (known.byLevel || letGo)) return known;
    for (const entry of [this.j1.get(node), this.j2.get(node), this.j3.get(node)]) if (entry?.key === key && entry.byLevel) return entry;
    networkWork.built++;
    const plate: [SegmentId, number][] = [];
    const byLevel = new Map<SurfaceLevel, Junction>();
    const derived = new Set<SurfaceLevel>();
    const build = (level: SurfaceLevel): Junction | null => {
      const maxTrimBySegment = capped ? this.trimCapsAt(node, level) : undefined;
      return buildJunction(doc, net.polylines, node, level, {
        radiusScaleBySegment: scales,
        ...(maxTrimBySegment ? { maxTrimBySegment } : {}),
      });
    };
    // Solved once, on the carriageway; every outer surface is that outline carried out to its own edge (`junction/derive.ts`).
    const carriageway = build(Level.Asphalt);
    const footprint = build(Level.Casing);
    footprint?.legs.forEach((leg, i) => plate.push([leg.seg, footprint.trims[i] as number]));
    for (const level of SURFACE_LEVELS) {
      const carried = level === Level.Asphalt || !carriageway ? null : deriveJunctionLevel(doc, net.polylines, carriageway, level);
      if (carried) derived.add(level);
      const j = level === Level.Asphalt ? carriageway : carried ?? build(level);
      if (j) byLevel.set(level, j);
    }
    return memoEntry(key, JunctionLevels.of(byLevel, derived), plate);
  }

  /** What a pass hands a node's junction beyond the node and its roads */
  private junctionKey(node: NodeId, scales: ReadonlyMap<SegmentId, number>, capped: boolean): number {
    const doc = this.net.doc;
    const source = doc.node(node);
    const digest = new Digest();
    if (!source) return digest.add(-1).value();
    digest.add(capped ? 1 : 0);
    for (const id of source.incident) {
      const segment = doc.segment(id);
      if (!segment) { digest.add(NaN); continue; }
      digest.add(scales.get(id) ?? 1);
      if (capped) {
        const trims = this.trims2.get(id);
        digest.addPlain(trims ? (segment.a === node ? trims.a : trims.b) : null);
      }
    }
    return digest.add(source.incident.length).value();
  }

  /** Final per-leg caps for one junction after segment-end reconciliation. */
  private trimCapsAt(node: NodeId, level: SurfaceLevel): ReadonlyMap<SegmentId, number> {
    const doc = this.net.doc;
    const caps = new Map<SegmentId, number>();
    const source = doc.node(node);
    if (!source) return caps;
    for (const id of source.incident) {
      const segment = doc.segment(id);
      const trims = this.trims2.get(id);
      if (!segment || !trims) continue;
      const side = segment.a === node ? trims.a : trims.b;
      caps.set(id, side[level] ?? 0);
    }
    return caps;
  }

  /** One segment's two ends reconciled against its length, per level, from the junctions at its ends */
  private reconcileSegment(id: SegmentId, entryAt: (node: NodeId) => MemoEntry | null): { trims: SegmentTrims; scale: number } {
    const doc = this.net.doc;
    const seg = doc.requireSegment(id);
    const t: { a: Record<number, number>; b: Record<number, number> } = { a: {}, b: {} };
    let floor: { a: number; b: number } | undefined;
    for (const node of seg.a === seg.b ? [seg.a] : [seg.a, seg.b]) {
      const summary = entryAt(node)?.summary;
      if (!summary) continue;
      for (let k = 0; k < summary.length; k += SUMMARY) {
        if (summary[k] !== id) continue;
        const side = seg.a === node ? t.a : t.b;
        for (const level of SURFACE_LEVELS) {
          const trim = summary[k + level]!;
          if (!Number.isNaN(trim)) side[level] = Math.max(side[level] ?? 0, trim);
        }
        // The part of a mouth no length budget may take
        const along = summary[k + SUMMARY_FLOOR]!;
        if (along > 0) {
          const h = floor ?? { a: 0, b: 0 };
          if (seg.a === node) h.a = Math.max(h.a, along); else h.b = Math.max(h.b, along);
          floor = h;
        }
      }
    }
    const length = this.net.polylines.get(doc, id).length;
    let worst = 1;
    for (const level of SURFACE_LEVELS) {
      const a = t.a[level] ?? 0;
      const b = t.b[level] ?? 0;
      const clamped = clampSegmentTrims({ a, b, length });
      let ca = clamped.a, cb = clamped.b;
      if (floor && clamped.scale < 1) {
        // The budget may squeeze the kerb returns, never the overlap itself
        const fa = Math.min(a, floor.a), fb = Math.min(b, floor.b);
        if (fa + fb <= length - MIN_RIBBON) { ca = Math.max(ca, fa); cb = Math.max(cb, fb); }
      }
      t.a[level] = ca;
      t.b[level] = cb;
      if (clamped.scale < worst) worst = clamped.scale;
    }
    return { trims: t, scale: worst };
  }

  /** The reconciled trims lowered to what the final junctions actually used */
  private finalTrims(id: SegmentId, seg: RoadSegment): SegmentTrims {
    const base = this.trims2.get(id)!;
    const t = { a: { ...base.a }, b: { ...base.b } };
    for (const node of seg.a === seg.b ? [seg.a] : [seg.a, seg.b]) {
      const byLevel = this.net.junctions.get(node);
      if (!byLevel) continue;
      byLevel.forEachTrim((level, legSeg, trim) => {
        if (legSeg !== id) return;
        const side = seg.a === node ? t.a : t.b;
        side[level] = Math.min(side[level] ?? Infinity, trim);
      });
    }
    return t;
  }

  /** A road's plate reaches (`Network.plateReach`), reconciled against its length the way the trims are */
  private writePlate(id: SegmentId, seg: RoadSegment): void {
    const net = this.net;
    for (const key of this.plateKeys.get(id) ?? []) net.plateReach.delete(key);
    const keyA = `${seg.a}:${id}`, keyB = `${seg.b}:${id}`;
    const a = this.plateRaw.get(seg.a)?.get(id);
    const b = this.plateRaw.get(seg.b)?.get(id);
    if (a === undefined && b === undefined) { this.plateKeys.delete(id); return; }
    const clamped = clampSegmentTrims({ a: a ?? 0, b: b ?? 0, length: net.polylines.get(net.doc, id).length });
    // A road that comes back to its node has one key for both ends: the second write stands.
    if (a !== undefined) net.plateReach.set(keyA, clamped.a);
    if (b !== undefined) net.plateReach.set(keyB, clamped.b);
    this.plateKeys.set(id, keyA === keyB ? [keyA] : [keyA, keyB]);
  }

  /** How far the worst mouth of a junction is cut short of where two of its legs' carriageways stop overlapping */
  private squeeze(node: NodeId): number {
    const net = this.net;
    const junction = net.junctions.get(node)?.get(Level.Asphalt);
    if (!junction || junction.transition) return 0;
    let worst = 0;
    for (const corner of junction.corners) {
      const x = corner.x;
      if (!x || corner.psi >= Math.PI / 2) continue;
      for (const index of [corner.i, corner.j]) {
        const leg = junction.legs[index];
        const seg = leg ? net.doc.segment(leg.seg) : undefined;
        const trims = leg ? net.trims.get(leg.seg) : undefined;
        if (!leg || !seg || !trims) continue;
        const along = (x.x - leg.origin.x) * leg.dir.x + (x.y - leg.origin.y) * leg.dir.y;
        const trim = (seg.a === node ? trims.a : trims.b)[Level.Asphalt] ?? 0;
        worst = Math.max(worst, along - trim);
      }
    }
    return worst;
  }


  /** A road's ribbon: the one it had when its road, its trims and the bends at its ends are the same. */
  private buildRibbon(id: SegmentId, seg: RoadSegment, t: SegmentTrims): SegmentRibbon {
    const net = this.net;
    const bendA = bendAt(net.doc, net.polylines, seg.a, id);
    const bendB = bendAt(net.doc, net.polylines, seg.b, id);
    const known = this.ribbonMemo.get(id);
    if (known && samePlain(known.trims, t) && known.bendA === bendA && known.bendB === bendB) return known.ribbon;
    const ribbon = makeRibbon(net.doc, net.polylines, id, seg, t, bendA, bendB);
    this.ribbonMemo.set(id, { ribbon, trims: t, bendA, bendB });
    return ribbon;
  }
}

function samePlate(a: ReadonlyMap<SegmentId, number>, b: ReadonlyMap<SegmentId, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}
