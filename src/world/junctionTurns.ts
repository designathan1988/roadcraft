import type { BodyClass } from './conflictPoints';
import type { NodeId } from './ids';

/** A turn as `turnPaths.ts` chose it: one cubic's handle, or two cubics through a point inside the junction. */
export type TurnChoice = number | { x: number; y: number; share: number };

/** What the search for a turn answers (`turnPaths.ts` `chooseTurn`): the choice and the largest body it fits. */
export interface ChosenTurn {
  readonly choice: TurnChoice;
  readonly maxBodyClass: BodyClass | -1;
}

/**
 * What a turn is chosen from, as plain numbers, for a worker (`conflictPool.ts`): the arriving and
 * departing lanes and the waiting ones as flat x, y lists (`Polyline.xy`), the junction's surface by
 * its key with its centre and rings, and whether a lane meets a road's end. The same numbers the page
 * would sweep: the turn chosen there is the one chosen here.
 */
export interface TurnAsk {
  /** The lanes' own lists (`Polyline.xy`, never changed once made): not copied here, once by the message. */
  readonly inXY: Float64Array;
  readonly outXY: Float64Array;
  readonly waiting: readonly Float64Array[];
  /** The junction's surface, kept once a key in the plan (`TurnPlan.surfaces`). */
  readonly surfaceKey: string;
  readonly fromRoadEnd: boolean;
  readonly toRoadEnd: boolean;
}

/** A junction's surface as a worker makes it again: its centre and its rings as flat x, y lists. */
export interface SurfaceRings {
  readonly centre: { readonly x: number; readonly y: number };
  readonly rings: readonly Float64Array[];
}

/**
 * The turns of one build of the lane graph chosen off the page (`LaneletGraph.update` with a plan):
 * while `recording`, a turn its junctions do not know is asked here and stood in for; the junctions
 * that stood one in are built again once `chosen` holds the answers (`LaneletGraph.redoProvisional`).
 * DO NOT sweep a generated city's turns on the page: 25 s of one frame on the whole map (2026-10-15).
 */
export class TurnPlan {
  recording = true;
  readonly asks = new Map<string, TurnAsk>();
  /** Each junction surface the asks stand on, once a key. DO NOT copy its rings into every ask: a junction has dozens of turns. */
  readonly surfaces = new Map<string, SurfaceRings>();
  readonly chosen = new Map<string, ChosenTurn>();
  /** The junctions built with a stand-in, and the turns they had. */
  readonly provisional = new Map<NodeId, JunctionTurns>();
}

/**
 * The turns one junction chose (`turnPath`), by what each was chosen from: the
 * junction's own (`lanelets.ts` keeps one per junction with what it built, and
 * hands the one of its last build to the next), so a turn is kept exactly as
 * long as the junction that made it, and goes with it. DO NOT go back to one
 * memo for the whole map with a ceiling that empties it (`MEMO_LIMIT`, then
 * `clear`): past the ceiling every junction of the city chose its turns again.
 */
export class JunctionTurns {
  private readonly made = new Map<string, ChosenTurn>();
  /** Whether a turn of this build was left to be chosen off the page (`TurnPlan`): its junction is built again once chosen. */
  provisional = false;
  /** How many turns this build left to be chosen off the page (`defer`): a movement that left one is shaped again once chosen. */
  deferred = 0;

  /**
   * `before`: the same junction's turns of the build before, read where a movement is unchanged.
   * `plan`: the turns chosen off the page for this build, and where the ones still to choose are asked.
   */
  constructor(private readonly before: JunctionTurns | null = null, readonly plan: TurnPlan | null = null, readonly node: NodeId | null = null) {}

  /** The turn chosen for `key`: this build's, else the build before's, else the plan's (then this build's too). */
  find(key: string): ChosenTurn | undefined {
    let known = this.made.get(key);
    if (known === undefined && this.before) {
      known = this.before.find(key);
      if (known !== undefined) this.made.set(key, known);
    }
    if (known === undefined && this.plan) {
      known = this.plan.chosen.get(key);
      if (known !== undefined) this.made.set(key, known);
    }
    return known;
  }

  /** Whether turns not known are left to be chosen off the page (`defer`) instead of here. */
  get deferring(): boolean {
    return this.plan?.recording === true;
  }

  /** A turn left to be chosen off the page: what it is chosen from, asked once a key; the junction built again after. */
  defer(key: string, ask: () => TurnAsk, surface: () => SurfaceRings): void {
    const plan = this.plan!;
    if (!plan.asks.has(key)) {
      const made = ask();
      plan.asks.set(key, made);
      if (!plan.surfaces.has(made.surfaceKey)) plan.surfaces.set(made.surfaceKey, surface());
    }
    this.provisional = true;
    this.deferred++;
    if (this.node !== null) plan.provisional.set(this.node, this);
  }

  keep(key: string, turn: ChosenTurn): void {
    this.made.set(key, turn);
  }

  /** Done building: the build before is let go, so what this one did not ask for goes with it. */
  settle(): JunctionTurns {
    const settled = new JunctionTurns();
    for (const [key, turn] of this.made) settled.made.set(key, turn);
    return settled;
  }
}
