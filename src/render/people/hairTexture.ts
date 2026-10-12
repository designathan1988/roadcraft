import { DataTexture, LinearFilter, LinearMipmapLinearFilter, NoColorSpace, RGBAFormat, UnsignedByteType } from 'three';

/**
 * The strand atlas a procedural hair card samples (`people/hair/procedural.ts`),
 * as DATA, not colour - the compact layout of the open-source Three.js hair
 * shader (github.com/creategamecharacters/threejs-hair-shader): R strand
 * coverage, G position from root (0) to tip (1), B a per-strand seed. The
 * shader turns them into the person's hair colour, darker at the roots,
 * each strand a little lighter or darker than its neighbours, and coverage
 * into alpha with no hard cut (alpha to coverage).
 *
 * Four strips side by side, root at the top (v = 0); a solid band along the
 * top for the painted scalp (the cap). Strands are rasterised directly:
 * each a tapered, slightly swaying line, ending at its own length.
 */
const CACHE = new Map<string, DataTexture>();

export function hairStrandTexture(kind: 'straight' | 'wavy'): DataTexture {
  const known = CACHE.get(kind);
  if (known) return known;
  const W = 512, H = 1024, strips = 4, sw = W / strips;
  const cover = new Float32Array(W * H), along = new Float32Array(W * H), seeds = new Float32Array(W * H).fill(0.5);
  let s = kind === 'wavy' ? 7 : 3;
  const rnd = (): number => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const band = Math.round(H * 0.03);
  for (let strip = 0; strip < strips; strip++) {
    const x0 = strip * sw;
    for (let y = 0; y < band; y++) for (let x = x0; x < x0 + sw; x++) cover[y * W + x] = 1;
    for (let k = 0; k < 420; k++) {
      const base = x0 + 3 + rnd() * (sw - 6);
      const tip = H * (0.72 + rnd() * 0.28);
      const sway = (rnd() - 0.5) * 9, freq = 1.5 + rnd() * 2, phase = rnd() * 6.28;
      const width = 0.8 + rnd() * 1.6, strength = 0.45 + rnd() * 0.45, seed = rnd();
      for (let y = 0; y < tip; y++) {
        const t = y / tip;
        const x = base + (kind === 'wavy' ? Math.sin(t * freq * 6.28 + phase) * 6 : 0) + sway * t * t;
        const w = width * (1 - 0.65 * t);
        // Thinning out over the last fifth: ragged tips, not a cut line.
        const c = strength * (t > 0.8 ? 1 - (t - 0.8) / 0.2 : 1);
        for (let px = Math.floor(x - w - 1); px <= Math.ceil(x + w + 1); px++) {
          if (px < x0 || px >= x0 + sw) continue;
          const d = Math.abs(px + 0.5 - x);
          const a = c * Math.max(0, Math.min(1, w + 0.5 - d));
          if (a <= 0) continue;
          const i = y * W + px;
          // Strands over strands: coverage adds up; the seed of the top one shows.
          cover[i] = Math.min(1, cover[i]! + a * (1 - cover[i]! * 0.5));
          if (a > 0.3) seeds[i] = seed;
        }
      }
    }
    for (let y = 0; y < H; y++) for (let x = x0; x < x0 + sw; x++) along[y * W + x] = y < band ? 0 : y / H;
  }
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = Math.round(cover[i]! * 255);
    data[i * 4 + 1] = Math.round(along[i]! * 255);
    data[i * 4 + 2] = Math.round(seeds[i]! * 255);
    data[i * 4 + 3] = 255;
  }
  const texture = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
  texture.colorSpace = NoColorSpace;
  texture.flipY = false;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  CACHE.set(kind, texture);
  return texture;
}
