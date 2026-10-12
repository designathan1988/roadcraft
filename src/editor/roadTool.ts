import { nameFor } from '@world/roads/streetNames';
import { layPowerLines } from './roads/powerLine';
import { type FurnitureSet, furnitureFor } from '@world/roads/furnitureSets';
import type { Vec2 } from '@core/vec2';
import { dist } from '@core/vec2';
import { clamp } from '@core/scalar';
import { shapeFromControl, type CurveShape } from '@core/bezier';
import { fitRoadCurve, type RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { GRID_CELL, GRID_STEP, snapToGrid } from '@world/grid';
import { Level, halfWidth, roadProfile } from '@world/roadTypes';
import { sectionForWidth } from '@world/roadSection';
import { METERS_PER_UNIT, UNITS_PER_METER, m } from '@world/units';
import type { RoadElevation } from '@world/elevation';
import type { SegmentParking } from '@world/parking';
import {
  type Anchor, anchorForHeight as anchorAtHeight, anchorHeightOffset as anchorHeightAt, findAnchor, setGridSnapStep, snapRoadEndpoint,
  snapRoadStart, type SnapResult,
} from './snap';
import { commitRoadPath } from './commit';
import { applyProfileTo } from './roads/profile';
import { roadsBefore, settleRoadEdit } from './roads/economy';
import type { RoadProfileSpec } from '@world/roads/profile';
import type { RoadStation } from '@world/roads/buildMode';
import type { RoadEditRefusal } from './editRules';
import { roadPathFromGesture, type RoadPathPiece, type RoadPathPoint } from './roadPath';

/** How long a draft rests before the preview judges it (`RoadTool.verdict`), ms. */
const VERDICT_DELAY = 120;

/** A refusal the preview names: the editing rules', or a crossing at the wrong height. */
export type RefusalReason = RoadEditRefusal | 'clearance';

const REFUSALS: ReadonlySet<string> = new Set<RefusalReason>(['sharp', 'squeezed', 'overlap', 'steep', 'clearance', 'funds']);
function isRefusal(reason: string): reason is RefusalReason {
  return REFUSALS.has(reason);
}

/** A road being drawn: a drag, or a stretch chained from the last road's end. */
export interface RoadDraft {
  readonly start: Anchor;
  readonly startHeightOffset: number;
  readonly chained: boolean;
  readonly pressedAt: Vec2;
  snap: SnapResult;
  readonly samples: RoadPathPoint[];
  heightOffset: number;
  curveControl?: Vec2;
}

/** A curve with its end put down, waiting for the click that sets its bend. */
export interface CurvePending {
  readonly start: Anchor;
  readonly startHeightOffset: number;
  end: Anchor;
  endHeightOffset: number;
  control: Vec2;
}

/** What the road tool reads of the game and does to it. */
export interface RoadToolHost {
  readonly doc: RoadDoc;
  readonly net: Network;
  zoom(): number;
  /** World units for `n` screen pixels at the current zoom (`Camera.px`). */
  px(n: number): number;
  /** The road in hand: class, lanes, plan, the height it is drawn at. */
  settings(): {
    readonly typeIndex: number; readonly lanes: number | null; readonly alignment: 'straight' | 'curve' | 'free';
    readonly heightOffset: number; readonly parking: SegmentParking | undefined; readonly width: number | null; readonly grid: boolean;
    /** A profile new roads are laid with (docs/VIAS.md V2), over the class, lanes, width and parking; null for those. */
    readonly profile?: { readonly profile: RoadProfileSpec; readonly type: number } | null;
    /** Retaining walls in the cuttings of new roads instead of a batter (docs/VIAS.md V3). */
    readonly cutWalls?: boolean;
    /** The furniture the new roads are built with (V7, `world/roads/furnitureSets.ts`); absent: none. */
    readonly furniture?: FurnitureSet;
  };
  /** Sets the height the road is drawn at (the game's state, with the cause). */
  setHeight(value: number, cause: string): void;
  /** The world point under screen point (px, py) at `height` above the ground plane. */
  worldAtScreen(px: number, py: number, height: number): Vec2;
  /** The natural ground's height, for the tunnel test of a commit. */
  naturalHeightAt(x: number, y: number): number;
  /** The elevation solved by the commit's tunnel test, offered to the renderer. */
  offerElevation(solution: RoadElevation, revision: number): void;
  /**
   * The roads' heights the game last solved on the natural ground as it
   * stands, or null (the land moved since): the tunnel test starts from them.
   */
  groundSolve?(): RoadElevation | null;
  /** The roads just laid blink. */
  flash(ids: readonly SegmentId[]): void;
  /** An edit of the document, one undo step. */
  mutate(fn: () => boolean): void;
  hint(key: string): void;
  redraw(): void;
}

/**
 * THE ROAD TOOL: a road drawn by a drag (or a click that starts a chain and
 * a click that ends each stretch), straight, as a curve (end, then the bend:
 * a quadratic Bézier through its two ends, pulled towards the control point)
 * or freehand; at a height set with PageUp/PageDown, carried mid-stroke; on
 * the grid when it is shown. What is being drawn lives here - the drag, the
 * chain's end and its preview, the curve waiting for its bend, the road just
 * laid shown as previewed until the world with it is built - with the
 * handlers that use it (Nystrom, "State"). `main.ts` passes the pointer and
 * draws `preview()`.
 */
export class RoadTool {
  /** The drag in progress. */
  draft: RoadDraft | null = null;
  /** The end of the last stretch, while the road is being chained. */
  private chain: Anchor | null = null;
  private chainHeight = 0;
  private chainPreview: RoadDraft | null = null;
  private curvePending: CurvePending | null = null;
  /** The pointer on the screen while the tool is in hand (the height step carries the stroke from it). */
  private pointerScreen: Vec2 | null = null;
  /**
   * How far a drag's stroke is carried, in plan, by the heights changed
   * during it: raising the road mid-drag moved the plane the cursor is read
   * on, and the stroke doubled back on itself into a loop.
   */
  private shift = { x: 0, y: 0 };
  /** The height was set by hand since the stroke began (a start on a road does not take that road's height then). */
  private heightEdited = false;
  /** The road just committed, drawn as previewed until the world with it is built. */
  private settling: RoadDraft | null = null;

  constructor(private readonly host: RoadToolHost) {}

  gesture(): string | null {
    if (this.draft) return 'via: desenhando';
    if (this.curvePending) return 'via: curvando';
    if (this.chain) return 'via: encadeando';
    if (this.settling) return 'via: assentando';
    return null;
  }

  /** A curve's end is down and its bend follows the pointer. */
  bending(): boolean {
    return this.curvePending !== null;
  }

  inProgress(): boolean {
    return this.draft !== null || this.chain !== null || this.curvePending !== null;
  }

  cancel(): void {
    this.draft = null;
    this.chain = null;
    this.chainPreview = null;
    this.curvePending = null;
  }

  /** The plan is no longer a curve: a curve waiting for its bend is dropped. */
  dropCurve(): void {
    this.curvePending = null;
  }

  /** A new map: drawn at the land's own height again. */
  reset(): void {
    this.host.setHeight(0, 'mapa novo');
    this.heightEdited = false;
  }

  /** A height chosen from outside the tool (the console). */
  heightChosen(value: number): void {
    this.host.setHeight(value, 'altura pedida pelo console');
    this.heightEdited = true;
  }

  /** The pointer over the map, on the screen. */
  pointerAt(screen: Vec2): void {
    this.pointerScreen = screen;
  }

  /** Height of an authored connection; open ground takes the height being drawn at. */
  private anchorHeight(anchor: Anchor): number {
    return anchorHeightAt(this.host.doc, this.host.net, anchor, this.host.settings().heightOffset);
  }

  /** A nearby road at another height is a crossing, not an accidental junction. */
  private atHeight(anchor: Anchor, heightOffset: number): Anchor {
    return anchorAtHeight(this.host.doc, this.host.net, anchor, heightOffset);
  }

  /** A press at `world` while a curve waits for its bend: the curve is laid bent there. True when there was one. */
  bend(world: Vec2): boolean {
    const pending = this.curvePending;
    if (!pending) return false;
    this.curvePending = null;
    this.commit({
      start: pending.start,
      startHeightOffset: pending.startHeightOffset,
      chained: true,
      pressedAt: world,
      snap: { at: pending.end.at, guide: pending.end.kind === 'free' ? null : 'network', angleDeg: 0, length: dist(pending.start.at, pending.end.at) },
      samples: [{ at: pending.start.at, heightOffset: pending.startHeightOffset }],
      heightOffset: pending.endHeightOffset,
      curveControl: world,
    }, pending.end);
    this.host.redraw();
    return true;
  }

  /** A press at `world`, `anchor` what is under it: a stroke begins (from the chain's end when chaining). */
  down(world: Vec2, anchor: Anchor): void {
    const { host } = this;
    const { doc, net } = host;
    const settings = host.settings();
    const chained = this.chain !== null;
    let gridOffset = 0;
    if (settings.grid) {
      // The road fills whole cells: an odd number of them wide, its middle in a cell's middle.
      const cells = Math.max(1, Math.round((2 * halfWidth(roadProfile(settings.typeIndex, settings.lanes), Level.Sidewalk)) / GRID_CELL));
      gridOffset = cells % 2 === 1 ? GRID_CELL / 2 : 0;
      setGridSnapStep(GRID_CELL, gridOffset);
    } else setGridSnapStep(GRID_STEP);
    let start = this.chain ?? snapRoadStart(anchor);
    // Drawn from a road with the grid on: from the grid point on that road,
    // not from wherever the press fell on it - the new road came out askew
    // and off the grid (the player, 2026-10-06).
    if (!this.chain && settings.grid && start.kind === 'segment' && start.segment !== undefined) {
      const line = net.polylines.get(doc, start.segment);
      const q = snapToGrid(start.at, GRID_CELL, gridOffset);
      let best: { at: Vec2; s: number; d: number } | null = null;
      for (const dx of [-1, 0, 1]) for (const dy of [-1, 0, 1]) {
        // The neighbouring grid point (on the planet the face's grid is not the chart's axes).
        const hit = line.closestPoint(snapToGrid({ x: q.x + dx * GRID_CELL, y: q.y + dy * GRID_CELL }, GRID_CELL, gridOffset));
        if (hit.distance < m(0.6) && (!best || Math.hypot(hit.point.x - start.at.x, hit.point.y - start.at.y) < best.d)) {
          best = { at: hit.point, s: hit.s, d: Math.hypot(hit.point.x - start.at.x, hit.point.y - start.at.y) };
        }
      }
      if (best) start = { ...start, at: best.at, s: best.s };
    }
    const startHeightOffset = chained ? this.chainHeight : start.kind === 'free' ? settings.heightOffset : this.anchorHeight(start);
    if (!chained && start.kind !== 'free' && !this.heightEdited) host.setHeight(startHeightOffset, 'via começa num ponto existente');
    this.heightEdited = false;
    this.chainPreview = null;
    this.shift = { x: 0, y: 0 };
    const height = host.settings().heightOffset;
    this.draft = {
      start, startHeightOffset, chained, pressedAt: world,
      snap: snapRoadEndpoint(doc, net, start, world, host.zoom(), height),
      samples: [{ at: start.at, heightOffset: startHeightOffset }],
      heightOffset: height,
    };
  }

  /** The pointer moved; true when the curve's bend or the drag took it. */
  move(world: Vec2): boolean {
    const { host } = this;
    if (this.curvePending) {
      this.curvePending.control = world;
      host.redraw();
      return true;
    }
    if (this.draft) {
      const at = { x: world.x + this.shift.x, y: world.y + this.shift.y };
      this.draft.snap = snapRoadEndpoint(host.doc, host.net, this.draft.start, at, host.zoom(), this.draft.heightOffset);
      if (this.draft.samples.length < 256) this.draft.samples.push({ at, heightOffset: this.draft.heightOffset });
      host.redraw();
      return true;
    }
    return false;
  }

  /** The pointer over the map with no drag: the next stretch of a chain, previewed. */
  hover(world: Vec2): void {
    if (!this.chain) return;
    const { host } = this;
    const height = host.settings().heightOffset;
    this.chainPreview = {
      start: this.chain,
      startHeightOffset: this.chainHeight,
      chained: true,
      pressedAt: world,
      snap: snapRoadEndpoint(host.doc, host.net, this.chain, world, host.zoom(), height),
      samples: [{ at: this.chain.at, heightOffset: this.chainHeight }],
      heightOffset: height,
    };
  }

  /**
   * The pointer let go: a click starts a chain, a curve waits for its bend,
   * a drag is laid (`commit` false: dropped). `released` is where it was let
   * go, read once the drag is over (on the plane of a chain or a curve in
   * hand, otherwise the ground's).
   */
  up(released: () => Vec2, commit: boolean): void {
    const d = this.draft;
    if (!d) return;
    this.draft = null;
    if (!commit) return;
    const { host } = this;
    const traveled = d.samples.reduce((sum, sample, i) => (i === 0 ? 0 : sum + dist(sample.at, d.samples[i - 1]!.at)), 0) +
      dist(d.samples[d.samples.length - 1]!.at, d.snap.at);
    const dragged = d.samples.slice(1).some((sample) => dist(sample.at, d.pressedAt) > host.px(7));
    // A click, by where the pointer itself went: with the snaps on, the start
    // and the snapped end both jump onto the grid, and a click read as a short
    // drag that laid nothing.
    const clicked = !dragged && dist(released(), d.pressedAt) < host.px(7);
    if (!d.chained && (traveled < host.px(7) || clicked)) {
      this.chain = d.start;
      this.chainHeight = d.startHeightOffset;
      host.redraw();
    } else if (d.chained && host.settings().alignment === 'curve' && !dragged) {
      // A curve uses endpoint, then bend point. A drag still draws it at once.
      const anchor = this.atHeight(findAnchor(host.doc, host.net, d.snap.at, host.zoom(), undefined, d.heightOffset), d.heightOffset);
      const end: Anchor = anchor.kind === 'free' ? { kind: 'free', at: d.snap.at } : anchor;
      this.curvePending = {
        start: d.start,
        startHeightOffset: d.startHeightOffset,
        end,
        endHeightOffset: end.kind === 'free' ? d.heightOffset : this.anchorHeight(end),
        control: { x: (d.start.at.x + end.at.x) / 2, y: (d.start.at.y + end.at.y) / 2 },
      };
      host.redraw();
    } else if (dist(d.start.at, d.snap.at) >= m(0.4) || traveled >= m(9.6)) {
      this.commit(d);
    }
  }

  /**
   * PageUp/PageDown or the height buttons: the road is drawn a metre higher
   * or lower, landing on whole metres (a road cut short by the safe grade
   * leaves the height at a fraction, and stepping from there never came back
   * to the ground's own level). A drag goes on from where it is: the jump of
   * the plane the pointer is read on is carried.
   */
  stepHeight(metres: number): void {
    const { host } = this;
    const before = host.settings().heightOffset;
    const now = before / UNITS_PER_METER;
    const next = metres > 0 ? Math.floor(now + 1e-6) + metres : Math.ceil(now - 1e-6) + metres;
    host.setHeight(next * UNITS_PER_METER, 'altura da via');
    this.heightEdited = true;
    const height = host.settings().heightOffset;
    const screen = this.pointerScreen;
    const underPointer = screen ? host.worldAtScreen(screen.x, screen.y, height) : null;
    if (this.draft) {
      this.draft.heightOffset = height;
      if (screen) {
        const was = host.worldAtScreen(screen.x, screen.y, before);
        this.shift = { x: this.shift.x + was.x - underPointer!.x, y: this.shift.y + was.y - underPointer!.y };
      }
      const at = underPointer ? { x: underPointer.x + this.shift.x, y: underPointer.y + this.shift.y } : this.draft.snap.at;
      this.draft.snap = snapRoadEndpoint(host.doc, host.net, this.draft.start, at, host.zoom(), height);
      this.draft.samples.push({ at, heightOffset: height });
    }
    if (this.chain && !this.draft && !this.curvePending) {
      const at = underPointer ?? this.chainPreview?.snap.at ?? this.chain.at;
      this.chainPreview = {
        start: this.chain,
        startHeightOffset: this.chainHeight,
        chained: true,
        pressedAt: at,
        snap: snapRoadEndpoint(host.doc, host.net, this.chain, at, host.zoom(), height),
        samples: [{ at: this.chain.at, heightOffset: this.chainHeight }],
        heightOffset: height,
      };
    }
    if (this.curvePending) {
      this.curvePending.end = this.atHeight(this.curvePending.end, height);
      this.curvePending.endHeightOffset = height;
    }
    host.redraw();
  }

  /** The end a draft is laid to (`chosenEnd`, or what is under its end), its height and its pieces. */
  private ending(d: RoadDraft, chosenEnd?: Anchor): { end: Anchor; endHeightOffset: number; pieces: RoadPathPiece[] } {
    const { host } = this;
    const endAnchor = chosenEnd ?? this.atHeight(findAnchor(host.doc, host.net, d.snap.at, host.zoom(), undefined, d.heightOffset), d.heightOffset);
    const end: Anchor = endAnchor.kind === 'free' ? { kind: 'free', at: d.snap.at } : endAnchor;
    const endHeightOffset = end.kind === 'free' ? d.heightOffset : this.anchorHeight(end);
    return { end, endHeightOffset, pieces: this.pieces(d, endHeightOffset) };
  }

  /**
   * Why the road in hand would be refused (`editRules.ts`, or a crossing at
   * the wrong height), or null: the draft judged as laid, on a copy
   * (`commitRoadPath` dry run), once it has rested `VERDICT_DELAY` ms - a
   * whole commit per pointer sample would cost a road's worth of work per
   * frame. The preview paints a refused draft as invalid with its reason,
   * before the button is let go, as Cities: Skylines does.
   */
  verdict(): RefusalReason | null {
    const road = this.curvePending ? null : this.draft ?? this.chainPreview;
    const key = road ? this.draftKey(road) : null;
    if (key !== this.judged.key) {
      this.judged = { key, reason: null, cost: null, stations: null };
      if (this.judgeTimer !== null) clearTimeout(this.judgeTimer);
      this.judgeTimer = null;
      if (key !== null) this.judgeTimer = setTimeout(() => this.judge(key), VERDICT_DELAY);
    }
    return this.judged.reason;
  }

  private judged: { key: string | null; reason: RefusalReason | null; cost: number | null; stations: readonly RoadStation[] | null } =
    { key: null, reason: null, cost: null, stations: null };

  /**
   * The road in hand as it would be built (docs/VIAS.md V3): the dry run's
   * stations - solved deck, natural ground, way of building - once the draft
   * is judged, or null until then (the preview estimates meanwhile).
   */
  stations(): readonly RoadStation[] | null {
    this.verdict();
    return this.judged.stations;
  }

  /**
   * What the road in hand would cost (`world/economy.ts`), judged with the
   * verdict on the same dry run, or null until it is: shown in the preview
   * beside its length, and when it is more than the balance the verdict is
   * `funds`.
   */
  cost(): number | null {
    this.verdict();
    return this.judged.cost;
  }
  private judgeTimer: ReturnType<typeof setTimeout> | null = null;

  private draftKey(d: RoadDraft): string {
    const s = this.host.settings();
    const last = d.samples[d.samples.length - 1]?.at;
    return JSON.stringify([d.start, d.startHeightOffset, d.snap.at, d.heightOffset, d.curveControl ?? null, d.samples.length,
      last ?? null, s.typeIndex, s.lanes, s.alignment, this.host.doc.revision]);
  }

  private judge(key: string): void {
    this.judgeTimer = null;
    const road = this.draft ?? this.chainPreview;
    if (!road || this.draftKey(road) !== key) return;
    const { host } = this;
    const settings = host.settings();
    const { end, pieces } = this.ending(road);
    if (!pieces.length) return;
    const result = commitRoadPath(host.doc, host.net, road.start, end, settings.typeIndex, pieces, settings.lanes,
      settings.parking, (x, y) => host.naturalHeightAt(x, y), { dryRun: true, groundSolve: host.groundSolve?.() ?? null });
    const reason = !result.committed && result.reason && isRefusal(result.reason) ? result.reason : null;
    this.judged = { key, reason, cost: result.cost ?? null, stations: result.stations ?? null };
    host.redraw();
  }

  /** Lays the road `d` ends at (`chosenEnd`, or what is under its end), one undo step; false when refused. */
  private commit(d: RoadDraft, chosenEnd?: Anchor): boolean {
    const { host } = this;
    const { doc, net } = host;
    const settings = host.settings();
    const { end, endHeightOffset, pieces } = this.ending(d, chosenEnd);
    let result: ReturnType<typeof commitRoadPath> = { committed: false };
    let before = new Set<SegmentId>();
    host.mutate(() => {
      before = new Set(doc.segments.keys());
      result = commitRoadPath(doc, net, d.start, end, settings.typeIndex, pieces, settings.lanes, settings.parking,
        (x, y) => host.naturalHeightAt(x, y), { groundSolve: host.groundSolve?.() ?? null });
      if (result.elevation) host.offerElevation(result.elevation, net.revision);
      // Drawn as it was previewed until the new world is in place.
      if (result.committed) this.settling = { ...d, snap: { ...d.snap, at: end.at } };
      // A chosen total width (Roads > Width): the segments just laid take it.
      // A profile chosen in the profile editor (V2), or a chosen width: the
      // segments just laid take it, paid for as the road was (`roads/economy.ts`);
      // what the balance cannot cover is not laid, and the road keeps its class.
      if (result.committed && (settings.profile || settings.width !== null)) {
        const laid = [...doc.segments.keys()].filter((id) => !before.has(id));
        const kept = laid.map((id) => ({ ...doc.requireSegment(id) }));
        const money = roadsBefore(doc);
        if (settings.profile) applyProfileTo(doc, laid, settings.profile.profile, settings.profile.type);
        else {
          const rt = roadProfile(settings.typeIndex, settings.lanes);
          const section = sectionForWidth(rt, settings.width!, Math.round(rt.speedLimit * 3.6 * METERS_PER_UNIT));
          for (const id of laid) doc.setSegmentSection(id, section);
        }
        if (!settleRoadEdit(money, doc).affordable) {
          for (const s of kept) {
            doc.setSegmentType(s.id, s.type);
            doc.setSegmentDirection(s.id, s.direction);
            doc.setSegmentLanes(s.id, s.lanes);
            doc.setSegmentSection(s.id, s.section);
            doc.setSegmentParking(s.id, s.parking);
          }
          host.hint('hint.rule.funds');
        }
      }
      // Retaining walls in the cuttings of the roads just laid (V3).
      if (result.committed && settings.cutWalls) {
        for (const id of doc.segments.keys()) if (!before.has(id)) doc.setSegmentCutWalls(id, true);
      }
      // The furniture of the roads just laid, in the same undo step (V7):
      // ordinary placed items, edited or removed one by one like any other.
      if (result.committed && settings.furniture && settings.furniture !== 'none') {
        if (net.revision !== doc.revision) net.rebuild();
        const laid = [...doc.segments.keys()].filter((id) => !before.has(id));
        // The complete set: a power line down the left, its poles lit (V7).
        const power = settings.furniture === 'complete' && layPowerLines(doc, net, laid) > 0;
        for (const piece of furnitureFor(net, laid, settings.furniture, doc.landscape.values(), power)) doc.addLandscape(piece.kind, piece.at);
        // A new street is given a name (V8), its plates at the corners; renamed or removed as any item.
        for (const name of nameFor(net, laid)) doc.addLandscape('streetname', name.at, { text: name.text });
      }
      return result.committed;
    });
    if (!result.committed) {
      const reason = result.reason;
      host.hint(reason === 'clearance' ? 'hint.road.clearance'
        : reason && isRefusal(reason) ? `hint.rule.${reason}` : 'hint.road.invalid');
      return false;
    }
    const finalHeight = result.finalHeightOffset ?? endHeightOffset;
    // Each completed placement ends the gesture. A new road begins only after
    // the player clicks a start again, including when that start is this node.
    this.chain = null;
    this.chainPreview = null;
    this.curvePending = null;
    this.chainHeight = finalHeight;
    host.setHeight(finalHeight, 'via terminada');
    this.heightEdited = false;
    if (result.heightLimited) host.hint('hint.road.gradeLimited');
    const laid = [...doc.segments.keys()].filter((id) => !before.has(id));
    if (laid.length) host.flash(laid);
    return true;
  }

  /**
   * What the overlay draws: the curve waiting for its bend, the drag, the
   * chain's next stretch, or the road just laid while the world with it is
   * built (`settled` says the world is in place: that preview is let go).
   */
  preview(settled: boolean): { readonly road: RoadDraft; readonly settling: boolean } | null {
    if (this.settling && settled) this.settling = null;
    const cp = this.curvePending;
    if (cp) {
      return { settling: false, road: {
        start: cp.start, startHeightOffset: cp.startHeightOffset, chained: true, pressedAt: cp.control,
        snap: { at: cp.end.at, guide: null, angleDeg: 0, length: dist(cp.start.at, cp.end.at) },
        samples: [{ at: cp.start.at, heightOffset: cp.startHeightOffset }],
        heightOffset: cp.endHeightOffset, curveControl: cp.control,
      } };
    }
    const road = this.draft ?? this.chainPreview;
    if (road) return { road, settling: false };
    return this.settling ? { road: this.settling, settling: true } : null;
  }

  /** The pieces a draft is laid as: one straight or curved, or the freehand path's. */
  pieces(value: RoadDraft, endHeightOffset = value.heightOffset): RoadPathPiece[] {
    const { alignment, typeIndex } = this.host.settings();
    const start = { at: value.start.at, heightOffset: value.startHeightOffset };
    const end = { at: value.snap.at, heightOffset: endHeightOffset };
    if (alignment === 'free') return roadPathFromGesture(value.samples, start, end).map((piece) => ({
      ...piece,
      curve: fitRoadCurve(piece.start.at, piece.end.at, piece.curve, typeIndex),
    }));
    if (Math.hypot(start.at.x - end.at.x, start.at.y - end.at.y) < 1e-6) return [];
    return [{ start, end, curve: alignment === 'curve' ? this.curveOf(value) : null }];
  }

  /** The curve of a draft: through its control point, or bent as far as the drag went off the chord. */
  private curveOf(value: RoadDraft): CurveShape | null {
    const { typeIndex } = this.host.settings();
    const a = value.start.at;
    const b = value.snap.at;
    if (value.curveControl) return fitRoadCurve(a, b, shapeFromControl(a, b, value.curveControl), typeIndex);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const chord = Math.hypot(dx, dy);
    if (chord < 1) return null;
    const nx = -dy / chord;
    const ny = dx / chord;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let side = 0;
    for (const sample of value.samples) {
      const p = sample.at;
      const candidate = (p.x - mid.x) * nx + (p.y - mid.y) * ny;
      if (Math.abs(candidate) > Math.abs(side)) side = candidate;
    }
    side = clamp(side, -chord * 0.52, chord * 0.52);
    if (Math.abs(side) < this.host.px(6)) return null;
    return fitRoadCurve(a, b, shapeFromControl(a, b, { x: mid.x + nx * side * 1.36, y: mid.y + ny * side * 1.36 }), typeIndex);
  }
}
