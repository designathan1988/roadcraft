import { WEAK_MACHINE, type WeakMachine } from '@core/weakMachine';
import type { BufferAttribute, BufferGeometry } from 'three';

/** THE GPU'S BYTES IN ONE BOOK: every owner of video memory registers what it holds (bytes and triangles by class), and selection asks it before it requests (Cesium `cacheBytes`, 3DTilesRendererJS `lruCache.maxBytes`) */

/** What holds video memory, by class. */
export type GpuClass = 'building detail' | 'building facade' | 'cell masses' | 'tile masses' | 'plate masses' | 'base masses' | 'render targets' | 'shadow maps' | `far ${string}`;

interface Entry { readonly cls: GpuClass; readonly bytes: number; readonly triangles: number }
interface Sum { bytes: number; triangles: number }

export class GpuLedger {
  private readonly owners = new Map<unknown, Entry>();
  private readonly classes = new Map<GpuClass, Sum>();
  private sum = 0;
  /** The most every owner together may hold, bytes (`deviceGpuCap`); Infinity until the renderer reads the device. */
  cap = Infinity;

  /** What `owner` holds now (replacing what it held), under `cls`. */
  set(owner: unknown, cls: GpuClass, bytes: number, triangles = 0): void {
    this.remove(owner);
    if (bytes <= 0 && triangles <= 0) return;
    this.owners.set(owner, { cls, bytes, triangles });
    const s = this.classes.get(cls) ?? { bytes: 0, triangles: 0 };
    s.bytes += bytes;
    s.triangles += triangles;
    this.classes.set(cls, s);
    this.sum += bytes;
  }

  /** `owner` let go of all it held. */
  remove(owner: unknown): void {
    const was = this.owners.get(owner);
    if (!was) return;
    this.owners.delete(owner);
    const s = this.classes.get(was.cls)!;
    s.bytes -= was.bytes;
    s.triangles -= was.triangles;
    if (s.bytes <= 0 && s.triangles <= 0) this.classes.delete(was.cls);
    this.sum -= was.bytes;
  }

  /** Bytes held by a class, or by all. */
  bytes(cls?: GpuClass): number {
    return cls === undefined ? this.sum : this.classes.get(cls)?.bytes ?? 0;
  }

  /** Triangles held by a class, or by all. */
  triangles(cls?: GpuClass): number {
    if (cls !== undefined) return this.classes.get(cls)?.triangles ?? 0;
    let n = 0;
    for (const s of this.classes.values()) n += s.triangles;
    return n;
  }

  /** Every owner and what it holds now, read only (the debugging lab's consumers, `lab/resources`): nothing is copied, the book is walked as it stands. */
  *entries(): IterableIterator<{ readonly owner: unknown; readonly cls: GpuClass; readonly bytes: number; readonly triangles: number }> {
    for (const [owner, entry] of this.owners) yield { owner, cls: entry.cls, bytes: entry.bytes, triangles: entry.triangles };
  }

  /** Bytes under the cap left for `classes` once every other class is counted: what they may hold together. */
  roomFor(classes: readonly GpuClass[]): number {
    let theirs = 0;
    for (const cls of classes) theirs += this.bytes(cls);
    return this.cap - (this.sum - theirs);
  }
}

/** The game's one book of video memory. */
export const gpuLedger = new GpuLedger();

/** What a geometry sends to the GPU, bytes, and its triangles: read before its arrays are let go (`gpuOnly.ts` keeps `keptBytes`). */
export function geometryCost(geometry: BufferGeometry): { bytes: number; triangles: number } {
  let bytes = 0;
  const add = (a: BufferAttribute | null | undefined): void => {
    if (!a) return;
    const array = a.array as { byteLength?: number } | null;
    bytes += array?.byteLength ?? (a as { keptBytes?: number }).keptBytes ?? 0;
  };
  for (const a of Object.values(geometry.attributes)) add(a as BufferAttribute);
  add(geometry.index);
  const index = geometry.index;
  const triangles = Math.floor((index ? index.count : geometry.attributes['position']?.count ?? 0) / 3);
  return { bytes, triangles };
}

/** What the cap is worked out from: the system's memory (GB, null unknown), the GPU's name, the drawing buffer's pixels. */
export interface GpuDevice {
  readonly memoryGB: number | null;
  readonly renderer: string;
  readonly pixels: number;
}

/** A discrete card's name: its own video memory, none taken from the system's. */
const DISCRETE = /NVIDIA|GeForce|Quadro|RTX|Radeon RX|Radeon Pro|FirePro|Arc\(TM\) A\d|Arc A\d/i;
/** An integrated GPU's name (or a software one): it draws from the system's memory. */
const INTEGRATED = /Intel|Radeon\(TM\) Graphics|Radeon Graphics|Vega \d* ?Graphics|Apple|Mali|Adreno|PowerVR|SwiftShader|llvmpipe|Microsoft Basic/i;

/** Whether the GPU named shares the system's memory. */
export const integratedGpu = (renderer: string): boolean => !DISCRETE.test(renderer) && INTEGRATED.test(renderer);

/** System memory assumed where none is said, GB (`deviceMemory` is a power of two clamped by the browser, MDN). */
const ASSUMED_MEMORY_GB = 8;
/** An iGPU may take up to half of the system's memory (Intel support 000020962); the game takes half of that, the page's heap and the OS living in the same memory. */
const INTEGRATED_POOL = 0.5;
const INTEGRATED_GAME = 0.5;
/** A discrete card's memory cannot be read from WebGL (MDN WebGL best practices): a 4 GB card assumed, three quarters of it the game's. */
const DISCRETE_GB = 4;
const DISCRETE_GAME = 0.75;
/** MDN's per-pixel VRAM budget (Google Maps): 3 GiB on the reference machine (UHD 770, high tier) at 1920 x 1080 drawn at 1.5, so ~690 bytes a pixel of the drawing buffer. */
const REFERENCE_BYTES = 3 * 2 ** 30;
const REFERENCE_PIXELS = 1920 * 1.5 * 1080 * 1.5;
/** The least cap: the far levels and the frame's targets alone. */
const FLOOR_BYTES = 512 * 2 ** 20;

/** cap = max(512 MiB, min(device ceiling, 690 B x drawing-buffer pixels)); ceiling = system GB x 0.5 x 0.5 on an iGPU (Intel 000020962), 4 GB x 0.75 on a discrete card; per-pixel budget from MDN WebGL best practices. */
export function deviceGpuCap(device: GpuDevice): number {
  const ceiling = integratedGpu(device.renderer)
    ? (device.memoryGB ?? ASSUMED_MEMORY_GB) * 2 ** 30 * INTEGRATED_POOL * INTEGRATED_GAME
    : DISCRETE_GB * 2 ** 30 * DISCRETE_GAME;
  const perPixel = (REFERENCE_BYTES / REFERENCE_PIXELS) * Math.max(1, device.pixels);
  return Math.max(FLOOR_BYTES, Math.min(ceiling, perPixel));
}

/** The device as the page can read it: `navigator.deviceMemory`, the unmasked renderer string (`WEBGL_debug_renderer_info`; Firefox gives it as `RENDERER`). */
export function readGpuDevice(gl: WebGLRenderingContext | WebGL2RenderingContext, pixels: number, weak: WeakMachine = WEAK_MACHINE): GpuDevice {
  // A run playing a weaker machine (`core/weakMachine.ts`): its GPU's name and its memory, the cap an integrated GPU of it has.
  const info = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
  const renderer = weak.gpu ?? String((info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null) ?? gl.getParameter(gl.RENDERER) ?? '');
  const said = (globalThis.navigator as unknown as { deviceMemory?: number } | undefined)?.deviceMemory;
  return { memoryGB: weak.memoryGB ?? (typeof said === 'number' && said > 0 ? said : null), renderer, pixels };
}
