import { MAP_REGIONS, plateOf } from '@world/bounds';
import { type ReliefVersion, reliefHeight } from '@world/terrain';
import { sampleCorners } from './terrainShaping';

/** THE GROUND'S HEIGHTS IN SHARED MEMORY: each plate's corners as drawn and as they were before the roads, the plate's own arrays (`terrain.ts`), read by any worker as the page reads them (`flatAtlas.ts`) */

/** One plate's corners and the diagonals they are drawn with, as drawn (`renderedHeightAt`) and natural (`naturalRenderedHeightAt`). */
export interface PlateHeights {
  readonly rendered: Float64Array;
  readonly natural: Float64Array;
  readonly flip: Uint8Array;
  readonly naturalFlip: Uint8Array;
}

/** What a job reads the ground from: each plate's buffer (null: a plate not made, read off the relief), its grid and the relief. */
export interface SharedGroundData {
  /** Corners a side, the cell, half the plate, the base level the corners carry. */
  readonly n: number;
  readonly cell: number;
  readonly half: number;
  readonly base: number;
  readonly relief: ReliefVersion | null;
  /** By plate (`world/bounds.ts` `MAP_REGIONS`). */
  readonly plates: readonly (SharedArrayBuffer | null)[];
}

/** The ground as a building reads it: as drawn, and as it was before the roads cut it. */
export interface GroundReaders {
  readonly groundAt: (x: number, y: number) => number;
  readonly naturalAt: (x: number, y: number) => number;
}

/** The ground as drawn, as the page reads it, with the shared plates it reads (`flatAtlas.ts` `renderedHeightAt`): a job handed it reads the same ground in a worker. */
export interface SharedGroundAt {
  (x: number, y: number): number;
  readonly share?: GroundShare;
}

/** Whether memory can be shared with the workers: a cross-origin isolated page (MDN, `SharedArrayBuffer`, COOP/COEP), or Node. */
function canShareMemory(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false;
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
}

/** A plate's bytes: two corner arrays of doubles, two diagonal arrays of bytes. */
const plateBytes = (n: number): number => n * n * 16 + (n - 1) * (n - 1) * 2;

/** A plate's arrays over its buffer, laid one after the other. */
function viewsOf(buffer: SharedArrayBuffer, n: number): PlateHeights {
  const corners = n * n, cells = (n - 1) * (n - 1);
  return {
    rendered: new Float64Array(buffer, 0, corners),
    natural: new Float64Array(buffer, corners * 8, corners),
    flip: new Uint8Array(buffer, corners * 16, cells),
    naturalFlip: new Uint8Array(buffer, corners * 16 + cells, cells),
  };
}

/** DO NOT copy the plates' heights for the workers: the plate writes its corners into the shared buffer itself, a stroke or a road reaching the workers as it lands, no message */
export class GroundShare {
  private readonly buffers: (SharedArrayBuffer | null)[] = MAP_REGIONS.map(() => null);
  private relief: ReliefVersion | null = null;
  /** What jobs are handed, made again only when a plate is made or let go, or the relief changes. */
  private data: SharedGroundData | null = null;
  private readonly shared = canShareMemory();

  constructor(private readonly n: number, private readonly cell: number, private readonly half: number, private readonly base: number) {}

  /** A plate made: the arrays it keeps its corners in, shared (null where memory cannot be shared: the plate makes its own). */
  open(index: number): PlateHeights | null {
    if (!this.shared || index < 0 || index >= this.buffers.length) return null;
    const buffer = new SharedArrayBuffer(plateBytes(this.n));
    this.buffers[index] = buffer;
    this.data = null;
    return viewsOf(buffer, this.n);
  }

  /** A plate let go: read off the relief from now on, as the page reads it. */
  close(index: number): void {
    if (!this.buffers[index]) return;
    this.buffers[index] = null;
    this.data = null;
  }

  setRelief(relief: ReliefVersion | null): void {
    if (relief === this.relief) return;
    this.relief = relief;
    this.data = null;
  }

  /** What a job reads the ground from; null where memory cannot be shared. */
  get current(): SharedGroundData | null {
    if (!this.shared) return null;
    return this.data ??= { n: this.n, cell: this.cell, half: this.half, base: this.base, relief: this.relief, plates: this.buffers.slice() };
  }
}

/** The ground read off the shared plates, point for point as `flatAtlas.ts` `ask` and `terrain.ts` `sampleGrid` read it on the page */
export function sharedGroundReaders(data: SharedGroundData): GroundReaders {
  const grid = { n: data.n, cell: data.cell, half: data.half };
  const views: (PlateHeights | null | undefined)[] = data.plates.map(() => undefined);
  const viewOf = (index: number): PlateHeights | null => {
    let v = views[index];
    if (v === undefined) {
      const buffer = data.plates[index];
      views[index] = v = buffer ? viewsOf(buffer, data.n) : null;
    }
    return v;
  };
  /** A plate not made: the base and the map's own relief (`flatAtlas.ts` `bareAt`). */
  const bare = (x: number, y: number): number => data.base + (data.relief === null ? 0 : reliefHeight(data.relief, x, y));
  const read = (natural: boolean) => (x: number, y: number): number => {
    const index = plateOf(x, y);
    const c = MAP_REGIONS[index]!;
    const lx = x - c.cx, ly = y - c.cy;
    const v = viewOf(index);
    // Off the map the page reads the edge plate's stamps; here its relief (no building stands there).
    if (!v || !(lx >= -data.half && lx <= data.half && ly >= -data.half && ly <= data.half)) return bare(c.cx + lx, c.cy + ly);
    return natural ? sampleCorners(grid, v.natural, v.naturalFlip, lx, ly) : sampleCorners(grid, v.rendered, v.flip, lx, ly);
  };
  return { groundAt: read(false), naturalAt: read(true) };
}
