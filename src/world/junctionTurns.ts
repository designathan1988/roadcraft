import type { BodyClass } from './conflictPoints';

/** A turn as `turnPaths.ts` chose it: one cubic's handle, or two cubics through a point inside the junction. */
export type TurnChoice = number | { x: number; y: number; share: number };

/**
 * The turns one junction chose (`turnPath`), by what each was chosen from: the
 * junction's own (`lanelets.ts` keeps one per junction with what it built, and
 * hands the one of its last build to the next), so a turn is kept exactly as
 * long as the junction that made it, and goes with it. DO NOT go back to one
 * memo for the whole map with a ceiling that empties it (`MEMO_LIMIT`, then
 * `clear`): past the ceiling every junction of the city chose its turns again.
 */
export class JunctionTurns {
  private readonly made = new Map<string, { readonly choice: TurnChoice; readonly maxBodyClass: BodyClass | -1 }>();

  /** `before`: the same junction's turns of the build before, read where a movement is unchanged. */
  constructor(private readonly before: JunctionTurns | null = null) {}

  /** The turn chosen for `key`: this build's, else the build before's (then this build's too). */
  find(key: string): { readonly choice: TurnChoice; readonly maxBodyClass: BodyClass | -1 } | undefined {
    let known = this.made.get(key);
    if (known === undefined && this.before) {
      known = this.before.made.get(key);
      if (known !== undefined) this.made.set(key, known);
    }
    return known;
  }

  keep(key: string, turn: { readonly choice: TurnChoice; readonly maxBodyClass: BodyClass | -1 }): void {
    this.made.set(key, turn);
  }

  /** Done building: the build before is let go, so what this one did not ask for goes with it. */
  settle(): JunctionTurns {
    const settled = new JunctionTurns();
    for (const [key, turn] of this.made) settled.made.set(key, turn);
    return settled;
  }
}
