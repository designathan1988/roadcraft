import { CELL } from '@world/cells';
import { m } from '@world/units';
import type { CellArrays, PartBanding, PartBandings } from './cellArrays';
import { PART_KINDS, type PartKind, type PartScreen } from './kit';
import { POSE_FLOATS } from './partPose';
import { LOOK_FLOATS } from './shellParts';

/** A CELL'S PARTS FILED BY BAND AND SUB-CELL WHERE THE CELL IS MADE (`cellWork.ts`): the page is handed each band's buffers ready, never an instance to read (`partCells.ts` draws them) */

export type { PartBanding, PartBandings } from './cellArrays';

/** Side of the sub-cells a cell's parts are filed by (four a side): each part kind's level is chosen per sub-cell, or per quadrant or cell where they agree (`partCells.ts`). DO NOT read it of `layerCells.ts`: that module reaches the shells, which reach the filing. */
export const DETAIL_CELL = m(64);
/** Sub-cells a side of a cell (the world's one grid, `layerCells.ts` BATCH_CELL): four, as `morton` is made for. */
export const SIDE = Math.round(CELL / DETAIL_CELL);
if (SIDE !== 4) throw new Error(`[buildings] a cell's parts are filed four sub-cells a side, not ${SIDE}`);
export const LEAVES = SIDE * SIDE;
/** What a draw is taken to cost in triangles: a band is kept apart only if it draws as much (three's per-object work on the page, `projectObject`/`renderObject`, outweighs this many triangles on the GPU). */
export const DRAW_TRIANGLES = 16384;

/** A sub-cell's index in Morton order from its column and row in the cell. */
export const morton = (u: number, v: number): number => (u & 1) | ((v & 1) << 1) | ((u & 2) << 1) | ((v & 2) << 2);

/** Each kind's banding off the kit's screens as they are now (a small prop's simplified levels come in once the simplifier has loaded). */
export function partBandings(screens: Readonly<Record<PartKind, PartScreen>>): PartBandings {
  return Object.fromEntries(PART_KINDS.map((kind) => {
    const s = screens[kind];
    return [kind, { first: s.levels.length > 1 ? s.levels[1]!.error : null, extent: s.extent, triangles: s.levels[0]!.triangles }];
  })) as Record<PartKind, PartBanding>;
}

/** One band of a kind's instances in the cell, by sub-cell in Morton order. */
export interface FiledBand {
  readonly kind: PartKind;
  /** Each sub-cell's first instance; the last entry is the band's count. */
  readonly start: Uint32Array;
  /** Each sub-cell's box in three's world (min x, y, z, max x, y, z). */
  readonly box: Float64Array;
  /** Each sub-cell's largest scale of an instance along each of the model's axes, then the cell's. */
  readonly scale: Float32Array;
  readonly poses: Float32Array;
  /** Tints in half floats, as the sub-cells' (`cellArrays.ts` `instanceColor`). */
  readonly colours: Uint16Array | null;
  /** The shell's parts: each one's finish, wear and ground (`shellParts.ts`). */
  readonly looks: Float32Array | null;
}

/** A cell's parts, every kind's bands. */
export interface PartFiling {
  readonly bands: readonly FiledBand[];
}

/** The error a band's instances are grouped by starts at this, m, each band four times the last's. */
const BAND_BASE = 0.01;
/** The band of an instance whose kind's first coarser level leaves out `metres` of it (its size, for a kind of one level). */
function bandOf(metres: number): number {
  let band = 0;
  for (let edge = BAND_BASE; band < 15 && metres > edge; edge *= 4) band++;
  return band;
}

/** `details`: the cell's sub-cells (`DETAIL_CELL`) as the job made them, by key "column,row"; every kind's instances by band, each laid out by sub-cell in Morton order, with each sub-cell's box and largest scales */
// DO NOT give a kind one buffer whatever its instances' shapes: a frame is also a gourmet balcony's post (1 m deep), and the
// largest scale over a sub-cell held every window at full detail; instances are banded by their error, each band its own buffer.
// A shell's part is banded by its size as any: its small ones left out under a pixel (`partCells.ts` `levelAt`).
export function fileParts(key: string, details: readonly (readonly [string, CellArrays])[], bandings: PartBandings): PartFiling {
  const comma = key.indexOf(',');
  const ci = Number(key.slice(0, comma)), cj = Number(key.slice(comma + 1));
  const slots: (CellArrays | undefined)[] = [];
  for (const [sub, arrays] of details) {
    const at = sub.indexOf(',');
    const u = Number(sub.slice(0, at)) - ci * SIDE, v = Number(sub.slice(at + 1)) - cj * SIDE;
    if (u < 0 || v < 0 || u >= SIDE || v >= SIDE) throw new Error(`[buildings] sub-cell ${sub} is not in cell ${key}`);
    slots[morton(u, v)] = arrays;
  }
  const bands: FiledBand[] = [];
  for (const kind of PART_KINDS) for (const band of fileKind(kind, slots, bandings[kind])) bands.push(band);
  return { bands };
}

/** Sub-cell `m`'s instances of a kind banded (`bands`), each band's count and largest scales in `perBand`; the band they all are (-1: mixed). */
/** DO NOT loop over a sub-cell's instances inside `fileKind`'s loop of sub-cells: entered on the stack (OSR) for the inner loop, its code left at each sub-cell's end (119 times a job), the rest run unoptimised. */
function bandSubCell(e: Float32Array, count: number, m: number, bands: Uint8Array, perBand: Map<number, { counts: Uint32Array; scale: Float32Array }>, screen: PartBanding): number {
  const first = screen.first;
  let only = -2, lastBand = -1;
  let into: { counts: Uint32Array; scale: Float32Array } | undefined;
  for (let i = 0; i < count; i++) {
    const o = i * POSE_FLOATS;
    // The model's axes as the instance scales them: its pose's scale.
    const sx = e[o + 5]!, sy = e[o + 6]!, sz = e[o + 7]!;
    const metres = first ? Math.max(first[0] * sx, first[1] * sy, first[2] * sz) : Math.sqrt((screen.extent[0] * sx) ** 2 + (screen.extent[1] * sy) ** 2 + (screen.extent[2] * sz) ** 2);
    // A shell's part too, by its size: its small ones a band of their own, left out under a pixel (`partCells.ts` `levelAt`).
    const b = bandOf(metres);
    bands[i] = b;
    only = only === -2 || only === b ? b : -1;
    if (b !== lastBand || !into) {
      into = perBand.get(b);
      if (!into) perBand.set(b, into = { counts: new Uint32Array(LEAVES), scale: new Float32Array(LEAVES * 3) });
      lastBand = b;
    }
    into.counts[m] = into.counts[m]! + 1;
    const at = m * 3, scale = into.scale;
    if (sx > scale[at]!) scale[at] = sx;
    if (sy > scale[at + 1]!) scale[at + 1] = sy;
    if (sz > scale[at + 2]!) scale[at + 2] = sz;
  }
  return only;
}

/** A sub-cell's instances of `band` (after the merge, `into`) copied in at `at`; where the next goes. */
function copyBand(bands: Uint8Array, into: Uint8Array, band: number, count: number, e: Float32Array, tint: Uint16Array | undefined, look: Float32Array | undefined,
  poses: Float32Array, colours: Uint16Array | null, looks: Float32Array | null, at: number): number {
  for (let i = 0; i < count; i++) {
    if (into[bands[i]!] !== band) continue;
    for (let k = 0; k < POSE_FLOATS; k++) poses[at * POSE_FLOATS + k] = e[i * POSE_FLOATS + k]!;
    if (colours && tint) for (let k = 0; k < 3; k++) colours[at * 3 + k] = tint[i * 3 + k]!;
    if (looks && look) for (let k = 0; k < LOOK_FLOATS; k++) looks[at * LOOK_FLOATS + k] = look[i * LOOK_FLOATS + k]!;
    at++;
  }
  return at;
}

/** One kind's bands: one pass reads each instance's scales and band, the other copies; a sub-cell all of one band is copied whole. */
function fileKind(kind: PartKind, slots: readonly (CellArrays | undefined)[], screen: PartBanding): FiledBand[] {
  // Each instance's band; each band's count and largest scales by sub-cell; the band each sub-cell is all of (-1: mixed).
  const bandsOf: (Uint8Array | undefined)[] = [];
  const perBand = new Map<number, { counts: Uint32Array; scale: Float32Array }>();
  const whole = new Int8Array(LEAVES).fill(-1);
  let coloured = false, looked = false;
  for (let m = 0; m < LEAVES; m++) {
    const p = slots[m]?.parts[kind];
    if (!p) continue;
    coloured ||= p.instanceColor !== undefined;
    looked ||= p.looks !== undefined;
    const bands = new Uint8Array(p.count);
    bandsOf[m] = bands;
    whole[m] = bandSubCell(p.poses, p.count, m, bands, perBand, screen);
  }
  // A band drawing less than a draw's worth joins the next coarser one (or the last the one before): its error only grows.
  const order = [...perBand.keys()].sort((a, b) => a - b);
  const into = new Uint8Array(16);
  let open: number[] = [];
  for (const band of order) {
    open.push(band);
    let total = 0;
    for (const b of open) for (const c of perBand.get(b)!.counts) total += c;
    if (total * screen.triangles < DRAW_TRIANGLES && band !== order.at(-1)) continue;
    for (const b of open) into[b] = band;
    open = [];
  }
  const merged = new Map<number, { counts: Uint32Array; scale: Float32Array }>();
  for (const [b, { counts, scale }] of perBand) {
    const to = into[b]!;
    let sum = merged.get(to);
    if (!sum) merged.set(to, sum = { counts: new Uint32Array(LEAVES), scale: new Float32Array((LEAVES + 1) * 3) });
    for (let m = 0; m < LEAVES; m++) {
      sum.counts[m] = sum.counts[m]! + counts[m]!;
      for (let k = 0; k < 3; k++) {
        sum.scale[m * 3 + k] = Math.max(sum.scale[m * 3 + k]!, scale[m * 3 + k]!);
        sum.scale[LEAVES * 3 + k] = Math.max(sum.scale[LEAVES * 3 + k]!, scale[m * 3 + k]!);
      }
    }
  }
  const out: FiledBand[] = [];
  for (const [band, { counts, scale }] of [...merged].sort((a, b) => a[0] - b[0])) {
    let total = 0;
    for (const c of counts) total += c;
    const poses = new Float32Array(total * POSE_FLOATS), colours = coloured ? new Uint16Array(total * 3) : null;
    const looks = looked ? new Float32Array(total * LOOK_FLOATS) : null;
    const start = new Uint32Array(LEAVES + 1);
    const box = new Float64Array(LEAVES * 6);
    let at = 0;
    for (let m = 0; m < LEAVES; m++) {
      start[m] = at;
      const p = slots[m]?.parts[kind];
      if (!p || counts[m] === 0) continue;
      // The sub-cell's box for the kind: a band's own is inside it.
      for (let k = 0; k < 6; k++) box[m * 6 + k] = p.bounds[k]!;
      const e = p.poses, tint = p.instanceColor, look = p.looks;
      if (whole[m]! >= 0) {
        poses.set(e.subarray(0, p.count * POSE_FLOATS), at * POSE_FLOATS);
        if (colours && tint) colours.set(tint.subarray(0, p.count * 3), at * 3);
        if (looks && look) looks.set(look.subarray(0, p.count * LOOK_FLOATS), at * LOOK_FLOATS);
        at += p.count;
        continue;
      }
      at = copyBand(bandsOf[m]!, into, band, p.count, e, tint, look, poses, colours, looks, at);
    }
    start[LEAVES] = at;
    out.push({ kind, start, box, scale, poses, colours, looks });
  }
  return out;
}

/** Every buffer of a filing: handed over, not copied (MDN, `postMessage` transfer). */
export function filingBuffers(f: PartFiling): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const b of f.bands) for (const a of [b.start, b.box, b.scale, b.poses, b.colours, b.looks]) if (a) out.push(a.buffer as ArrayBuffer);
  return out;
}

/** What a filing sends to the GPU, in bytes: each band's instances, its colours and looks. */
export function filingBytes(f: PartFiling): number {
  let bytes = 0;
  for (const b of f.bands) bytes += b.poses.byteLength + (b.colours?.byteLength ?? 0) + (b.looks?.byteLength ?? 0);
  return bytes;
}
