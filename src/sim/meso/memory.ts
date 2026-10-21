import { UNITS_PER_METER } from '@world/units';

/** THE MESO TRAFFIC AS THE PAGE READS IT: the worker sends only the links whose numbers changed (`MesoDelta`, its buffers handed over, not copied); the page keeps its own copy of every link (`MesoMemory`) */

/** A link's record (Float32), by slot (the meso's own dense number, `meso.ts`): its numbers of the step, then its road's start, middle and end (x, y: drawn straight from afar)
 *  and `shape`, a serial moved on each time the slot's link or its line changes (the page writes its line again then; 0 in a delta: the line did not change). */
export const ML = { count: 0, queued: 1, speed: 2, length: 3, lanes: 4, flags: 5, ax: 6, ay: 7, mx: 8, my: 9, bx: 10, by: 11, shape: 12 } as const;
export const MESO_RECORD = 13;
/** `ML.flags`: the link is in the model; it is inside the micro window (its cars are the micro simulation's); its road is one-way. */
export const MESO_PRESENT = 1;
export const MESO_INSIDE = 2;
export const MESO_ONE_WAY = 4;

/** The micro window's radius: the ~1.5 km window of the brief (CLAUDE.md), the micro simulation inside, the meso outside. */
export const MICRO_RADIUS = 750 * UNITS_PER_METER;
/** The least the micro window shrinks to round a close view (`Meso.follow`): the street and the next blocks stay micro. */
export const MICRO_MIN_RADIUS = 300 * UNITS_PER_METER;

/** DO NOT keep the micro window 750 m wide round a street view (`Meso.step`): 1.35 the view (as `AmbientWorld`'s cars), between `MICRO_MIN_RADIUS` and the page's ask (`most`); moved past a third of it, resized when the view outgrows it or shrinks under 3/4 (no breathing with the wheel). The window to move to, or null. */
export function followView(now: { readonly x: number; readonly y: number; readonly r: number },
  focus: { readonly x: number; readonly y: number; readonly r: number; readonly view?: { readonly far: number } | null }, most: number): { x: number; y: number; r: number } | null {
  // Playing, the camera sees far down the street, past `r` (`SimWorld.focus.view`).
  const r = Math.min(most, Math.max(MICRO_MIN_RADIUS, Math.max(focus.r, focus.view?.far ?? 0) * 1.35));
  const resized = now.r <= 0 || r > now.r || r < now.r * 0.75;
  if (!resized && Math.hypot(focus.x - now.x, focus.y - now.y) <= now.r / 3) return null;
  return { x: focus.x, y: focus.y, r: resized ? r : now.r };
}

/**
 * The links that changed since the last delta the page took, as the worker sends them (in the frame's message, its three buffers
 * transferred). DO NOT send every link each step: a link goes only when what the page draws of it changed (its rounded count or
 * queue, its speed past a step, its flags, its line), so a step costs the page the links that moved, not the map.
 */
export interface MesoDelta {
  /** The page's copy is cleared first (a new map, the page's first window): the links in it are every link there is. */
  readonly whole: boolean;
  /** One past the highest slot the worker holds. */
  readonly slots: number;
  /** The simulation's time of the step and the micro window it stood at. */
  readonly time: number;
  readonly windowX: number;
  readonly windowY: number;
  readonly windowR: number;
  /** Each changed link's slot, its link id (`tileLinks.ts` linkId), and its record (`MESO_RECORD` numbers, fields `ML`). */
  readonly at: Int32Array;
  readonly ids: Float64Array;
  readonly records: Float32Array;
}

/** The buffers of a delta, to hand over with the message that carries it. */
export function deltaTransfer(d: MesoDelta): ArrayBuffer[] {
  return [d.at.buffer as ArrayBuffer, d.ids.buffer as ArrayBuffer, d.records.buffer as ArrayBuffer];
}

/** The worker's delta under way: records appended as the publish runs (it may be spread over ticks), taken whole by the frame. */
export class MesoDeltaBuilder {
  private at = new Int32Array(256);
  private ids = new Float64Array(256);
  private records = new Float32Array(256 * MESO_RECORD);
  private n = 0;
  private whole = false;
  /** Whether a publish ended since the last take (the head is new). */
  private ended = false;
  private head = { slots: 0, time: 0, windowX: 0, windowY: 0, windowR: 0 };

  /** Links appended since the last take. */
  get size(): number {
    return this.n;
  }

  /** Everything appended dropped: the next take is whole (the page clears its copy). */
  startWhole(): void {
    this.n = 0;
    this.whole = true;
  }

  /** Room for one more link: its slot and id noted; the offset of its record in `recordsNow` to write it at. */
  push(slot: number, id: number): number {
    if (this.n === this.at.length) {
      const size = this.n * 2;
      const at = new Int32Array(size); at.set(this.at); this.at = at;
      const ids = new Float64Array(size); ids.set(this.ids); this.ids = ids;
      const records = new Float32Array(size * MESO_RECORD); records.set(this.records); this.records = records;
    }
    this.at[this.n] = slot;
    this.ids[this.n] = id;
    return this.n++ * MESO_RECORD;
  }

  /** The records' array the offsets of `push` point into (it grows: ask again after each push). */
  get recordsNow(): Float32Array {
    return this.records;
  }

  /** A publish ended: the step's head. */
  end(slots: number, time: number, windowX: number, windowY: number, windowR: number): void {
    this.head = { slots, time, windowX, windowY, windowR };
    this.ended = true;
  }

  /** The links appended since the last take, in new buffers to hand over; null when nothing was appended and no publish ended. */
  take(): MesoDelta | null {
    if (!this.n && !this.ended && !this.whole) return null;
    const n = this.n;
    const delta: MesoDelta = {
      whole: this.whole, ...this.head,
      at: this.at.slice(0, n), ids: this.ids.slice(0, n), records: this.records.slice(0, n * MESO_RECORD),
    };
    this.n = 0;
    this.whole = false;
    this.ended = false;
    return delta;
  }
}

/** The page's copy of every link the worker sent (`MesoDelta`), by slot: what the far cars are written from (`render/densityCars.ts`). */
export class MesoMemory {
  links = new Float32Array(0);
  /** Each slot's link (`tileLinks.ts` linkId: segment * 2 + direction), as of its `shape`. */
  ids = new Float64Array(0);
  /** One past the highest slot the worker holds, and the deltas taken in. */
  slots = 0;
  serial = 0;
  /** The simulation's time of the last step taken in, and the micro window it stood at. */
  time = 0;
  windowX = 0;
  windowY = 0;
  windowR = 0;

  /** Slots it has room for. */
  get capacity(): number {
    return this.ids.length;
  }

  /** A delta taken in, the slots it changed appended to `changed` (a slot may come twice); a whole one first takes every link out. */
  apply(d: MesoDelta, changed: number[]): void {
    if (d.whole) {
      for (let slot = 0; slot < this.capacity; slot++) {
        const at = slot * MESO_RECORD + ML.flags;
        if (this.links[at] !== 0) { this.links[at] = 0; changed.push(slot); }
      }
    }
    let top = d.slots;
    for (let k = 0; k < d.at.length; k++) top = Math.max(top, d.at[k]! + 1);
    this.reserve(top);
    for (let k = 0; k < d.at.length; k++) {
      const slot = d.at[k]!, to = slot * MESO_RECORD, from = k * MESO_RECORD;
      for (let f = 0; f < ML.shape; f++) this.links[to + f] = d.records[from + f]!;
      // The line kept as the page wrote it unless the worker moved its serial.
      const shape = d.records[from + ML.shape]!;
      if (shape !== 0) this.links[to + ML.shape] = shape;
      this.ids[slot] = d.ids[k]!;
      changed.push(slot);
    }
    this.slots = d.slots;
    this.time = d.time;
    this.windowX = d.windowX;
    this.windowY = d.windowY;
    this.windowR = d.windowR;
    this.serial++;
  }

  /** Room for slots below `n`, doubling, what was there kept. */
  private reserve(n: number): void {
    if (n <= this.capacity) return;
    const size = Math.max(n, this.capacity * 2, 1024);
    const links = new Float32Array(size * MESO_RECORD); links.set(this.links); this.links = links;
    const ids = new Float64Array(size).fill(Number.NaN); ids.set(this.ids); this.ids = ids;
  }
}
