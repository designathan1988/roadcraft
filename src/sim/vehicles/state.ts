import type { ConnectorId, LaneletId } from '@world/lanelets';
import type { Archetype } from './archetypes';
import type { Driver } from './driver';
import { type ConstraintSet, emptyConstraints } from './idm';
import type { ErrandKind, KerbStop } from './kerbStops';
import type { PersonAgeClass } from '../people/view';
import type { VehicleId } from './vehicleId';

export type { VehicleId };

export interface Kinematics {
  readonly lanelet: LaneletId;
  readonly s: number;
  readonly v: number;
  readonly lateral: number;
  /** Rate of change of `lateral`, world units a second. */
  /** Sideways offset per unit of road driven: the tangent of the lane-change heading. */
  readonly lateralSlope: number;
  /** Most recently left lanelets, needed to locate the body behind its front. */
  readonly rearPath: readonly LaneletId[];
}

interface ConnectorClearance {
  /** Connector whose exit the front of the vehicle has already crossed. */
  readonly connector: ConnectorId;
  /** Distance travelled by the front beyond that connector's exit. */
  distanceBeyondExit: number;
}

export interface Vehicle {
  readonly id: VehicleId;
  /** The machine: dimensions, mass, palette. One object per class. */
  readonly archetype: Archetype;
  /** The person driving it: acceleration, braking, headway, gap acceptance, patience. */
  readonly driver: Driver;
  readonly color: string;

  /** Current lanelet and arc position. Written ONLY by the integrator. */
  lanelet: LaneletId;
  s: number;
  v: number;
  /** Acceleration applied last tick, u/s². Written only by the integrator. */
  accel: number;
  /** Lateral render offset. Current lanelets keep this at zero. */
  lateral: number;
  /** The offset is that of the REAR AXLE, which is what follows the curve; the body is steered from it (`vehiclePose`). */
  lateralStart: number;
  lateralTravelled: number;
  lateralLength: number;
  /** d(lateral)/ds, for the heading the body points along (`laneChangeSlope`). */
  lateralSlope: number;

  /** Free-flow speed, already including this driver's personal factor. */
  v0: number;
  /** The driver shot dead at the wheel (`strandVehicle`): drawn slumped over it. */
  slain?: boolean;

  /** Planned lanelet sequence ahead, current lanelet first. */
  route: LaneletId[];
  /** Stable trip endpoint; congestion may change the route, not the goal. */
  destination: LaneletId | null;
  /** Lanelets still occupied by the body after its front has crossed a boundary. */
  rearPath: LaneletId[];

  /** Conflict points currently held by this vehicle. */
  claims: number[];
  /** Movement granted by the admission pass. */
  admittedConnector: ConnectorId | null;
  /** Soft Banker's maximum claim at or ahead of the vehicle. */
  reservedConnectors: ConnectorId[];
  /** Earlier connectors still occupied by the rear of the vehicle. */
  clearingConnectors: ConnectorClearance[];
  /** Tick of the oldest request, retained across one compact compound box. */
  firstRequestTick: number | null;
  /** Tick at which it last moved a meaningful distance, for the watchdog. */
  lastMovedTick: number;
  /** Seconds spent stationary at a stop line, for gap-acceptance impatience. */
  waited: number;
  /** Tick at which admission last refused it ONLY for people at or on a zebra */
  heldByPedestriansTick?: number;
  /** Set once the vehicle has come to a full stop, enabling right-on-red. */
  rorCredit: boolean;
  rorStopped: number;
  /** The connector whose amber this driver has decided to stop for, until its next green. */
  amberStop: string | null;

  /** Ticks since spawn, used to fade in. */
  age: number;

  /** Seconds spent stationary while the signal was green AND nothing was physically in the way. */
  greenStall: number;

  /** Seconds stopped at a green, whatever the reason. */
  greenDenied: number;

  /** Sibling lane this vehicle wants to be on before the next junction. */
  desiredLane: LaneletId | null;
  /** Chosen next movement, retained while moving through adjacent lanes. */
  movementIntent: ConnectorId | null;

  /** This vehicle's own age at its last lane change, in seconds. */
  lastLaneChangeAge: number;

  /** Seconds spent crawling, which is what makes a driver look for a way round. */
  heldUp: number;

  /** A lane change cleared to execute THIS tick. */
  laneChange: LaneletId | null;

  /** The lane this driver is signalling towards, and their age when they began. */
  laneIntent: LaneletId | null;
  laneIntentSince: number;

  /** How far each door is open, 0 shut to 1 fully open, indexed as the body model numbers them */
  doors: number[];

  /** Seats taken, one bit per seat in the body model's order; bit 0 is the driver. */
  seats: number;
  /** Pedestrian ids of people picked up, by seat; others are `seatPerson`'s default. */
  people: number[];
  /** Age class of the people in `people`, by seat. */
  peopleAge: PersonAgeClass[];
  /** What this trip stops for at a kerb, if anything (`kerbStops.ts`). */
  errand: ErrandKind | null;
  /** The kerb stop under way, from choosing the place to pulling away. */
  kerbStop: KerbStop | null;
  /** A resident driving to a building (`sim/city`) */
  commute: { readonly trip: number; readonly lanelet: LaneletId; readonly at: number } | null;
  /** Further tasks of the same stop: the next passenger of a bus, the mate's return. */
  kerbQueue: KerbStop[];
  /** Own age at the last bus stop served. */
  lastServiceAge: number;

  /** The lane this vehicle is sliding OUT of, while its body still overlaps it. */
  shadow: { readonly lanelet: LaneletId; readonly offset: number; readonly clearAt: number } | null;

  constraints: ConstraintSet;

  /** Previous kinematics, for render interpolation. */
  prev: Kinematics;

  /** A car OFF the road (`sim/agents`): parked in a bay, or manoeuvring between the bay and its lane. */
  free: FreePose | null;
}

/** A car standing in a bay as its readers see it (`AmbientWorld.parked`): a vehicle, or a scenery's row that is none (`SceneryCar`). */
export interface StandingCar {
  readonly id: VehicleId;
  readonly archetype: Archetype;
  readonly color: string;
  readonly free: FreePose | null;
}

/** A body centre and heading, now and at the previous tick (for interpolation). */
export interface FreePose {
  x: number;
  y: number;
  angle: number;
  px: number;
  py: number;
  pangle: number;
  /** The building whose lot it stands on or crosses, for the height it is drawn at; null off any lot. */
  lot: number | null;
}

export function snapshot(v: Vehicle): Kinematics {
  return { lanelet: v.lanelet, s: v.s, v: v.v, lateral: v.lateral, lateralSlope: v.lateralSlope, rearPath: v.rearPath };
}

/** `snapshot` written into the vehicle's own `prev`, every field of it */
export function snapshotInto(v: Vehicle): void {
  const p = v.prev as { -readonly [K in keyof Kinematics]: Kinematics[K] };
  p.lanelet = v.lanelet;
  p.s = v.s;
  p.v = v.v;
  p.lateral = v.lateral;
  p.lateralSlope = v.lateralSlope;
  p.rearPath = v.rearPath;
}

export function createVehicle(
  id: VehicleId,
  archetype: Archetype,
  driver: Driver,
  color: string,
  lanelet: LaneletId,
  v0: number,
  tick: number,
): Vehicle {
  const base: Kinematics = { lanelet, s: 0, v: 0, lateral: 0, lateralSlope: 0, rearPath: [] };
  return {
    id,
    archetype,
    driver,
    color,
    lanelet,
    s: 0,
    v: 0,
    accel: 0,
    lateral: 0,
    lateralStart: 0,
    lateralTravelled: 0,
    lateralLength: 1,
    lateralSlope: 0,
    v0,
    route: [lanelet],
    destination: null,
    rearPath: [],
    claims: [],
    admittedConnector: null,
    reservedConnectors: [],
    clearingConnectors: [],
    firstRequestTick: null,
    lastMovedTick: tick,
    waited: 0,
    rorCredit: false,
    rorStopped: 0,
    amberStop: null,
    age: 0,
    greenStall: 0,
    greenDenied: 0,
    desiredLane: null,
    movementIntent: null,
    lastLaneChangeAge: 0,
    heldUp: 0,
    laneChange: null,
    laneIntent: null,
    laneIntentSince: 0,
    doors: [],
    seats: 1,
    people: [],
    peopleAge: [],
    errand: null,
    kerbStop: null,
    commute: null,
    kerbQueue: [],
    lastServiceAge: 0,
    shadow: null,
    constraints: emptyConstraints(),
    prev: base,
    free: null,
  };
}

/** The driver shot dead at the wheel: the car rolls to a stop where it is and stays there */
export function strandVehicle(v: Vehicle): void {
  v.v0 = 0;
  v.slain = true;
}
