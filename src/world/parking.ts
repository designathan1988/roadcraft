import { m } from './units';

/**
 * On-street parking: a native part of a road's cross-section.
 *
 * A parking lane lies between the travel lanes and the kerb, on either side
 * of the road, and is chosen per segment. It is counted into the carriageway
 * (kerb face to kerb face), so a street with parking is wider kerb to kerb and
 * its travel lanes sit where they always did, inside the parking lanes.
 *
 * Cars park along the line of the street, beside the kerb, as they do on a
 * real street: bays are parallel to the kerb and follow the road round its
 * curves (the player's decision of 2026-10-05; bays across the kerb, at 45 or
 * 90 degrees, are not offered). Every measure is in whole metres of the
 * universal grid (`grid.ts`): the lane 2 m deep, bays 6 m long (Brazilian
 * standard 2.3 x 5.5).
 *
 * Bays stop short of every corner (`CORNER_CLEAR`, CTB art. 181 I: no parking
 * within 5 m of the cross street's kerb line), of crossings and of lot
 * entrances; that is laid out in `parkingLayout.ts`.
 */

/**
 * A band by the kerb is parking (`parallel`) or a CYCLE LANE (`cycle`): the
 * ciclofaixa of the Brazilian code (CTB, MBST vol. IV), a lane of the
 * carriageway painted red, kept from the traffic by a solid white line, where
 * the bicycles ride (`sim/pose.ts`, `vehicles/leaderIndex.ts`).
 */
export const PARKING_KINDS = ['none', 'parallel', 'cycle'] as const;
export type ParkingKind = (typeof PARKING_KINDS)[number];

/** Parking on the two sides of a segment, left and right of its a -> b direction. */
export interface SegmentParking {
  readonly left: ParkingKind;
  readonly right: ParkingKind;
}

/** Depth of a parking lane from the kerb face, world units. */
export const PARKING_DEPTH: Readonly<Record<ParkingKind, number>> = {
  none: 0,
  parallel: m(2),
  // 1.5 m to 2 m in the manuals; whole metres of the grid.
  cycle: m(2),
};

/** Distance along the kerb between bay lines, world units. */
export const PARKING_PITCH: Readonly<Record<ParkingKind, number>> = {
  none: 0,
  parallel: m(6),
  cycle: 0,
};



/** No bay within this distance of a junction's kerb line (CTB art. 181 I). */
export const CORNER_CLEAR = m(5);
/** No bay within this distance of a pedestrian crossing. */
export const CROSSING_CLEAR = m(2);

export function isParkingKind(value: unknown): value is ParkingKind {
  return typeof value === 'string' && (PARKING_KINDS as readonly string[]).includes(value);
}

/** A stored kind: the kinds across the kerb an earlier build offered park parallel now. */
function readKind(value: unknown): ParkingKind {
  if (value === 'angled' || value === 'perpendicular') return 'parallel';
  return isParkingKind(value) ? value : 'none';
}

/** Reads a stored value, or undefined when there is no parking at all. */
export function normalizeParking(raw: unknown): SegmentParking | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const left = readKind(value['left']);
  const right = readKind(value['right']);
  return left === 'none' && right === 'none' ? undefined : { left, right };
}

export function sameParking(a: SegmentParking | undefined, b: SegmentParking | undefined): boolean {
  return (a?.left ?? 'none') === (b?.left ?? 'none') && (a?.right ?? 'none') === (b?.right ?? 'none');
}

/** The same parking seen from the other end of the segment. */
export function flipParking(p: SegmentParking | undefined): SegmentParking | undefined {
  return p ? { left: p.right, right: p.left } : undefined;
}

/** Roads without footways (highways, ramps) do not park at all; every street does. */
export function parkingAllowed(kind: ParkingKind, road: { readonly id: string }): boolean {
  if (kind === 'none') return true;
  return road.id !== 'highway' && road.id !== 'ramp';
}
