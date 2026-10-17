import type { Restoration } from '@world/doc';
import type { BuildingChange, TrafficMap } from '../agents/trafficBuildings';
import type { NodeId, SegmentId } from '@world/ids';
import type { NetworkBake } from '@world/networkBuild';
import type { BodyPart, PedView, PersonAgeClass } from '../people/view';
import type { Casualty } from '../people/casualties';
import type { KerbStop } from '../vehicles/kerbStops';
import { FLEET_CEILING, PED_CEILING } from '../params';
import type { SignalState } from '../signals/query';
import type { TileEvent } from '../meso/meso';

/** THE SIMULATION'S WORKER AND THE PAGE (`simHost.ts` there, `simClient.ts` here): what goes between them */

/** A vehicle's numbers as the worker writes them each tick (Float64, `VEHICLE_STRIDE` a vehicle). */
export const V = {
  id: 0, archetype: 1, free: 2, bx: 3, by: 4, bangle: 5, x: 6, y: 7, angle: 8, yawBefore: 9, yawNow: 10, jump: 11,
  v: 12, prevV: 13, age: 14, segment: 15, indicator: 16, curvature: 17, odometer: 18, seats: 19, slain: 20, lot: 21, inSegment: 22,
} as const;
export const VEHICLE_STRIDE = 23;
/** A pedestrian's numbers (Float64, `PED_STRIDE` a person). */
export const P = {
  id: 0, x: 1, y: 2, heading: 3, px: 4, py: 5, pheading: 6, v: 7, turnV: 8, age: 9, segment: 10, walking: 11, kerbWait: 12, rank: 13,
} as const;
export const PED_STRIDE = 14;
/** The head of a slot: counts and the clock (Float64). */
export const H = { tick: 0, time: 1, vehicles: 2, peds: 3, alpha: 4, steps: 5, stepMs: 6, minutes: 7 } as const;
const HEAD = 8;

/** Most vehicles a slot holds: the traffic's ceiling. */
const VEHICLES = FLEET_CEILING;
const PEDS = PED_CEILING;
/** One slot's Float64s: the head, then the vehicles, then the pedestrians. */
export const SLOT = HEAD + VEHICLES * VEHICLE_STRIDE + PEDS * PED_STRIDE;
export const vehicleBase = (slot: number): number => slot * SLOT + HEAD;
export const pedBase = (slot: number): number => slot * SLOT + HEAD + VEHICLES * VEHICLE_STRIDE;
export const headBase = (slot: number): number => slot * SLOT;
export const MAX_VEHICLES = VEHICLES;
export const MAX_PEDS = PEDS;

/** The control words (Int32): the slot written last, the slot the page reads now (Atomics, MDN). */
export const C = { latest: 0, reading: 1 } as const;
export const CONTROL_WORDS = 2;

/** The memory both sides hold: three slots (a triple buffer) and the control words. */
export interface SharedFrames {
  readonly data: SharedArrayBuffer;
  readonly control: SharedArrayBuffer;
}

export function makeSharedFrames(): SharedFrames {
  return { data: new SharedArrayBuffer(3 * SLOT * 8), control: new SharedArrayBuffer(CONTROL_WORDS * 4) };
}

/** What a vehicle carries that is not a number of the tick: told when it changes. */
export interface VehicleRich {
  readonly color: string;
  readonly archetype: string;
  readonly doors: readonly number[];
  readonly kerbStop: KerbStop | null;
  readonly people: readonly number[];
  readonly peopleAge: readonly (PersonAgeClass | undefined)[];
  /** Off the road: its pose a tick ago and now (the numbers carry them too), its lot. */
  readonly freeLot: number | null;
}

/** What a pedestrian carries that is not a number of the tick (`P`): told when it changes. */
export type PedRich = Omit<PedView, 'id' | 'x' | 'y' | 'heading' | 'prev' | 'v' | 'turnV' | 'age' | 'segment' | 'walking' | 'kerbWait' | 'rank'>;

/** A signalised junction's heads by group (`render/signals.ts`): which roads each group lights. */
export interface SignalLayout {
  readonly node: NodeId;
  readonly groups: readonly { readonly id: number; readonly segments: readonly SegmentId[] }[];
}

/** A junction's lights now: its stage, and each group's colour. */
export interface SignalLights {
  readonly node: NodeId;
  readonly stage: string;
  readonly states: readonly (readonly [number, SignalState])[];
}

/** A train drawn: its line's colour and each car's place. */
export interface TrainCar { readonly x: number; readonly y: number; readonly heading: number }
export interface TrainState { readonly colour: string; readonly metro: boolean; readonly cars: readonly TrainCar[] }

/** The page to the worker: never the whole map nor a building's record, only what traffic reads (`agents/trafficBuildings.ts`). */
export type ToSim =
  /** `live`: the tiles the page's document holds (`world/tiles.ts`): the meso takes the others from their link tables. */
  | { readonly type: 'init'; readonly frames: SharedFrames; readonly map: TrafficMap; readonly live: readonly number[]; readonly seed: number; readonly zones: ReadonlyMap<string, Float64Array | null>; readonly zonesPrefix: string | null; readonly ambient: 'view' | 'edges' }
  | { readonly type: 'load'; readonly map: TrafficMap; readonly live: readonly number[] }
  /** The streamed world's tile store the meso reads its far tiles from (`meso/tileFeed.ts`), in IndexedDB by `map`, or over `port` (the desktop's), within `reach` of the camera. */
  | { readonly type: 'tiles'; readonly map: string; readonly reach: number; readonly port: MessagePort | null }
  /** The page's job lanes for the lots' bays and the conflict pairs (`jobPool.ts` jobChannel), before `init`: the worker opens no pool of its own. */
  | { readonly type: 'lanes'; readonly bays: readonly MessagePort[]; readonly conflicts: readonly MessagePort[] }
  /** The page's worker serving those lanes failed: their pool falls back to working here. */
  | { readonly type: 'laneLost'; readonly service: 'bays' | 'conflicts'; readonly why: string }
  /** A tile of the page taken in, let go, or written at `version` (`worldStreamer.ts` StreamerEvents). */
  /** `fromPage`: a tile loaded whose store is behind the page (a write not confirmed): its buildings come from the page, DO NOT read them, or its bays, from the store. */
  | { readonly type: 'tile'; readonly event: TileEvent; readonly key: number; readonly version: number; readonly fromPage?: boolean }
  /** The roads', lots' and transit's records the diary named (`delta`), and the buildings it named as traffic records. */
  | { readonly type: 'delta'; readonly delta: Restoration; readonly buildings: readonly BuildingChange[] }
  /** A tile's junctions and ribbons as the page has them solved (`NetworkBake`): the worker's network takes them where its inputs are the same, never solving them again. */
  | { readonly type: 'bake'; readonly bake: NetworkBake }
  | { readonly type: 'frame'; readonly wall: number; readonly hold: boolean; readonly controls: SimControls }
  | { readonly type: 'reset' }
  /** The micro window's centre and radius (`meso/meso.ts`), and the page's buffer the meso traffic is written into (`meso/memory.ts`). */
  | { readonly type: 'window'; readonly x: number; readonly y: number; readonly r: number; readonly meso: SharedArrayBuffer }
  | { readonly type: 'act'; readonly id: number; readonly act: SimAct }
  | { readonly type: 'ask'; readonly id: number; readonly ask: SimAsk };

/** What the player sets of the simulation, sent each frame (a few numbers). */
export interface SimControls {
  readonly speed: number;
  readonly paused: boolean;
  readonly traffic: boolean;
  readonly pedestrians: boolean;
  readonly trafficIntensity: number;
  readonly pedestrianIntensity: number;
  readonly demandMultiplier: number;
  readonly maxShare: number;
  readonly focus: SimFocus | null;
}

export interface SimFocus {
  readonly x: number;
  readonly y: number;
  readonly r: number;
  readonly detail: boolean;
  readonly view: { readonly ex: number; readonly ey: number; readonly dx: number; readonly dy: number; readonly cos: number; readonly far: number } | null;
}

/** The player's hand on the simulation (the Actions): answered with `acted`. */
export type SimAct =
  | { readonly kind: 'shot'; readonly ped: number; readonly part: BodyPart; readonly fromX: number; readonly fromY: number }
  | { readonly kind: 'impact'; readonly x: number; readonly y: number; readonly kill: number; readonly scare: number }
  | { readonly kind: 'removeVehicle'; readonly id: number }
  | { readonly kind: 'strand'; readonly id: number }
  | { readonly kind: 'removeVehiclesNear'; readonly x: number; readonly y: number; readonly r: number }
  | { readonly kind: 'getUp'; readonly id: number; readonly x: number; readonly y: number; readonly heading: number; readonly seconds: number; readonly crawl?: boolean };

/** A question the panels ask (the inspector, the junction panel): answered with `answer`. */
export type SimAsk =
  | { readonly kind: 'segment'; readonly id: SegmentId }
  | { readonly kind: 'junction'; readonly node: NodeId }
  | { readonly kind: 'greenWave'; readonly node: NodeId }
  | { readonly kind: 'nodeLanes'; readonly node: NodeId };

/** A bullet wound on somebody (`people/casualties.ts` recordWound), told once. */
export interface Wound { readonly id: number; readonly part: BodyPart; readonly fromX: number; readonly fromY: number }

/** The worker to the page. */
export type FromSim =
  | { readonly type: 'ready' }
  /** A message the worker could not handle: told, so the page reports it and does not wait for a frame never coming. */
  | { readonly type: 'failed'; readonly message: string }
  | { readonly type: 'tick'; readonly slot: number; readonly vehicles: readonly (readonly [number, VehicleRich])[]; readonly peds: readonly (readonly [number, PedRich])[];
      readonly signals: readonly SignalLights[]; readonly layout: { readonly all: boolean; readonly junctions: readonly SignalLayout[] } | null; readonly trains: readonly TrainState[];
      readonly parked: readonly ParkedCar[] | null; readonly stats: SimStats;
      readonly wounds: readonly Wound[]; readonly casualties: readonly Casualty[] }
  | { readonly type: 'acted'; readonly id: number; readonly result: unknown }
  | { readonly type: 'answer'; readonly id: number; readonly answer: unknown };

/** A car parked in its bay, still: where, and how it looks. */
export interface ParkedCar {
  readonly id: number; readonly archetype: string; readonly color: string; readonly x: number; readonly y: number; readonly angle: number; readonly lot: number | null;
  /** Gone from its bay (driven out, taken away). */
  readonly gone: boolean;
  /** The list is every parked car of the map: those not in it are gone. */
  readonly whole: boolean;
}

/** The simulation's own numbers for the status bar, the monitor and the population governor. */
export interface SimStats {
  readonly vehicles: number;
  readonly people: number;
  readonly completedTrips: number;
  readonly entryDemandLost: number;
  readonly controllers: number;
  readonly lotsMoving: number;
  readonly topologyRevision: number;
  readonly issues: readonly { readonly code: string; readonly subject: string; readonly detail: string; readonly tick: number }[];
  readonly populationShare: number;
  readonly stepMs: number;
  readonly measured: readonly (readonly [string, Float64Array | null])[];
}
