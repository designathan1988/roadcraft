import type { BodyPart, Severable } from './view';
import type { LaneletId } from '@world/lanelets';
import type { AuditIssue } from '../audit';
import type { SimWorld } from '../world';
import type { PersonAgeClass, PersonGender } from './view';

/**
 * What the simulation asks of whichever model moves its people.
 *
 * The pipeline, the vehicles and the audit talk to pedestrians only through
 * this, `SimWorld.crossingStates` and `SimWorld.pedViews`; the model's own
 * state stays behind it. The game's one implementation is the agents'
 * walking engine (`agents/walk.ts`); `SimWorld` starts with a null engine
 * (nobody walks) until one is installed.
 */
export interface PedestrianEngine {
  readonly kind: 'legacy' | 'people';
  /** Start of a tick: remember where everybody is, for the renderer's interpolation. */
  beginTick(w: SimWorld): void;
  /** Stage 2: people arrive (or, `enabled` false, do not). */
  dispatch(w: SimWorld, enabled: boolean): void;
  /** Stage 3: everybody decides and moves; crossing states are published at the end. */
  step(w: SimWorld): void;
  /** After the walkable topology was rebuilt: re-seat everybody on what is left. */
  rebind(w: SimWorld): void;
  /** End of a tick: publish `SimWorld.pedViews`. */
  publish(w: SimWorld): void;
  /** The model's own invariants, for `runAudit`. */
  audit(w: SimWorld, out: AuditIssue[]): void;
  /** Everybody leaves (a new map, an opened file); the engine starts over on the map as it is. */
  reset(w: SimWorld): void;
  readonly bridge: PeopleBridge;
  /**
   * A resident walking from one place to another (`sim/city`): put on the
   * footway at `from`, walking to `to` and in. Returns the walker's id, or
   * null when there is no way there. Engines without it carry no walks.
   */
  walkTrip?(w: SimWorld, trip: ResidentWalk): number | null;
  /** The trips (by `ResidentWalk.trip`) that ended since the last call. */
  takeArrivals?(w: SimWorld): number[];
  /**
   * The walkable point nearest `(x, y)` within `reach`, or null: where a person
   * stepping off the footway towards a parked car leaves it (`sim/agents`).
   */
  walkableNear?(w: SimWorld, x: number, y: number, reach: number): { x: number; y: number } | null;
  /**
   * A blow at (x, y) - a building struck, a wall coming down (`editor/impact`):
   * everybody within `kill` dies on the spot, everybody within `scare` runs
   * away from it for a while. Returns how many died.
   */
  impact?(w: SimWorld, x: number, y: number, kill: number, scare: number): number;
  /**
   * A shot striking one person in one part (`BodyPart`) from (fromX, fromY):
   * the wound, the reaction (a stagger, a fall, a limp, running off), a limb
   * shot off once it has taken enough, death when they have. What happened,
   * for the blood and the pieces drawn; null when there is nobody to hit.
   */
  shot?(w: SimWorld, id: number, part: BodyPart, fromX: number, fromY: number): { killed: boolean; severed: Severable | null } | null;
  /**
   * Somebody knocked down (`impact`) or fallen gets up at (x, y) facing
   * `heading`, in `seconds`: where their body came to rest (`render/ragdoll.ts`).
   */
  /** `crawl`: not up but onto hands and knees, crawling off from there (a grave wound, `sim/agents/walk.ts`). */
  getUp?(w: SimWorld, id: number, x: number, y: number, heading: number, seconds: number, crawl?: boolean): void;
}

export interface ResidentWalk {
  /** The city's id for this trip, handed back when it ends. */
  readonly trip: number;
  readonly fromX: number;
  readonly fromY: number;
  readonly toX: number;
  readonly toY: number;
  readonly seed: number;
  readonly ageClass: PersonAgeClass;
  /**
   * The person's own id, kept for life (`sim/agents`): the walker is drawn as
   * this person (`personHash`), so the same resident looks the same on every
   * walk, in their car and out of it. Absent, the engine numbers a new walker.
   */
  readonly person?: number;
  /** Walking with this walker (their companion: the same way, at their pace, `sim/agents/walk.ts`). */
  readonly with?: number;
  /** Farthest `from` and `to` may be from the walkable area; the engine's own default when absent. */
  readonly reach?: number;
}

/**
 * Somebody passing between a vehicle seat and the footway. They keep their
 * id both ways: the person who gets out is the person who got in.
 */
export interface Boarder {
  readonly seed: number;
  readonly gender: PersonGender;
  readonly ageClass: PersonAgeClass;
  /** Where they stand on the footway (getting out) or come from (getting in), world units. */
  readonly footX: number;
  readonly footY: number;
  /** Heading they face while standing on the footway. */
  readonly footHeading: number;
}

/**
 * What vehicles ask of people at the kerb (§5).
 *
 * For now every call is answered at once, in the same stage, exactly as the
 * kerb-stop code did when it reached into the pedestrian model itself: a
 * person hailed is taken out of the crowd there and then, and one getting out
 * appears on the footway. When people walk to doors themselves (People P5)
 * this becomes a two-way mailbox (offer, arrive at door, boarded, aborted).
 */
export interface PeopleBridge {
  /**
   * The nearest person along the lane, between `s0` and `s1`, who could be
   * picked up there: walking alone on that side's footway, not a child, not
   * busy, not in `exclude`. `s` is where they are along the lane.
   */
  hailable(w: SimWorld, lanelet: LaneletId, s0: number, s1: number,
    exclude?: ReadonlySet<number>): { readonly id: number; readonly s: number } | null;
  /**
   * Takes `id` out of the crowd to walk to a door at `door`, if they are
   * still free and within `reach` of it; null otherwise.
   */
  board(w: SimWorld, id: number, door: { readonly x: number; readonly y: number }, reach: number): Boarder | null;
  /** Somebody getting out, standing where they got out, if there is footway there. */
  /** Whether a walker came out (false: nowhere to walk from the door, nobody made). */
  alight(w: SimWorld, person: Boarder): boolean;
  /** Whether anybody other than `except` stands within `radius` of the point. */
  anyoneWithin(w: SimWorld, x: number, y: number, radius: number, except: number | null): boolean;
}
