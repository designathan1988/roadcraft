import { Rng } from '@core/rng';
import { m } from '@world/units';
import { fbm, makeNoise, normalTexels } from '../mesh/textureBaker';

/** The close-up detail layer's recipes (`mesh/detailLayer.ts`), baked at build time (`scripts/vite/surface-bake-plugin.ts`) */

export type DetailKind = 'asphalt' | 'concrete' | 'grass' | 'soil';

/** Texels across a detail texture. */
const SIZE = 512;

/** World units one tile of each detail family covers. */
export const DETAIL_WORLD_SIZE: Readonly<Record<DetailKind, number>> = {
  asphalt: m(1.28),
  concrete: m(1.04),
  grass: m(1.6),
  soil: m(1.2),
};

/** Adds a soft round mark into a wrapped float field. */
function stamp(
  field: Float32Array,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  angle: number,
  value: number,
  mode: 'max' | 'add',
): void {
  const reach = Math.ceil(Math.max(rx, ry)) + 1;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  for (let dy = -reach; dy <= reach; dy++) {
    for (let dx = -reach; dx <= reach; dx++) {
      const px = dx + (cx - Math.floor(cx));
      const py = dy + (cy - Math.floor(cy));
      const u = (px * cos + py * sin) / rx;
      const v = (-px * sin + py * cos) / ry;
      const d = u * u + v * v;
      if (d >= 1) continue;
      const x = (((Math.floor(cx) + dx) % SIZE) + SIZE) % SIZE;
      const y = (((Math.floor(cy) + dy) % SIZE) + SIZE) % SIZE;
      const i = y * SIZE + x;
      // A dome, so a stone has a rounded top in the normal map.
      const h = Math.sqrt(1 - d) * value;
      if (mode === 'max') field[i] = Math.max(field[i] as number, h);
      else field[i] = (field[i] as number) + h;
    }
  }
}

/** Draws a thin tapered stroke - one grass blade seen from above. */
function blade(
  field: Float32Array,
  tone: Float32Array,
  x: number,
  y: number,
  angle: number,
  length: number,
  width: number,
  shade: number,
): void {
  const steps = Math.ceil(length);
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const half = width * (1 - t * 0.85);
    const cx = x + dx * s;
    const cy = y + dy * s;
    const reach = Math.ceil(half);
    for (let oy = -reach; oy <= reach; oy++) {
      for (let ox = -reach; ox <= reach; ox++) {
        if (ox * ox + oy * oy > half * half + 0.25) continue;
        const px = (((Math.round(cx) + ox) % SIZE) + SIZE) % SIZE;
        const py = (((Math.round(cy) + oy) % SIZE) + SIZE) % SIZE;
        const i = py * SIZE + px;
        // Later blades lie on top of earlier ones, and a blade is higher at its tip than at its root
        const h = 0.35 + t * 0.65;
        if (h >= (field[i] as number)) {
          field[i] = h;
          tone[i] = shade * (0.78 + t * 0.34);
        }
      }
    }
  }
}

/** Bakes one detail family. */
function bake(kind: DetailKind): { albedo: Float32Array; tint: Float32Array[]; height: Float32Array; relief: number } {
  const n = SIZE * SIZE;
  const height = new Float32Array(n);
  const albedo = new Float32Array(n).fill(1);
  const rng = new Rng(0xde7a11 ^ kind.length * 7919);

  if (kind === 'asphalt') {
    // Aggregate: a dark bitumen binder, packed with stones of 2 to 14 mm in a spread of greys, a few of them pale quartz.
    const binder = makeNoise(0x3a91);
    for (let i = 0; i < n; i++) {
      const x = i % SIZE;
      const y = (i / SIZE) | 0;
      albedo[i] = 0.8 + fbm(binder, (x / SIZE) * 64, (y / SIZE) * 64, 64, 2) * 0.1;
      height[i] = 0.05;
    }
    const stones = new Float32Array(n);
    const stoneTone = new Float32Array(n);
    // A FINE, worn surfacing course: stones mostly 2 to 8 mm, their tones close to the binder's once traffic has dulled them
    for (let k = 0; k < 7800; k++) {
      const x = rng.float() * SIZE;
      const y = rng.float() * SIZE;
      const r = 1.0 + rng.float() ** 2.4 * 3.4;
      const tone = rng.float() < 0.03 ? 1.3 + rng.float() * 0.15 : 0.92 + rng.float() * 0.26;
      const rx = r * (0.8 + rng.float() * 0.4);
      const ry = r * (0.7 + rng.float() * 0.3);
      const angle = rng.float() * Math.PI;
      // Paint the tone where this stone is now the highest thing.
      const reach = Math.ceil(Math.max(rx, ry)) + 1;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      for (let dy = -reach; dy <= reach; dy++) {
        for (let dx = -reach; dx <= reach; dx++) {
          const u = (dx * cos + dy * sin) / rx;
          const v = (-dx * sin + dy * cos) / ry;
          const d = u * u + v * v;
          if (d >= 1) continue;
          const px = (((Math.floor(x) + dx) % SIZE) + SIZE) % SIZE;
          const py = (((Math.floor(y) + dy) % SIZE) + SIZE) % SIZE;
          const i = py * SIZE + px;
          const h = 0.25 + Math.sqrt(1 - d) * 0.75 * Math.min(1, r / 4);
          if (h > (stones[i] as number)) {
            stones[i] = h;
            stoneTone[i] = tone * (0.86 + Math.sqrt(1 - d) * 0.2);
          }
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if ((stones[i] as number) > 0) {
        albedo[i] = stoneTone[i] as number;
        height[i] = stones[i] as number;
      }
    }
    return { albedo, tint: [], height, relief: 3.2 };
  }

  if (kind === 'concrete') {
    // Broom-finished concrete: fine sand, the odd exposed pebble, and pin-hole pores that catch dirt.
    const sand = makeNoise(0x1c07);
    const cloud = makeNoise(0x88e1);
    for (let i = 0; i < n; i++) {
      const x = i % SIZE;
      const y = (i / SIZE) | 0;
      const fine = fbm(sand, (x / SIZE) * 180, (y / SIZE) * 180, 180, 2);
      const soft = fbm(cloud, (x / SIZE) * 12, (y / SIZE) * 12, 12, 3);
      albedo[i] = 0.9 + (fine - 0.5) * 0.22 + (soft - 0.5) * 0.12;
      height[i] = 0.5 + (fine - 0.5) * 0.35;
    }
    const pebbles = new Float32Array(n);
    for (let k = 0; k < 900; k++) {
      stamp(pebbles, rng.float() * SIZE, rng.float() * SIZE, 1 + rng.float() * 2.4, 1 + rng.float() * 2, rng.float() * 3, 0.5, 'max');
    }
    for (let k = 0; k < 1400; k++) {
      const x = Math.floor(rng.float() * SIZE);
      const y = Math.floor(rng.float() * SIZE);
      const i = y * SIZE + x;
      albedo[i] = 0.55;
      height[i] = 0.15;
    }
    for (let i = 0; i < n; i++) {
      const p = pebbles[i] as number;
      if (p > 0) {
        albedo[i] = (albedo[i] as number) * (0.92 + p * 0.3);
        height[i] = (height[i] as number) + p * 0.6;
      }
    }
    return { albedo, tint: [], height, relief: 2.4 };
  }

  if (kind === 'grass') {
    // Blades seen from above, in every direction, darker at the root.
    const tone = new Float32Array(n).fill(0.55);
    height.fill(0);
    const soil = makeNoise(0x4411);
    for (let i = 0; i < n; i++) {
      const x = i % SIZE;
      const y = (i / SIZE) | 0;
      tone[i] = 0.38 + fbm(soil, (x / SIZE) * 40, (y / SIZE) * 40, 40, 2) * 0.2;
    }
    for (let k = 0; k < 9000; k++) {
      blade(
        height,
        tone,
        rng.float() * SIZE,
        rng.float() * SIZE,
        rng.float() * Math.PI * 2,
        9 + rng.float() * 22,
        0.9 + rng.float() * 1.1,
        0.85 + rng.float() * 0.5,
      );
    }
    // Carried in the tint channels: blades are yellow-green, the gaps between them are a darker, warmer green-brown.
    const r = new Float32Array(n);
    const g = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = tone[i] as number;
      const lift = height[i] as number;
      r[i] = t * (0.92 + lift * 0.12);
      g[i] = t * (1.02 + lift * 0.1);
      b[i] = t * (0.82 + lift * 0.02);
      albedo[i] = t;
    }
    return { albedo, tint: [r, g, b], height, relief: 3.6 };
  }

  // soil: dirt with crumbs and small stones, for bare ground and rock.
  const crumb = makeNoise(0x9d02);
  for (let i = 0; i < n; i++) {
    const x = i % SIZE;
    const y = (i / SIZE) | 0;
    const fine = fbm(crumb, (x / SIZE) * 120, (y / SIZE) * 120, 120, 3);
    albedo[i] = 0.82 + (fine - 0.5) * 0.4;
    height[i] = fine * 0.6;
  }
  const grit = new Float32Array(n);
  for (let k = 0; k < 1800; k++) {
    stamp(grit, rng.float() * SIZE, rng.float() * SIZE, 1.2 + rng.float() * 3.5, 1 + rng.float() * 3, rng.float() * 3, 1, 'max');
  }
  for (let i = 0; i < n; i++) {
    const p = grit[i] as number;
    if (p > 0) {
      albedo[i] = (albedo[i] as number) * (0.95 + p * 0.35);
      height[i] = (height[i] as number) + p * 0.7;
    }
  }
  return { albedo, tint: [], height, relief: 3 };
}

/** One detail family's texels, rows top first as a canvas holds them: its albedo (linear data around 0.5, a multiplier of 2) and its normal map. */
export function detailTexels(kind: DetailKind): { readonly size: number; readonly map: Uint8Array; readonly normal: Uint8Array } {
  const baked = bake(kind);
  const n = SIZE * SIZE;
  const channels = baked.tint.length === 3 ? baked.tint : [baked.albedo, baked.albedo, baked.albedo];
  const means = channels.map((channel) => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += channel[i] as number;
    return sum / n;
  });
  const map = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const value = ((channels[c] as Float32Array)[i] as number) / (means[c] as number);
      map[i * 4 + c] = Math.round(Math.min(1, Math.max(0, value * 0.5)) * 255);
    }
    map[i * 4 + 3] = 255;
  }
  const normal = new Uint8Array(n * 4);
  normalTexels(baked.height, SIZE, baked.relief, normal);
  return { size: SIZE, map, normal };
}
