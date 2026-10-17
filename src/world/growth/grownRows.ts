import type { Lot } from '@world/lots';
import type { TileRecords } from '@world/doc';
import type { GrownRows } from './rows';
import { type GrownChoice, LOT_PLAN_VERSION, replayOnLot } from './zoning';

/** A TILE'S GROWN BUILDINGS PACKED AND MADE AGAIN (`rows.ts`): the generator packs what it grew (`packGrown`), every reader of a tile's buildings takes them made again from their lots (`tileBuildingsOf`) - the page's document, the far levels, the simulation's sections - and nothing holds the records of a tile it does not read */

/** The flat land a generated tile is grown on (`wholeMapTile.ts`): what its buildings are made again on. */
const FLAT = (): number => 0;

/** Buildings grown, each with its lot and its choices, packed in columns. */
export function packGrown(grown: readonly { readonly id: number; readonly lot: number; readonly choice: GrownChoice }[]): GrownRows {
  const id: number[] = [], lot: number[] = [], state: number[] = [], pick: number[] = [], floor: (number | null)[] = [], reach: number[] = [];
  const nbEnd: number[] = [], nb: number[] = [], dropEnd: number[] = [], drop: number[] = [];
  // The kept candidate's streams only when every row has them: a row without would read another's.
  const streams: number[] | null = grown.every((g) => g.choice.keptState && g.choice.afterState) ? [] : null;
  for (const g of grown) {
    const c = g.choice;
    id.push(g.id); lot.push(g.lot);
    state.push(...c.state);
    pick.push(c.density, c.attempt, c.corner, c.made, c.kept);
    floor.push(Number.isFinite(c.floor) ? c.floor : null);
    reach.push(c.reach);
    nb.push(...c.neighbours); nbEnd.push(nb.length);
    drop.push(...c.dropped); dropEnd.push(drop.length);
    if (streams) streams.push(...c.keptState!, ...c.afterState!);
  }
  return { version: LOT_PLAN_VERSION, id, lot, state, pick, floor, reach, nbEnd, nb, dropEnd, drop, ...(streams ? { streams } : {}) };
}

/** Row `k`'s choices. */
function choiceOf(rows: GrownRows, k: number): GrownChoice {
  const s = rows.state, p = rows.pick;
  const nb0 = k ? rows.nbEnd[k - 1]! : 0, drop0 = k ? rows.dropEnd[k - 1]! : 0;
  return {
    state: [s[k * 4]!, s[k * 4 + 1]!, s[k * 4 + 2]!, s[k * 4 + 3]!],
    density: p[k * 5]!, attempt: p[k * 5 + 1]!, corner: p[k * 5 + 2]! as 0 | 1 | 2, made: p[k * 5 + 3]!, kept: p[k * 5 + 4]!,
    neighbours: rows.nb.slice(nb0, rows.nbEnd[k]), floor: rows.floor[k] ?? Number.NaN, reach: rows.reach[k] as 0 | 1,
    dropped: rows.drop.slice(drop0, rows.dropEnd[k]),
    ...(rows.streams ? {
      keptState: [rows.streams[k * 8]!, rows.streams[k * 8 + 1]!, rows.streams[k * 8 + 2]!, rows.streams[k * 8 + 3]!] as const,
      afterState: [rows.streams[k * 8 + 4]!, rows.streams[k * 8 + 5]!, rows.streams[k * 8 + 6]!, rows.streams[k * 8 + 7]!] as const,
    } : {}),
  };
}

let warned = false;

/** The rows made records again on their lots, stamped as the generator stamped them (built at the city's first minute, new); a row of another generator, or whose lot is not among `lots`, is left out (said once). */
export function grownRecords(rows: GrownRows | undefined, lots: readonly Lot[]): unknown[] {
  if (!rows || rows.id.length === 0) return [];
  const out: unknown[] = [];
  let lost = 0;
  if (rows.version !== LOT_PLAN_VERSION) lost = rows.id.length;
  else {
    const lotOf = new Map<number, Lot>();
    for (const l of lots) lotOf.set(l.id, l);
    for (let k = 0; k < rows.id.length; k++) {
      const lot = lotOf.get(rows.lot[k]!);
      const record = lot ? replayOnLot(lot, choiceOf(rows, k), FLAT) : null;
      if (!record) { lost++; continue; }
      out.push({ ...record, id: rows.id[k]!, builtAt: 0, decay: 0, lotPlan: rows.version });
    }
  }
  if (lost && !warned) {
    warned = true;
    console.warn(`[tiles] ${lost} grown buildings could not be made again (generator ${rows.version}, now ${LOT_PLAN_VERSION})`);
  }
  return out;
}

/** Every building of a tile: its records and its grown rows made again. */
export function tileBuildingsOf(records: Pick<TileRecords, 'buildings' | 'grown' | 'lots'>): readonly unknown[] {
  return records.grown?.id.length ? [...records.buildings, ...grownRecords(records.grown, records.lots)] : records.buildings;
}

/** The tile with its grown rows made records (for whoever reads `buildings` whole: a write's bakes, a tile prepared for the page). */
export function withGrownBuildings(records: TileRecords): TileRecords {
  if (!records.grown?.id.length) return records;
  const { grown: _grown, ...rest } = records;
  return { ...rest, buildings: tileBuildingsOf(records) };
}
