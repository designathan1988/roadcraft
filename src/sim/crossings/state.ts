import type { CrossingId } from '../signals/plan';

/** What the rest of the simulation may know about the people at one crossing. */
export interface CrossingOccupant {
  readonly id: number;
  /** Distance from the `from` kerb. */
  readonly s: number;
  /** Walking from the `from` kerb towards the `to` kerb. */
  readonly forward: boolean;
  /** Walking speed, world units a second. */
  readonly v: number;
  /** Standing still on the crossing, waiting for something - very often for the very vehicle asking - rather than arriving. */
  readonly held: boolean;
}

export interface CrossingState {
  /** Kerb to kerb, world units. */
  readonly length: number;
  /** Everybody on the crossing, in the order they stepped on. */
  readonly occupants: CrossingOccupant[];
  /** People waiting at each kerb to cross. */
  waitingFrom: number;
  waitingTo: number;
  /** Anybody at, or walking up to, a kerb meaning to cross here. */
  demand: boolean;
  /** Longest time anybody has waited at a kerb for this crossing, seconds. */
  longestWait: number;
}

export type CrossingStates = Map<CrossingId, CrossingState>;

/** An empty state for a crossing of this length. */
export function emptyCrossingState(length: number): CrossingState {
  return { length, occupants: [], waitingFrom: 0, waitingTo: 0, demand: false, longestWait: 0 };
}
