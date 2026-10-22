import type { ChangeJournal, ChangeKind, ChangeRect } from './changes';
import { CELL } from './cells';
import { JournalCursor } from './derived';

/**
 * THE VIEW'S CELLS: WHAT IS DERIVED FROM THE DOCUMENT, HELD ONLY ROUND THE CAMERA
 *
 * The document stays whole in memory; what a system works out of it (a cover index, the road surfaces' rings) is held cell by cell on
 * the world's fixed grid (`cells.ts`), each cell at a stage: nothing (the document only), derived (its product on the CPU), resident
 * (its product holding GPU bytes too). A product is a pure function of the cell and the document (`derive`), stamped with its
 * generator's version: it can be made again at any moment, so what is far from the camera is let go and made again when wanted.
 *
 * - A view scheduler (`look`, `pump`) asks the cells round the eye nearest first, those in the frustum before those behind, and the
 *   ones ahead of the eye's motion before it gets there (Cesium's `foveatedScreenSpaceError`, Minecraft's ticket levels).
 * - Two separate LRU budgets, one of CPU bytes and one of GPU bytes (Cesium's `cacheBytes` bounds the GPU only, and its CPU tree grew
 *   without bound: both are bounded here). A cell the view wants is never let go for the budget; past it the least recently used go.
 * - The document's diary (`follow`) drops the cells an edit reached, nothing else: an edit costs the cells it touched, not the map.
 *
 * DO NOT keep a product for every cell ever derived: a cell is held by the view or by the budget, never by having been asked once.
 */

/** A cell's key: its column and row on the world's grid (`cells.ts` `cellAt`). */
export type CellKey = number;

/** A cell's stage. */
export const CellStage = { none: 0, derived: 1, resident: 2 } as const;
export type CellStage = (typeof CellStage)[keyof typeof CellStage];

/** What a cell's derivation made: its value, and the bytes it holds on the CPU and on the GPU. */
export interface CellProduct<V> {
  readonly value: V;
  readonly cpuBytes: number;
  /** Bytes on the GPU: a product holding some is resident. */
  readonly gpuBytes?: number;
}

export interface ViewCellsSpec<V> {
  /** For the ledgers and the console. */
  readonly name: string;
  /** The generator's version: a product made by another version is made again. */
  readonly version: number;
  /** The side of the cells, world units: the world's grid by default. */
  readonly side?: number;
  /** How far round the eye the cells are kept derived, world units. */
  readonly reach: number;
  /** The most the products hold on the CPU, bytes (the cells the view wants are kept past it). */
  readonly cpuBudget: number;
  /** The most the products hold on the GPU, bytes. */
  readonly gpuBudget?: number;
  /** The kinds of the document's changes a product reads (`follow`), and how far past a change's rectangle a product may read. */
  readonly kinds?: readonly ChangeKind[];
  readonly pad?: number;
  /** The product of a cell, from the document as it is: a pure function of the cell (and the document). */
  derive(key: CellKey, rect: ChangeRect): CellProduct<V>;
  /** A product let go (out of the budget, or made stale): what it holds elsewhere given back. */
  release?(key: CellKey, value: V): void;
  /** A resident product's GPU share let go, the cell kept derived: its GPU bytes are 0 after it. None: the whole product goes. */
  releaseGpu?(key: CellKey, value: V): void;
}

/** What the cells did since they were made: the products derived, those let go for the budget, those dropped by edits. */
export interface ViewCellsWork {
  derived: number;
  evicted: number;
  invalidated: number;
}

interface Held<V> {
  product: CellProduct<V>;
  version: number;
  stage: CellStage;
}

/** What every held cell costs besides its product: the map entry and its record (a cell with nothing in it is still remembered). */
const ENTRY_BYTES = 96;
/** How far ahead of the eye, in seconds of its motion, the cells are asked before it gets there. */
const LEAD_SECONDS = 1.5;
/** A cell out of the frustum is asked as if this much farther. */
const BEHIND_FACTOR = 2;

const keyOf = (cx: number, cy: number): CellKey => (cx + 32768) * 65536 + (cy + 32768);
const columnOf = (key: CellKey): number => Math.floor(key / 65536) - 32768;
const rowOf = (key: CellKey): number => (key % 65536) - 32768;

/** The eye the view's cells are chosen for: its place on the ground, its motion (world units a second) and its frustum on the plan. */
export interface CellEye {
  readonly x: number;
  readonly y: number;
  readonly vx?: number;
  readonly vy?: number;
  /** Whether a cell's rectangle is in the view; none: every cell is. */
  readonly sees?: (rect: ChangeRect) => boolean;
}

export class ViewCells<V> {
  /** The share of every product's GPU budget (`ViewCellsSpec.gpuBudget`) the quality tier allows (`render/quality.ts` GEOMETRY_BUDGETS, set by the renderer): the far props' and poles' blocks of a weak tier held to a quarter of the ultra tier's. */
  static gpuShare = 1;
  private readonly held = new Map<CellKey, Held<V>>();
  private readonly side: number;
  private readonly cursor: JournalCursor | null;
  /** The cells the view wants, in the order they are asked (nearest, in view, ahead first). */
  private wanted: CellKey[] = [];
  private readonly wantedSet = new Set<CellKey>();
  /** Bytes the held products hold now. */
  cpuBytes = 0;
  gpuBytes = 0;
  readonly work: ViewCellsWork = { derived: 0, evicted: 0, invalidated: 0 };
  /** Moves whenever a held product is dropped for a change of the document (`invalidate`): what the products answer may differ since. */
  version = 0;

  constructor(readonly spec: ViewCellsSpec<V>) {
    this.side = spec.side ?? CELL;
    this.cursor = spec.kinds ? new JournalCursor(spec.kinds) : null;
  }

  /** The key of the cell holding a point. */
  cellAt(x: number, y: number): CellKey {
    return keyOf(Math.floor(x / this.side), Math.floor(y / this.side));
  }

  /** The rectangle a cell covers. */
  rectOf(key: CellKey): ChangeRect {
    const x0 = columnOf(key) * this.side, y0 = rowOf(key) * this.side;
    return [x0, y0, x0 + this.side, y0 + this.side];
  }

  /** Calls `visit` with every cell a rectangle reaches. */
  forCellsOver(rect: ChangeRect, visit: (key: CellKey) => void): void {
    const cx0 = Math.floor(rect[0] / this.side), cx1 = Math.floor(rect[2] / this.side);
    const cy0 = Math.floor(rect[1] / this.side), cy1 = Math.floor(rect[3] / this.side);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) visit(keyOf(cx, cy));
  }

  /** The cells held (any order). */
  keys(): IterableIterator<CellKey> {
    return this.held.keys();
  }

  get size(): number {
    return this.held.size;
  }

  stageOf(key: CellKey): CellStage {
    return this.held.get(key)?.stage ?? CellStage.none;
  }

  /** Whether a cell's product is held (made by this generator). */
  has(key: CellKey): boolean {
    return this.held.get(key)?.version === this.spec.version;
  }

  /** A held cell's value, the cell made the most recently used; undefined when it is not held. */
  peek(key: CellKey): V | undefined {
    const known = this.held.get(key);
    if (!known || known.version !== this.spec.version) return undefined;
    this.touch(key, known);
    return known.product.value;
  }

  /** A cell's value, derived now if it is not held: what a question about a place far from the view costs (one cell), never the map. */
  ensure(key: CellKey): V {
    const known = this.held.get(key);
    if (known && known.version === this.spec.version) {
      this.touch(key, known);
      return known.product.value;
    }
    const value = this.make(key);
    this.trim(new Set([key]));
    return value;
  }

  /** Several cells derived if not held, and kept to the budgets only once all are in: none of them let go for another of them. */
  ensureMany(keys: Iterable<CellKey>): void {
    const asked = new Set(keys);
    let made = false;
    for (const key of asked) {
      const known = this.held.get(key);
      if (known && known.version === this.spec.version) { this.touch(key, known); continue; }
      this.make(key);
      made = true;
    }
    if (made) this.trim(asked);
  }

  /** The cells the view wants: those within `reach` of the eye and of where its motion takes it, ordered nearest, in view, ahead first. */
  look(eye: CellEye): void {
    const reach = this.spec.reach;
    const ahead = { x: eye.x + (eye.vx ?? 0) * LEAD_SECONDS, y: eye.y + (eye.vy ?? 0) * LEAD_SECONDS };
    const score = new Map<CellKey, number>();
    const consider = (at: { x: number; y: number }, extra: number): void => {
      this.forCellsOver([at.x - reach, at.y - reach, at.x + reach, at.y + reach], (key) => {
        const rect = this.rectOf(key);
        const dx = Math.max(rect[0] - at.x, 0, at.x - rect[2]), dy = Math.max(rect[1] - at.y, 0, at.y - rect[3]);
        const d = Math.hypot(dx, dy);
        if (d > reach) return;
        const s = (d + extra) * (eye.sees && !eye.sees(rect) ? BEHIND_FACTOR : 1);
        const was = score.get(key);
        if (was === undefined || s < was) score.set(key, s);
      });
    };
    consider(eye, 0);
    // The cells ahead of the motion, asked after the ones at the eye at the same distance.
    if (ahead.x !== eye.x || ahead.y !== eye.y) consider(ahead, this.side / 2);
    this.wanted = [...score.keys()].sort((a, b) => score.get(a)! - score.get(b)! || a - b);
    this.wantedSet.clear();
    for (const key of this.wanted) this.wantedSet.add(key);
  }

  /** The cells the view wants given as they are (a layer that chooses its own: a square round the eye, the blocks a frustum sees), in the order they are asked. */
  want(keys: readonly CellKey[]): void {
    // Copied into its own list, kept from look to look (asked every frame of a move): never a new array each time.
    const wanted = this.wanted;
    // Its own list handed back (`wantedKeys`): nothing to copy, and emptying it first would empty what it reads.
    if (keys !== wanted) {
      wanted.length = 0;
      for (const key of keys) wanted.push(key);
    }
    this.wantedSet.clear();
    for (const key of this.wanted) this.wantedSet.add(key);
  }

  /** A held product's bytes set again: what it holds on the CPU and the GPU now (its arrays let go once on the GPU, `mesh/gpuOnly.ts`). */
  account(key: CellKey, cpuBytes: number, gpuBytes: number): void {
    const known = this.held.get(key);
    if (!known) return;
    this.cpuBytes += cpuBytes - known.product.cpuBytes;
    this.gpuBytes += gpuBytes - (known.product.gpuBytes ?? 0);
    known.product = { value: known.product.value, cpuBytes, gpuBytes };
    known.stage = gpuBytes > 0 ? CellStage.resident : CellStage.derived;
  }

  /** These cells dropped, made again when next wanted or asked (what they answer changed without an entry of the diary: the city's hour). The cells dropped. */
  forget(keys: Iterable<CellKey>): number {
    let n = 0;
    for (const key of keys) if (this.held.has(key)) { this.drop(key); n++; }
    this.work.invalidated += n;
    if (n) this.version++;
    return n;
  }

  /** The cells the view wants (`look`), in their order. */
  get wantedKeys(): readonly CellKey[] {
    return this.wanted;
  }

  /** Derives up to `most` of the cells the view wants that are not held, first in the view's order; then keeps to the budgets. The cells derived. */
  pump(most = Infinity): number {
    let made = 0;
    for (const key of this.wanted) {
      if (made >= most) break;
      if (this.has(key)) continue;
      this.make(key);
      made++;
    }
    this.trim(null);
    return made;
  }

  /** The cells a change reached (its rectangles grown by the spec's `pad`) dropped, made again when next wanted or asked. The cells dropped. */
  invalidate(rects: readonly ChangeRect[]): number {
    const pad = this.spec.pad ?? 0;
    const hit = new Set<CellKey>();
    for (const r of rects) this.forCellsOver([r[0] - pad, r[1] - pad, r[2] + pad, r[3] + pad], (key) => { if (this.held.has(key)) hit.add(key); });
    for (const key of hit) this.drop(key);
    this.work.invalidated += hit.size;
    if (hit.size) this.version++;
    return hit.size;
  }

  /** Every held cell dropped (a map loaded, a diary that cannot say where). */
  clear(): void {
    const n = this.held.size;
    for (const key of [...this.held.keys()]) this.drop(key);
    this.work.invalidated += n;
    this.version++;
  }

  /** The document's changes since the last look, read off its diary: the cells they reached dropped (everything, when it cannot say where). The cells dropped. */
  follow(journal: ChangeJournal): number {
    if (!this.cursor) return 0;
    const entries = this.cursor.read(journal);
    if (entries === null) { const n = this.held.size; this.clear(); return n; }
    const rects: ChangeRect[] = [];
    for (const e of entries) {
      if (e.rects === null) { const n = this.held.size; this.clear(); return n; }
      rects.push(...e.rects);
    }
    return rects.length ? this.invalidate(rects) : 0;
  }

  /** Keeps the products to the budgets: the least recently used out first, never a cell the view wants nor one of `keep`. `cpuBudget`: a lower one to rest at (after a build swept the map). */
  trim(keep: ReadonlySet<CellKey> | null, cpuBudget = this.spec.cpuBudget): void {
    const gpuBudget = (this.spec.gpuBudget ?? Infinity) * ViewCells.gpuShare;
    if (this.gpuBytes > gpuBudget) {
      for (const [key, held] of this.held) {
        if (this.gpuBytes <= gpuBudget) break;
        if (keep?.has(key) || this.wantedSet.has(key) || !(held.product.gpuBytes ?? 0)) continue;
        if (this.spec.releaseGpu) {
          this.spec.releaseGpu(key, held.product.value);
          this.gpuBytes -= held.product.gpuBytes ?? 0;
          held.product = { value: held.product.value, cpuBytes: held.product.cpuBytes };
          held.stage = CellStage.derived;
        } else this.drop(key);
        this.work.evicted++;
      }
    }
    if (this.cpuBytes <= cpuBudget) return;
    for (const key of [...this.held.keys()]) {
      if (this.cpuBytes <= cpuBudget) break;
      if (keep?.has(key) || this.wantedSet.has(key)) continue;
      this.drop(key);
      this.work.evicted++;
    }
  }

  private make(key: CellKey): V {
    const known = this.held.get(key);
    if (known) this.drop(key);
    const product = this.spec.derive(key, this.rectOf(key));
    this.work.derived++;
    const gpu = product.gpuBytes ?? 0;
    this.held.set(key, { product, version: this.spec.version, stage: gpu > 0 ? CellStage.resident : CellStage.derived });
    this.cpuBytes += product.cpuBytes + ENTRY_BYTES;
    this.gpuBytes += gpu;
    return product.value;
  }

  private drop(key: CellKey): void {
    const known = this.held.get(key);
    if (!known) return;
    this.held.delete(key);
    this.cpuBytes -= known.product.cpuBytes + ENTRY_BYTES;
    this.gpuBytes -= known.product.gpuBytes ?? 0;
    this.spec.release?.(key, known.product.value);
  }

  /** The cell made the most recently used (last in the map's order, MDN: a key deleted and set again is inserted anew). */
  private touch(key: CellKey, known: Held<V>): void {
    this.held.delete(key);
    this.held.set(key, known);
  }
}
