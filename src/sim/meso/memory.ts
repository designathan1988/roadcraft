import { UNITS_PER_METER } from '@world/units';

/** THE MESO TRAFFIC AS THE PAGE READS IT: one SharedArrayBuffer, made by the page (`render/densityCars.ts`), written by the worker each meso step */

/** The control words (Int32, Atomics): the step written last, the slots the worker would write (more than fit asks for a bigger buffer). */
export const MC = { serial: 0, wanted: 1 } as const;
const CONTROL_BYTES = 16;
/** The head (Float64): the simulation's time of the step, the micro window it stood at. */
export const MH = { time: 0, windowX: 1, windowY: 2, windowR: 3 } as const;
const HEAD_BYTES = 32;
/** A link's record (Float32), by slot (`segment * 2 + direction`, direction 0 from the segment's `a` to its `b`). */
export const ML = { count: 0, queued: 1, speed: 2, length: 3, lanes: 4, flags: 5 } as const;
export const MESO_RECORD = 6;
/** `ML.flags`: the link is in the model; it is inside the micro window (its cars are the micro simulation's). */
export const MESO_PRESENT = 1;
export const MESO_INSIDE = 2;

/** The micro window's radius: the ~1.5 km window of the brief (CLAUDE.md), the micro simulation inside, the meso outside. */
export const MICRO_RADIUS = 750 * UNITS_PER_METER;

/** The views of one buffer: written by the worker, read by the page; a link's numbers may be read half-written, never a step's serial. */
export class MesoMemory {
  readonly control: Int32Array;
  readonly head: Float64Array;
  readonly links: Float32Array;
  /** Slots it holds. */
  readonly capacity: number;

  constructor(readonly buffer: SharedArrayBuffer) {
    this.control = new Int32Array(buffer, 0, CONTROL_BYTES / 4);
    this.head = new Float64Array(buffer, CONTROL_BYTES, HEAD_BYTES / 8);
    this.capacity = Math.floor((buffer.byteLength - CONTROL_BYTES - HEAD_BYTES) / (MESO_RECORD * 4));
    this.links = new Float32Array(buffer, CONTROL_BYTES + HEAD_BYTES, this.capacity * MESO_RECORD);
  }

  /** A buffer for `capacity` slots. */
  static make(capacity: number): MesoMemory {
    return new MesoMemory(new SharedArrayBuffer(CONTROL_BYTES + HEAD_BYTES + capacity * MESO_RECORD * 4));
  }

  get serial(): number {
    return Atomics.load(this.control, MC.serial);
  }

  /** The slots the worker would write; above `capacity`, the page makes a bigger buffer. */
  get wanted(): number {
    return Atomics.load(this.control, MC.wanted);
  }
}
