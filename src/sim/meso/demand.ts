import type { ChangeJournal } from '@world/changes';
import { m } from '@world/units';
import type { TrafficBuilding, TrafficBuildings } from '../agents/trafficBuildings';
import { CARS, busy, kindOf, type Mix } from '../ambient/demand';
import { buildingsChangedSince, cellKey } from '../ambient/ambientIndex';

/** WHAT THE LAND USE PUTS ON THE STREETS, BY THE WORLD'S 256 m CELL: the meso traffic's trips start and end where the buildings are */

/** The world's cell (CLAUDE.md, one grid). */
export const DEMAND_CELL = m(256);
/** Numbers a cell takes in a tile's baked counts (`tileLinks.ts` cells): its key, then its buildings by kind (home, shop, work, civic) and in all. */
export const CELL_STRIDE = 6;
/** Buildings in a cell at which its streets carry the ambient's full density (`ambient/demand.ts` CARS); fewer, in proportion. */
const FULL_CELL = 24;
const KINDS: readonly (keyof Mix)[] = ['home', 'shop', 'work', 'civic'];

/** Each cell's buildings by kind (`kindOf`): the simulation's own (the page's tiles) kept by the diary, and the far tiles' as their link tables bring them. */
export class DemandCells {
  private serial = -1;
  private readonly byBuilding = new Map<number, { readonly cell: number; readonly kind: number }>();
  /** By cell: home, shop, work, civic, all. */
  private readonly cells = new Map<number, Float64Array>();
  /** The far tiles' counts by tile (`CELL_STRIDE` a cell), and summed by cell. */
  private readonly farTiles = new Map<number, Float64Array>();
  private readonly far = new Map<number, Float64Array>();
  /** The cells' busyness of the hour (`busy`), by kind, set by `atHour`. */
  private readonly now = new Float64Array(4);

  sync(store: TrafficBuildings, journal: ChangeJournal): void {
    const changed = buildingsChangedSince(journal, this.serial);
    this.serial = journal.version;
    if (changed === null) {
      // @rebuild A map opened, or a diary that forgot: every building read again.
      this.byBuilding.clear();
      this.cells.clear();
      for (const b of store.all()) this.file(b.id, b);
      return;
    }
    for (const id of changed) {
      this.unfile(id);
      const b = store.get(id as never);
      if (b) this.file(id, b);
    }
  }

  /** A far tile's buildings by cell (`tileLinks.ts` cells), in place of what it brought before. */
  setFar(tile: number, counts: Float64Array): void {
    this.dropFar(tile);
    this.farTiles.set(tile, counts);
    this.addFar(counts, 1);
  }

  /** A far tile's buildings gone (it came into the simulation's own map, or out of the meso's reach). */
  dropFar(tile: number): void {
    const counts = this.farTiles.get(tile);
    if (!counts) return;
    this.farTiles.delete(tile);
    this.addFar(counts, -1);
  }

  /** The cell a point is in. */
  cellOf(x: number, y: number): number {
    return cellKey(Math.floor(x / DEMAND_CELL), Math.floor(y / DEMAND_CELL));
  }

  /** The hour of the day the next questions are asked at. */
  atHour(hour: number): void {
    KINDS.forEach((kind, k) => { this.now[k] = busy(kind, hour); });
  }

  /** Cars per 100 m of street the cell's buildings put on it at the hour, scaled by how built it is (none in an empty cell). */
  carsPer100m(cell: number): number {
    const c = this.cells.get(cell), f = this.far.get(cell);
    if (!c && !f) return 0;
    let sum = 0;
    KINDS.forEach((kind, k) => { sum += CARS[kind] * ((c?.[k] ?? 0) + (f?.[k] ?? 0)) * this.now[k]!; });
    return sum / Math.max((c?.[4] ?? 0) + (f?.[4] ?? 0), FULL_CELL);
  }

  /** How built the cell is, 0 to 1: the share of trips its streets end. */
  weight(cell: number): number {
    const all = (this.cells.get(cell)?.[4] ?? 0) + (this.far.get(cell)?.[4] ?? 0);
    return Math.min(1, all / FULL_CELL);
  }

  private addFar(counts: Float64Array, sign: 1 | -1): void {
    for (let at = 0; at + CELL_STRIDE <= counts.length; at += CELL_STRIDE) {
      const cell = counts[at]!;
      let f = this.far.get(cell);
      if (!f) this.far.set(cell, f = new Float64Array(5));
      for (let k = 0; k < 5; k++) f[k] = f[k]! + sign * counts[at + 1 + k]!;
      if (f[4]! <= 0) this.far.delete(cell);
    }
  }

  private file(id: number, b: TrafficBuilding): void {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
    const cell = this.cellOf(b.x, b.y), kind = KINDS.indexOf(kindOf(b));
    this.byBuilding.set(id, { cell, kind });
    let c = this.cells.get(cell);
    if (!c) this.cells.set(cell, c = new Float64Array(5));
    c[kind] = c[kind]! + 1;
    c[4] = c[4]! + 1;
  }

  private unfile(id: number): void {
    const f = this.byBuilding.get(id);
    if (!f) return;
    this.byBuilding.delete(id);
    const c = this.cells.get(f.cell);
    if (!c) return;
    c[f.kind] = c[f.kind]! - 1;
    c[4] = c[4]! - 1;
    if (c[4]! <= 0) this.cells.delete(f.cell);
  }
}
