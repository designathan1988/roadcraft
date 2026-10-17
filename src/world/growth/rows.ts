/** THE BUILDINGS A TILE'S GENERATOR GREW, AS ROWS (the city-game's record: a few numbers a building and a versioned generator): each the choices `designOnLot` made on its lot (`zoning.ts` `GrownChoice`), in columns of plain numbers - what the store keeps and the threads post, made into records again by `replayOnLot` where they are read (`grownRows.ts`) */
export interface GrownRows {
  /** The lot generator they were grown by (`LOT_PLAN_VERSION`): another one does not make them again. */
  readonly version: number;
  /** Each building's id and its lot's. */
  readonly id: readonly number[];
  readonly lot: readonly number[];
  /** Four words a row: the stream at the start of its try (`Rng.state`). */
  readonly state: readonly number[];
  /** Five a row: its density, its try, its corner, the candidates made and the one kept. */
  readonly pick: readonly number[];
  /** Its ground floor over the street, world units; null where its try read none. */
  readonly floor: readonly (number | null)[];
  /** 1 when its front reaches the street. */
  readonly reach: readonly number[];
  /** The storeys beside each front, one list after another, each row's list ending at `nbEnd`. */
  readonly nbEnd: readonly number[];
  readonly nb: readonly number[];
  /** The boundary pieces left out of each, the same way. */
  readonly dropEnd: readonly number[];
  readonly drop: readonly number[];
  /** Eight words a row: the stream at the start of the candidate kept and after the candidates (`GrownChoice.keptState`, `afterState`); absent in a tile grown before them, whose rows are replayed candidate by candidate. */
  readonly streams?: readonly number[];
}
