import { fitProxy, type ProxyPack } from '@people/body/proxy';

/** HAIR AND CLOTHES SHAPED BY PARAMETERS: a catalogue hairstyle (hand-made, its quality kept) lengthened or shortened, given volume and waves by sliders, the
 *  way the parametric character creators do it - Daz's and Character Creator's per-hairstyle morphs, inZOI's root-to-tip length - computed here
 *  from the piece itself, so every catalogue hairstyle has them. Garments take the same two of them: their length below the waist (Mutable's
 *  clip-and-morph does a hem so) and their looseness (Roblox's puffiness). The result is a move of the item's own offsets (as the sculptor's), so
 *  it fits any body as the game fits the item. */

export interface HairShape {
  /** Length of the hanging part: 1 as made, below 1 shorter, above longer. */
  readonly length: number;
  /** Volume (dm): the hair stood off the head, more towards the ends. */
  readonly volume: number;
  /** Waves (dm): side to side along the hanging part, growing from the root. */
  readonly wave: number;
}

export const PLAIN_SHAPE: HairShape = { length: 1, volume: 0, wave: 0 };

/** One wave along the hair (dm). */
const WAVE_PERIOD = 0.9;

export function isPlain(s: HairShape | undefined): boolean {
  return !s || (Math.abs(s.length - 1) < 1e-3 && Math.abs(s.volume) < 1e-4 && Math.abs(s.wave) < 1e-4);
}

/** The item with the shape applied on this body (`base`: the base mesh as shaped, dm). */
export function shapedPack(pack: ProxyPack, base: Float32Array, s: HairShape): ProxyPack {
  const P = fitProxy(pack, base);
  const n = P.length / 3;
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < P.length; i += 3) { lo = Math.min(lo, P[i]!); hi = Math.max(hi, P[i]!); }
  // The head's middle: the base mesh's skin within ~14 cm of its top, side to side and front to back; its height a fifth of the way down the hair.
  let top = -Infinity;
  for (let i = 1; i < base.length; i += 3) top = Math.max(top, base[i]!);
  let cx = 0, cz = 0, c = 0;
  for (let i = 0; i < base.length; i += 3) if (base[i + 1]! > top - 1.4) { cx += base[i]!; cz += base[i + 2]!; c++; }
  cx /= c || 1; cz /= c || 1;
  const cy = top - 1.0;
  // Where the hair starts to hang (as the sculptor's lengthen): a little below its middle.
  const pivot = hi - (hi - lo) * 0.45, span = Math.max(1e-4, hi - lo);
  const offsets = new Float32Array(pack.offsets);
  const scale = axisScales(pack, base);
  for (let v = 0; v < n; v++) {
    const x = P[v * 3]!, y = P[v * 3 + 1]!, z = P[v * 3 + 2]!;
    let nx = x, ny = y, nz = z;
    // Length: the hanging part stretched or drawn up from the pivot.
    if (y < pivot) ny = pivot - (pivot - y) * s.length;
    // Out from the head: from its middle above it, level below it.
    let ox = x - cx, oy = y > cy ? y - cy : 0, oz = z - cz;
    const ol = Math.hypot(ox, oy, oz) || 1;
    ox /= ol; oy /= ol; oz /= ol;
    const down = Math.max(0, Math.min(1, (hi - y) / span));
    // Volume: more towards the ends (the roots stay on the scalp).
    const lift = s.volume * (0.15 + 0.85 * down);
    nx += ox * lift; ny += oy * lift; nz += oz * lift;
    // Waves: side to side round the head (across the way out), along the hanging part, growing from the pivot.
    if (s.wave > 0 && ny < pivot) {
      const along = (pivot - ny) / WAVE_PERIOD;
      const amount = Math.sin(along * Math.PI * 2) * s.wave * Math.min(1, along * 1.5);
      const tx = -oz, tz = ox, tl = Math.hypot(tx, tz) || 1;
      nx += tx / tl * amount; nz += tz / tl * amount;
    }
    offsets[v * 3] = offsets[v * 3]! + (nx - x) / scale[0];
    offsets[v * 3 + 1] = offsets[v * 3 + 1]! + (ny - y) / scale[1];
    offsets[v * 3 + 2] = offsets[v * 3 + 2]! + (nz - z) / scale[2];
  }
  return { ...pack, offsets };
}

/** `fitProxy`'s axis scales on this body: a position move of d dm is an offset move of d / scale. */
function axisScales(pack: ProxyPack, base: Float32Array): [number, number, number] {
  const axis = (i: number): number => {
    const a = pack.scaleRefs[i * 2]!, b = pack.scaleRefs[i * 2 + 1]!;
    const d = Math.abs(base[a * 3 + i]! - base[b * 3 + i]!);
    return d > 0 ? d / Math.max(1e-6, pack.scaleBase[i]!) : 1;
  };
  return [axis(0), axis(1), axis(2)];
}
