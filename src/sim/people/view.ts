import type { SegmentId } from '@world/ids';
import { DT } from '../params';

/**
 * A person as everything outside the pedestrian engine sees them.
 *
 * The renderer, the inspector and the counters used to read the legacy
 * model's `Ped` directly: its crossing state machine, its sidewalk edge and
 * arc position, its route. None of that exists in the People engine that
 * replaces it (a navmesh, not edges), so the renderer reads this instead, and
 * whichever engine runs publishes one `PedView` per person at the end of its
 * tick. The object for an id is kept for as long as that person lives, so a
 * renderer may key per-person state on it.
 *
 * `docs/design/agency-architecture.md` §5.
 */

export type PersonAgeClass = 'child' | 'adult' | 'elder';
export type PersonGender = 'f' | 'm';
export type PartyArchetype = 'solo' | 'family' | 'couple' | 'friends' | 'colleagues' | 'elders' | 'tourists';
export const PARTY_ARCHETYPES: readonly PartyArchetype[] = ['solo', 'family', 'couple', 'friends', 'colleagues', 'elders', 'tourists'];

/** The group someone walks with. Its id is its first member's; members are `id + rank`. */
export interface PartyView {
  readonly id: number;
  readonly size: number;
  readonly archetype: PartyArchetype;
  readonly hasChild: boolean;
}

/** What someone standing is doing with their hands and face. */
export type GestureKind = 'look' | 'phone' | 'talk' | 'bench'
  // Something a person stops a moment to do (`people.ts` pauses).
  | 'read' | 'drink' | 'photo' | 'wave' | 'headphones' | 'bag' | 'dance' | 'cheer' | 'crouch' | 'laugh'
  | 'argue' | 'umbrella' | 'trolley' | 'knock' | 'eat' | 'work'
  // A trip and a fall: down, a few seconds on the ground, up again.
  | 'fall'
  // Shot, a first wound: doubled over a moment, a hand to it, up again.
  | 'flinch'
  // Somebody they were walking with shot: down beside them, crying, then away.
  | 'mourn'
  // Gravely wounded, dragging themself off on hands and knees, bleeding.
  | 'crawl';
export type GesturePhase = 'approach' | 'hold' | 'step' | 'turn' | 'sitDown' | 'seated' | 'standUp' | 'leave';
export interface GestureView {
  kind: GestureKind;
  phase: GesturePhase;
  /** Seconds into the phase: a sit-down or stand-up clip is played to it. */
  t: number;
  /** How long the whole gesture lasts, seconds, where it has an end (a pause). */
  hold?: number;
  /** A fall: the point it was knocked from (a punch, a shove, a blast) - the body goes down away from it. */
  fromX?: number;
  fromY?: number;
}

/** Seconds a sit-down and a stand-up take, per sex: the engine holds the phase, the renderer plays the clip, to this clock. */
export const SIT_DOWN_SECONDS = { m: 2.9, f: 4.9 } as const;
export const STAND_UP_SECONDS = { m: 2.5, f: 3.33 } as const;

/** What the body stands on, which sets the height it is drawn at. */
export type PedGround = 'footway' | 'crossing' | 'open';
/** What a body can lose: an arm or a leg (each side), or the head. */
export type Severable = 'armL' | 'armR' | 'legL' | 'legR' | 'head';
/** Where a shot strikes a body. */
export type BodyPart = 'head' | 'torso' | Severable;

export interface PedView {
  readonly id: number;
  /** Terrified, running from a blow (`impact`): the face screams. */
  panic?: boolean;
  /** A limb lost to a blow, the rest of the walk on without it (and bleeding). */
  maimed?: 'armL' | 'armR' | 'legL' | 'legR';
  /** Every limb lost (to shots, `PedestrianEngine.shot`), drawn gone; `maimed` is the first of them. */
  lost?: readonly Severable[];
  /** Wounded and bleeding (shot): blood drips where they go. */
  bleeding?: boolean;
  /** Shot and hurt: where, and how badly (grave: half their health gone or a limb lost). It sets how they move. */
  wound?: { part: BodyPart; grave: boolean };
  /** Position and heading at the end of this tick, and at the end of the last. */
  x: number;
  y: number;
  heading: number;
  readonly prev: { x: number; y: number; heading: number };
  /** Walking speed, and how fast the heading is turning (rad/s). */
  v: number;
  turnV: number;
  /** Seconds since this person appeared: their animation clock. */
  age: number;
  /** How they walk, when not as everybody does: unsteady, late at night. */
  style?: 'drunk' | undefined;
  /** Walking hand in hand: which hand holds the partner's. */
  hand?: 'L' | 'R' | undefined;
  /** Carrying something in both arms in front: a box. */
  carry?: 'box' | undefined;

  readonly ageClass: PersonAgeClass;
  readonly gender: PersonGender;
  party: PartyView;
  rank: number;

  ground: PedGround;
  /** The road the ground belongs to, for its elevation; undefined off the road network. */
  segment: SegmentId | undefined;
  /**
   * Which walkway and which way along it. Two people with the same stretch
   * are walking the same path in the same direction, side by side if close.
   */
  stretch: string;
  /** Under way along a path, not paused, waiting or crossing. */
  walking: boolean;
  /** Seconds standing at a kerb waiting to cross; 0 when not. */
  kerbWait: number;
  /** The crossing waited for, while `kerbWait > 0`. */
  waitingFor: string | null;
  /**
   * What the person is doing in place, or null. A new object means a new
   * gesture: a renderer looking round starts its look again.
   */
  gesture: GestureView | null;
}

/**
 * Integer avalanche over an id: how a person's appearance and idle habits are
 * drawn, identically in the simulation and in the renderer.
 */
export function personHash(id: number): number {
  let h = (id | 0) + 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  return (h ^ (h >>> 15)) >>> 0;
}

/**
 * How fast the body really went this tick, u/s: its walking speed, or what it
 * moved if more. A walker stepping aside into its stripe moves while its
 * forward speed is nil (SUMO's striping does the same, `MSPModel_Striping`
 * `maxYSpeed`); the gait drawn from `v` alone stood still and the body slid
 * along the ground (Etapa 5a, `tests/sim/walkHeight.spec.ts`).
 */
export function gaitSpeed(view: Pick<PedView, 'x' | 'y' | 'prev' | 'v'>): number {
  return Math.max(view.v, Math.hypot(view.x - view.prev.x, view.y - view.prev.y) / DT);
}
