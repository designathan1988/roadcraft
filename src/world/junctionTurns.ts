import type { NodeId } from './ids';

// The turn's question and answer as a worker reads them live with the measurer's interface
// (`conflictTable.ts`): here they are only named. DO NOT define them here: `conflictTable.ts`
// importing this file closed an import cycle through `conflictPoints.ts`.
export type { ChosenTurn, SurfaceRings, TurnAsk, TurnChoice } from './conflictTable';
import type { ChosenTurn, SurfaceRings, TurnAsk } from './conflictTable';

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

  /** The turns it holds, in the order found: what a worker is sent and answers (`junctionBuild.ts`). */
  entries(): [string, ChosenTurn][] {
    return [...this.made];
  }

  /** A settled junction's turns from `entries` (a worker's answer, or what it is sent). */
  static of(entries: readonly (readonly [string, ChosenTurn])[]): JunctionTurns {
    const turns = new JunctionTurns();
    for (const [key, turn] of entries) turns.made.set(key, turn);
    return turns;
  }
}
