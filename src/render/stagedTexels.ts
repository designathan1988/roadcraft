import type { DataArrayTexture, DataTexture, Texture } from 'three';

/** A DATA TEXTURE'S TEXELS ON THE PAGE ONLY WHILE THREE SENDS THEM: no CPU copy of what the GPU holds (`terrain.ts`) */
// three r186 reads `image.data` only in `WebGLTextures.uploadTexture` (whole, its `layerUpdates`, or its `updateRanges`), then calls `onUpdate`.

type Texels = Float32Array | Uint8Array;
type TexelsOf<T extends Texels> = { new (length: number): T; readonly name: string };

/** A box of texels, inclusive (column x, row y). */
export interface TexelBox { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number }

/** What three is about to send: every texel (`layers` and `box` null), some layers of an array, or a box holding a 2D texture's ranges. */
export interface TexelPart {
  readonly layers: readonly number[] | null;
  readonly box: TexelBox | null;
}

/** The staging arrays, one per type and size for the whole page: three sends one texture at a time, synchronously. */
const staging = new Map<string, Texels>();
function stagingOf<T extends Texels>(type: TexelsOf<T>, length: number): T {
  const key = `${type.name}:${length}`;
  let array = staging.get(key);
  if (!array) staging.set(key, array = new type(length));
  return array as T;
}
/** The texture the staging array was last filled for, and its version: three reads `image.data` several times in one send. */
let filledFor: object | null = null;
let filledVersion = -1;
let filledArray: Texels | null = null;

/** What a texture's `image.data` sends while it holds no array of its own. */
function partOf(texture: DataTexture | DataArrayTexture, channels: number): TexelPart {
  if ((texture as DataArrayTexture).isDataArrayTexture) {
    const layers = (texture as DataArrayTexture).layerUpdates;
    return { layers: layers.size > 0 ? [...layers] : null, box: null };
  }
  const ranges = texture.updateRanges;
  if (ranges.length === 0) return { layers: null, box: null };
  const width = texture.image.width;
  let x0 = Infinity, x1 = -1, y0 = Infinity, y1 = -1;
  for (const range of ranges) {
    const first = Math.floor(range.start / channels), last = Math.ceil((range.start + range.count) / channels) - 1;
    const r0 = Math.floor(first / width), r1 = Math.floor(last / width);
    y0 = Math.min(y0, r0); y1 = Math.max(y1, r1);
    // A range over more than a row covers whole rows between.
    if (r0 !== r1) { x0 = 0; x1 = width - 1; } else { x0 = Math.min(x0, first % width); x1 = Math.max(x1, last % width); }
  }
  return { layers: null, box: { x0, x1, y0, y1 } };
}

/** The texture's own array, sent instead of the staging one until it is let go. */
export interface StagedTexels<T extends Texels> {
  /** The array it holds (an edit in progress, a worker's answer), or null. */
  readonly held: T | null;
  /** Holds `array` as its texels; null lets go of the one held. */
  hold(array: T | null): void;
  /** Lets go of the array held once three has sent it (at once when nothing waits to be sent). */
  letGoWhenSent(): void;
}

/** Makes `texture` read its texels from `fill` at each send, into an array shared by the page, unless it holds its own (`hold`). */
export function stageTexels<T extends Texels>(texture: DataTexture | DataArrayTexture, type: TexelsOf<T>, length: number, channels: number,
  fill: (into: T, part: TexelPart) => void): StagedTexels<T> {
  let held: T | null = null;
  let letGo = false;
  let sentVersion = -1;
  Object.defineProperty(texture.image, 'data', {
    configurable: true,
    enumerable: true,
    get(): T {
      if (held) return held;
      const into = stagingOf(type, length);
      if (filledFor === texture && filledVersion === texture.version && filledArray === into) return into;
      fill(into, partOf(texture, channels));
      filledFor = texture;
      filledVersion = texture.version;
      filledArray = into;
      return into;
    },
    set(value: T | null) { held = value; },
  });
  const before = texture.onUpdate;
  texture.onUpdate = (t: Texture): void => {
    before?.call(texture, t);
    sentVersion = texture.version;
    // The next send (a context restored) fills again: what three read here may have been a part.
    if (filledFor === texture) filledFor = null;
    if (letGo) { held = null; letGo = false; }
  };
  return {
    get held() { return held; },
    hold(array) { held = array; letGo = false; },
    letGoWhenSent() {
      if (!held) return;
      if (sentVersion === texture.version) held = null;
      else letGo = true;
    },
  };
}
