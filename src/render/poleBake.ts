import type { PoleId, SpanId } from '@world/ids';
import type { Network } from '@world/network';
import { kerbward } from '@world/poleLines';
import { m } from '@world/units';
import { POLE_HEIGHT, type PoleArms, poleArmsAt, type UtilityPole, type UtilitySpan } from '@world/utilities';
import { type Placement, SPAN_WIRES, WIRE_STRIDE, spanWires } from './utilities';

/** WHAT THE POLE LAYER'S PARTS SHARE (`poleLayer.ts`): a pole's frame, a wire's ends, a cell's bounds */
/** What a pole layer is built from: the document's poles and spans, or a planned run (`buildPolePreview`). */
export interface PoleSource {
  readonly poles: ReadonlyMap<PoleId, UtilityPole>;
  readonly spans: ReadonlyMap<SpanId, UtilitySpan>;
  /** The spans reaching a pole, in the order they were strung (`RoadDoc.spansAt`). */
  spansAt(id: PoleId): Iterable<UtilitySpan>;
  /** Which poles get a mast, arms and lamp here; a pole a preview only ties into is standing already. */
  readonly draws?: (pole: UtilityPole) => boolean;
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
