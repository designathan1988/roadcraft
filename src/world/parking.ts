import { m } from './units';

/** On-street parking: a native part of a road's cross-section. */

/** A band by the kerb is parking (`parallel`) or a CYCLE LANE (`cycle`): the ciclofaixa of the Brazilian code */
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

function isParkingKind(value: unknown): value is ParkingKind {
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
