import type { BuildingId } from '@world/buildings/types';
import type { LaneletId } from '@world/lanelets';
import type { VehicleId } from '../vehicles/vehicleId';

/**
 * A parking bay and the lane it is reached from (`parking.ts`, the bays of the
 * city; `kerbBays.ts`, those along the kerbs). Their own file: `kerbBays.ts`
 * reads them and `parking.ts` imports it, so a type import from `parking.ts`
 * closed an import cycle (`tests/arch/imports.spec.ts`).
 */

export interface BayLane {
  readonly lanelet: LaneletId;
  /** Arc position of the point where a car's body centre joins or leaves the lane. */
  readonly at: number;
  readonly x: number;
  readonly y: number;
  /** Unit direction of travel there. */
  readonly tx: number;
  readonly ty: number;
  /**
   * For a lot entered by a car gate: the arc position (body centre) an
   * arriving car stops at, a few metres BEFORE the gate, to turn in through
   * it; `at` is then a few metres past the gate, where a car leaving joins.
   * As SUMO binds a parking area to the lane its access is on, the gate's
   * lane is the one a lot is driven to and left by.
   */
  readonly entryAt?: number;
}

export interface Bay {
  readonly id: number;
  readonly building: BuildingId;
  /** Centre of the stall. */
  readonly x: number;
  readonly y: number;
  /** Unit direction out of the stall, towards its open end. */
  readonly ox: number;
  readonly oy: number;
  /** Depth of the stall. */
  readonly depth: number;
  /** The road it is reached from; null when no lane is near enough. */
  readonly lane: BayLane | null;
  /**
   * The way through its lot, from the aisle in front of the stall to the lot's
   * street edge (world points, in the order a car leaving drives them): a car
   * keeps to the lot and never cuts across a building to the nearest road.
   * Empty for a bay outside any lot: it is driven straight to its lane.
   */
  readonly via: readonly { readonly x: number; readonly y: number }[];
  /**
   * Half the stall's clear length: from its centre to its nearer end, or to
   * the first part of the lot or wall standing in the stall before that
   * (`stallRoom`). A body is parked centred, so it fits when half its
   * length is no more than this (`stallFits`).
   */
  readonly room: number;
  /** The car standing in it, or coming to it (reserved). */
  car: VehicleId | null;
  /**
   * A bay along a street's kerb (`world/parkingLayout.ts`), not in a lot: a
   * car backs into it from the lane beside, as one parks on a real street,
   * and drives forward out of it. Its lane point is a few metres ahead of it.
   */
  readonly kerb?: true;
}
