import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  IcosahedronGeometry,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type Material,
  type MeshDepthMaterial,
} from 'three';
import { applyWind, windDepthMaterial, type WindResponse } from './wind';
import { UNITS_PER_METER } from '@world/units';

/** THE ONE TREE STYLE of the game: every tree and bush on the map - the countryside's and the planted ones */
/** Leaves in the far clump, and the near clump's times as many. */
const FAR_LEAVES = 300;
const NEAR_LEAVES = 2.5;
/** World distance from the eye over which a card goes from the near clump to the far one, metres. */
const LEAF_NEAR = 22;
const LEAF_FAR = 70;
/** The atlas' thirds: the far clump, the near clump, the frond. */
const THIRD = 1 / 3;

export type LowPolyKind = 'oak' | 'broadleafTall' | 'cypress' | 'palm' | 'ipeYellow' | 'ipePink' | 'bush' | 'bushFlowering' | 'hedge';

/** A tree's two parts: its body (trunk, inner crown) and its foliage cards (a palm's: its frond strips). */
export interface LowPolyParts {
  readonly body: BufferGeometry;
  readonly cards: BufferGeometry | null;
}

interface Tone {
  readonly dark: Color;
  readonly lit: Color;
}
/** Two sRGB hex colours, converted once into the linear working space by `Color`. */
const tone = (dark: number, lit: number): Tone => ({ dark: new Color(dark), lit: new Color(lit) });
// Seen in the game's own light (ACES at exposure 1), and DARKER and a touch bluer than the lawn they stand on
const LEAF = tone(0x24401c, 0x4f7a34);
const LEAF_TALL = tone(0x203a1e, 0x46703a);
const NEEDLE = tone(0x22402a, 0x4a7343);
const FROND = tone(0x3e6026, 0x7fa448);
const BARK = tone(0x4a3c2f, 0x7d6853);
/** How far the shaded heart under a crown's foliage cards is drawn, of its full size: hidden behind the cards, seen only as shade between them. */
const HEART_SHRINK = 0.62;
const PALM_BARK = tone(0x5a4c3e, 0x948268);
const NUT = tone(0x4a4a1e, 0x8a7c3a);
const BLOOM_YELLOW = tone(0xb8892a, 0xe6bd4c);
const BLOOM_PINK = tone(0x9a5078, 0xd88ab0);
const SHRUB = tone(0x223d1b, 0x4a6e32);
const HEDGE = tone(0x1f3618, 0x42602c);
const FLOWERS: readonly Tone[] = [tone(0xb9b2a4, 0xe8e2d6), tone(0x9c4a68, 0xd0759a), tone(0x8e2f2f, 0xc4524c)];

/** A small seeded random (mulberry32): a model is the same every time it is made. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A deterministic 3-D value noise in -1..1, of the ORIGINAL corner, so the copies of a corner move together. */
function noise3(x: number, y: number, z: number, seed: number): number {
  const hash = (i: number, j: number, k: number): number => {
    let h = Math.imul(i, 374_761_393) ^ Math.imul(j, 668_265_263) ^ Math.imul(k, 1_274_126_177) ^ Math.imul(seed, 2_246_822_519);
    h = Math.imul(h ^ (h >>> 13), 1_274_126_177);
    return ((h ^ (h >>> 16)) >>> 0) / 2_147_483_648 - 1;
  };
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const plane = (k: number): number => lerp(
    lerp(hash(xi, yi, k), hash(xi + 1, yi, k), sx),
    lerp(hash(xi, yi + 1, k), hash(xi + 1, yi + 1, k), sx),
    sy,
  );
  return lerp(plane(zi), plane(zi + 1), sz);
}

/** How much light a face keeps, from where its centre lies (1 open, lower in shade). */
type Occlusion = (centre: Vector3) => number;
const OPEN: Occlusion = () => 1;

/** A crown's baked occlusion: dark low in it and deep inside it, where the leaves above shade it. */
function crownShade(bottom: number, top: number, radius: number): Occlusion {
  return (p) => {
    const h = Math.min(1, Math.max(0, (p.y - bottom) / Math.max(1e-6, top - bottom)));
    const out = Math.min(1, Math.hypot(p.x, p.z) / Math.max(1e-6, radius));
    return (0.62 + 0.38 * h) * (0.85 + 0.15 * out);
  };
}

/** A point of a crown's surface the foliage cards stand on: where, which way is out, its leaf colour, its height in the crown (0..1). */
interface LeafPoint {
  readonly p: Vector3;
  readonly n: Vector3;
  readonly tone: Tone;
  readonly height: number;
  /** Its cards' size against the tree's (a conifer's narrow towards the tip); 1 when absent. */
  readonly size?: number;
}

/** Triangles laid out flat - each its own three corners, so each face takes its own normal and colour */
class Builder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  private readonly n = new Vector3();
  private readonly e = new Vector3();
  private readonly centre = new Vector3();
  readonly leaves: LeafPoint[] = [];
  /** Frond strips (`frond`), laid flat: each corner's position, normal, colour and atlas uv. */
  private readonly strip = { pos: [] as number[], nrm: [] as number[], col: [] as number[], uv: [] as number[] };

  constructor(readonly rng: () => number) {}

  /** A palm frond's card: a strip along `spine` */
  frond(spine: readonly Vector3[], side: Vector3, width: number, fold: number, t: Tone, occlusion: Occlusion): void {
    const along = new Vector3(), up = new Vector3(), n = new Vector3();
    const rows: { p: Vector3[]; n: Vector3[]; c: [number, number, number] }[] = [];
    for (let i = 0; i < spine.length; i++) {
      const p = spine[i]!;
      along.subVectors(spine[Math.min(spine.length - 1, i + 1)]!, spine[Math.max(0, i - 1)]!).normalize();
      // The strip's own up: across it, out of the frond's top.
      up.crossVectors(side, along).normalize();
      if (up.y < 0) up.negate();
      const drop = new Vector3(0, -width * fold, 0);
      const left = p.clone().addScaledVector(side, -width).add(drop);
      const right = p.clone().addScaledVector(side, width).add(drop);
      const k = Math.min(1, Math.max(0, 0.5 + 0.3 * up.y + (this.rng() - 0.5) * 0.1)) * occlusion(p);
      const c: [number, number, number] = [
        (t.dark.r + (t.lit.r - t.dark.r) * k), (t.dark.g + (t.lit.g - t.dark.g) * k), (t.dark.b + (t.lit.b - t.dark.b) * k),
      ];
      const tip = (sign: number): Vector3 => n.copy(up).addScaledVector(side, sign * 0.45).normalize().clone();
      rows.push({ p: [left, p.clone(), right], n: [tip(-1), up.clone(), tip(1)], c });
    }
    const corner = (row: number, col: number): void => {
      const r = rows[row]!;
      const p = r.p[col]!, q = r.n[col]!;
      this.strip.pos.push(p.x, p.y, p.z);
      this.strip.nrm.push(q.x, q.y, q.z);
      this.strip.col.push(...r.c);
      this.strip.uv.push((2 + col * 0.5) * THIRD, row / (rows.length - 1));
    };
    for (let i = 0; i + 1 < rows.length; i++) {
      for (const col of [0, 1]) {
        corner(i, col); corner(i, col + 1); corner(i + 1, col + 1);
        corner(i, col); corner(i + 1, col + 1); corner(i + 1, col);
      }
    }
  }

  /** One face: lighter facing the sky, a little shade of its own, times its occlusion. */
  tri(a: Vector3, b: Vector3, c: Vector3, t: Tone, occlusion: Occlusion = OPEN, jitter = 0.15): void {
    this.n.subVectors(b, a).cross(this.e.subVectors(c, a)).normalize();
    this.centre.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    const k = Math.min(1, Math.max(0, 0.42 + 0.45 * this.n.y + (this.rng() - 0.5) * jitter));
    const light = occlusion(this.centre);
    const r = (t.dark.r + (t.lit.r - t.dark.r) * k) * light;
    const g = (t.dark.g + (t.lit.g - t.dark.g) * k) * light;
    const bl = (t.dark.b + (t.lit.b - t.dark.b) * k) * light;
    for (const p of [a, b, c]) {
      this.pos.push(p.x, p.y, p.z);
      this.col.push(r, g, bl);
    }
  }

  /** A three primitive, moved by `m`, its faces each their own shade; `pick` may give a face another tone. */
  add(geometry: BufferGeometry, m: Matrix4, t: Tone, occlusion: Occlusion = OPEN, jitter = 0.15, pick?: (centre: Vector3) => Tone): void {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    g.applyMatrix4(m);
    const p = g.getAttribute('position');
    const mid = new Vector3();
    for (let i = 0; i + 2 < p.count; i += 3) {
      const a = new Vector3().fromBufferAttribute(p, i);
      const b = new Vector3().fromBufferAttribute(p, i + 1);
      const c = new Vector3().fromBufferAttribute(p, i + 2);
      const faceTone = pick ? pick(mid.copy(a).add(b).add(c).multiplyScalar(1 / 3)) : t;
      this.tri(a, b, c, faceTone, occlusion, jitter);
    }
    g.dispose();
    geometry.dispose();
  }

  /** A crown mass: an 80-face sphere */
  mass(at: Vector3, radius: number, squash: Vector3, t: Tone, seed: number, roughness: number, occlusion: Occlusion,
    leafy: boolean, pick?: (centre: Vector3) => Tone, floor = -Infinity): void {
    const solid = new IcosahedronGeometry(1, 1);
    const position = solid.getAttribute('position');
    const p = new Vector3();
    const top = radius * squash.y;
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i);
      const big = noise3(p.x * 1.1 + seed * 3.1, p.y * 1.1, p.z * 1.1, seed);
      const small = noise3(p.x * 2.6, p.y * 2.6 + seed * 1.7, p.z * 2.6, seed + 17);
      p.multiplyScalar(radius * (1 + big * roughness + small * roughness * 0.3)).multiply(squash).add(at);
      if (p.y < floor) p.y = floor + (p.y - floor) * 0.2;
      position.setXYZ(i, p.x, p.y, p.z);
      if (leafy && i % 3 === 0) {
        const n = p.clone().sub(at).normalize();
        const height = Math.min(1, Math.max(0, (p.y - (at.y - top)) / Math.max(1e-6, 2 * top)));
        this.leaves.push({ p: p.clone(), n, tone: pick ? pick(p) : t, height });
      }
    }
    // The heart under the cards is their shade: what shows of it between them reads as depth in the canopy, not as a solid.
    const heart: Occlusion = leafy ? (c) => occlusion(c) * 0.5 : occlusion;
    // Under foliage the heart is drawn shrunk towards the crown's middle (the cards stay on the full surface)
    const shrink = leafy
      ? new Matrix4().makeTranslation(at.x, at.y, at.z).multiply(new Matrix4().makeScale(HEART_SHRINK, HEART_SHRINK, HEART_SHRINK))
        .multiply(new Matrix4().makeTranslation(-at.x, -at.y, -at.z))
      : new Matrix4();
    this.add(solid, shrink, t, heart, 0.15, pick);
  }

  /** The body and `count` cards of `size` on the leaf points, both stood on the origin and scaled to one unit tall. */
  finish(count: number, size: number): LowPolyParts {
    const body = new BufferGeometry();
    body.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    body.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    body.computeBoundingBox();
    const box = body.boundingBox!;
    // Where each card goes, before the model is scaled: a little out from the heart's surface.
    const placed: { leaf: LeafPoint; s: number; c: Vector3 }[] = [];
    let top = box.max.y;
    for (let k = 0; k < (this.leaves.length > 0 ? count : 0); k++) {
      const leaf = this.leaves[Math.floor(this.rng() * this.leaves.length)]!;
      const s = size * (leaf.size ?? 1) * (0.75 + this.rng() * 0.5);
      const c = leaf.p.clone().addScaledVector(leaf.n, s * (0.1 + this.rng() * 0.2));
      top = Math.max(top, c.y + s * 0.45);
      placed.push({ leaf, s, c });
    }
    const strip = this.strip;
    for (let i = 1; i < strip.pos.length; i += 3) top = Math.max(top, strip.pos[i]!);
    const lift = -box.min.y;
    const scale = 1 / Math.max(1e-6, top - box.min.y);
    body.translate(0, lift, 0);
    body.scale(scale, scale, scale);
    // Non-indexed: each face its own corners, so its own normal.
    body.computeVertexNormals();
    body.computeBoundingBox();
    body.computeBoundingSphere();
    if (placed.length === 0 && strip.pos.length === 0) return { body, cards: null };

    const positions: number[] = [], normals: number[] = [], colours: number[] = [], uvs: number[] = [], corners: number[] = [];
    // The frond strips as they lie: no offset in the view's plane.
    for (let i = 0; i < strip.pos.length; i += 3) {
      positions.push(strip.pos[i]! * scale, (strip.pos[i + 1]! + lift) * scale, strip.pos[i + 2]! * scale);
      corners.push(0, 0);
    }
    normals.push(...strip.nrm);
    colours.push(...strip.col);
    uvs.push(...strip.uv);
    for (const { leaf, s, c } of placed) {
      c.y += lift;
      c.multiplyScalar(scale);
      const roll = this.rng() * Math.PI * 2;
      const cr = Math.cos(roll), sr = Math.sin(roll);
      const k0 = Math.min(1, 0.45 + 0.55 * leaf.height) * (0.88 + this.rng() * 0.24);
      const t = leaf.tone;
      const r = t.dark.r + (t.lit.r - t.dark.r) * k0, g = t.dark.g + (t.lit.g - t.dark.g) * k0, b = t.dark.b + (t.lit.b - t.dark.b) * k0;
      // The normal out of the crown, lifted a little: the canopy's top takes the sky.
      const nx = leaf.n.x, ny = leaf.n.y * 0.8 + 0.2, nz = leaf.n.z;
      const nl = Math.hypot(nx, ny, nz) || 1;
      const corner = (u: number, w: number): void => {
        // Every corner at the card's centre
        positions.push(c.x, c.y, c.z);
        const ou = (u - 0.5) * s * scale, ow = (w - 0.5) * s * scale;
        corners.push(ou * cr - ow * sr, ou * sr + ow * cr);
        normals.push(nx / nl, ny / nl, nz / nl);
        colours.push(r, g, b);
        // The leaf cluster: the atlas' first third (the shader moves near cards to the second).
        uvs.push(u * THIRD, w);
      };
      corner(0, 0); corner(1, 0); corner(1, 1);
      corner(0, 0); corner(1, 1); corner(0, 1);
    }
    const cards = new BufferGeometry();
    cards.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    cards.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
    cards.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
    cards.setAttribute('uv', new BufferAttribute(new Float32Array(uvs), 2));
    cards.setAttribute('aCorner', new BufferAttribute(new Float32Array(corners), 2));
    cards.computeBoundingBox();
    cards.computeBoundingSphere();
    // The cards reach past their centres by up to their size.
    if (cards.boundingSphere) cards.boundingSphere.radius += size * scale;
    return { body, cards };
  }
}

const UP = new Vector3(0, 1, 0);
/** A primitive standing along +y, placed from `from` to `to` (its height is the distance). */
function along(from: Vector3, to: Vector3): Matrix4 {
  const dir = new Vector3().subVectors(to, from);
  const length = dir.length();
  const q = new Quaternion().setFromUnitVectors(UP, dir.clone().normalize());
  const mid = new Vector3().addVectors(from, to).multiplyScalar(0.5);
  return new Matrix4().compose(mid, q, new Vector3(1, 1, 1)).multiply(new Matrix4().makeScale(1, length, 1));
}

/** A six-sided trunk from the ground to `top`, tapering from `r0` to `r1`, open at its ends (in the ground and the crown). */
function trunk(b: Builder, top: Vector3, r0: number, r1: number, bark: Tone): void {
  b.add(new CylinderGeometry(r1, r0, 1, 6, 1, true), along(new Vector3(0, 0, 0), top), bark, OPEN, 0.1);
}

/** Limbs from near the top of the trunk out into the crown, each `r0` thick at the trunk: seen between the cards. */
function limbs(b: Builder, from: Vector3, count: number, reach: number, rise: number, r0: number, bark: Tone): void {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + b.rng() * 0.7;
    const to = new Vector3(from.x + Math.cos(a) * reach * (0.8 + b.rng() * 0.3), from.y + rise * (0.8 + b.rng() * 0.4), from.z + Math.sin(a) * reach * (0.8 + b.rng() * 0.3));
    b.add(new CylinderGeometry(r0 * 0.45, r0, 1, 5, 1, true), along(from, to), bark, OPEN, 0.1);
  }
}

/** The shade tree: a broad crown of cards over a lumpy heart, on a short stout trunk. */
function oak(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  const top = new Vector3((b.rng() - 0.5) * 0.04, 0.42, (b.rng() - 0.5) * 0.04);
  trunk(b, top, 0.062, 0.04, BARK);
  limbs(b, new Vector3(top.x, top.y - 0.06, top.z), 3, 0.16, 0.16, 0.024, BARK);
  // A small heart under large cards (the forest's old card trees: 36 cards of 0.48 over a heart of 0.19)
  const shade = crownShade(0.3, 0.98, 0.34);
  b.mass(new Vector3(top.x, 0.62, top.z), 0.19, new Vector3(1.05, 0.9, 1.05), LEAF, seed, 0.22, shade, true);
  const a = b.rng() * Math.PI * 2;
  b.mass(new Vector3(top.x + Math.cos(a) * 0.13, 0.64, top.z + Math.sin(a) * 0.13), 0.13, new Vector3(1, 0.88, 1), LEAF, seed + 5, 0.2, shade, true);
  return b.finish(40, 0.44);
}

/** A tall, narrow crown of cards on a longer clear stem. */
function broadleafTall(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  const top = new Vector3((b.rng() - 0.5) * 0.03, 0.4, (b.rng() - 0.5) * 0.03);
  trunk(b, top, 0.05, 0.032, BARK);
  limbs(b, new Vector3(top.x, top.y - 0.05, top.z), 2, 0.1, 0.16, 0.02, BARK);
  const shade = crownShade(0.26, 1.0, 0.24);
  b.mass(new Vector3(top.x, 0.66, top.z), 0.14, new Vector3(1, 1.7, 1), LEAF_TALL, seed, 0.2, shade, true);
  return b.finish(34, 0.34);
}

/** The cypress: a narrow, dark cone of a heart over a short trunk under needle-green foliage cards */
function cypress(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  trunk(b, new Vector3(0, 0.2, 0), 0.034, 0.024, BARK);
  const slim = 0.92 + b.rng() * 0.16;
  // Only a thin core: a cone as wide as the crown showed through the cards as a smooth black spike (the player, 2026-10-08).
  const base = 0.16, height = 0.8, core = 0.045 * slim, crown = 0.16 * slim;
  const shade: Occlusion = (p) => (0.66 + 0.34 * Math.min(1, Math.max(0, (p.y - base) / height))) * 0.5;
  b.add(new ConeGeometry(core, height, 6, 1, true), new Matrix4().makeTranslation(0, base + height / 2, 0), NEEDLE, shade, 0.12);
  // The cards' points through a cone round the core, each facing out and a little up
  for (let i = 0; i < 120; i++) {
    const t = Math.pow(b.rng(), 1.3);
    const y = base + 0.03 + t * height * 0.9;
    const r = (crown * (1 - t) + 0.02) * (0.55 + 0.45 * b.rng());
    const a = b.rng() * Math.PI * 2;
    const n = new Vector3(Math.cos(a), 0.35, Math.sin(a)).normalize();
    b.leaves.push({ p: new Vector3(Math.cos(a) * r, y, Math.sin(a) * r), n, tone: NEEDLE, height: t, size: 1 - 0.6 * t });
  }
  return b.finish(70, 0.3);
}

/** The palm: a slender, leaning trunk, smooth but for faint rings, a dark crownshaft with a few nuts under it */
function palm(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  const lean = 0.12 + b.rng() * 0.1, turn = b.rng() * Math.PI * 2;
  const leanDir = new Vector3(Math.cos(turn), 0, Math.sin(turn));
  // The trunk's line: up, bending out with the lean (a quadratic curve).
  const at = (t: number): Vector3 => new Vector3(0, 0.8 * t, 0).addScaledVector(leanDir, lean * t * t);
  const rings = 5;
  for (let s = 0; s < rings; s++) {
    const p0 = at(s / rings), p1 = at((s + 1.02) / rings);
    const r = 0.036 * (1 - 0.3 * (s / rings));
    // Barely wider at each foot than its top: the faint rings of the leaf scars.
    b.add(new CylinderGeometry(r * 0.95, r * 1.02, 1, 8, 1, true), along(p0, p1), PALM_BARK, OPEN, 0.06);
  }
  const crown = at(1);
  // The crownshaft and the nuts hanging under the fronds, in the crown's shade.
  b.add(new IcosahedronGeometry(0.024, 1), new Matrix4().makeScale(1, 1.6, 1).premultiply(new Matrix4().makeTranslation(crown.x, crown.y - 0.012, crown.z)), PALM_BARK, () => 0.8, 0.1);
  for (let k = 0; k < 4; k++) {
    const a = b.rng() * Math.PI * 2;
    b.add(new IcosahedronGeometry(0.016, 0), new Matrix4().makeTranslation(crown.x + Math.cos(a) * 0.03, crown.y - 0.035 - b.rng() * 0.012, crown.z + Math.sin(a) * 0.03), NUT, () => 0.7, 0.1);
  }
  const shade: Occlusion = (p) => 0.7 + 0.3 * Math.min(1, Math.max(0, (p.y - crown.y + 0.25) / 0.35));
  const fronds = 10;
  for (let k = 0; k < fronds; k++) {
    // The last two the young ones, standing up out of the middle.
    const young = k >= fronds - 2;
    const a = (k / fronds) * Math.PI * 2 * (young ? 2.7 : 1) + b.rng() * 0.4;
    const out = new Vector3(Math.cos(a), 0, Math.sin(a));
    const side = new Vector3(-Math.sin(a), 0, Math.cos(a));
    const length = (young ? 0.32 : 0.46) + b.rng() * 0.08;
    // Where it leaves the crown, and how far it bends over to its tip.
    const lift = young ? 1.05 + b.rng() * 0.2 : 0.35 + b.rng() * 0.35;
    const bend = young ? 0.7 : 1.5 + b.rng() * 0.4;
    const steps = 6;
    const spine: Vector3[] = [crown.clone()];
    for (let i = 1; i <= steps; i++) {
      const angle = lift - (i / steps) * bend;
      const step = new Vector3().addScaledVector(out, Math.cos(angle)).setY(Math.sin(angle)).multiplyScalar(length / steps);
      spine.push(spine[i - 1]!.clone().add(step));
    }
    // Leaflets a sixth of the frond long, at an angle to the rachis: a narrow strip.
    b.frond(spine, side, length * 0.14, young ? 0.35 : 0.7, FROND, shade);
  }
  return b.finish(0, 0);
}

/** The flowering ipê: one wide, flat crown of cards, flower over the top and the last leaves' green underneath. */
function ipe(seed: number, bloom: Tone): LowPolyParts {
  const b = new Builder(random(seed));
  const top = new Vector3((b.rng() - 0.5) * 0.05, 0.44, (b.rng() - 0.5) * 0.05);
  trunk(b, top, 0.058, 0.036, BARK);
  limbs(b, new Vector3(top.x, top.y - 0.05, top.z), 4, 0.2, 0.14, 0.022, BARK);
  const shade = crownShade(0.34, 0.95, 0.42);
  const centre = 0.62;
  const pick = (c: Vector3): Tone => (c.y < centre - 0.1 ? LEAF : bloom);
  b.mass(new Vector3(top.x, centre, top.z), 0.2, new Vector3(1.25, 0.65, 1.25), bloom, seed, 0.2, shade, true, pick);
  return b.finish(54, 0.46);
}

/** A bush: one lump of leaves pressed onto the ground under a coat of cards, about one and a half times as wide as tall. */
function bush(seed: number, flowering: boolean): LowPolyParts {
  const b = new Builder(random(seed));
  const shade = crownShade(0, 0.95, 0.7);
  // A flowering bush: a scatter of blossoms over the sunlit upper side.
  const pick = flowering
    ? (c: Vector3): Tone => (c.y > 0.5 && b.rng() < 0.3 ? FLOWERS[Math.floor(b.rng() * FLOWERS.length)]! : SHRUB)
    : undefined;
  b.mass(new Vector3(0, 0.42, 0), 0.36, new Vector3(1.5, 1, 1.3), SHRUB, seed, 0.2, shade, true, pick, 0);
  return b.finish(16, 0.62);
}

/** A clipped hedge: one long, trimmed block of leaves under a coat of cards. */
function hedge(seed: number): LowPolyParts {
  const b = new Builder(random(seed));
  const shade = crownShade(0, 0.95, 0.9);
  b.mass(new Vector3(0, 0.46, 0), 0.4, new Vector3(2, 1, 0.8), HEDGE, seed, 0.08, shade, true, undefined, 0);
  return b.finish(20, 0.56);
}

/** A tree or bush of this kind, grown from `seed` (the same seed, the same model): its body and its foliage cards. */
export function lowPolyTreeParts(kind: LowPolyKind, seed: number): LowPolyParts {
  switch (kind) {
    case 'oak': return oak(seed);
    case 'broadleafTall': return broadleafTall(seed);
    case 'cypress': return cypress(seed);
    case 'palm': return palm(seed);
    case 'ipeYellow': return ipe(seed, BLOOM_YELLOW);
    case 'ipePink': return ipe(seed, BLOOM_PINK);
    case 'bush': return bush(seed, false);
    case 'bushFlowering': return bush(seed, true);
    case 'hedge': return hedge(seed);
  }
}

/** The foliage atlas, one for the whole game, grey */
let atlasTexture: CanvasTexture | null | undefined;
export function foliageAtlas(): CanvasTexture | null {
  if (atlasTexture !== undefined) return atlasTexture;
  if (typeof document === 'undefined') return (atlasTexture = null);
  // 512 texels a clump (was 256): the leaves, 14-24 texels long
  const size = 512;
  const k = size / 256;
  const canvas = document.createElement('canvas');
  canvas.width = size * 3;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return (atlasTexture = null);
  const rng = random(0xc1a5);
  ctx.clearRect(0, 0, size * 3, size);
  // The far clump, then the near one: as many times the leaves, each 1 / sqrt(NEAR_LEAVES) the size
  const clump = (left: number, leaves: number, grow: number): void => {
  for (let i = 0; i < leaves; i++) {
    const a = rng() * Math.PI * 2;
    // Denser at the heart of the clump, ragged at its rim.
    const r = Math.pow(rng(), 0.7) * 112 * k;
    const x = left + size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r * 0.92;
    const len = (14 + rng() * 10) * k * grow;
    const wid = (6 + rng() * 4) * k * grow;
    const shade = 150 + Math.floor(rng() * 105);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rng() * Math.PI * 2);
    // Each leaf in two tones (its lit half paler) and a darker rim, so it reads as a leaf and not as a smudge.
    const leaf = new Path2D();
    leaf.moveTo(-len / 2, 0);
    leaf.quadraticCurveTo(0, -wid, len / 2, 0);
    leaf.quadraticCurveTo(0, wid, -len / 2, 0);
    ctx.fillStyle = `rgb(${shade}, ${shade}, ${shade})`;
    ctx.fill(leaf);
    const lit = Math.min(255, shade + 30);
    ctx.fillStyle = `rgb(${lit}, ${lit}, ${lit})`;
    ctx.beginPath();
    ctx.moveTo(-len / 2, 0);
    ctx.quadraticCurveTo(0, -wid, len / 2, 0);
    ctx.closePath();
    ctx.fill();
    const rim = Math.max(0, shade - 70);
    ctx.strokeStyle = `rgb(${rim}, ${rim}, ${rim})`;
    ctx.lineWidth = 1.2 * k * grow;
    ctx.stroke(leaf);
    ctx.restore();
  }
  };
  clump(0, FAR_LEAVES, 1);
  clump(size, Math.round(FAR_LEAVES * NEAR_LEAVES), 1 / Math.sqrt(NEAR_LEAVES));
  // The frond: base at the canvas' foot (the texture's v = 0), tip at its head.
  const mid = size * 2.5, base = size - 4 * k, tipY = 4 * k;
  ctx.lineCap = 'round';
  for (const sign of [-1, 1]) {
    for (let j = 0; j < 40; j++) {
      const t = (j + rng() * 0.4) / 40;
      const y = base - t * (base - tipY);
      // Longest a third of the way up, short at the base and the tip.
      const reach = 120 * k * Math.sin(Math.PI * Math.min(1, 0.06 + t * 0.95)) ** 0.7 * (0.85 + rng() * 0.15);
      const shade = 150 + Math.floor(rng() * 105);
      ctx.strokeStyle = `rgb(${shade}, ${shade}, ${shade})`;
      // Thin, with clear gaps between them: leaflets, not a blade.
      ctx.lineWidth = (2.2 + rng() * 1.4) * k;
      ctx.beginPath();
      ctx.moveTo(mid, y);
      // Swept up towards the tip, curving out.
      ctx.quadraticCurveTo(mid + sign * reach * 0.5, y - reach * 0.15, mid + sign * reach, y - reach * 0.5);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = 'rgb(210, 205, 170)';
  ctx.lineWidth = 4 * k;
  ctx.beginPath();
  ctx.moveTo(mid, base);
  ctx.lineTo(mid, tipY);
  ctx.stroke();
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  // Sharp at the grazing angles the camera looks at a crown from (three clamps it to what the GPU allows).
  texture.anisotropy = 8;
  return (atlasTexture = texture);
}

/** Turns a material's foliage cards to face the camera - or the light, in a shadow pass */
function billboardCards(material: Material): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec2 aCorner;`)
      .replace('mvPosition = modelViewMatrix * mvPosition;', `mvPosition = modelViewMatrix * mvPosition;
        {
          float cardScale = 1.0;
          #ifdef USE_INSTANCING
            cardScale = 0.5 * (length(instanceMatrix[0].xyz) + length(instanceMatrix[1].xyz));
          #endif
          mvPosition.xy += aCorner * cardScale;
        }`);
  };
  const cacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${cacheKey()}-billboard`;
}

/** Keeps the leaves as covered at a distance as up close */
function keepLeafCoverage(material: Material): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      #ifdef USE_MAP
      {
        vec2 texel = vMapUv * vec2(textureSize(map, 0));
        float lod = max(0.0, 0.5 * log2(max(dot(dFdx(texel), dFdx(texel)), dot(dFdy(texel), dFdy(texel)))));
        diffuseColor.a *= 1.0 + lod * 0.25;
      }
      #endif`);
  };
  const cacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${cacheKey()}-coverage`;
}

/** The near clump on cards close to the eye (`NEAR_LEAVES`) */
function nearLeaves(material: Material): void {
  const previous = material.onBeforeCompile.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    previous(shader, renderer);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        varying float vLeafNear;`)
      .replace('mvPosition.xy += aCorner * cardScale;', `mvPosition.xy += aCorner * cardScale;
        // (After \`billboardCards\`: the wind has three's projection written out.)
        vLeafNear = 1.0 - smoothstep(${(LEAF_NEAR * UNITS_PER_METER).toFixed(3)}, ${(LEAF_FAR * UNITS_PER_METER).toFixed(3)}, length(mvPosition.xyz));`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vLeafNear;`)
      .replace('#include <map_fragment>', `#ifdef USE_MAP
        {
          vec2 leafDx = dFdx(vMapUv), leafDy = dFdy(vMapUv);
          vec4 sampledDiffuseColor = textureGrad(map, vMapUv, leafDx, leafDy);
          if (vLeafNear > 0.001 && vMapUv.x < ${THIRD.toFixed(6)}) {
            vec4 nearClump = textureGrad(map, vMapUv + vec2(${THIRD.toFixed(6)}, 0.0), leafDx, leafDy);
            sampledDiffuseColor = mix(sampledDiffuseColor, nearClump, vLeafNear);
          }
          diffuseColor *= sampledDiffuseColor;
        }
        #endif`);
  };
  const cacheKey = material.customProgramCacheKey.bind(material);
  material.customProgramCacheKey = () => `${cacheKey()}-near`;
}

/** The foliage cards' material (leaf-cluster texture, alpha to coverage, billboards, the wind) and the depth material their shadows would use: the same programs for every kit (`key` names the wind's user only), the patches being the same code. */
export function leafCardMaterials(wind: WindResponse, key: string): { material: MeshStandardMaterial; depth: MeshDepthMaterial } {
  const map = foliageAtlas();
  const material = new MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, map, alphaTest: 0.5, alphaToCoverage: true, side: DoubleSide,
    roughness: 0.8, metalness: 0, envMapIntensity: 0.3,
  });
  applyWind(material, wind, `${key}-cards`);
  billboardCards(material);
  keepLeafCoverage(material);
  nearLeaves(material);
  const depth = windDepthMaterial(wind, `${key}-cards`);
  billboardCards(depth);
  depth.map = map;
  depth.alphaTest = 0.5;
  return { material, depth };
}
