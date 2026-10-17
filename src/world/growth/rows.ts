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

/** The rows of the buildings `keep` names, in their order (a tile written again with the grown buildings no edit touched, `RoadDoc.tileRecords`). */
export function selectRows(rows: GrownRows, keep: ReadonlySet<number>): GrownRows {
  const out = { version: rows.version, id: [] as number[], lot: [] as number[], state: [] as number[], pick: [] as number[], floor: [] as (number | null)[],
    reach: [] as number[], nbEnd: [] as number[], nb: [] as number[], dropEnd: [] as number[], drop: [] as number[], streams: rows.streams ? [] as number[] : undefined };
  for (let k = 0; k < rows.id.length; k++) {
    if (!keep.has(rows.id[k]!)) continue;
    out.id.push(rows.id[k]!); out.lot.push(rows.lot[k]!);
    for (let w = 0; w < 4; w++) out.state.push(rows.state[k * 4 + w]!);
    for (let w = 0; w < 5; w++) out.pick.push(rows.pick[k * 5 + w]!);
    out.floor.push(rows.floor[k]!); out.reach.push(rows.reach[k]!);
    for (let i = k ? rows.nbEnd[k - 1]! : 0; i < rows.nbEnd[k]!; i++) out.nb.push(rows.nb[i]!);
    out.nbEnd.push(out.nb.length);
    for (let i = k ? rows.dropEnd[k - 1]! : 0; i < rows.dropEnd[k]!; i++) out.drop.push(rows.drop[i]!);
    out.dropEnd.push(out.drop.length);
    if (rows.streams && out.streams) for (let w = 0; w < 8; w++) out.streams.push(rows.streams[k * 8 + w]!);
  }
  const { streams, ...rest } = out;
  return streams ? { ...rest, streams } : rest;
}
