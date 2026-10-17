import type { Vec2 } from '@core/vec2';
import type { ChangeRect } from '@world/changes';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import {
  addPolygonLot, applyLots, curveLotSide, cutLines, deleteLot, insideLot, joinLots, lotCentre, lotFrame, lotRect, lotSnapper,
  moveLotCorner, onLand, setLotFront, splitLot, zoneLots, type Lot, type LotPlan,
} from '@world/lots';
import { LotStore, lotBox } from '@world/lotStore';
import { CellFiling } from '@world/cells';
import { solidFootprints } from '@world/buildings/geometry';
import type { BuildingId } from '@world/buildings/types';
import { JournalCursor } from '@world/derived';
import { m } from '@world/units';
import { nearestRibbon } from '@world/nearestRibbon';
import type { ZoneDensity, ZoneUse } from '@world/zones';

/** How far apart a zone stroke is sampled between two pointer reports: under any lot's front. */
/** How far from a road edit a refused lot is tried again: its frontage and setbacks read the roads that near, u. */
const REFUSED_REACH = m(40);
const STROKE_STEP = m(2);

/** THE ZONING TOOL: the lots the player draws, edits and zones (`world/lots.ts`), and the gestures doing it */

/** Brush paints the cells under the pointer; the other modes edit the lots. */
export type ZoneMode = 'brush' | 'fill' | 'edit' | 'front' | 'split' | 'join' | 'add' | 'polygon' | 'curve' | 'delete';
/** How the split tool cuts (`LotCut`): across the front, parallel to it, or along a drawn line. */
export type LotSplitKind = 'vertical' | 'horizontal' | 'line';

/** What the tool reads of the game and does to it. */
export interface LotToolHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  zoom(): number;
  readonly settings: () => {
    readonly mode: ZoneMode; readonly use: ZoneUse; readonly density: ZoneDensity; readonly eraser: boolean;
    readonly splitKind: LotSplitKind; readonly splitParts: number;
  };
  /** An edit of the document, one undo step. */
  mutate(fn: () => boolean): void;
  hint(key: string): void;
  redraw(): void;
  /** The proposed lots for the land as it is now, planned off the page (the simulation's worker, `SimClient.lotPlan`); null: not now, asked again. */
  plan(): Promise<LotPlan | null>;
}

/** What the scene draws of the lots, a group at a time (the shape of `render/lotOverlay.ts` `LotOverlayShapes`), and the labels. */
export interface LotOverlay {
  /** `built`: a lot with a building, whose yard's paving is coloured too. */
  readonly polygons: { corners: readonly Vec2[]; fill: number | null; fillAlpha: number; line: number; lineAlpha: number; width: number; built?: boolean }[];
  readonly lines: { a: Vec2; b: Vec2; colour: number; dashed: boolean; width: number }[];
  readonly points: { p: Vec2; colour: number; radius: number }[];
  /** Labels for the 2D layer: a lot's size, a side's length. */
  readonly labels: { at: Vec2; kind: 'size'; width: number; depth: number }[] | { at: Vec2; kind: 'length'; length: number }[];
}

const ZONE_COLOURS: Readonly<Record<ZoneUse, number>> = { residential: 0x56bb73, commercial: 0x5da9e9, industrial: 0xd9b254 };
/** Side of the grid the proposed lots are filed in for the pointer (`proposedAt`): a few lots wide, as the planner files them. */
const PROPOSAL_CELL = m(64);
/** Drawing ranks of the overlay's groups (`render/lotOverlay.ts`, under 2^29): the lots by their order, then the proposal, then the gesture. */
const PROPOSAL_RANK = 2 ** 28;
const GESTURE_RANK = PROPOSAL_RANK + 1;
/** No proposal drawn (out of the tool, or not worked out for the land as it is). */
const NO_PROPOSAL: readonly (readonly Vec2[])[] = [];
/** How near a dragged corner the corners it moves are (`drawLot`). */
const DRAG_REACH = m(0.8);

/** What a lot's group is drawn with besides the lot itself (`LotTool.drawLot`): -1 for no lot. */
interface LotDecor {
  readonly editing: boolean;
  readonly mode: ZoneMode;
  readonly use: ZoneUse;
  readonly eraser: boolean;
  /** The lot under the pointer. */
  readonly hover: number;
  /** The first lot of a join. */
  readonly joinFirst: number;
}

/** One group of the overlay: its shapes and its rank in the drawing order (`render/lotOverlay.ts` `LotOverlayGroup`). */
interface LotOverlayGroup extends Omit<LotOverlay, 'labels'> {
  readonly rank: number;
}

/** DO NOT hand the scene every lot again for a pointer move: the overlay by group, each put again only when it changed */
class LotOverlayBook {
  /** Each lot's (`l` + id), each proposed lot's (`p` + a number) and the gesture's (`g`). */
  readonly groups = new Map<string, LotOverlayGroup>();
  /** The labels for the 2D layer: a lot's size, a side's length. */
  labels: LotOverlay['labels'] = [];
  /** The one reader the changes are kept for; another one is told everything. */
  private reader: object | null = null;
  private readonly changed = new Set<string>();

  /** A group put (null: taken away). */
  put(name: string, group: LotOverlayGroup | null): void {
    if (group) this.groups.set(name, group);
    else if (!this.groups.delete(name)) return;
    this.changed.add(name);
  }

  /** The groups put or taken away since `reader` last asked; null: all of them (another reader than the last). */
  changedFor(reader: object): Iterable<string> | null {
    if (reader !== this.reader) {
      this.reader = reader;
      this.changed.clear();
      return null;
    }
    const out = [...this.changed];
    this.changed.clear();
    return out;
  }
}

export class LotTool {
  /** The pointer over the map while the tool is in hand. */
  hover: Vec2 | null = null;
  /** Lots on which nothing would grow, skipped by the growth until the land or the roads change. */
  readonly refused = new Set<number>();
  /** The network's state the refused lots were last brought up to (`refusedNow`). */
  private refusedNet: object | null = null;

  /** The corners of a lot being drawn point by point (the polygon mode). */
  private polygon: Vec2[] = [];
  /** A drawn cut line, and a side being curved. */
  private cutLine: { pointer: number; a: Vec2; b: Vec2 } | null = null;
  private curve: { pointer: number; a: Vec2; b: Vec2; through: Vec2 } | null = null;
  /** A stroke of the brush, a corner being dragged, a lot being drawn, the first lot of a join. */
  /** A zone stroke: the lots it passed, the proposed lots it passed */
  private stroke: { pointer: number; remove: boolean; ids: Set<number>; fresh: Set<number>; pending: Vec2[]; last: Vec2 } | null = null;
  /** A stroke let go before the proposal it waits on was worked out: made in the frame the proposal is done */
  private waiting: { stroke: NonNullable<LotTool['stroke']>; use: ZoneUse; density: ZoneDensity } | null = null;
  /** The land along the streets cut into lots while the Zoning tool is in hand, as Cities */
  private proposal: { key: number; lots: readonly Vec2[][]; keys: readonly string[]; keyRects: readonly ChangeRect[] } | null = null;
  /** The proposed lots by place (`proposedAt`), filed for the list they were filed from. */
  private proposalFiling: { lots: readonly Vec2[][]; cells: CellFiling<number, readonly Vec2[]> } | null = null;
  private corner: { pointer: number; from: Vec2; to: Vec2 } | null = null;
  private drawn: { pointer: number; a: Vec2; b: Vec2; angle: number } | null = null;
  private joinFirst: number | null = null;
  /** A stroke of the delete mode: the lots and buildings it has passed over, removed on release as one undo step. */
  private erase: { pointer: number; last: Vec2; lots: Set<number>; buildings: Set<BuildingId> } | null = null;

  constructor(private readonly host: LotToolHost) {}

  /** The zoned lots, kept by the lots the diary names (`anyZoned`). */
  private readonly zonedIds = new Set<number>();
  private readonly zonedCursor = LotStore.cursor();

  /** Whether any lot is zoned: the faint zones are shown with the other tools. DO NOT walk every lot when one changes. */
  anyZoned(): boolean {
    const store = this.doc.lotStore;
    const changed = store.changedFor(this.zonedCursor);
    if (changed === null) {
      this.zonedIds.clear();
      for (const lot of store.all()) if (lot.use) this.zonedIds.add(lot.id);
    } else {
      for (const id of changed) { if (store.get(id)?.use) this.zonedIds.add(id); else this.zonedIds.delete(id); }
    }
    return this.zonedIds.size > 0;
  }

  /** Whether the quiet overlay is held as it is while lots keep changing (`holdOverlay`). */
  private held = false;
  /** Holds the quiet overlay as it is (a city growing, a lot a slice); released, the next frame lays it again. */
  holdOverlay(on: boolean): void {
    this.held = on;
  }

  private get doc(): RoadDoc { return this.host.doc; }
  private get net(): Network { return this.host.net; }

  /** DO NOT let every refused lot of the town go for an edit */
  refusedNow(): Set<number> {
    const net = this.net;
    if (this.refusedNet === net.state) return this.refused;
    const delta = this.refusedNet === null ? null : net.changesSince(this.refusedNet);
    this.refusedNet = net.state;
    if (delta === null) { this.refused.clear(); return this.refused; }
    for (const r of delta.rects) {
      for (const lot of this.doc.lotsIn([r[0] - REFUSED_REACH, r[1] - REFUSED_REACH, r[2] + REFUSED_REACH, r[3] + REFUSED_REACH])) this.refused.delete(lot.id);
    }
    return this.refused;
  }

  /** What the player is in the middle of doing with it, named (`main.ts` `currentGesture`). */
  gesture(): string | null {
    if (this.erase) return 'gesture.zone.erasing';
    if (this.stroke) return this.stroke.remove ? 'gesture.zone.unzoning' : 'gesture.zone.zoning';
    if (this.corner) return 'gesture.lot.corner';
    if (this.drawn) return 'gesture.lot.drawing';
    if (this.cutLine) return 'gesture.lot.cutting';
    if (this.curve) return 'gesture.lot.curving';
    if (this.polygon.length > 0) return 'gesture.lot.polygon';
    if (this.joinFirst !== null) return 'gesture.lot.joining';
    return null;
  }

  /** Every gesture dropped without committing it. */
  cancel(): void {
    // A stroke already let go is the player's: made now, not dropped.
    if (this.waiting) void this.advanceProposal();
    this.polygon = [];
    this.drawn = null;
    this.corner = null;
    this.curve = null;
    this.cutLine = null;
    this.stroke = null;
    this.joinFirst = null;
    this.erase = null;
  }

  /** Another mode picked: a polygon half drawn or a join half chosen is dropped. */
  modeChanged(): void {
    this.joinFirst = null;
    this.polygon = [];
  }

  // ------------------------------------------------------------ the proposed lots

  /** The network's state and the diary's lot entries the proposal key last saw (`proposalKey`). */
  private proposalNet: object | null = null;
  private readonly proposalCursor = new JournalCursor(['lots', 'lotKeys']);
  private proposalStamp = 0;
  /** What the proposal was worked out from, as what its planner reads (`LotPlanner.update`): moves when the roads or the lots changed. */
  private proposalKey(): number {
    const changed = this.proposalCursor.read(this.doc.changes);
    if (this.net.state !== this.proposalNet || changed === null || changed.length > 0) {
      this.proposalNet = this.net.state;
      this.proposalStamp++;
    }
    return this.proposalStamp;
  }

  /** The plan asked for and its key, until it is answered. */
  private asking: { readonly key: number; readonly done: Promise<void> } | null = null;

  /** The proposal brought up to the land as it is: when what it stands on changed, the plan asked of the host (planned in the simulation's worker, incrementally: DO NOT plan it on the page, the first plan of a region floods its land for long) and the last plan shown until it comes; the stroke waiting on it made once a plan for the land as it is now is in. Resolves when the plan asked for is in. */
  advanceProposal(): Promise<void> {
    const key = this.proposalKey();
    if (this.proposal?.key === key) { this.takeWaiting(); return Promise.resolve(); }
    if (this.asking?.key === key) return this.asking.done;
    const done = this.host.plan().then((plan) => {
      if (this.asking?.key === key) this.asking = null;
      // Not now (the worker reading a tile): asked again at the next frame.
      if (plan) this.proposal = { key, lots: plan.add.map((c) => c.corners), keys: plan.keys, keyRects: plan.keyRects ?? [] };
      this.host.redraw();
      if (plan && key === this.proposalKey()) this.takeWaiting();
    }, (error: unknown) => {
      if (this.asking?.key === key) this.asking = null;
      console.warn('[lots] the proposed lots could not be planned', error);
    });
    this.asking = { key, done };
    return done;
  }

  /** The stroke let go before the proposal was in, made now with it. */
  private takeWaiting(): void {
    if (!this.waiting) return;
    const { stroke, use, density } = this.waiting;
    this.waiting = null;
    this.readPending(stroke);
    this.commitStroke(stroke, use, density);
  }

  /** The proposed lot under a point (its index), or -1; only once worked out for the land as it is now. */
  private proposedAt(p: Vec2): number {
    const prop = this.proposal;
    if (!prop || prop.key !== this.proposalKey()) return -1;
    // DO NOT walk the proposal: this runs for each of up to 400 steps of a pointer move. Filed once for each plan.
    let filing = this.proposalFiling;
    if (!filing || filing.lots !== prop.lots) {
      const cells = new CellFiling<number, readonly Vec2[]>(PROPOSAL_CELL);
      prop.lots.forEach((corners, k) => cells.file(k, corners, lotBox({ corners })));
      filing = { lots: prop.lots, cells };
      this.proposalFiling = filing;
    }
    // In increasing order: the first in the proposal's order, as a search of the list would find.
    for (const k of filing.cells.idsMeeting([p.x, p.y, p.x, p.y])) if (insideLot(p, { corners: prop.lots[k]! })) return k;
    return -1;
  }

  /** A stroke's points that waited on the proposal, read once it is ready. */
  private readPending(stroke: NonNullable<LotTool['stroke']>): void {
    if (!stroke.pending.length || this.proposalReady() < 0) return;
    for (const p of stroke.pending) { const k = this.proposedAt(p); if (k >= 0) stroke.fresh.add(k); }
    stroke.pending.length = 0;
  }

  /** A stroke made: the proposed lots it passed laid, and zoned with the stored ones, in one undo step. */
  private commitStroke(stroke: NonNullable<LotTool['stroke']>, use: ZoneUse, density: ZoneDensity): void {
    const { doc, host } = this;
    if (!stroke.ids.size && !stroke.fresh.size) { host.hint('hint.zone.empty'); return; }
    const fresh = [...stroke.fresh].map((k) => this.proposal?.lots[k]).filter((c): c is Vec2[] => !!c);
    const before = this.proposal && this.proposal.key === this.proposalKey() ? this.proposal : null;
    host.mutate(() => {
      const first = doc.nextLotId;
      if (fresh.length) applyLots(doc, { add: fresh.map((corners) => ({ key: '', corners })), keys: [], drop: [] });
      for (let id = first; id < doc.nextLotId; id++) stroke.ids.add(id);
      return zoneLots(doc, [...stroke.ids], stroke.remove ? null : { use, density }) || fresh.length > 0;
    });
    // The proposal holds on: the lots laid were its own, and the rest of it is as it was
    if (before && fresh.length) {
      const laid = new Set(stroke.fresh);
      this.proposal = { key: this.proposalKey(), lots: before.lots.filter((_, k) => !laid.has(k)), keys: before.keys, keyRects: before.keyRects };
    }
    this.refused.clear();
    host.hint(stroke.remove ? 'hint.zone.removed' : 'hint.zone.painted');
    host.redraw();
  }

  /** The zone brush over the street land at `at`: the proposed lot under it, or the point kept until the proposal is ready */
  private brushProposed(at: Vec2): void {
    const stroke = this.stroke;
    if (!stroke) return;
    const ready = this.proposalReady() >= 0;
    this.readPending(stroke);
    if (ready) { const k = this.proposedAt(at); if (k >= 0) stroke.fresh.add(k); return; }
    // A point a metre from the last one kept is enough: a lot is metres wide.
    const last = stroke.pending[stroke.pending.length - 1];
    if (!last || Math.hypot(at.x - last.x, at.y - last.y) > m(1)) stroke.pending.push({ x: at.x, y: at.y });
  }

  /** Whether the proposal for the land as it is now is ready (probes). */
  proposalReady(): number {
    const prop = this.proposal;
    return prop && prop.key === this.proposalKey() ? prop.lots.length : -1;
  }

  // ------------------------------------------------------------ geometry

  /** The snap of lot points to the footways, the blocks' corners and the other lots' corners. */
  private snapReach(): number { return Math.max(m(2.5), 16 / Math.max(0.05, this.host.zoom())); }
  private snap(p: Vec2): Vec2 { return lotSnapper(this.doc, this.net)(p, this.snapReach()).p; }
  /** DO NOT walk `doc.lots`: this runs for each of up to 400 steps of a pointer move. */
  private lotAt(p: Vec2): Lot | undefined { return this.doc.lotAt(p); }
  /** The lots whose box comes within `reach` of a point (a superset: test each). */
  private lotsNear(p: Vec2, reach: number): Lot[] { return this.doc.lotsIn([p.x - reach, p.y - reach, p.x + reach, p.y + reach]); }

  /** The side of a lot nearest a point: its two corners. */
  private sideNear(p: Vec2): { a: Vec2; b: Vec2 } | null {
    let best: { a: Vec2; b: Vec2 } | null = null, bestD = 18 / Math.max(0.05, this.host.zoom());
    for (const l of this.lotsNear(p, bestD)) for (let i = 0; i < l.corners.length; i++) {
      const a = l.corners[i]!, b = l.corners[(i + 1) % l.corners.length]!;
      const q = p;
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));
      const d = Math.hypot(a.x + dx * t - q.x, a.y + dy * t - q.y);
      if (d < bestD) { bestD = d; best = { a, b }; }
    }
    return best;
  }

  /** The side of a lot nearest a point within reach: the lot and the side's index (corner i to i + 1). */
  private sideAt(p: Vec2): { lot: Lot; side: number; a: Vec2; b: Vec2 } | null {
    let best: { lot: Lot; side: number; a: Vec2; b: Vec2 } | null = null, bestD = 18 / Math.max(0.05, this.host.zoom());
    for (const l of this.lotsNear(p, bestD)) for (let i = 0; i < l.corners.length; i++) {
      const a = l.corners[i]!, b = l.corners[(i + 1) % l.corners.length]!;
      const q = p;
      const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / len2));
      // Inside the lot counts as nearer: of two lots sharing a side, the one the pointer is in.
      const d = Math.hypot(a.x + dx * t - q.x, a.y + dy * t - q.y) - (insideLot(p, l) ? 1e-3 : 0);
      if (d < bestD) { bestD = d; best = { lot: l, side: i, a, b }; }
    }
    return best;
  }

  /** A dragged corner's snap: onto the streets and other corners, never onto itself. */
  private snapExcept(p: Vec2, from: Vec2): Vec2 {
    // The lots near the point, by place, their corners at `from` left out (`apart`): DO NOT copy every lot of the map.
    return lotSnapper(this.doc, this.net, undefined, from)(p, this.snapReach()).p;
  }

  /** Which side of a lot is its front: the longest of those against a street */
  private frontSideOf(points: readonly Vec2[]): number {
    const sides = points.map((p, i) => {
      const q = points[(i + 1) % points.length]!;
      const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
      const d = nearestRibbon(this.net, mid)?.distance ?? Infinity;
      return { i, d, length: Math.hypot(q.x - p.x, q.y - p.y) };
    });
    const nearest = Math.min(...sides.map((side) => side.d));
    return sides.filter((side) => side.d < nearest + m(1.5)).sort((a, b) => b.length - a.length)[0]?.i ?? 0;
  }

  /** A lot as drawn, cut back to the footways (`onLand`), with its front; null when nothing is left on land. */
  private landLot(points: readonly Vec2[]): { corners: Vec2[]; front: number } | null {
    const corners = onLand(this.net, points);
    return corners ? { corners, front: this.frontSideOf(corners) } : null;
  }

  /** The direction of the street nearest a point, for a lot drawn there. */
  private streetAngleNear(p: Vec2): number {
    const nearest = nearestRibbon(this.net, p);
    if (!nearest) return 0;
    const line = nearest.ribbon.full;
    const f = line.sampleAt(line.closestPoint(p).s);
    return Math.atan2(f.t.y, f.t.x);
  }

  /** What the delete stroke takes at a point: the lot there, the building there. */
  private eraseUnder(world: Vec2): void {
    if (!this.erase) return;
    const lot = this.lotAt(world);
    if (lot) {
      this.erase.lots.add(lot.id);
      if (lot.building !== undefined) this.erase.buildings.add(lot.building as BuildingId);
    }
    // DO NOT walk `buildings.all()`: this runs for each of up to 400 steps of a pointer move.
    for (const b of this.doc.buildings.near(world.x, world.y, world.x, world.y)) {
      if (Math.hypot(b.x - world.x, b.y - world.y) > m(80)) continue;
      if (solidFootprints(b).some((ring) => insideLot(world, { corners: ring }))) this.erase.buildings.add(b.id as BuildingId);
    }
  }

  // ------------------------------------------------------------ pointer

  /** The street land's proposed lots made real, to be edited as lots */
  private adoptProposal(): void {
    const prop = this.proposal;
    if (!prop || prop.key !== this.proposalKey() || !prop.lots.length) return;
    const add = prop.lots.map((corners) => ({ key: '', corners: [...corners] }));
    // With where each key's land lies (`LotPlan.keyRects`): DO NOT hand the keys without it
    this.host.mutate(() => applyLots(this.doc, { add, keys: [...prop.keys], drop: [], keyRects: [...prop.keyRects] }));
  }

  /** @perInput Runs once an input on one thing (a press, a release, a click): nothing it reaches may walk the map. */
  down(pointer: number, world: Vec2, shift: boolean, detail: number): void {
    const { doc, host } = this;
    const settings = host.settings();
    if (settings.mode === 'edit' || settings.mode === 'front' || settings.mode === 'split' || settings.mode === 'join' ||
      settings.mode === 'curve' || settings.mode === 'delete') this.adoptProposal();
    const at = { x: world.x, y: world.y };
    const lot = this.lotAt(at);
    const zoom = Math.max(0.05, host.zoom());
    if (settings.mode === 'edit') {
      // The nearest corner within reach of the pointer.
      let best: Vec2 | null = null, bestD = 14 / zoom;
      for (const l of this.lotsNear(at, bestD)) for (const q of l.corners) {
        const d = Math.hypot(q.x - at.x, q.y - at.y);
        if (d < bestD) { bestD = d; best = q; }
      }
      if (best) this.corner = { pointer, from: { ...best }, to: { ...world } };
    } else if (settings.mode === 'front') {
      // The side clicked becomes the lot's front, the side its building faces.
      const side = this.sideAt(at);
      if (!side) host.hint('hint.lot.frontPick');
      else {
        host.mutate(() => setLotFront(doc, side.lot.id, side.side));
        this.refused.clear();
        host.hint('hint.lot.front');
      }
    } else if (settings.mode === 'split') {
      if (settings.splitKind === 'line') this.cutLine = { pointer, a: { ...world }, b: { ...world } };
      else if (lot) {
        let ok = false;
        host.mutate(() => (ok = splitLot(doc, lot.id, { kind: settings.splitKind as 'vertical' | 'horizontal', parts: settings.splitParts })));
        host.hint(ok ? 'hint.lot.split' : 'hint.lot.splitFail');
      }
    } else if (settings.mode === 'polygon') {
      // A point a click; the first point again (or a double click) closes it.
      const p = this.snap(world);
      const first = this.polygon[0];
      const closing = first && this.polygon.length >= 3 && (Math.hypot(p.x - first.x, p.y - first.y) < 12 / zoom || detail >= 2);
      if (closing) {
        const points = [...this.polygon];
        this.polygon = [];
        let made = false;
        const landed = this.landLot(points);
        host.mutate(() => (made = landed !== null && addPolygonLot(doc, landed.corners, landed.front) !== null));
        host.hint(made ? 'hint.lot.added' : 'hint.lot.addFail');
      } else this.polygon.push(p);
    } else if (settings.mode === 'curve') {
      const side = this.sideNear(at);
      if (side) this.curve = { pointer, a: side.a, b: side.b, through: { ...world } };
    } else if (settings.mode === 'join') {
      if (lot && this.joinFirst === null) { this.joinFirst = lot.id; host.hint('hint.lot.joinPick'); }
      else if (lot && this.joinFirst !== null && lot.id !== this.joinFirst) {
        const first = this.joinFirst;
        let ok = false;
        host.mutate(() => (ok = joinLots(doc, first, lot.id)));
        host.hint(ok ? 'hint.lot.join' : 'hint.lot.joinFail');
        this.joinFirst = null;
      } else this.joinFirst = null;
    } else if (settings.mode === 'add') {
      this.drawn = { pointer, a: this.snap(world), b: this.snap(world), angle: this.streetAngleNear(at) };
    } else if (settings.mode === 'delete') {
      // Lots, the buildings on them or anywhere under the stroke, and the zoned cells: all at once.
      this.erase = { pointer, last: at, lots: new Set(), buildings: new Set() };
      this.eraseUnder(at);
    } else {
      // The brush zones the lots it passes over, and the proposed lots of the street land (`proposal`), made when it is let go.
      const remove = shift || settings.eraser;
      this.stroke = { pointer, remove, ids: new Set(lot ? [lot.id] : []), fresh: new Set(), pending: [], last: at };
      if (!lot && !remove) this.brushProposed(at);
    }
    host.redraw();
  }

  /** @perInput The pointer moved; true when one of this tool's gestures took it. */
  move(pointer: number, world: Vec2): boolean {
    const { host } = this;
    if (this.stroke?.pointer === pointer) {
      const stroke = this.stroke;
      const at = { x: world.x, y: world.y };
      // The whole way from the last sample, a step shorter than any lot's front: a fast drag reports its pointer far apart
      const from = stroke.last;
      const steps = Math.min(400, Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) / STROKE_STEP));
      for (let k = 1; k <= steps; k++) {
        const p = k === steps ? at : { x: from.x + (at.x - from.x) * k / steps, y: from.y + (at.y - from.y) * k / steps };
        const lot = this.lotAt(p);
        if (lot) stroke.ids.add(lot.id);
        else if (!stroke.remove) this.brushProposed(p);
      }
      stroke.last = at;
      host.redraw();
      return true;
    }
    if (this.erase?.pointer === pointer) {
      // The whole way from the last sample, as the brush's stroke.
      const erase = this.erase;
      const at = { x: world.x, y: world.y };
      const from = erase.last;
      const steps = Math.min(400, Math.ceil(Math.hypot(at.x - from.x, at.y - from.y) / STROKE_STEP));
      for (let k = 1; k <= steps; k++) {
        this.eraseUnder(k === steps ? at : { x: from.x + (at.x - from.x) * k / steps, y: from.y + (at.y - from.y) * k / steps });
      }
      erase.last = at;
      host.redraw();
      return true;
    }
    if (this.corner?.pointer === pointer) { this.corner.to = this.snapExcept(world, this.corner.from); host.redraw(); return true; }
    if (this.drawn?.pointer === pointer) { this.drawn.b = this.snap(world); host.redraw(); return true; }
    if (this.cutLine?.pointer === pointer) { this.cutLine.b = { ...world }; host.redraw(); return true; }
    if (this.curve?.pointer === pointer) { this.curve.through = { ...world }; host.redraw(); return true; }
    return false;
  }

  /** @perInput The pointer let go: the gesture it held is committed (`commit`), or dropped. */
  up(pointer: number, commit: boolean): void {
    const { doc, host } = this;
    const settings = host.settings();
    if (this.stroke?.pointer === pointer) {
      const stroke = this.stroke;
      this.stroke = null;
      this.readPending(stroke);
      if (commit && stroke.pending.length) {
        // The street land it passed is still being worked out: the stroke made as soon as it is in
        this.waiting = { stroke, use: settings.use, density: settings.density };
        void this.advanceProposal();
        if (this.waiting) host.hint('hint.zone.pending');
      } else if (commit) this.commitStroke(stroke, settings.use, settings.density);
      host.redraw();
    }
    if (this.corner?.pointer === pointer) {
      const drag = this.corner;
      this.corner = null;
      const to = { x: drag.to.x, y: drag.to.y };
      if (commit && Math.hypot(to.x - drag.from.x, to.y - drag.from.y) > m(0.3)) {
        host.mutate(() => moveLotCorner(doc, drag.from, to));
        this.refused.clear();
      }
      host.redraw();
    }
    if (this.cutLine?.pointer === pointer) {
      const line = this.cutLine;
      this.cutLine = null;
      if (commit && Math.hypot(line.b.x - line.a.x, line.b.y - line.a.y) > m(2)) {
        // Every lot the line crosses is cut along it.
        const a = { x: line.a.x, y: line.a.y }, b = { x: line.b.x, y: line.b.y };
        const crossed = doc.lotsIn([Math.min(a.x, b.x), Math.min(a.y, b.y), Math.max(a.x, b.x), Math.max(a.y, b.y)]).filter((l) => {
          if (!l.corners.length) return false;
          return cutLines(l, { kind: 'line', a, b }).length &&
            l.corners.some((q) => (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) > 0) &&
            l.corners.some((q) => (b.x - a.x) * (q.y - a.y) - (b.y - a.y) * (q.x - a.x) < 0) &&
            segmentCrossesLot(a, b, l.corners);
        });
        let ok = false;
        host.mutate(() => { for (const l of crossed) ok = splitLot(doc, l.id, { kind: 'line', a, b }) || ok; return ok; });
        host.hint(ok ? 'hint.lot.split' : 'hint.lot.splitFail');
      }
      host.redraw();
    }
    if (this.curve?.pointer === pointer) {
      const bend = this.curve;
      this.curve = null;
      if (commit) host.mutate(() => curveLotSide(doc, bend.a, bend.b, { x: bend.through.x, y: bend.through.y }));
      host.redraw();
    }
    if (this.drawn?.pointer === pointer) {
      const drawn = this.drawn;
      this.drawn = null;
      if (commit) {
        let made = false;
        const rect = lotRect(drawn.a, drawn.b, drawn.angle);
        const landed = rect ? this.landLot(rect) : null;
        host.mutate(() => (made = landed !== null && addPolygonLot(doc, landed.corners, landed.front) !== null));
        host.hint(made ? 'hint.lot.added' : 'hint.lot.addFail');
      }
      host.redraw();
    }
    if (this.erase?.pointer === pointer) {
      const stroke = this.erase;
      this.erase = null;
      if (commit && (stroke.lots.size || stroke.buildings.size)) {
        host.mutate(() => {
          for (const id of stroke.lots) deleteLot(doc, id);
          for (const id of stroke.buildings) doc.buildings.remove(id);
          return true;
        });
        host.hint('hint.lot.deleted');
      }
      host.redraw();
    }
  }

  // ------------------------------------------------------------ drawing

  /** The lots as the scene draws them (`render/lotOverlay.ts`), brought up to date: in the Zoning tool (`editing`), or the faint zones */
  overlay(editing: boolean): LotOverlayBook {
    const gesture = this.polygon.length > 0 || this.drawn !== null || this.cutLine !== null || this.curve !== null;
    // A faint hint, not the tool: held while a city grows lot by lot
    if (!editing && !gesture && this.held && this.drawnWith?.editing === false) return this.book;
    if (editing) void this.advanceProposal();
    const settings = this.host.settings();
    const hoverLot = editing && this.hover ? this.lotAt(this.hover) : undefined;
    const decor: LotDecor = { editing, mode: settings.mode, use: settings.use, eraser: settings.eraser, hover: hoverLot?.id ?? -1, joinFirst: this.joinFirst ?? -1 };
    const seen = this.refreshLots(decor);
    this.refreshProposal(decor, hoverLot);
    this.refreshGesture(decor, hoverLot, seen);
    return this.book;
  }

  /** The overlay by group (`overlay`), and what its lots' groups were last made with. */
  private readonly book = new LotOverlayBook();
  private drawnWith: LotDecor | null = null;
  private readonly lotsCursor = LotStore.cursor();
  /** The buildings' entries: a lot built on or cleared is drawn otherwise. */
  private readonly builtCursor = new JournalCursor(['buildings']);
  /** The lots drawn as painted by the stroke, and whether it was taking the zone off. */
  private readonly painted = new Set<number>();
  private paintedRemove = false;
  /** The dragged corner the lots near it were drawn with. */
  private drawnCorner = '';
  /** Counts the times the lots' groups changed: the gesture reads the lots too (`refreshGesture`). */
  private lotsSeen = 0;

  /** The lots' groups made again where what they are drawn from changed: the diary, the pointer, the stroke, the dragged corner; the count of times any did. */
  private refreshLots(d: LotDecor): number {
    const { doc } = this;
    const store = doc.lotStore;
    const was = this.drawnWith;
    this.drawnWith = d;
    const changed = store.changedFor(this.lotsCursor);
    const built = this.builtCursor.read(doc.changes);
    let all = !was || was.editing !== d.editing || was.mode !== d.mode || was.use !== d.use || was.eraser !== d.eraser ||
      changed === null || built === null;
    const dirty = new Set<number>(changed ?? []);
    for (const e of built ?? []) {
      if (!e.rects) { all = true; break; }
      for (const r of e.rects) for (const lot of doc.lotsIn(r)) dirty.add(lot.id);
    }
    // The pointer's lot and the first lot of a join: the one left and the one come to.
    if (was && was.hover !== d.hover) { dirty.add(was.hover); dirty.add(d.hover); }
    if (was && was.joinFirst !== d.joinFirst) { dirty.add(was.joinFirst); dirty.add(d.joinFirst); }
    // The stroke's lots: those it came to, and those it no longer holds.
    const ids = this.stroke?.ids;
    const remove = this.stroke?.remove ?? false;
    if (remove !== this.paintedRemove) { for (const id of this.painted) dirty.add(id); this.paintedRemove = remove; }
    for (const id of this.painted) if (!ids?.has(id)) { dirty.add(id); this.painted.delete(id); }
    if (ids) for (const id of ids) if (!this.painted.has(id)) { dirty.add(id); this.painted.add(id); }
    // A dragged corner moves the corners of the lots near where it was taken from.
    const c = this.corner;
    const corner = c ? `${c.from.x},${c.from.y}>${c.to.x},${c.to.y}` : '';
    if (corner !== this.drawnCorner) {
      for (const q of [this.drawnFrom, c?.from]) if (q) for (const lot of this.lotsNear(q, DRAG_REACH)) dirty.add(lot.id);
      this.drawnCorner = corner;
      this.drawnFrom = c ? { x: c.from.x, y: c.from.y } : null;
    }
    dirty.delete(-1);
    if (all) this.drawAllLots(d);
    else for (const id of dirty) this.drawLot(id, d);
    if (all || dirty.size) this.lotsSeen++;
    return this.lotsSeen;
  }
  private drawnFrom: Vec2 | null = null;

  /** @rebuild Every lot's group made again: the first frame, another mode or zone colour, a map loaded, a change the diary cannot place. */
  private drawAllLots(d: LotDecor): void {
    for (const name of [...this.book.groups.keys()]) if (name.startsWith('l')) this.book.put(name, null);
    for (const lot of this.doc.lotStore.all()) this.drawLot(lot.id, d);
  }

  /** One lot's group: its outline and fill, its front and arrow, its corners (none where nothing of it is drawn). */
  private drawLot(id: number, d: LotDecor): void {
    const { doc } = this;
    const l = doc.lotStore.get(id);
    const built = !!l && l.building !== undefined && doc.buildings.has(l.building as BuildingId);
    if (!l || (!d.editing && (!l.use || built))) { this.book.put(`l${id}`, null); return; }
    const corner = this.corner;
    const dragged = (q: Vec2): Vec2 => corner && Math.hypot(q.x - corner.from.x, q.y - corner.from.y) < DRAG_REACH ? corner.to : q;
    const painting = this.stroke?.ids.has(l.id);
    const brushHover = l.id === d.hover && d.mode === 'brush';
    const picked = d.editing && (l.id === d.joinFirst || (l.id === d.hover && !brushHover && d.mode !== 'edit'));
    const fill = painting ? (this.stroke!.remove ? 0xe36c60 : ZONE_COLOURS[d.use]) : l.use ? ZONE_COLOURS[l.use] : brushHover ? (d.eraser ? 0xe36c60 : ZONE_COLOURS[d.use]) : null;
    const fillAlpha = painting ? 0.6 : l.use ? (d.editing ? (built ? 0.22 : 0.45) : 0.25) : brushHover ? 0.35 : 0;
    const polygons: LotOverlay['polygons'] = [{ corners: l.corners.map(dragged), fill, fillAlpha,
      line: picked ? (d.mode === 'delete' ? 0xff6b5e : 0xffd25e) : 0xffffff, lineAlpha: d.editing ? (picked ? 1 : 0.85) : 0,
      width: picked ? 0.7 : 0.35, ...(built ? { built: true } : {}) }];
    const lines: LotOverlay['lines'] = [];
    // The lot's front, the side its building faces: marked in the Zoning tool.
    if (d.editing && l.corners.length > 1) {
      const a = dragged(l.corners[0]!), b = dragged(l.corners[1]!);
      lines.push({ a, b, colour: 0x5ee0ff, dashed: false, width: 0.8 });
      // An arrow from inside the lot out through the middle of its front, towards the street.
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len >= m(2)) {
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const centre = lotCentre(l);
        let nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
        if ((mid.x - centre.x) * nx + (mid.y - centre.y) * ny < 0) { nx = -nx; ny = -ny; }
        const size = Math.min(m(7), len * 0.35, Math.max(m(2), Math.hypot(mid.x - centre.x, mid.y - centre.y) * 0.6));
        const tail = { x: mid.x - nx * size, y: mid.y - ny * size };
        const tip = { x: mid.x - nx * size * 0.15, y: mid.y - ny * size * 0.15 };
        const head = size * 0.4, tx = -ny, ty = nx;
        lines.push({ a: tail, b: tip, colour: 0x5ee0ff, dashed: false, width: 1 });
        lines.push({ a: tip, b: { x: tip.x - nx * head + tx * head * 0.7, y: tip.y - ny * head + ty * head * 0.7 }, colour: 0x5ee0ff, dashed: false, width: 1 });
        lines.push({ a: tip, b: { x: tip.x - nx * head - tx * head * 0.7, y: tip.y - ny * head - ty * head * 0.7 }, colour: 0x5ee0ff, dashed: false, width: 1 });
      }
    }
    const points: LotOverlay['points'] = d.editing && d.mode === 'edit' ? l.corners.map((q) => ({ p: dragged(q), colour: 0xffffff, radius: 0.6 })) : [];
    const rank = Math.min(doc.lotStore.orderOf(id) ?? id, PROPOSAL_RANK - 1);
    this.book.put(`l${id}`, { rank, polygons, lines, points });
  }

  /** The proposal drawn: its list, the zone colour, each lot's group name and look (bit 1 painted, 2 under the pointer), the pointer's lot, the stroke's. */
  private shownProposal: {
    lots: readonly (readonly Vec2[])[]; look: string; ids: Map<readonly Vec2[], number>; idOf: number[]; state: Map<number, number>; hoverAt: number; fresh: Set<number>;
  } = { lots: NO_PROPOSAL, look: '', ids: new Map(), idOf: [], state: new Map(), hoverAt: -1, fresh: new Set() };
  private nextProposalId = 1;

  /** The street land proposed as lots, in every mode of the tool (they vanished from the Lots modes): faint outlines, one group each */
  private refreshProposal(d: LotDecor, hoverLot: Lot | undefined): void {
    const prop = this.proposal;
    // The last plan drawn until the next is in (DO NOT leave the street land bare while the worker plans): only one for the land as it is now is picked or laid.
    const lots: readonly (readonly Vec2[])[] = d.editing && prop ? prop.lots : NO_PROPOSAL;
    const hoverAt = d.editing && this.hover && !hoverLot && d.mode === 'brush' ? this.proposedAt(this.hover) : -1;
    const fresh = this.stroke?.fresh;
    const stateOf = (k: number): number => (fresh?.has(k) ? 1 : 0) | (k === hoverAt ? 2 : 0);
    const look = `${d.use}|${d.eraser ? 1 : 0}`;
    const shown = this.shownProposal;
    const draw = (corners: readonly Vec2[], state: number): LotOverlayGroup => {
      const painting = (state & 1) !== 0, lit = (state & 2) !== 0;
      return { rank: PROPOSAL_RANK, lines: [], points: [], polygons: [{ corners, fill: painting || lit ? (d.eraser ? null : ZONE_COLOURS[d.use]) : null,
        fillAlpha: painting ? 0.6 : lit ? 0.35 : 0, line: 0xffffff, lineAlpha: lit || painting ? 0.85 : 0.35, width: 0.25 }] };
    };
    if (lots !== shown.lots || look !== shown.look) {
      // Another plan: each proposed lot known by its corners (a block planned again hands new ones), the rest left as drawn.
      const ids = new Map<readonly Vec2[], number>();
      const idOf: number[] = [], state = new Map<number, number>();
      lots.forEach((corners, k) => {
        const s = stateOf(k);
        const known = shown.ids.get(corners);
        const id = known ?? this.nextProposalId++;
        ids.set(corners, id);
        idOf.push(id);
        state.set(id, s);
        if (known === undefined || look !== shown.look || shown.state.get(id) !== s) this.book.put(`p${id}`, draw(corners, s));
      });
      for (const [corners, id] of shown.ids) if (!ids.has(corners)) this.book.put(`p${id}`, null);
      this.shownProposal = { lots, look, ids, idOf, state, hoverAt, fresh: new Set(fresh) };
      return;
    }
    // The same plan: only the lots the pointer and the stroke left or came to.
    const touched = new Set<number>();
    if (hoverAt !== shown.hoverAt) { touched.add(shown.hoverAt); touched.add(hoverAt); }
    for (const k of shown.fresh) if (!fresh?.has(k)) { touched.add(k); shown.fresh.delete(k); }
    if (fresh) for (const k of fresh) if (!shown.fresh.has(k)) { touched.add(k); shown.fresh.add(k); }
    for (const k of touched) {
      if (k < 0 || k >= lots.length) continue;
      const s = stateOf(k), id = shown.idOf[k]!;
      if (s === shown.state.get(id)) continue;
      shown.state.set(id, s);
      this.book.put(`p${id}`, draw(lots[k]!, s));
    }
    shown.hoverAt = hoverAt;
  }

  /** The gesture's own group (lines being drawn, a cut, a curve, the snap) and the labels: made again when what it reads changed. */
  private refreshGesture(d: LotDecor, hoverLot: Lot | undefined, lotsSeen: number): void {
    const settings = this.host.settings();
    const at = (q: Vec2 | null | undefined): string => (q ? `${q.x},${q.y}` : '-');
    const key = [d.editing ? 'e' : 'q', d.mode, settings.splitKind, settings.splitParts, at(this.hover), this.hover ? this.host.zoom() : 0, d.hover,
      lotsSeen, this.proposalKey(), this.corner ? `${at(this.corner.from)}>${at(this.corner.to)}` : '-',
      this.drawn ? `${at(this.drawn.a)}>${at(this.drawn.b)}@${this.drawn.angle}` : '-', this.cutLine ? `${at(this.cutLine.a)}>${at(this.cutLine.b)}` : '-',
      this.curve ? `${at(this.curve.a)}>${at(this.curve.b)}~${at(this.curve.through)}` : '-', this.polygon.map(at).join(';')].join('|');
    if (key === this.gestureKey) return;
    this.gestureKey = key;
    const editing = d.editing;
    const corner = this.corner;
    const polygons: LotOverlay['polygons'] = [];
    const lines: LotOverlay['lines'] = [];
    const points: LotOverlay['points'] = [];
    if (editing && settings.mode === 'front' && this.hover) {
      const side = this.sideAt(this.hover);
      if (side) lines.push({ a: side.a, b: side.b, colour: 0xffd25e, dashed: false, width: 1 });
    }
    if (editing && settings.mode === 'split' && settings.splitKind !== 'line' && hoverLot) {
      for (const [a, b] of cutLines(hoverLot, { kind: settings.splitKind, parts: settings.splitParts })) lines.push({ a, b, colour: 0xffd25e, dashed: true, width: 0.5 });
    }
    if (this.cutLine) lines.push({ a: this.cutLine.a, b: this.cutLine.b, colour: 0xffd25e, dashed: true, width: 0.5 });
    if (this.curve) {
      const { a, b, through } = this.curve;
      const c = { x: 2 * through.x - (a.x + b.x) / 2, y: 2 * through.y - (a.y + b.y) / 2 };
      let prev = a;
      for (let k = 1; k <= 16; k++) {
        const t = k / 16, s1 = 1 - t;
        const q = { x: s1 * s1 * a.x + 2 * s1 * t * c.x + t * t * b.x, y: s1 * s1 * a.y + 2 * s1 * t * c.y + t * t * b.y };
        lines.push({ a: prev, b: q, colour: 0xffd25e, dashed: false, width: 0.6 });
        prev = q;
      }
    }
    if (editing && settings.mode === 'curve' && !this.curve && this.hover) {
      const side = this.sideNear(this.hover);
      if (side) lines.push({ a: side.a, b: side.b, colour: 0xffd25e, dashed: false, width: 0.7 });
    }
    if (this.polygon.length) {
      const pts = [...this.polygon, ...(this.hover ? [this.snap(this.hover)] : [])];
      for (let i = 1; i < pts.length; i++) lines.push({ a: pts[i - 1]!, b: pts[i]!, colour: 0xffffff, dashed: false, width: 0.5 });
      for (const q of this.polygon) points.push({ p: q, colour: 0xffffff, radius: 0.6 });
    }
    if (editing && (settings.mode === 'polygon' || settings.mode === 'add' || corner) && this.hover) {
      points.push({ p: corner ? corner.to : this.snap(this.hover), colour: 0x5ee0ff, radius: 0.9 });
    }
    if (this.drawn) {
      // As it will be made: cut back to the footways.
      const rect = lotRect(this.drawn.a, this.drawn.b, this.drawn.angle);
      const cut = rect ? onLand(this.net, rect) : null;
      if (cut) polygons.push({ corners: cut, fill: 0xffffff, fillAlpha: 0.2, line: 0xffffff, lineAlpha: 1, width: 0.5 });
    }
    let labels: LotOverlay['labels'] = [];
    if (editing && hoverLot && !this.polygon.length) {
      const f = lotFrame(hoverLot);
      labels = [{ at: lotCentre(hoverLot), kind: 'size', width: f.width, depth: f.depth }];
    } else if (this.polygon.length && this.hover) {
      const a = this.polygon[this.polygon.length - 1]!, b = this.snap(this.hover);
      labels = [{ at: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, kind: 'length', length: Math.hypot(b.x - a.x, b.y - a.y) }];
    }
    this.book.labels = labels;
    this.book.put('g', polygons.length || lines.length || points.length ? { rank: GESTURE_RANK, polygons, lines, points } : null);
  }
  private gestureKey = '';
}

/** Whether the segment a-b passes through the inside of a lot. */
function segmentCrossesLot(a: Vec2, b: Vec2, q: readonly Vec2[]): boolean {
  for (let k = 0; k <= 20; k++) if (insideLot({ x: a.x + (b.x - a.x) * k / 20, y: a.y + (b.y - a.y) * k / 20 }, { corners: q })) return true;
  return false;
}
