import type { PoleId, SpanId } from '@world/ids';
import type { Network } from '@world/network';
import { cellAt } from '@world/cells';
import { kerbward } from '@world/poleLines';
import { m } from '@world/units';
import { POLE_HEIGHT, type PoleArms, poleArmsAt, type UtilityPole, type UtilitySpan } from '@world/utilities';
import { POLE_PART_COUNT, type Placement, SPAN_WIRES, WIRE_STRIDE, placePole, spanWires, writePlacement } from './utilities';

/** THE POLES AND WIRES BAKED OFF THE PAGE (`poleTiles.ts`, in a worker), and what the page's layer and a bake share: a pole's frame, a wire's ends, a cell's bounds (`poleLayer.ts` draws both) */
/** What a pole layer is built from: the document's poles and spans, or a planned run (`buildPolePreview`). */
export interface PoleSource {
  readonly poles: ReadonlyMap<PoleId, UtilityPole>;
  readonly spans: ReadonlyMap<SpanId, UtilitySpan>;
  /** The spans reaching a pole, in the order they were strung (`RoadDoc.spansAt`). */
  spansAt(id: PoleId): Iterable<UtilitySpan>;
  /** Which poles get a mast, arms and lamp here; a pole a preview only ties into is standing already. */
  readonly draws?: (pole: UtilityPole) => boolean;
  /** Which poles are placed here at all (none: every one): the streamed world's active tiles' (`docPoles`). */
  readonly stands?: (pole: UtilityPole) => boolean;
  /** Which spans are strung here, between two placed poles (none: every one). */
  readonly strings?: (span: UtilitySpan) => boolean;
}

/** What the view reads of a cell's part: the box its pieces stand in (three's axes), their largest scale, and the largest piece's two longest sides multiplied (the most of the screen one covers, square units). */
export interface PartBounds { readonly box: number[]; scale: number; cover: number }
/** A part's shape as `PartBounds` reads it: its box's sides (null: a shape with no box). */
export type PartShape = readonly [number, number, number] | null;

/** A piece placed: its part's bounds grown to take it in; whether they moved. */
export function growPart(b: PartBounds, placement: Placement, shape: PartShape): boolean {
  let moved = false;
  const box = b.box;
  const x = placement.x, y = placement.z, z = -placement.y;
  if (x < box[0]! || y < box[1]! || z < box[2]! || x > box[3]! || y > box[4]! || z > box[5]!) {
    box[0] = Math.min(box[0]!, x); box[1] = Math.min(box[1]!, y); box[2] = Math.min(box[2]!, z);
    box[3] = Math.max(box[3]!, x); box[4] = Math.max(box[4]!, y); box[5] = Math.max(box[5]!, z);
    moved = true;
  }
  const s = Math.max(Math.abs(placement.sx), Math.abs(placement.sy), Math.abs(placement.sz));
  if (s > b.scale) { b.scale = s; moved = true; }
  // The piece's box as placed (a turn keeps its sides): its two longest sides.
  if (shape) {
    const [long, wide] = [shape[0] * Math.abs(placement.sx), shape[1] * Math.abs(placement.sy), shape[2] * Math.abs(placement.sz)].sort((p, q) => q - p);
    b.cover = Math.max(b.cover, long! * wide!);
  }
  return moved;
}

/** A shape's box's sides, as `growPart` reads them. */
export function partShape(geometry: { readonly boundingBox: { readonly min: { readonly x: number; readonly y: number; readonly z: number }; readonly max: { readonly x: number; readonly y: number; readonly z: number } } | null }): PartShape {
  const b = geometry.boundingBox;
  return b ? [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z] : null;
}

/** What the view reads of a cell's wires: the box of their ends (three's axes) and their deepest sag. */
export interface WireBounds { readonly box: number[]; sag: number }
/** Numbers a span's wires take (`spanWires`). */
export const WIRE_BLOCK = SPAN_WIRES * WIRE_STRIDE;

/** A span's wires strung at `at` in `d`: the cell's wire bounds grown to take them in; whether they moved. */
export function growWires(b: WireBounds, d: Float32Array, at: number): boolean {
  let moved = false;
  const x = b.box;
  for (let i = at; i < at + WIRE_BLOCK; i += WIRE_STRIDE) {
    for (const k of [i, i + 3]) {
      if (d[k]! < x[0]! || d[k + 1]! < x[1]! || d[k + 2]! < x[2]! || d[k]! > x[3]! || d[k + 1]! > x[4]! || d[k + 2]! > x[5]!) {
        x[0] = Math.min(x[0]!, d[k]!); x[1] = Math.min(x[1]!, d[k + 1]!); x[2] = Math.min(x[2]!, d[k + 2]!);
        x[3] = Math.max(x[3]!, d[k]!); x[4] = Math.max(x[4]!, d[k + 1]!); x[5] = Math.max(x[5]!, d[k + 2]!);
        moved = true;
      }
    }
    if (d[i + 6]! > b.sag) { b.sag = d[i + 6]!; moved = true; }
  }
  return moved;
}

export const emptyBox = (): number[] => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];

/** A cell's part as a bake hands it (`bakePoles`): its pieces' matrices (16 floats each, `writePlacement`) and their bounds. */
export interface BakedPart {
  readonly matrices: Float32Array<ArrayBuffer>;
  readonly count: number;
  readonly box: readonly number[];
  readonly scale: number;
  readonly cover: number;
}

/** A cell's wires as a bake hands them: each span's `SPAN_WIRES` instances (`spanWires`), and their bounds. */
export interface BakedWires {
  readonly data: Float32Array<ArrayBuffer>;
  readonly count: number;
  readonly box: readonly number[];
  readonly sag: number;
}

/** One cell of the world's grid (`cellAt`) as a bake hands it: each part's pieces (`POLE_PART` order, null where none), its wires. */
export interface BakedPoleCell {
  readonly key: number;
  readonly parts: readonly (BakedPart | null)[];
  readonly wires: BakedWires | null;
}

/** A tile's poles and wires baked: cell by cell, as a layer filled with them holds them. */
export interface PoleBake {
  readonly cells: readonly BakedPoleCell[];
}

/** A pole as it stands: its top, its way to the kerb (kept from before, or undefined to read it, `kerbward`), its arms. */
export function framePole(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource,
  pole: UtilityPole, kept: { x: number; y: number } | null | undefined): { readonly top: number; readonly kerb: { x: number; y: number } | null; readonly frame: PoleArms } {
  const top = groundAt(pole.x, pole.y) + POLE_HEIGHT;
  // Towards the carriageway: the nearest kerb, or null off the streets.
  const kerb = kept !== undefined ? kept : kerbward(net, { x: pole.x, y: pole.y }, m(6));
  // A pole with no wire yet stands square to its street.
  const frame = poleArmsAt(pole, source.spansAt(pole.id), source.poles, () => kerb ?? { x: 0, y: 1 });
  return { top, kerb, frame };
}

/** A span's end at a pole, as its wires read it: the pole's place and top, and its arm for the span. */
export const wireEnd = (span: UtilitySpan, at: { readonly x: number; readonly y: number; readonly top: number; readonly frame: PoleArms }): Parameters<typeof spanWires>[1] =>
  ({ x: at.x, y: at.y, top: at.top, arm: at.frame.bySpan.get(span.id) ?? { x: 0, y: 1 } });

/** One cell's pieces and wires as a bake makes them. */
interface BakingCell {
  readonly parts: ({ readonly matrices: number[]; count: number; readonly bounds: PartBounds } | null)[];
  wires: { readonly data: number[]; count: number; readonly bounds: WireBounds } | null;
}

/** THE POLES AND WIRES OF A SOURCE BAKED, IN A WORKER (`poleTiles.ts`): placed, framed and strung as a layer filled with them places them (`PoleLayer.fill`, the same order, the same matrices), cell by cell; `shapes`, each part's box (`partShape`, from the page's catalogue) */
export function bakePoles(net: Network, groundAt: (x: number, y: number) => number, source: PoleSource, shapes: readonly PartShape[]): PoleBake {
  const cells = new Map<number, BakingCell>();
  const cellOf = (key: number): BakingCell => {
    let cell = cells.get(key);
    if (!cell) cells.set(key, cell = { parts: Array.from({ length: POLE_PART_COUNT }, () => null), wires: null });
    return cell;
  };
  const states = new Map<PoleId, { readonly x: number; readonly y: number; readonly top: number; readonly frame: PoleArms }>();
  const out: Placement[][] = Array.from({ length: POLE_PART_COUNT }, () => []);
  const matrix = new Float32Array(16);
  for (const pole of source.poles.values()) {
    if (!(source.stands?.(pole) ?? true)) continue;
    const { top, kerb, frame } = framePole(net, groundAt, source, pole, undefined);
    states.set(pole.id, { x: pole.x, y: pole.y, top, frame });
    if (!(source.draws?.(pole) ?? true)) continue;
    for (const list of out) list.length = 0;
    placePole(pole, top, frame, kerb, groundAt, out);
    const cell = cellOf(cellAt(pole.x, pole.y));
    out.forEach((list, k) => {
      for (const placement of list) {
        const part = cell.parts[k] ??= { matrices: [], count: 0, bounds: { box: emptyBox(), scale: 0, cover: 0 } };
        writePlacement(placement, matrix, 0);
        for (let c = 0; c < 16; c++) part.matrices.push(matrix[c]!);
        part.count++;
        growPart(part.bounds, placement, shapes[k] ?? null);
      }
    });
  }
  const block = new Float32Array(WIRE_BLOCK);
  for (const span of source.spans.values()) {
    if (!(source.strings?.(span) ?? true)) continue;
    const a = states.get(span.a), b = states.get(span.b);
    if (!a || !b) continue;
    const cell = cellOf(cellAt((a.x + b.x) / 2, (a.y + b.y) / 2));
    const wires = cell.wires ??= { data: [], count: 0, bounds: { box: emptyBox(), sag: 0 } };
    spanWires(span, wireEnd(span, a), wireEnd(span, b), block, 0);
    growWires(wires.bounds, block, 0);
    for (let c = 0; c < WIRE_BLOCK; c++) wires.data.push(block[c]!);
    wires.count++;
  }
  const baked: BakedPoleCell[] = [];
  for (const [key, cell] of cells) {
    baked.push({
      key,
      parts: cell.parts.map((p) => (p ? { matrices: Float32Array.from(p.matrices), count: p.count, box: p.bounds.box, scale: p.bounds.scale, cover: p.bounds.cover } : null)),
      wires: cell.wires ? { data: Float32Array.from(cell.wires.data), count: cell.wires.count, box: cell.wires.bounds.box, sag: cell.wires.bounds.sag } : null,
    });
  }
  return { cells: baked };
}

/** Every buffer of a bake: handed over, not copied. */
export function poleBakeBuffers(bake: PoleBake): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const cell of bake.cells) {
    for (const part of cell.parts) if (part) out.push(part.matrices.buffer as ArrayBuffer);
    if (cell.wires) out.push(cell.wires.data.buffer as ArrayBuffer);
  }
  return out;
}
