import type { ChangeJournal } from '@world/changes';
import { m } from '@world/units';
import type { TrafficBuilding, TrafficBuildings } from '../agents/trafficBuildings';
import { CARS, busy, kindOf, type Mix } from '../ambient/demand';
import { buildingsChangedSince, cellKey } from '../ambient/ambientIndex';

/** WHAT THE LAND USE PUTS ON THE STREETS, BY THE WORLD'S 256 m CELL: the meso traffic's trips start and end where the buildings are */

/** The world's cell (CLAUDE.md, one grid). */
export const DEMAND_CELL = m(256);
/** Buildings in a cell at which its streets carry the ambient's full density (`ambient/demand.ts` CARS); fewer, in proportion. */
const FULL_CELL = 24;
const KINDS: readonly (keyof Mix)[] = ['home', 'shop', 'work', 'civic'];
/** Numbers a cell keeps: its buildings by kind (home, shop, work, civic), then in all. */
const STRIDE = 5;

/**
 * Each cell's buildings by kind (`kindOf`), kept by the diary.
 * DO NOT ask a Map by a cell's key on the meso's step: a cell gets a dense index once (`cellOf`, when a link is placed or a building
 * filed), and its numbers live in typed arrays by that index, so the step reads arrays only (`carsPer100m`, `weight`).
 */
export class DemandCells {
  /** The diary read by serial, not followed (a reader that stops reading would keep every entry after it). */
  private serial = -1;
  private readonly byBuilding = new Map<number, { readonly cell: number; readonly kind: number }>();
  /** Each cell key's dense index; indexes are never given back (a cell is a 256 m square: a city has a few thousand). */
  private readonly index = new Map<number, number>();
  private counts = new Float64Array(64 * STRIDE);
  /** The cells' busyness of the hour (`busy`), by kind, set by `atHour`. */
  private readonly now = new Float64Array(4);

  /** Cells given an index so far: every index below it is valid. */
  get cells(): number {
    return this.index.size;
  }

  sync(store: TrafficBuildings, journal: ChangeJournal): void {
    const changed = buildingsChangedSince(journal, this.serial);
    this.serial = journal.version;
    if (changed === null) {
      // @rebuild A map opened, or a diary that forgot: every building read again.
      this.byBuilding.clear();
      this.counts.fill(0);
      for (const b of store.all()) this.file(b.id, b);
      return;
    }
    for (const id of changed) {
      this.unfile(id);
      const b = store.get(id as never);
      if (b) this.file(id, b);
    }
  }

  /** The dense index of the cell a point is in (made on first ask). */
  cellOf(x: number, y: number): number {
    const key = cellKey(Math.floor(x / DEMAND_CELL), Math.floor(y / DEMAND_CELL));
    let at = this.index.get(key);
    if (at === undefined) {
      at = this.index.size;
      this.index.set(key, at);
      if ((at + 1) * STRIDE > this.counts.length) {
        const grown = new Float64Array(this.counts.length * 2);
        grown.set(this.counts);
        this.counts = grown;
      }
    }
    return at;
  }

  /** The hour of the day the next questions are asked at. */
  atHour(hour: number): void {
    for (let k = 0; k < KINDS.length; k++) this.now[k] = busy(KINDS[k]!, hour);
  }

  /** Cars per 100 m of street the cell's buildings put on it at the hour, scaled by how built it is (none in an empty cell). */
  carsPer100m(cell: number): number {
    const c = this.counts, at = cell * STRIDE;
    if (cell < 0 || at >= c.length || c[at + 4]! <= 0) return 0;
    let sum = 0;
    for (let k = 0; k < KINDS.length; k++) sum += CARS[KINDS[k]!] * c[at + k]! * this.now[k]!;
    return sum / Math.max(c[at + 4]!, FULL_CELL);
  }

  /** How built the cell is, 0 to 1: the share of trips its streets end. */
  weight(cell: number): number {
    const at = cell * STRIDE;
    return cell < 0 || at >= this.counts.length ? 0 : Math.min(1, this.counts[at + 4]! / FULL_CELL);
  }

  private file(id: number, b: TrafficBuilding): void {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
    const cell = this.cellOf(b.x, b.y), kind = KINDS.indexOf(kindOf(b));
    this.byBuilding.set(id, { cell, kind });
    const at = cell * STRIDE;
    this.counts[at + kind] = this.counts[at + kind]! + 1;
    this.counts[at + 4] = this.counts[at + 4]! + 1;
  }

  private unfile(id: number): void {
    const f = this.byBuilding.get(id);
    if (!f) return;
    this.byBuilding.delete(id);
    const at = f.cell * STRIDE;
    this.counts[at + f.kind] = this.counts[at + f.kind]! - 1;
    this.counts[at + 4] = this.counts[at + 4]! - 1;
  }
}
