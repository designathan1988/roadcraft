import type { MultiPoly, Poly } from '@core/clipper';
import { union } from '@core/clipper';
import { Digest } from '@core/digest';
import { type Input, inputOf, medianOf } from './roadSurfaceRings';
import type { ChangeRect } from '@world/changes';
import { JournalCursor } from '@world/derived';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { CASING_BAND, Level, type SurfaceLevel } from '@world/roadTypes';
import { levelRingsOf } from '@world/surfaces';
import { rampOutline, rampsOfNode } from '@world/curbRamps';
import { footwayRiseShare } from '@world/roads/footwayRise';
import { ROAD_STRUCTURES, roadStructure, type RoadStructure } from '@world/structures';
import { m } from '@world/units';
import {
  type Bar,
  type StrokeSpec,
  approachLegendsAt,
  junctionDetailAt,
  midBlockDetailAt,
  miniRoundaboutAt,
  transitionMarkings,
} from '@world/markings';
import { parkingLinesOf, parksAlong } from '@world/parkingLayout';
import { PAINT_COLOURS, STOP_PAINT, ZEBRA_PAINT, barQuad, roadStrokes, strokeQuads, type QuadSink } from './markings';
import { FOOTWAY_EDGE_CELL } from './roadSurfaceReads';

/**
 * THE ROAD SURFACES' INPUTS, KEPT ROAD BY ROAD AND NODE BY NODE (`roadSurfaces.ts`).
 *
 * What a pass of the surfaces is cut from - each road's rings of every level,
 * its median, its carriageway for the paint, its lines and its parking; each
 * node's junction plates, taper, mini-roundabout plate, dropped kerbs, stop
 * lines, zebras and legends - is made for an item when the network's change
 * names it (`Network.changesSince`, the change the lane graph and the dropped
 * kerbs read), and filed into the tiles its rings reach, each pass's tiles
 * holding what reaches them. An edit costs the items it touched and their
 * tiles, whatever the size of the map: the change a build system propagates
 * item by item (Mokhov, Mitchell and Peyton Jones, "Build systems à la carte").
 *
 * DO NOT gather a pass's inputs by walking the whole map and filtering by the
 * pass (`levelRings(net, level, include)`, `markingQuads(net, include)`): every
 * road edit - and every road a growing city laid - flattened every ring of the
 * map again, once per pass (2026-10-15).
 *
 * A tile's inputs come out in the order a walk of the whole map meets them
 * (the roads by id, then the junctions by id; the paint by kind, then by id):
 * the same rings in the same order however the edits came, so a tile built
 * after any edits is the tile a build from nothing makes, byte for byte
 * (`tests/render/roadTileWorkers.spec.ts`).
 */

/**
 * World size of one tile.
 *
 * A road edit used to merge, cut and triangulate every band of the whole
 * network: a quarter of a million triangles and every polygon boolean, most of
 * the time a new road took to appear, and more on a bigger map. Everything is
 * now done a tile at a time from the rings that reach the tile, and a tile
 * whose rings and surroundings (`SurfaceReuse.dependsOn`) have not changed is
 * copied from the last build, so an edit pays for the tiles it reaches. A
 * multiple of the ground and deck spans (8 x 6 and 16 x 6), so a tile holds
 * whole pieces.
 */
export const TILE = m(76.8);
/**
 * Where the tile grid starts. Off any round number, so no road drawn on a
 * round coordinate has its edge lie along a tile line, where it would be taken
 * for a cut and lose its kerb (`meshTile`).
 */
export const TILE_ORIGIN = m(0.1484);
/** How far round a tile a ring may reach and still be read by it. */
const TILE_REACH = m(0.2);
export const TILE_BIAS = 1 << 15;

/** A tile's key from its column and row. */
const tileKey = (ix: number, iy: number): number => (ix + TILE_BIAS) * 0x1_0000 + (iy + TILE_BIAS);

/** How many items had their inputs made, for the scale tests: an edit far away makes few. */
export const surfaceInputWork = { segments: 0, nodes: 0 };

/** Everything that reaches a tile of a pass, by kind, in input order. */
export interface Reach {
  readonly levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', readonly Input[]>;
  readonly medians: Record<'kerb' | 'planting' | 'paved', readonly Input[]>;
  readonly ramps: readonly Input[];
  readonly ribbons: readonly Input[];
  readonly quads: ReadonlyMap<string, readonly Input[]>;
}

/**
 * One input of an item, as a pass files it: its kind (`slot`), its pass, and
 * where a walk of the map meets it - `phase` (which loop of that walk), `id`
 * (the road or node), `seq` (its place among the item's own).
 */
interface Entry {
  readonly input: Input;
  readonly slot: string;
  readonly phase: number;
  readonly id: number;
  readonly seq: number;
  /** The pass it belongs to; `DETAILS`: every pass at ground level reads it where it paints (`reachOf`). */
  readonly pass: string;
  readonly tiles: readonly number[];
}

/**
 * The junctions' stop lines, zebras, islands and legends: the old walk painted
 * all of them in every pass at ground level, clipped to that pass's carriageway
 * (`roadTileShape.ts`), so they are filed once and read by each such pass in
 * the tiles where it has carriageway - a tile with none paints nothing of them.
 */
const DETAILS = '*details';

const LEVEL_SLOTS = ['casing', 'sidewalk', 'curb', 'asphalt'] as const;
const LEVEL_OF: Readonly<Record<(typeof LEVEL_SLOTS)[number], SurfaceLevel>> = {
  casing: Level.Casing as SurfaceLevel,
  sidewalk: Level.Sidewalk as SurfaceLevel,
  curb: Level.Curb as SurfaceLevel,
  asphalt: Level.Asphalt as SurfaceLevel,
};
const MEDIAN_SLOTS = ['kerb', 'planting', 'paved'] as const;
const medianSlot = (part: string): string => `median:${part}`;
const paintSlot = (color: string): string => `paint:${color}`;
const PAINT_PREFIX = 'paint:';

/**
 * The phases of the walk the inputs are ordered by, as `roadSurfaces.ts` once
 * walked the map: the levels' roads then junctions; the carriageway's roads,
 * tapers, mini-roundabout plates; the paint's road lines, parking, tapers,
 * junctions' then mid-block stop lines, junctions' then mid-block zebras,
 * islands and legends.
 */
const PHASE = {
  road: 0, junction: 1,
  taper: 1, mini: 2,
  lines: 0, parking: 1, taperPaint: 2, stops: 3, midStops: 4, zebras: 5, midZebras: 6, islands: 7, legends: 8,
} as const;

const byWalk = (p: Entry, q: Entry): number => p.phase - q.phase || p.id - q.id || p.seq - q.seq;

/** A tile of one pass: its entries by slot, and what it reads once put together. */
interface TileInputs {
  readonly key: number;
  readonly slots: Map<string, Set<Entry>>;
  /** The pass's own entries in it; at none it goes. */
  own: number;
  /** Of them, the carriageway the paint is clipped to: only then does it read the junctions' paint. */
  ribbons: number;
  /** Put together (`reachOf`) and its digest; null when something in it changed since. */
  reach: Reach | null;
  digest: number;
  /** The paint colours it holds, in order. */
  colours: readonly string[];
}

/** One pass's tiles, by key. */
interface PassInputs {
  readonly id: string;
  /** Whether it reads the junctions' paint (`DETAILS`): a pass at ground level. */
  readonly ground: boolean;
  readonly tiles: Map<number, TileInputs>;
}

/** A pass of the surfaces as the build walks it: a structural level, or an alignment raised by hand. */
export interface SurfacePass {
  readonly id: string;
  readonly structure: RoadStructure;
  readonly segment?: SegmentId;
  readonly chain?: readonly SegmentId[];
}

interface SegmentItem {
  readonly pass: string | null;
  readonly ends: readonly [NodeId, NodeId];
  readonly entries: readonly Entry[];
}

/**
 * The inputs of every pass, kept between builds and brought up to the network
 * by its change (`refresh`). One per `SurfaceReuse` (the renderer's); a build
 * without one makes a fresh one, from the whole map.
 */
export class SurfaceInputs {
  private net: Network | null = null;
  /** The network's state the inputs stand for (`Network.state`). */
  private token: object | null = null;
  private style: string | null = null;
  /** The buildings' entries read (a street's parking keeps clear of their gates, `parkingLayout.ts`). */
  private readonly buildings = new JournalCursor(['buildings']);
  private readonly segments = new Map<SegmentId, SegmentItem>();
  private readonly nodes = new Map<NodeId, readonly Entry[]>();
  /** The roads with an end raised by hand: drawn in an alignment of their own. */
  private readonly manual = new Set<SegmentId>();
  /** Each such road's alignment, by its lowest id; and each alignment's roads, in id order. */
  private readonly rootOf = new Map<SegmentId, SegmentId>();
  private readonly chains = new Map<SegmentId, SegmentId[]>();
  /** The document's roads in each pass. */
  private readonly count = new Map<string, number>();
  private readonly passes = new Map<string, PassInputs>();
  /** The junctions' paint (`DETAILS`), by tile and slot. */
  private readonly details = new Map<number, Map<string, Set<Entry>>>();
  /** Every paint colour met (a handful: the catalogue's, `PAINT_COLOURS`, and any it lacks). */
  private readonly met = new Set<string>();

  /**
   * Brings the inputs up to `net`: the items its change since the last refresh
   * names, and the roads round them, made again; everything when it cannot say.
   * @rebuild Called once a build of the surfaces, when the network was rebuilt.
   */
  refresh(net: Network): void {
    const doc = net.doc;
    const same = this.net === net && this.token !== null;
    const delta = same ? net.changesSince(this.token) : null;
    const styleChanged = this.style !== doc.markingStyle;
    const buildings = this.buildings.read(doc.changes);
    this.net = net;
    this.token = net.state;
    this.style = doc.markingStyle;
    // A change of the paint's standard repaints every road and junction, and a change of buildings the
    // diary cannot place may move any street's parking: the whole map changed.
    if (delta === null || styleChanged || buildings === null || buildings.some((entry) => entry.rects === null)) {
      this.rebuildAll(net);
      return;
    }

    const segs = new Set<SegmentId>(delta.segments);
    // A crossing is fitted to the footway along its road, a flush footway lowers the kerbs on it: a
    // change where a road reaches moves its paint and its ramps (`Network.forgetCrossings`).
    if (delta.rects.length) for (const id of net.segmentCells.idsMeetingAny(delta.rects)) segs.add(id);
    const nodes = new Set<NodeId>(delta.nodes);
    const ends = (id: SegmentId): void => {
      const segment = doc.segment(id);
      if (segment) { nodes.add(segment.a); nodes.add(segment.b); }
      const item = this.segments.get(id);
      if (item) { nodes.add(item.ends[0]); nodes.add(item.ends[1]); }
    };
    for (const id of segs) ends(id);
    // A road's lines stop at its nodes' stop lines and crossings, and its mouths overlap their plates:
    // every road of a node that changed.
    for (const node of nodes) for (const id of doc.node(node)?.incident ?? []) segs.add(id);
    for (const id of segs) ends(id);
    // A building changed beside a street with parking: the bays keep clear of its gates.
    const near: ChangeRect[] = [];
    for (const entry of buildings) for (const r of entry.rects ?? []) near.push([r[0] - PARKING_REACH, r[1] - PARKING_REACH, r[2] + PARKING_REACH, r[3] + PARKING_REACH]);
    if (near.length) {
      for (const id of net.segmentCells.idsMeetingAny(near)) {
        const ribbon = net.ribbons.get(id);
        if (ribbon && parksAlong(net, ribbon)) segs.add(id);
      }
    }
    // The alignments the roads changed are in, and the roads whose pass that moved.
    for (const id of this.reassign(net, segs)) {
      if (segs.has(id) || this.passOf(net, id) === (this.segments.get(id)?.pass ?? null)) continue;
      segs.add(id);
      ends(id);
    }
    for (const id of [...segs].sort((p, q) => p - q)) this.placeSegment(net, id);
    for (const node of [...nodes].sort((p, q) => p - q)) this.placeNode(net, node);
  }

  /** @rebuild Every item made again: the network could not say what changed (a load, the first build). */
  private rebuildAll(net: Network): void {
    this.passes.clear();
    this.details.clear();
    this.segments.clear();
    this.nodes.clear();
    this.manual.clear();
    this.rootOf.clear();
    this.chains.clear();
    this.count.clear();
    const ids = [...net.doc.segments.keys()].sort((p, q) => p - q);
    this.reassign(net, ids);
    for (const id of ids) this.placeSegment(net, id);
    for (const node of [...net.doc.nodes.keys()].sort((p, q) => p - q)) this.placeNode(net, node);
  }

  /** Whether a road has an end raised by hand: it is drawn from its own deck, in an alignment. */
  private static raisedByHand(net: Network, id: SegmentId): boolean {
    const segment = net.doc.segment(id);
    return !!segment && (Math.abs(net.doc.node(segment.a)?.heightOffset ?? 0) > 1e-6 ||
      Math.abs(net.doc.node(segment.b)?.heightOffset ?? 0) > 1e-6);
  }

  /**
   * The alignments of `ids` made again: each road's flag read, every alignment
   * one of them was or is in walked again from it (roads raised by hand that
   * run on from one another through a two-way node are ONE surface). Returns
   * every road whose alignment may have moved.
   */
  private reassign(net: Network, ids: Iterable<SegmentId>): Set<SegmentId> {
    const doc = net.doc;
    const redo = new Set<SegmentId>();
    for (const id of ids) {
      const now = SurfaceInputs.raisedByHand(net, id);
      const was = this.manual.has(id);
      if (now) this.manual.add(id); else this.manual.delete(id);
      if (!now && !was) continue;
      redo.add(id);
      const root = this.rootOf.get(id);
      if (root === undefined) continue;
      for (const member of this.chains.get(root) ?? []) redo.add(member);
      this.chains.delete(root);
    }
    for (const id of redo) this.rootOf.delete(id);
    const reached = new Set<SegmentId>();
    for (const start of redo) {
      if (!this.manual.has(start) || this.rootOf.has(start)) continue;
      const component: SegmentId[] = [start];
      const seen = new Set<SegmentId>([start]);
      for (let k = 0; k < component.length; k++) {
        const segment = doc.segment(component[k]!);
        if (!segment) continue;
        for (const end of [segment.a, segment.b]) {
          // Bent or straight: a bend's junction plate belongs to the pass that holds both its legs.
          const incident = doc.node(end)?.incident;
          if (!incident || incident.length !== 2) continue;
          for (const other of incident) {
            if (seen.has(other) || !this.manual.has(other)) continue;
            seen.add(other);
            component.push(other);
          }
        }
      }
      component.sort((p, q) => p - q);
      const root = component[0]!;
      for (const member of component) {
        // An alignment this one joined: its roads move into this one.
        const before = this.rootOf.get(member);
        if (before !== undefined && before !== root) {
          for (const moved of this.chains.get(before) ?? []) reached.add(moved);
          this.chains.delete(before);
        }
        this.rootOf.set(member, root);
        reached.add(member);
      }
      this.chains.set(root, component);
    }
    for (const id of reached) redo.add(id);
    return redo;
  }

  /** The pass a road is drawn in: its alignment when raised by hand, else its structural level. */
  private passOf(net: Network, id: SegmentId): string | null {
    const segment = net.doc.segment(id);
    if (!segment) return null;
    const root = this.rootOf.get(id);
    return root !== undefined ? alignmentPass(root) : segment.structure;
  }

  /** A road's inputs made again and filed. */
  private placeSegment(net: Network, id: SegmentId): void {
    surfaceInputWork.segments++;
    const old = this.segments.get(id);
    if (old) {
      this.unfile(old.entries);
      if (old.pass !== null) this.count.set(old.pass, (this.count.get(old.pass) ?? 1) - 1);
      this.segments.delete(id);
    }
    const segment = net.doc.segment(id);
    if (!segment) return;
    const pass = this.passOf(net, id)!;
    this.count.set(pass, (this.count.get(pass) ?? 0) + 1);
    const entries: Entry[] = [];
    const ribbon = net.ribbons.get(id);
    if (ribbon) {
      let seq = 0;
      const add = (slot: string, phase: number, poly: Poly): void => {
        const input = inputOf(poly);
        if (input) entries.push(entryOf(input, slot, phase, id, seq++, pass));
      };
      for (const slot of LEVEL_SLOTS) for (const poly of levelRingsOf(net, LEVEL_OF[slot], [ribbon], [])) add(slot, PHASE.road, poly);
      const median = medianOf(net, ribbon);
      if (median) {
        add(medianSlot('kerb'), PHASE.road, median.kerb);
        add(medianSlot(median.paved ? 'paved' : 'planting'), PHASE.road, median.inner);
      }
      // Paint belongs to the road legs, not to the shared intersection interior,
      // so it is clipped to the ribbons' carriageway alone.
      const ring = ribbon.rings[Level.Asphalt];
      if (ring && !ring.isEmpty) add('ribbons', PHASE.road, [ring.flatten().map((point) => [point.x, point.y])]);
      const paint = (phase: number): QuadSink => (color, quad) => { this.colour(color); add(paintSlot(color), phase, [quad]); };
      const lines = paint(PHASE.lines);
      for (const spec of roadStrokes(net, ribbon)) strokeQuads(lines, spec);
      // Parking bays and the no-parking lines beside them (`world/parkingLayout.ts`).
      const parking = paint(PHASE.parking);
      for (const line of parkingLinesOf(net, ribbon)) {
        strokeQuads(parking, { points: line.points, width: line.width, color: line.color, dash: line.dash, dashOffset: 0 });
      }
    }
    this.segments.set(id, { pass, ends: [segment.a, segment.b], entries });
    this.file(entries);
  }

  /** A node's inputs made again and filed: its plates, taper, island, dropped kerbs and junction paint. */
  private placeNode(net: Network, node: NodeId): void {
    surfaceInputWork.nodes++;
    const old = this.nodes.get(node);
    if (old) {
      this.unfile(old);
      this.nodes.delete(node);
    }
    const record = net.doc.node(node);
    if (!record) return;
    const entries: Entry[] = [];
    let seq = 0;
    const add = (slot: string, phase: number, input: Input | null, pass: string | null): void => {
      if (input && pass !== null) entries.push(entryOf(input, slot, phase, node, seq++, pass));
    };
    const byLevel = net.junctions.get(node);
    const plate = byLevel?.get(Level.Asphalt as SurfaceLevel);
    if (byLevel) {
      const owner = this.ownerOf(net, node);
      if (owner !== null) {
        for (const slot of LEVEL_SLOTS) {
          for (const poly of levelRingsOf(net, LEVEL_OF[slot], [], [[node, byLevel]])) add(slot, PHASE.junction, inputOf(poly), owner);
        }
      }
    }
    // ...and to the tapers where a road carries on at another width, whose lane
    // lines and edge lines run on through them (see transitionMarkings).
    if (net.transitions.has(node)) {
      const leg = plate?.legs[0];
      const pass = leg ? this.passOf(net, leg.seg) : null;
      if (plate && pass !== null) {
        add('ribbons', PHASE.taper, inputOf([plate.ring.flatten().map((point) => [point.x, point.y])]), pass);
        const sink: QuadSink = (color, quad) => { this.colour(color); add(paintSlot(color), PHASE.taperPaint, inputOf([quad]), pass); };
        for (const spec of transitionMarkings(net, node)) strokeQuads(sink, spec);
      }
    }
    // ...and to a mini-roundabout's plate, where its island is painted (docs/VIAS.md V5): in each pass
    // one of its roads is drawn in.
    if (plate && record.control === 'mini' && record.incident.length >= 3) {
      const input = inputOf([plate.ring.flatten().map((point) => [point.x, point.y])]);
      const seen = new Set<string>();
      for (const id of record.incident) {
        const pass = this.passOf(net, id);
        if (pass === null || seen.has(pass)) continue;
        seen.add(pass);
        add('ribbons', PHASE.mini, input, pass);
      }
    }
    // The dropped kerbs. No dropped kerb on a footway laid flush: there is no kerb to drop.
    for (const r of rampsOfNode(net, node)) {
      if (footwayRiseShare(net, r.x + r.nx * r.run, r.y + r.ny * r.run) <= 0) continue;
      add('ramps', PHASE.road, inputOf([rampOutline(r)]), this.passOf(net, r.segment));
    }
    // The junction's paint, read by every pass at ground level (`DETAILS`).
    const bars = (phase: number, color: string, list: readonly Bar[]): void => {
      for (const bar of list) barQuad((c, quad) => { this.colour(c); add(paintSlot(c), phase, inputOf([quad]), DETAILS); }, color, bar);
    };
    const strokes = (phase: number, list: readonly StrokeSpec[]): void => {
      const sink: QuadSink = (color, quad) => { this.colour(color); add(paintSlot(color), phase, inputOf([quad]), DETAILS); };
      for (const spec of list) strokeQuads(sink, spec);
    };
    const stops: Bar[] = [], zebras: Bar[] = [], midStops: Bar[] = [], midZebras: Bar[] = [];
    junctionDetailAt(net, node, stops, zebras);
    midBlockDetailAt(net, node, midStops, midZebras);
    bars(PHASE.stops, STOP_PAINT, stops);
    bars(PHASE.midStops, STOP_PAINT, midStops);
    bars(PHASE.zebras, ZEBRA_PAINT, zebras);
    bars(PHASE.midZebras, ZEBRA_PAINT, midZebras);
    // Mini-roundabouts' painted islands (V5), and the junction rule's words and symbols before the stop lines (V6).
    const islands: StrokeSpec[] = [];
    miniRoundaboutAt(net, node, islands);
    strokes(PHASE.islands, islands);
    const legends: StrokeSpec[] = [];
    approachLegendsAt(net, node, net.doc.markingStyle, legends);
    strokes(PHASE.legends, legends);
    if (entries.length) this.nodes.set(node, entries);
    this.file(entries);
  }

  /**
   * The pass a junction's plates are drawn in: that of its lowest road that is
   * not a tunnel (the first such in its order), or none.
   */
  private ownerOf(net: Network, node: NodeId): string | null {
    const record = net.doc.node(node);
    if (!record) return null;
    let lowest = Infinity;
    let owner: string | null = null;
    for (const id of record.incident) {
      const structure = net.doc.segment(id)?.structure ?? 'ground';
      if (structure === 'tunnel') continue;
      const clearance = roadStructure(structure).clearance;
      if (clearance < lowest) {
        lowest = clearance;
        owner = this.passOf(net, id);
      }
    }
    return owner;
  }

  private colour(color: string): void {
    this.met.add(color);
  }

  private file(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.pass === DETAILS) {
        for (const key of entry.tiles) {
          let slots = this.details.get(key);
          if (!slots) this.details.set(key, slots = new Map());
          let set = slots.get(entry.slot);
          if (!set) slots.set(entry.slot, set = new Set());
          set.add(entry);
          this.touchDetails(key);
        }
        continue;
      }
      let pass = this.passes.get(entry.pass);
      if (!pass) this.passes.set(entry.pass, pass = { id: entry.pass, ground: isGroundPass(entry.pass), tiles: new Map() });
      for (const key of entry.tiles) {
        let tile = pass.tiles.get(key);
        if (!tile) pass.tiles.set(key, tile = { key, slots: new Map(), own: 0, ribbons: 0, reach: null, digest: 0, colours: [] });
        let set = tile.slots.get(entry.slot);
        if (!set) tile.slots.set(entry.slot, set = new Set());
        set.add(entry);
        tile.own++;
        if (entry.slot === 'ribbons') tile.ribbons++;
        tile.reach = null;
      }
    }
  }

  private unfile(entries: readonly Entry[]): void {
    for (const entry of entries) {
      if (entry.pass === DETAILS) {
        for (const key of entry.tiles) {
          const slots = this.details.get(key);
          const set = slots?.get(entry.slot);
          if (!slots || !set) continue;
          set.delete(entry);
          if (set.size === 0) slots.delete(entry.slot);
          if (slots.size === 0) this.details.delete(key);
          this.touchDetails(key);
        }
        continue;
      }
      const pass = this.passes.get(entry.pass);
      if (!pass) continue;
      for (const key of entry.tiles) {
        const tile = pass.tiles.get(key);
        const set = tile?.slots.get(entry.slot);
        if (!tile || !set) continue;
        set.delete(entry);
        if (set.size === 0) tile.slots.delete(entry.slot);
        tile.own--;
        if (entry.slot === 'ribbons') tile.ribbons--;
        tile.reach = null;
        if (tile.own === 0) pass.tiles.delete(key);
      }
      if (pass.tiles.size === 0) this.passes.delete(pass.id);
    }
  }

  /** The junctions' paint in a tile changed: every pass at ground level reads that tile again. */
  private touchDetails(key: number): void {
    for (const pass of this.passes.values()) {
      if (!pass.ground) continue;
      const tile = pass.tiles.get(key);
      if (tile) tile.reach = null;
    }
  }

  /**
   * The passes of the surfaces: every structural level, then each alignment
   * raised by hand, by its lowest road.
   */
  passList(): SurfacePass[] {
    const out: SurfacePass[] = ROAD_STRUCTURES.map((structure) => ({ id: structure.id, structure: structure.id }));
    for (const root of [...this.chains.keys()].sort((p, q) => p - q)) {
      out.push({ id: alignmentPass(root), structure: 'ground', segment: root, chain: this.chains.get(root)! });
    }
    return out;
  }

  /** Whether some road of the document is drawn in a pass. */
  present(pass: string): boolean {
    return (this.count.get(pass) ?? 0) > 0;
  }

  /**
   * Every colour a pass may paint in: the catalogue's, then any other met (none is:
   * `tests/render/paintCatalogue.spec.ts`), in order.
   */
  paintColours(): string[] {
    return [...PAINT_COLOURS, ...[...this.met].filter((color) => !PAINT_COLOURS.includes(color)).sort()];
  }

  /** The colours the roads and junctions have been painted in. */
  paintedColours(): string[] {
    return [...this.met];
  }

  /** The keys of a pass's tiles, in order. */
  tileKeys(pass: string): number[] {
    return [...this.passes.get(pass)?.tiles.keys() ?? []].sort((p, q) => p - q);
  }

  /**
   * What a tile of a pass reads, put together when something in it changed:
   * its entries and, in a pass at ground level that paints there, the
   * junctions' paint - each kind in the order a walk of the map meets it.
   */
  reachOf(passId: string, key: number): { readonly reach: Reach; readonly digest: number; readonly colours: readonly string[] } {
    const pass = this.passes.get(passId)!;
    const tile = pass.tiles.get(key)!;
    if (tile.reach) return { reach: tile.reach, digest: tile.digest, colours: tile.colours };
    const list = (slot: string): Input[] => {
      const set = tile.slots.get(slot);
      return set ? [...set].sort(byWalk).map((entry) => entry.input) : [];
    };
    const paint = new Map<string, Entry[]>();
    const collect = (slots: ReadonlyMap<string, ReadonlySet<Entry>>): void => {
      for (const [slot, set] of slots) {
        if (!slot.startsWith(PAINT_PREFIX)) continue;
        const color = slot.slice(PAINT_PREFIX.length);
        const into = paint.get(color);
        if (into) into.push(...set); else paint.set(color, [...set]);
      }
    };
    collect(tile.slots);
    const details = pass.ground && tile.ribbons > 0 ? this.details.get(key) : undefined;
    if (details) collect(details);
    const colours = [...paint.keys()].sort();
    const quads = new Map<string, Input[]>();
    for (const color of colours) quads.set(color, paint.get(color)!.sort(byWalk).map((entry) => entry.input));
    const reach: Reach = {
      levels: { casing: list('casing'), sidewalk: list('sidewalk'), curb: list('curb'), asphalt: list('asphalt') },
      medians: { kerb: list(medianSlot('kerb')), planting: list(medianSlot('planting')), paved: list(medianSlot('paved')) },
      ramps: list('ramps'),
      ribbons: list('ribbons'),
      quads,
    };
    const digest = new Digest();
    const addAll = (inputs: readonly Input[]): void => {
      digest.add(inputs.length);
      for (const input of inputs) digest.add(input.digest);
    };
    for (const slot of LEVEL_SLOTS) addAll(reach.levels[slot]);
    for (const part of MEDIAN_SLOTS) addAll(reach.medians[part]);
    addAll(reach.ramps);
    addAll(reach.ribbons);
    for (const color of colours) {
      digest.addText(color);
      addAll(quads.get(color)!);
    }
    tile.reach = reach;
    tile.digest = digest.value();
    tile.colours = colours;
    return { reach, digest: tile.digest, colours };
  }

  /**
   * The footways' outer edges round one cell of `FOOTWAY_EDGE_CELL` for a pass
   * (`roadSurfaceReads.ts` `fromFootway`): the union of the footways that come
   * within `EDGE_PAD` of the cell, each straight piece of its outline whose box,
   * padded so, covers the cell - four numbers a piece; undefined when none.
   *
   * Only a distance under `CASING_BAND` changes the batter (`vergeTop` clamps
   * it), and the outline within twice that of the cell is the outline of the
   * footways that reach there, whatever lies further. DO NOT merge every
   * footway of the pass for it: the union of a town's footways is one ring round
   * the town, made again on every edit for the cells of the tiles it built.
   */
  footwayEdges(passId: string, cell: number): number[] | undefined {
    const pass = this.passes.get(passId);
    if (!pass) return undefined;
    const cx = Math.floor(cell / 65536) - 32768, cy = (cell % 65536) - 32768;
    const x0 = cx * FOOTWAY_EDGE_CELL, y0 = cy * FOOTWAY_EDGE_CELL;
    const minX = x0 - EDGE_PAD, minY = y0 - EDGE_PAD, maxX = x0 + FOOTWAY_EDGE_CELL + EDGE_PAD, maxY = y0 + FOOTWAY_EDGE_CELL + EDGE_PAD;
    const found = new Set<Entry>();
    for (let ix = Math.floor((minX - TILE_ORIGIN) / TILE); ix <= Math.floor((maxX - TILE_ORIGIN) / TILE); ix++) {
      for (let iy = Math.floor((minY - TILE_ORIGIN) / TILE); iy <= Math.floor((maxY - TILE_ORIGIN) / TILE); iy++) {
        for (const entry of pass.tiles.get(tileKey(ix, iy))?.slots.get('sidewalk') ?? []) {
          const input = entry.input;
          if (input.maxX >= minX && input.minX <= maxX && input.maxY >= minY && input.minY <= maxY) found.add(entry);
        }
      }
    }
    if (found.size === 0) return undefined;
    const outline: MultiPoly = union([...found].sort(byWalk).map((entry) => entry.input.poly));
    const out: number[] = [];
    for (const poly of outline) for (const ring of poly) {
      if (ring.length < 3) continue;
      for (let i = 0; i < ring.length; i++) {
        const ax = ring[i]![0]!, ay = ring[i]![1]!;
        const bx = ring[(i + 1) % ring.length]![0]!, by = ring[(i + 1) % ring.length]![1]!;
        // The rule a piece is filed into a cell by: its box, padded, covers the cell.
        if (Math.floor((Math.min(ax, bx) - EDGE_PAD) / FOOTWAY_EDGE_CELL) > cx || Math.floor((Math.max(ax, bx) + EDGE_PAD) / FOOTWAY_EDGE_CELL) < cx) continue;
        if (Math.floor((Math.min(ay, by) - EDGE_PAD) / FOOTWAY_EDGE_CELL) > cy || Math.floor((Math.max(ay, by) + EDGE_PAD) / FOOTWAY_EDGE_CELL) < cy) continue;
        out.push(ax, ay, bx, by);
      }
    }
    return out.length ? out : undefined;
  }
}

/** How far round a footway's cell its outline is read (`footwayEdges`): twice the batter's reach. */
const EDGE_PAD = CASING_BAND * 2;
/** How far from a building's box a street's parking may read its gates (`parkingLayout.ts` `entrancesNear`). */
const PARKING_REACH = m(8.5);

const alignmentPass = (root: SegmentId): string => `alignment-${root}`;
/** A pass at ground level: the ground's, or an alignment raised by hand (drawn from the ground's structure). */
const isGroundPass = (pass: string): boolean => pass === 'ground' || pass.startsWith('alignment-');

function entryOf(input: Input, slot: string, phase: number, id: number, seq: number, pass: string): Entry {
  const tiles: number[] = [];
  const x0 = Math.floor((input.minX - TILE_REACH - TILE_ORIGIN) / TILE);
  const x1 = Math.floor((input.maxX + TILE_REACH - TILE_ORIGIN) / TILE);
  const y0 = Math.floor((input.minY - TILE_REACH - TILE_ORIGIN) / TILE);
  const y1 = Math.floor((input.maxY + TILE_REACH - TILE_ORIGIN) / TILE);
  for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) tiles.push(tileKey(ix, iy));
  return { input, slot, phase, id, seq, pass, tiles };
}
