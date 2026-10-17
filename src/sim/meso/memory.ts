import { UNITS_PER_METER } from '@world/units';

/** THE MESO TRAFFIC AS THE PAGE READS IT: one SharedArrayBuffer, made by the page (`render/densityCars.ts`), written by the worker each meso step */

/** The control words (Int32, Atomics): the step written last, the slots the worker would write (more than fit asks for a bigger buffer). */
export const MC = { serial: 0, wanted: 1 } as const;
const CONTROL_BYTES = 16;
/** The head (Float64): the simulation's time of the step, the micro window it stood at. */
export const MH = { time: 0, windowX: 1, windowY: 2, windowR: 3 } as const;
const HEAD_BYTES = 32;
/** A link's record (Float32), by slot (the meso's own dense number, `meso.ts`): its numbers of the step, then its road's start, middle and end (x, y: drawn straight from afar)
 *  and `shape`, a serial moved on each time the slot's link or its line changes (the page writes its line again then). */
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

/** Bytes a slot takes: its link's id (Float64, `ids`) and its record. */
const SLOT_BYTES = 8 + MESO_RECORD * 4;

/** The views of one buffer: written by the worker, read by the page; a link's numbers may be read half-written, never a step's serial. */
export class MesoMemory {
  readonly control: Int32Array;
  readonly head: Float64Array;
  /** Each slot's link (`tileLinks.ts` linkId: segment * 2 + direction), as of its `shape`. */
  readonly ids: Float64Array;
  readonly links: Float32Array;
  /** Slots it holds. */
  readonly capacity: number;

  constructor(readonly buffer: SharedArrayBuffer) {
    this.control = new Int32Array(buffer, 0, CONTROL_BYTES / 4);
    this.head = new Float64Array(buffer, CONTROL_BYTES, HEAD_BYTES / 8);
    this.capacity = Math.floor((buffer.byteLength - CONTROL_BYTES - HEAD_BYTES) / SLOT_BYTES);
    this.ids = new Float64Array(buffer, CONTROL_BYTES + HEAD_BYTES, this.capacity);
    this.links = new Float32Array(buffer, CONTROL_BYTES + HEAD_BYTES + this.capacity * 8, this.capacity * MESO_RECORD);
  }

  /** A buffer for `capacity` slots. */
  static make(capacity: number): MesoMemory {
    return new MesoMemory(new SharedArrayBuffer(CONTROL_BYTES + HEAD_BYTES + capacity * SLOT_BYTES));
  }

  get serial(): number {
    return Atomics.load(this.control, MC.serial);
  }

  /** The slots the worker would write; above `capacity`, the page makes a bigger buffer. */
  get wanted(): number {
    return Atomics.load(this.control, MC.wanted);
  }
}
