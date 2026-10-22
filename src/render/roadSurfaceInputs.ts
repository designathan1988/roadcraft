import type { MultiPoly, Poly } from '@core/clipper';
import type { Polyline } from '@core/polyline';
import type { Vec2 } from '@core/vec2';
import { union } from '@core/clipper';
import { Digest } from '@core/digest';
import { type Input, inputOf, medianOf } from './roadSurfaceRings';
import type { ChangeRect } from '@world/changes';
import { CellFiling } from '@world/cells';
import { junctionBounds } from '@world/ribbons';
import { ViewCells } from '@world/viewCells';
import { JournalCursor } from '@world/derived';
import type { NodeId, SegmentId } from '@world/ids';
import type { Network } from '@world/network';
import { CASING_BAND, Level, type SurfaceLevel } from '@world/roadTypes';
import { levelRingsOf } from '@world/surfaces';
import { rampOutline, rampsOfNode } from '@world/curbRamps';
import { footwayRiseShare } from '@world/roads/footwayRise';
import { ROAD_STRUCTURES, roadStructure } from '@world/structures';
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
import { PAINT_COLOURS, STOP_PAINT, ZEBRA_PAINT, barQuad, roadStrokes, strokeQuads, type QuadSink } from './paintQuads';
import { FOOTWAY_EDGE_CELL } from './roadSurfaceReads';
import {
  type CellHold, DETAILS, type Entry, type InputResidency, LEVEL_OF, LEVEL_SLOTS, MEDIAN_SLOTS, NODE_PAD, type NodeItem, PAINT_PREFIX, PHASE, type PassInputs, type Reach, type SegmentItem, type Superset, type SurfacePass, TILE, TILE_ORIGIN, TILE_REACH, WAKE_PAD, alignmentPass, byWalk, entryBytes, entryOf, growRect, isGroundPass, medianSlot, paintSlot, surfaceInputWork, tileKey, tileRectOf, tilesOver, unite,
} from './roadSurfaceEntries';

export { ROAD_INPUT_RESIDENCY, TILE, TILE_BIAS, TILE_ORIGIN, surfaceInputWork } from './roadSurfaceEntries';
export type { InputResidency, Reach, SurfacePass } from './roadSurfaceEntries';

/** DO NOT gather a pass's inputs by walking the whole map and filtering by the pass */

/** The inputs of every pass, kept between builds and brought up to the network by its change (`refresh`). */
export class SurfaceInputs {
  /** `gates`: the entrances a street's parking keeps clear of (`parkingLayout.ts` gatesNear), for a network without its buildings (a road bake in a worker, `nearRoadTiles.ts`); none: the document's buildings. */
  /** `residency`: the inputs held round the view, cell by cell (`viewCells.ts`), each item derived only when a tile it reaches is visited; none: every item derived for good (a bake in a worker, the tests). */
  constructor(private readonly gates: ((line: Polyline, half: number) => [Vec2, Vec2][]) | null = null, residency: InputResidency | null = null) {
    this.cells = residency ? new ViewCells<CellHold>({
      name: 'road surface inputs',
      version: 1,
      reach: residency.reach,
      cpuBudget: residency.cpuBudget,
      derive: (_key, rect) => this.deriveCell(rect),
      release: (key, hold) => this.releaseCell(key, hold),
    }) : null;
  }

  /** The cells the inputs are held in round the view; null: every item derived for good. */
  readonly cells: ViewCells<CellHold> | null;
  /** The items not derived now, filed by their boxes: what a visited tile derives (`wakeTile`). */
  private dormantSegments = new CellFiling<SegmentId, SegmentItem>(TILE);
  private dormantNodes = new CellFiling<NodeId, NodeItem>(TILE);
  /** The items derived now (held round the view only). */
  private readonly residentSegments = new Set<SegmentId>();
  private readonly residentNodes = new Set<NodeId>();
  /** What the derived items' inputs hold, bytes (an estimate, `entryBytes`). */
  residentBytes = 0;
  /** Set while every item is let go at once (`rebuildAll`): the cells let go with them make nothing dormant. */
  private resetting = false;

  private net: Network | null = null;
  /** The network's state the inputs stand for (`Network.state`). */
  private token: object | null = null;
  private style: string | null = null;
  /** The buildings' entries read (a street's parking keeps clear of their gates, `parkingLayout.ts`). */
  private readonly buildings = new JournalCursor(['buildings']);
  private readonly segments = new Map<SegmentId, SegmentItem>();
  private readonly nodes = new Map<NodeId, NodeItem>();
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
  /** Passes made so far: each pass's birth number. */
  private births = 0;

  /** @rebuild Brings the inputs up to `net`: the items its change since the last refresh names, and the roads round them, made again */
  refresh(net: Network): void {
    const doc = net.doc;
    const same = this.net === net && this.token !== null;
    const delta = same ? net.changesSince(this.token) : null;
    const styleChanged = this.style !== doc.markingStyle;
    const buildings = this.buildings.read(doc.changes);
    this.net = net;
    this.token = net.state;
    this.style = doc.markingStyle;
    // A change of the paint's standard repaints every road and junction
    if (delta === null || styleChanged || buildings === null || buildings.some((entry) => entry.rects === null)) {
      this.rebuildAll(net);
      return;
    }

    const segs = new Set<SegmentId>(delta.segments);
    // A crossing is fitted to the footway along its road, a flush footway lowers the kerbs on it
    if (delta.rects.length) for (const id of net.segmentCells.idsMeetingAny(delta.rects)) segs.add(id);
    const nodes = new Set<NodeId>(delta.nodes);
    const ends = (id: SegmentId): void => {
      const segment = doc.segment(id);
      if (segment) { nodes.add(segment.a); nodes.add(segment.b); }
      const item = this.segments.get(id);
      if (item) { nodes.add(item.ends[0]); nodes.add(item.ends[1]); }
    };
    for (const id of segs) ends(id);
    // A road's lines stop at its nodes' stop lines and crossings, and its mouths overlap their plates
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

  /** @rebuild Every item made again: the network could not say what changed (a load, the first build). Held round the view, every item is only filed by its box, its inputs derived when a tile it reaches is visited (`wakeTile`): DO NOT derive the whole map's rings before the city appears. */
  private rebuildAll(net: Network): void {
    this.resetting = true;
    this.cells?.clear();
    this.resetting = false;
    this.dormantSegments = new CellFiling<SegmentId, SegmentItem>(TILE);
    this.dormantNodes = new CellFiling<NodeId, NodeItem>(TILE);
    this.residentSegments.clear();
    this.residentNodes.clear();
    this.residentBytes = 0;
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
    const nodes = [...net.doc.nodes.keys()].sort((p, q) => p - q);
    if (this.cells) {
      for (const id of ids) this.fileSegment(net, id);
      for (const node of nodes) this.fileNode(net, node);
      return;
    }
    for (const id of ids) this.placeSegment(net, id);
    for (const node of nodes) this.placeNode(net, node);
  }

  /** A road filed as not derived (held round the view): its pass counted, its box's tiles filed (`Superset`). */
  private fileSegment(net: Network, id: SegmentId): void {
    const segment = net.doc.segment(id);
    if (!segment) return;
    const pass = this.passOf(net, id)!;
    this.count.set(pass, (this.count.get(pass) ?? 0) + 1);
    const fresh: SegmentItem = { pass, ends: [segment.a, segment.b], entries: [], box: this.segmentBox(net, id), superset: null, bytes: 0 };
    const item = this.dormant(fresh, [pass]);
    this.segments.set(id, item);
    if (item.box) this.dormantSegments.file(id, item, item.box);
  }

  /** A node filed as not derived: the passes of its roads, its box's tiles. */
  private fileNode(net: Network, node: NodeId): void {
    const box = this.nodeBox(net, node);
    if (!box) return;
    const item = this.dormant({ entries: [], box, superset: null, bytes: 0 }, this.nodePasses(net, node));
    this.nodes.set(node, item);
    this.dormantNodes.file(node, item, box);
  }

  /** The box a road's inputs lie in: its ribbon's (`ribbonBounds`, every level), or null when it has none. */
  private segmentBox(net: Network, id: SegmentId): ChangeRect | null {
    const box = net.segmentCells.rectOf(id);
    return box ? growRect(box, TILE_REACH) : null;
  }

  /** The box a node's inputs may lie in: its roads' boxes and its plates', grown by `NODE_PAD`; null for a node with neither. */
  private nodeBox(net: Network, node: NodeId): ChangeRect | null {
    let box: ChangeRect | null = null;
    for (const id of net.doc.node(node)?.incident ?? []) box = unite(box, net.segmentCells.rectOf(id) ?? null);
    const byLevel = net.junctions.get(node);
    if (byLevel) box = unite(box, junctionBounds(byLevel));
    return box ? growRect(box, NODE_PAD) : null;
  }

  /** The passes a node's inputs may be drawn in: its roads'. */
  private nodePasses(net: Network, node: NodeId): string[] {
    const out = new Set<string>();
    for (const id of net.doc.node(node)?.incident ?? []) { const pass = this.passOf(net, id); if (pass !== null) out.add(pass); }
    return [...out];
  }

  /** An item made not derived: its superset's tiles counted in its passes (`PassInputs.dormant`) before its entries go, so no pass is left empty on the way. */
  private dormant<T extends { readonly entries: readonly Entry[] | null; readonly box: ChangeRect | null; readonly superset: Superset | null; readonly bytes: number }>(item: T, passes: readonly string[]): T {
    const superset: Superset | null = item.box && passes.length ? { passes, tiles: tilesOver(item.box) } : null;
    if (superset) {
      for (const id of superset.passes) {
        const pass = this.passFor(id);
        for (const key of superset.tiles) pass.dormant.set(key, (pass.dormant.get(key) ?? 0) + 1);
      }
    }
    if (item.entries) { this.unfile(item.entries, true); this.residentBytes -= item.bytes; }
    return { ...item, entries: null, superset, bytes: 0 };
  }

  /** A dormant item's superset taken out of its passes (it is derived now, or gone); `dirty`: its tiles visited by the next build (what it drew there may have changed). */
  private undormant(superset: Superset | null, dirty: boolean): void {
    if (!superset) return;
    for (const id of superset.passes) {
      const pass = this.passes.get(id);
      if (!pass) continue;
      for (const key of superset.tiles) {
        const n = (pass.dormant.get(key) ?? 0) - 1;
        if (n > 0) pass.dormant.set(key, n); else pass.dormant.delete(key);
        if (dirty) pass.dirty.add(key);
      }
      if (pass.tiles.size === 0 && pass.dormant.size === 0) this.passes.delete(pass.id);
    }
  }

  /** A pass's inputs, made if it has none yet. */
  private passFor(id: string): PassInputs {
    let pass = this.passes.get(id);
    if (!pass) this.passes.set(id, pass = { id, ground: isGroundPass(id), tiles: new Map(), dormant: new Map(), born: this.births++, dirty: new Set() });
    return pass;
  }

  /** The items that may put inputs in tile `key` derived, with the cells round it (`WAKE_PAD`): what a build visiting the tile reads is whole. Nothing when every item is derived for good. */
  wakeTile(key: number): void {
    if (this.cells) this.wakeRect(growRect(tileRectOf(key), WAKE_PAD));
  }

  /** The cells a rectangle reaches derived (`deriveCell`), none of them let go for another. */
  private wakeRect(rect: ChangeRect): void {
    const cells = this.cells;
    if (!cells || !this.net) return;
    const keys: number[] = [];
    cells.forCellsOver(rect, (cell) => { keys.push(cell); });
    cells.ensureMany(keys);
  }

  /** A cell of the residency derived: every road and node whose box meets it derived (silently: the same inputs they had), and found. */
  private deriveCell(rect: ChangeRect): { value: CellHold; cpuBytes: number } {
    const net = this.net!;
    const segments = new Set<SegmentId>([...net.segmentCells.idsMeeting(rect), ...this.dormantSegments.idsMeeting(rect)]);
    const nodes = new Set<NodeId>(this.dormantNodes.idsMeeting(rect));
    let bytes = 0;
    for (const id of [...segments].sort((p, q) => p - q)) {
      const item = this.segments.get(id);
      if (!item) { segments.delete(id); continue; }
      if (!item.entries) this.placeSegment(net, id, true);
      bytes += this.segments.get(id)?.bytes ?? 0;
      for (const end of item.ends) nodes.add(end);
    }
    for (const node of [...nodes].sort((p, q) => p - q)) {
      const item = this.nodes.get(node);
      if (!item) { nodes.delete(node); continue; }
      if (!item.entries) this.placeNode(net, node, true);
      bytes += this.nodes.get(node)?.bytes ?? 0;
    }
    return { value: { segments: [...segments], nodes: [...nodes] }, cpuBytes: bytes };
  }

  /** Whether a box meets a cell held now (other than `except`). */
  private held(box: ChangeRect | null, except: number): boolean {
    const cells = this.cells;
    if (!cells || !box) return false;
    let found = false;
    cells.forCellsOver(box, (key) => { if (!found && key !== except && cells.has(key)) found = true; });
    return found;
  }

  /** A cell let go: the items it found that no other held cell meets made not derived again. */
  private releaseCell(key: number, hold: CellHold): void {
    if (this.resetting) return;
    for (const id of hold.segments) this.letGoSegment(id, key);
    for (const node of hold.nodes) this.letGoNode(node, key);
  }

  private letGoSegment(id: SegmentId, except: number): void {
    const item = this.segments.get(id);
    if (!item?.entries || this.held(item.box, except)) return;
    const dormant = this.dormant(item, item.pass !== null ? [item.pass] : []);
    this.segments.set(id, dormant);
    this.residentSegments.delete(id);
    if (dormant.box) this.dormantSegments.file(id, dormant, dormant.box);
  }

  private letGoNode(node: NodeId, except: number): void {
    const item = this.nodes.get(node);
    if (!item?.entries || this.held(item.box, except) || !this.net) return;
    const dormant = this.dormant(item, this.nodePasses(this.net, node));
    this.nodes.set(node, dormant);
    this.residentNodes.delete(node);
    if (dormant.box) this.dormantNodes.file(node, dormant, dormant.box);
  }

  /** The inputs brought back to the view after a build (`roadSurfaces.ts`): the cells round the eye wanted (`most` of them derived ahead), every item derived that no held cell meets let go, the cells kept to their budget. */
  keepNear(eye: { readonly x: number; readonly y: number } | null, most = 4): void {
    const cells = this.cells;
    if (!cells || !this.net || !eye) return;
    cells.look(eye);
    cells.pump(most);
    // At rest a quarter of the budget, past the cells the view wants: the rest is a build's room to sweep the map (`ROAD_INPUT_RESIDENCY`).
    cells.trim(null, cells.spec.cpuBudget / 4);
    for (const id of [...this.residentSegments]) this.letGoSegment(id, Number.NaN);
    for (const node of [...this.residentNodes]) this.letGoNode(node, Number.NaN);
  }

  /** Whether a road has an end raised by hand: it is drawn from its own deck, in an alignment. */
  private static raisedByHand(net: Network, id: SegmentId): boolean {
    const segment = net.doc.segment(id);
    return !!segment && (Math.abs(net.doc.node(segment.a)?.heightOffset ?? 0) > 1e-6 ||
      Math.abs(net.doc.node(segment.b)?.heightOffset ?? 0) > 1e-6);
  }

  /** The alignments of `ids` made again */
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

  /** A road's inputs made again and filed. `silent`: derived again as it was (held round the view, `wakeTile`): no tile made dirty. */
  private placeSegment(net: Network, id: SegmentId, silent = false): void {
    surfaceInputWork.segments++;
    const old = this.segments.get(id);
    if (old) {
      if (old.entries) { this.unfile(old.entries, silent); this.residentBytes -= old.bytes; }
      else this.dormantSegments.remove(id);
      if (old.pass !== null) this.count.set(old.pass, (this.count.get(old.pass) ?? 1) - 1);
      this.segments.delete(id);
      this.residentSegments.delete(id);
    }
    const segment = net.doc.segment(id);
    if (!segment) { if (old && !old.entries) this.undormant(old.superset, !silent); return; }
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
      // Paint belongs to the road legs, not to the shared intersection interior
      const ring = ribbon.rings[Level.Asphalt];
      if (ring && !ring.isEmpty) add('ribbons', PHASE.road, [ring.flatten().map((point) => [point.x, point.y])]);
      const paint = (phase: number): QuadSink => (color, quad) => { this.colour(color); add(paintSlot(color), phase, [quad]); };
      const lines = paint(PHASE.lines);
      for (const spec of roadStrokes(net, ribbon)) strokeQuads(lines, spec);
      // Parking bays and the no-parking lines beside them (`world/parkingLayout.ts`).
      const parking = paint(PHASE.parking);
      const gates = this.gates && parksAlong(net, ribbon) ? this.gates(ribbon.full, ribbon.road.width / 2) : null;
      for (const line of parkingLinesOf(net, ribbon, gates)) {
        strokeQuads(parking, { points: line.points, width: line.width, color: line.color, dash: line.dash, dashOffset: 0 });
      }
    }
    const bytes = entryBytes(entries);
    this.segments.set(id, { pass, ends: [segment.a, segment.b], entries, box: this.cells ? this.segmentBox(net, id) : null, superset: null, bytes });
    this.file(entries, silent);
    this.residentBytes += bytes;
    if (this.cells) this.residentSegments.add(id);
    // Its superset out once its entries are in (no pass left empty on the way); made by an edit, the tiles it reached before visited again.
    if (old && !old.entries) this.undormant(old.superset, !silent);
  }

  /** A node's inputs made again and filed: its plates, taper, island, dropped kerbs and junction paint. */
  private placeNode(net: Network, node: NodeId, silent = false): void {
    surfaceInputWork.nodes++;
    const old = this.nodes.get(node);
    if (old) {
      if (old.entries) { this.unfile(old.entries, silent); this.residentBytes -= old.bytes; }
      else this.dormantNodes.remove(node);
      this.nodes.delete(node);
      this.residentNodes.delete(node);
    }
    const record = net.doc.node(node);
    if (!record) { if (old && !old.entries) this.undormant(old.superset, !silent); return; }
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
    // ...and to the tapers where a road carries on at another width, whose lane lines and edge lines run on through them
    if (net.transitions.has(node)) {
      const leg = plate?.legs[0];
      const pass = leg ? this.passOf(net, leg.seg) : null;
      if (plate && pass !== null) {
        add('ribbons', PHASE.taper, inputOf([plate.ring.flatten().map((point) => [point.x, point.y])]), pass);
        const sink: QuadSink = (color, quad) => { this.colour(color); add(paintSlot(color), PHASE.taperPaint, inputOf([quad]), pass); };
        for (const spec of transitionMarkings(net, node)) strokeQuads(sink, spec);
      }
    }
    //...and to a mini-roundabout's plate, where its island is painted
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
    const bytes = entryBytes(entries);
    if (entries.length || this.cells) this.nodes.set(node, { entries, box: this.cells ? this.nodeBox(net, node) : null, superset: null, bytes });
    this.file(entries, silent);
    this.residentBytes += bytes;
    if (this.cells) this.residentNodes.add(node);
    if (old && !old.entries) this.undormant(old.superset, !silent);
  }

  /** The pass a junction's plates are drawn in: that of its lowest road that is not a tunnel */
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

  /** `silent`: entries derived again as they were (`wakeTile`), or let go while what they drew still stands (`dormant`): what the tiles read is put together again, no tile made dirty. */
  private file(entries: readonly Entry[], silent = false): void {
    for (const entry of entries) {
      if (entry.pass === DETAILS) {
        for (const key of entry.tiles) {
          let slots = this.details.get(key);
          if (!slots) this.details.set(key, slots = new Map());
          let set = slots.get(entry.slot);
          if (!set) slots.set(entry.slot, set = new Set());
          set.add(entry);
          this.touchDetails(key, silent);
        }
        continue;
      }
      const pass = this.passFor(entry.pass);
      for (const key of entry.tiles) {
        let tile = pass.tiles.get(key);
        if (!tile) pass.tiles.set(key, tile = { key, slots: new Map(), own: 0, ribbons: 0, reach: null, digest: 0, colours: [] });
        let set = tile.slots.get(entry.slot);
        if (!set) tile.slots.set(entry.slot, set = new Set());
        set.add(entry);
        tile.own++;
        if (entry.slot === 'ribbons') tile.ribbons++;
        tile.reach = null;
        if (!silent) pass.dirty.add(key);
      }
    }
  }

  private unfile(entries: readonly Entry[], silent = false): void {
    for (const entry of entries) {
      if (entry.pass === DETAILS) {
        for (const key of entry.tiles) {
          const slots = this.details.get(key);
          const set = slots?.get(entry.slot);
          if (!slots || !set) continue;
          set.delete(entry);
          if (set.size === 0) slots.delete(entry.slot);
          if (slots.size === 0) this.details.delete(key);
          this.touchDetails(key, silent);
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
        if (!silent) pass.dirty.add(key);
        if (tile.own === 0) pass.tiles.delete(key);
      }
      if (pass.tiles.size === 0 && pass.dormant.size === 0) this.passes.delete(pass.id);
    }
  }

  /** The junctions' paint in a tile changed: every pass at ground level reads that tile again. */
  private touchDetails(key: number, silent = false): void {
    for (const pass of this.passes.values()) {
      if (!pass.ground) continue;
      const tile = pass.tiles.get(key);
      if (tile) { tile.reach = null; if (!silent) pass.dirty.add(key); }
    }
  }

  /** A pass's birth and the tiles whose inputs changed since the build last settled them; null when the pass is not there. */
  dirtyOf(pass: string): { readonly born: number; readonly keys: ReadonlySet<number> } | null {
    const p = this.passes.get(pass);
    return p ? { born: p.born, keys: p.dirty } : null;
  }

  /** The build that took these tiles of a pass finished: they are no longer dirty (a pass made again since keeps its own). */
  settle(pass: string, born: number, keys: Iterable<number>): void {
    const p = this.passes.get(pass);
    if (!p || p.born !== born) return;
    for (const key of keys) p.dirty.delete(key);
  }

  /** A tile a build visits: the items reaching it derived (`wakeTile`), then whether the pass has it. */
  visits(pass: string, key: number): boolean {
    this.wakeTile(key);
    return this.hasTile(pass, key);
  }

  /** Whether a pass has a tile at `key`: inputs filed there, or an item not derived now that may put some (`wakeTile` derives them). */
  hasTile(pass: string, key: number): boolean {
    const p = this.passes.get(pass);
    return !!p && (p.tiles.has(key) || p.dormant.has(key));
  }

  /** The passes of the surfaces: every structural level, then each alignment raised by hand, by its lowest road. */
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

  /** Every colour a pass may paint in: the catalogue's, then any other met */
  paintColours(): string[] {
    return [...PAINT_COLOURS, ...[...this.met].filter((color) => !PAINT_COLOURS.includes(color)).sort()];
  }

  /** The colours the roads and junctions have been painted in. */
  paintedColours(): string[] {
    return [...this.met];
  }

  /** The keys of a pass's tiles, in order. */
  tileKeys(pass: string): number[] {
    const p = this.passes.get(pass);
    if (!p) return [];
    const keys = new Set(p.tiles.keys());
    for (const key of p.dormant.keys()) keys.add(key);
    return [...keys].sort((a, b) => a - b);
  }

  /** What a tile of a pass reads, put together when something in it changed */
  reachOf(passId: string, key: number): { readonly reach: Reach; readonly digest: number; readonly colours: readonly string[] } {
    // Held round the view: the items reaching it derived first (a build visiting it has, `wakeTile`).
    this.wakeTile(key);
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

  /** DO NOT merge every footway of the pass for it */
  footwayEdges(passId: string, cell: number): number[] | undefined {
    if (!this.passes.has(passId)) return undefined;
    const cx = Math.floor(cell / 65536) - 32768, cy = (cell % 65536) - 32768;
    const x0 = cx * FOOTWAY_EDGE_CELL, y0 = cy * FOOTWAY_EDGE_CELL;
    const minX = x0 - EDGE_PAD, minY = y0 - EDGE_PAD, maxX = x0 + FOOTWAY_EDGE_CELL + EDGE_PAD, maxY = y0 + FOOTWAY_EDGE_CELL + EDGE_PAD;
    // Held round the view: the footways round the cell derived first.
    this.wakeRect([minX - TILE_REACH, minY - TILE_REACH, maxX + TILE_REACH, maxY + TILE_REACH]);
    const pass = this.passes.get(passId);
    if (!pass) return undefined;
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
