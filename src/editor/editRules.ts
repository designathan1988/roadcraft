import type { Vec2 } from '@core/vec2';
import { COARSE_EPS } from '@core/scalar';
import type { RoadDoc, RoadSegment } from '@world/doc';
import type { SegmentId } from '@world/ids';
import { Network } from '@world/network';
import { FLAT_GROUND, type RoadElevation, buildRoadElevation } from '@world/elevation';
import { Level, halfWidth } from '@world/roadTypes';
import { roadStructure } from '@world/structures';
import { ROAD_TUNING } from '@world/roads/tuning';
import { roadsBefore, settleRoadEdit } from './roads/economy';
import { m } from '@world/units';

/**
 * What a road edit may not leave behind, judged on the network it builds.
 *
 * City builders refuse a placement the game cannot carry and say why, before
 * the mouse is let go: Cities: Skylines will not lay a road steeper than its
 * limit, nor a segment too short ("distance too short": intersections too
 * close together, a curve too sharp), nor a piece over something already
 * there. These are the same refusals for this game's geometry:
 *  - `sharp`: a node whose legs meet under `MIN_LEG_ANGLE` - the mark the game
 *    already shows as "cannot be built" (`Network.impossible`);
 *  - `squeezed`: a junction whose legs are too short to separate their lanes
 *    (`Network.squeezed`);
 *  - `overlap`: a road lying on another one with no junction between them and
 *    without the vertical room to pass over it;
 *  - `steep`: a road whose height change, over what the junction plates at its
 *    ends leave free, needs a grade no street is built at.
 * And `funds`, which is not geometry: an edit the balance cannot pay for
 * (`editor/roads/economy.ts`), judged after the rules above.
 *
 * Every rule is DIFFERENTIAL: an edit is refused for what IT created or made
 * worse, never for damage already on the map. Loading never refuses, so any
 * map may hold such places; judged absolutely, one of them would refuse every
 * road drawn anywhere afterwards (measured on the old sharp-node refusal: a
 * 7-degree node 5000 units away blocked a road at the origin).
 */
export type RoadEditRefusal = 'sharp' | 'squeezed' | 'overlap' | 'steep' | 'funds';

export interface RoadState {
  readonly doc: RoadDoc;
  /** Built for `doc` (`revision` current). */
  readonly net: Network;
}

/**
 * A node's smallest leg gap may shrink this much before it counts as made
 * sharper: re-flattening a split curve moves an untouched gap by ulps.
 */
const GAP_NOISE = COARSE_EPS;
/** A squeeze may deepen this much (0.4 m) before it counts as made worse. */
const SQUEEZE_SLACK = m(0.4);
/**
 * The steepest grade a road is refused beyond: Baldwin Street, Dunedin, the
 * steepest street in the world at 34.8 % (Guinness; Wikipedia, "Grade
 * (slope)"). The height solver lays any grade the two ends ask for as one
 * continuous ramp (`elevation.ts` `solveGround`/`solveVariable`); past this
 * there is no street to model, and on the free run the plates leave the ramp
 * becomes a cliff (fuzz seed 3: 17 units down in about 10).
 */
const MAX_BUILT_GRADE = ROAD_TUNING.grade.refuse;
/**
 * Vertical room for one road to pass over another: the elevated deck's
 * clearance, the same figure the road tool uses for its crossings
 * (`commit.ts` `CROSSING_CLEARANCE`).
 */
const PASS_CLEARANCE = ROAD_TUNING.clearance.elevated;
/** Two decks within this height of each other are at one level (`commit.ts` `HEIGHT_JOIN_EPS`). */
const SAME_LEVEL = m(0.3);
/** Spacing of the samples along a changed road (0.8 m). */
const SAMPLE_STEP = m(0.8);
/** Overlap shallower than this is a kerb grazing a kerb, not a road on a road (0.2 m). */
const OVERLAP_SLACK = m(0.2);
/** A point within this of an old centreline lay on that road before the edit. */
const SAME_PLACE = 1;

/**
 * The reason to refuse turning `before` into `after`, or null when the edit
 * may stand. `after.net` must be rebuilt for `after.doc`; node and segment ids
 * of `before` keep their meaning in `after` (a working clone, or the same
 * document edited in place).
 */
export function refuseRoadEdit(before: RoadState, after: RoadState): RoadEditRefusal | null {
  for (const [node, gap] of after.net.impossible) {
    const was = before.doc.node(node) ? before.net.impossible.get(node) : undefined;
    if (was === undefined || gap < was - GAP_NOISE) return 'sharp';
  }
  for (const [node, short] of after.net.squeezed) {
    const was = before.doc.node(node) ? before.net.squeezed.get(node) : undefined;
    if (was === undefined || short > was + SQUEEZE_SLACK) return 'squeezed';
  }
  const changed = changedSegments(before.doc, after.doc);
  if (!changed.length) return null;
  if (tooSteep(before, after, changed)) return 'steep';
  // The decks as the game solves them, over flat land (two roads at one map
  // point stand on the same ground, so it cancels): a tunnel is at its full
  // depth only between its portals, and a road crossing it near one passed
  // over it with 3 m to spare by the authored figures - 13 units under at
  // mid-length, 8 near the portal (fuzz fixture `open-road-drawn-over-road`).
  // Solved only when two roads lie on each other in plan.
  let solved: RoadElevation | null = null;
  const deck = (id: SegmentId, p: Vec2): number =>
    (solved ??= buildRoadElevation(after.net, FLAT_GROUND)).onSegment(id, p.x, p.y);
  if (changed.some((id) => overlapsAnother(before, after, id, deck))) return 'overlap';
  return null;
}

/**
 * A copy of the roads as they stand, to judge an edit made in place against
 * (`refuseRoadEdit`). The network's geometry is taken over, not rebuilt.
 */
export function snapshotRoads(doc: RoadDoc, net: Network): RoadState {
  const copy = doc.clone();
  const copyNet = new Network(copy);
  if (net.revision === doc.revision) copyNet.adopt(net);
  else copyNet.rebuild();
  return { doc: copy, net: copyNet };
}

/**
 * Runs an edit made in place on the live roads (a split, a retype, more lanes,
 * a bend, a join, a copy) and judges it by the same rules as a drawn road. A
 * refused edit is undone: the document and its network are put back exactly
 * as they were, so the caller records nothing.
 */
export function guardRoadEdit(doc: RoadDoc, net: Network, edit: () => boolean):
  { readonly changed: boolean; readonly refused: RoadEditRefusal | null } {
  const before = snapshotRoads(doc, net);
  const money = roadsBefore(doc);
  if (!edit()) return { changed: false, refused: null };
  if (net.revision !== doc.revision) net.rebuild();
  // Judged, then paid for (`editor/roads/economy.ts`): an edit the balance
  // cannot cover is refused like any other.
  const refused = refuseRoadEdit(before, { doc, net }) ?? (settleRoadEdit(money, doc).affordable ? null : 'funds');
  if (!refused) return { changed: true, refused: null };
  doc.replaceWith(before.doc);
  net.adopt(before.net);
  return { changed: false, refused };
}

/** Segments of `after` that are new, or whose shape, class, structure or end points changed. */
function changedSegments(before: RoadDoc, after: RoadDoc): SegmentId[] {
  const out: SegmentId[] = [];
  for (const [id, seg] of after.segments) {
    const old = before.segment(id);
    if (!old || segmentKey(before, old) !== segmentKey(after, seg)) out.push(id);
  }
  return out;
}

function segmentKey(doc: RoadDoc, seg: RoadSegment): string {
  const a = doc.node(seg.a);
  const b = doc.node(seg.b);
  return JSON.stringify([seg.a, seg.b, seg.type, seg.lanes, seg.direction, seg.structure, seg.curve, seg.section ?? null,
    seg.parking ?? null, a?.x, a?.y, a?.heightOffset, b?.x, b?.y, b?.heightOffset]);
}

/** The deck's authored height along a segment at arc length `s` (as `commit.ts` `segmentOffsetAt`). */
function deckAt(doc: RoadDoc, seg: RoadSegment, s: number, length: number): number {
  const t = Math.max(0, Math.min(1, s / Math.max(1e-6, length)));
  const a = doc.node(seg.a)?.heightOffset ?? 0;
  const b = doc.node(seg.b)?.heightOffset ?? 0;
  return a + (b - a) * t + roadStructure(seg.structure).clearance;
}

/** Spacing of the deck samples a grade is read from, and the run it is measured over (0.4 m). */
const GRADE_STEP = m(0.4);
const GRADE_RUN = 2;

/**
 * The steepest grade of a segment's deck as the game solves it (rise over run,
 * over `GRADE_RUN`): read from the solved profile itself, not estimated. It was
 * estimated as the rise over the length less `Network.plateReach` at both ends,
 * and the solver flattens a wider plate (`elevation.ts`: the trim, the footway
 * and verge, a margin, up to 45 % of the length each); a ramp measured at 14 %
 * was solved as 4.8 units up in about 4 (fuzz `elevationStep`, seed 21).
 */
function grade(state: RoadState, id: SegmentId, solved: () => RoadElevation): number {
  const { doc, net } = state;
  const seg = doc.segment(id);
  if (!seg) return 0;
  const length = net.polylines.get(doc, id).length;
  // Level ends: no ramp to measure (and no profile to solve for it).
  if (Math.abs(deckAt(doc, seg, length, length) - deckAt(doc, seg, 0, length)) < SAME_LEVEL) return 0;
  const line = net.ribbons.get(id)?.full;
  if (!line) return 0;
  const elevation = solved();
  const heights: number[] = [];
  for (let s = 0; s <= line.length; s += GRADE_STEP) {
    const p = line.sampleAt(Math.min(s, line.length)).p;
    heights.push(elevation.onSegment(id, p.x, p.y));
  }
  const span = Math.max(1, Math.round(GRADE_RUN / GRADE_STEP));
  let steepest = 0;
  for (let i = span; i < heights.length; i++) {
    const rise = Math.abs((heights[i] as number) - (heights[i - span] as number));
    if (Number.isFinite(rise)) steepest = Math.max(steepest, rise / (span * GRADE_STEP));
  }
  return steepest;
}

/**
 * Whether the edit leaves a ramp steeper than any street, on a road it laid
 * or on one meeting it: a junction made at a ramp's end grows the plate the
 * ramp loses its run to (fuzz seed 3: a road set 17 units up, a new road at
 * its foot, 10 units left to come down in). A ramp already that steep is
 * refused only when the edit made it steeper.
 */
function tooSteep(before: RoadState, after: RoadState, changed: readonly SegmentId[]): boolean {
  const touched = new Set<SegmentId>(changed);
  for (const id of changed) {
    const seg = after.doc.segment(id);
    for (const node of seg ? [seg.a, seg.b] : []) {
      for (const other of after.doc.node(node)?.incident ?? []) touched.add(other);
    }
  }
  // Solved over flat land, once per state and only when a ramp asks for it
  // (two roads at one point stand on the same ground, so it cancels).
  let solvedAfter: RoadElevation | null = null;
  let solvedBefore: RoadElevation | null = null;
  const afterElevation = (): RoadElevation => (solvedAfter ??= buildRoadElevation(after.net, FLAT_GROUND));
  const beforeElevation = (): RoadElevation => (solvedBefore ??= buildRoadElevation(before.net, FLAT_GROUND));
  for (const id of touched) {
    const now = grade(after, id, afterElevation);
    if (now <= MAX_BUILT_GRADE) continue;
    if (!changed.includes(id) && before.doc.segment(id) && grade(before, id, beforeElevation) >= now - 1e-6) continue;
    return true;
  }
  return false;
}

/**
 * Whether a changed segment's roadway lies on another road's carriageway
 * (or that road's on its own), away from any junction they share, at one level.
 *
 * Sampled along the centreline beyond the junction plates at both ends. A
 * sample is in conflict with another segment when the gap between the two
 * centrelines is less than one road's carriageway half-width plus the other's
 * footway half-width: the lanes, or a footway and the lanes, lie on each other.
 * Near a node the two share, the other road's own plate is junction, not overlap.
 */
function overlapsAnother(before: RoadState, after: RoadState, id: SegmentId,
  deck: (id: SegmentId, p: Vec2) => number): boolean {
  const { doc, net } = after;
  const seg = doc.segment(id);
  const ribbon = net.ribbons.get(id);
  if (!seg || !ribbon) return false;
  const line = ribbon.full;
  const length = line.length;
  const trims = net.trims.get(id);
  const from = (trims?.a[Level.Casing] ?? 0) + SAMPLE_STEP / 2;
  const to = length - (trims?.b[Level.Casing] ?? 0) - SAMPLE_STEP / 2;
  if (to <= from) return false;

  // Candidate roads: any whose box comes within reach of this one's.
  const box = line.bbox;
  const others: { id: SegmentId; seg: RoadSegment; limit: number }[] = [];
  for (const [otherId, other] of doc.segments) {
    if (otherId === id) continue;
    const ob = net.ribbons.get(otherId)?.full.bbox;
    const limit = overlapReach(net, id, otherId);
    if (!ob || ob.minX > box.maxX + limit || ob.maxX < box.minX - limit ||
      ob.minY > box.maxY + limit || ob.maxY < box.minY - limit) continue;
    others.push({ id: otherId, seg: other, limit });
  }
  if (!others.length) return false;

  const steps = Math.max(1, Math.ceil((to - from) / SAMPLE_STEP));
  for (let k = 0; k <= steps; k++) {
    const s = from + ((to - from) * k) / steps;
    const p = line.sampleAt(s).p;
    const height = deckAt(doc, seg, s, length);
    for (const { id: otherId, seg: other, limit } of others) {
      const otherLine = net.ribbons.get(otherId)?.full;
      if (!otherLine) continue;
      const ob = otherLine.bbox;
      if (p.x < ob.minX - limit || p.x > ob.maxX + limit || p.y < ob.minY - limit || p.y > ob.maxY + limit) continue;
      const hit = otherLine.closestPoint(p);
      if (hit.distance >= limit) continue;
      if (withinSharedPlate(after, seg, other, otherId, hit.s, otherLine.length)) continue;
      if (Math.abs(deck(id, p) - deck(otherId, hit.point)) >= PASS_CLEARANCE) continue;
      if (overlappedBefore(before, p, height, hit.point, deckAt(doc, other, hit.s, otherLine.length))) continue;
      return true;
    }
  }
  return false;
}

/** The other road's closest point lies on its own junction plate at a node the two share. */
function withinSharedPlate(after: RoadState, seg: RoadSegment, other: RoadSegment, otherId: SegmentId, s: number, length: number): boolean {
  const trims = after.net.trims.get(otherId);
  const shares = (node: number): boolean => node === seg.a || node === seg.b;
  if (shares(other.a) && s <= (trims?.a[Level.Casing] ?? 0) + SAMPLE_STEP) return true;
  if (shares(other.b) && s >= length - (trims?.b[Level.Casing] ?? 0) - SAMPLE_STEP) return true;
  return false;
}

/**
 * The same two places already overlapped before the edit: both were road, on
 * two different segments at those heights, whose widths then already reached
 * across the gap between them. The overlap is old (a split elsewhere on those
 * roads re-identifies them), not this edit's. Only being road before is not
 * enough: a lane added that widens a road onto its neighbour leaves both
 * centrelines where they were.
 */
function overlappedBefore(before: RoadState, p: Vec2, ph: number, q: Vec2, qh: number): boolean {
  const onP = segmentsThrough(before, p, ph);
  if (!onP.length) return false;
  const gap = Math.hypot(q.x - p.x, q.y - p.y);
  for (const y of segmentsThrough(before, q, qh)) {
    for (const x of onP) {
      if (x !== y && gap < overlapReach(before.net, x, y)) return true;
    }
  }
  return false;
}

/**
 * How close two roads' centrelines may come before one's carriageway lies on
 * the other's carriageway or footway.
 */
function overlapReach(net: Network, a: SegmentId, b: SegmentId): number {
  const ra = net.ribbons.get(a)?.road;
  const rb = net.ribbons.get(b)?.road;
  if (!ra || !rb) return 0;
  return Math.max(halfWidth(ra, Level.Asphalt) + halfWidth(rb, Level.Sidewalk),
    halfWidth(ra, Level.Sidewalk) + halfWidth(rb, Level.Asphalt)) - OVERLAP_SLACK;
}

function segmentsThrough(state: RoadState, p: Vec2, height: number): SegmentId[] {
  const out: SegmentId[] = [];
  for (const [id, seg] of state.doc.segments) {
    const line = state.net.polylines.get(state.doc, id);
    const box = line.bbox;
    if (p.x < box.minX - SAME_PLACE || p.x > box.maxX + SAME_PLACE || p.y < box.minY - SAME_PLACE || p.y > box.maxY + SAME_PLACE) continue;
    const hit = line.closestPoint(p);
    if (hit.distance > SAME_PLACE) continue;
    if (Math.abs(deckAt(state.doc, seg, hit.s, line.length) - height) > SAME_LEVEL) continue;
    out.push(id);
  }
  return out;
}
