import { type BlueprintBody } from '@world/buildings/blueprints';
import { Model, mat } from '@world/buildings/cityBuildings';
import { edgeFrame } from '@world/buildings/footprints';
import { baysOn } from '@world/buildings/geometry';
import { type BayComponent, type Building, type Volume, bayKey } from '@world/buildings/types';
import { m } from '@world/units';
import type { Point3, ReferenceSampler, Triangle } from '@world/buildings/reference';

/**
 * Builds a building from a reference model: the real building's 3D model,
 * read the way a surveyor reads one, and rebuilt of the game's own blocks so
 * every part of it stays editable.
 *
 * 1. Massing: every upward face of the model is a top; the tops at one height
 *    that touch are one block, whose plan is the convex hull of its roof, and
 *    which stands on the highest top under its centre (or on the ground).
 * 2. Colour: each block's walls take the colour the model shows on them; a
 *    base of another colour (a stone plinth) becomes its own block.
 * 3. Facade: every bay of every storey is looked at in the model's pictures:
 *    plain where the model is light, windows where it is dark, a portal where
 *    the ground floor is open, wide openings where most of a bay is dark.
 * 4. Crown: what rises above the highest block (a mast, a lantern, a spire)
 *    becomes a lantern with a flag on that block's roof.
 *
 * Everything is in metres in the reference's plan: x across, y away from the
 * front, z up; the plan centred on the origin.
 */

// The model's geometry types live below both readers (`world/buildings/reference.ts`).
export type { Point3, ReferenceSampler, Triangle };

export interface ReferenceBlock {
  x0: number; x1: number; y0: number; y1: number;
  /** Foot and top, metres above the ground. */
  z0: number; z1: number;
  /** Counter-clockwise convex hull of the roof, metres. */
  hull: [number, number][];
}

export interface ReferenceOptions {
  /** Ground floor and upper storey heights, metres. */
  readonly ground?: number;
  readonly storey?: number;
}

const TOUCH = 0.05;

/** The model's blocks, from its upward faces. */
export function blocksFromTriangles(tris: readonly Triangle[]): ReferenceBlock[] {
  interface Top { x0: number; x1: number; y0: number; y1: number; z: number; pts: [number, number][] }
  const tops: Top[] = [];
  const overlaps = (a: Top, b: Top): boolean =>
    Math.abs(a.z - b.z) < TOUCH && b.x0 <= a.x1 + TOUCH && b.x1 >= a.x0 - TOUCH && b.y0 <= a.y1 + TOUCH && b.y1 >= a.y0 - TOUCH;
  const absorb = (a: Top, b: Top): void => {
    a.x0 = Math.min(a.x0, b.x0); a.x1 = Math.max(a.x1, b.x1);
    a.y0 = Math.min(a.y0, b.y0); a.y1 = Math.max(a.y1, b.y1);
    a.pts.push(...b.pts);
  };
  for (const [a, b, c] of tris) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    // Upward faces only (either winding: models are not always consistent).
    if (len < 2e-4 || Math.abs(nz) / len < 0.98) continue;
    const xs = [a[0], b[0], c[0]], ys = [a[1], b[1], c[1]];
    const top: Top = {
      x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
      z: (a[2] + b[2] + c[2]) / 3, pts: [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]]],
    };
    const near = tops.find((q) => overlaps(q, top));
    if (near) absorb(near, top);
    else tops.push(top);
  }
  // A top grown by later triangles can now touch another one.
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 0; i < tops.length && !changed; i++) {
      for (let j = i + 1; j < tops.length && !changed; j++) {
        if (overlaps(tops[i]!, tops[j]!)) { absorb(tops[i]!, tops[j]!); tops.splice(j, 1); changed = true; }
      }
    }
  }
  return tops
    .filter((t) => t.z > 0.2 && t.x1 - t.x0 > 0.3 && t.y1 - t.y0 > 0.3)
    .map((t) => {
      const cx = (t.x0 + t.x1) / 2, cy = (t.y0 + t.y1) / 2;
      const below = tops.filter((q) => q.z < t.z - TOUCH && cx >= q.x0 && cx <= q.x1 && cy >= q.y0 && cy <= q.y1);
      return { x0: t.x0, x1: t.x1, y0: t.y0, y1: t.y1, z0: below.length ? Math.max(...below.map((q) => q.z)) : 0, z1: t.z, hull: convexHull(t.pts) };
    })
    .sort((a, b) => a.z1 - b.z1);
}

const luminance = (c: readonly [number, number, number]): number => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
const toHex = (c: readonly [number, number, number]): number =>
  (Math.round(c[0] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[2] * 255);
const distance = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** The building the reference shows; null when the model has no block big enough to build. */
export function buildFromReference(tris: readonly Triangle[], sample: ReferenceSampler, options: ReferenceOptions = {}): BlueprintBody | null {
  const GROUND = options.ground ?? 4.5, STOREY = options.storey ?? 3.3;
  const level = (z: number): number => (z < 1 ? 0 : Math.max(1, Math.round((z - GROUND) / STOREY) + 1));
  const height = (L: number): number => (L === 0 ? 0 : GROUND + (L - 1) * STOREY);

  // 1. Massing: blocks big enough to be rooms, on the kept blocks under them.
  const all = blocksFromTriangles(tris);
  const kept = all.filter((b) => b.x1 - b.x0 >= 2 && b.y1 - b.y0 >= 2 && b.z1 - b.z0 >= 2.5);
  if (kept.length === 0) return null;
  const levels = new Map<ReferenceBlock, { base: number; top: number }>();
  for (const b of kept) {
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    const under = kept.filter((o) => o !== b && o.z1 <= b.z0 + 1 && cx >= o.x0 && cx <= o.x1 && cy >= o.y0 && cy <= o.y1);
    const base = under.length ? level(Math.max(...under.map((o) => o.z1))) : 0;
    levels.set(b, { base, top: Math.max(base + 1, level(b.z1)) });
  }

  // 2. Colour: what the walls show, a storey at a time, on the blocks standing on the ground.
  const wallColour = (b: ReferenceBlock, z0: number, z1: number): [number, number, number] | null => {
    const light: [number, number, number][] = [];
    // All four sides, each where it shows: the walls, not its windows or shadows.
    const sides: [number, number, number, number, number, number][] = [
      [b.x0, b.y0 - 0.05, b.x1, b.y0 - 0.05, 0, -1], [b.x1 + 0.05, b.y0, b.x1 + 0.05, b.y1, 1, 0],
      [b.x0, b.y1 + 0.05, b.x1, b.y1 + 0.05, 0, 1], [b.x0 - 0.05, b.y0, b.x0 - 0.05, b.y1, -1, 0],
    ];
    for (const [ax, ay, bx, by, nx, ny] of sides) {
      for (let k = 0; k < 9; k++) {
        const f = 0.1 + 0.8 * k / 8;
        for (let c = 0; c < 3; c++) {
          const col = sample(ax + (bx - ax) * f, ay + (by - ay) * f, z0 + (z1 - z0) * (0.2 + 0.3 * c), nx, ny);
          if (col && luminance(col) >= 0.42) light.push([...col]);
        }
      }
    }
    if (light.length < 4) return null;
    // The median of each channel: the wall, not its windows or shadows.
    const med = (i: number): number => light.map((p) => p[i]!).sort((p, q) => p - q)[light.length >> 1]!;
    return [med(0), med(1), med(2)];
  };
  const blockLook = new Map<ReferenceBlock, [number, number, number] | null>();
  let plinth = 0;
  let plinthColour: [number, number, number] | null = null;
  for (const b of kept) {
    const { base, top } = levels.get(b)!;
    blockLook.set(b, wallColour(b, height(Math.max(base, top - 3)), height(top)));
    if (base !== 0 || top < 4) continue;
    // A base of another colour: the highest storey from the ground that still differs from the top.
    const upper = blockLook.get(b);
    if (!upper) continue;
    let reach = 0, colour: [number, number, number] | null = null;
    for (let L = 0; L < top - 2; L++) {
      const c = wallColour(b, height(L), height(L + 1));
      if (c && distance(c, upper) > 0.12) { reach = L + 1; colour ??= c; } else if (L > reach + 1) break;
    }
    if (reach > plinth) { plinth = reach; plinthColour = colour; }
  }
  const stoneOf = (c: [number, number, number] | null | undefined) => (c ? mat('stone', toHex(c)) : undefined);
  const body = new Model('office', 'commercial', 6)
    .heights(GROUND, STOREY)
    .look(mat('stone', 0xd2cec4), mat('concrete', 0x9a9890), mat('stone', 0xc9c3b4));
  const plinthWall = stoneOf(plinthColour);
  for (const b of [...kept].sort((p, q) => levels.get(p)!.base - levels.get(q)!.base)) {
    const { base, top } = levels.get(b)!;
    const w = b.x1 - b.x0, d = b.y1 - b.y0;
    const shape = b.hull.length > 4 ? normalisedOutline(b, w, d) : undefined;
    const wall = stoneOf(blockLook.get(b));
    const spec = { x: b.x0, y: b.y0, w, d, roof: 'flat' as const, fill: 'sashWindow' as const, ...(shape ? { shape } : {}) };
    if (plinthWall && base === 0 && top > plinth) {
      body.block({ ...spec, base: 0, storeys: plinth, wall: plinthWall });
      body.block({ ...spec, base: plinth, storeys: top - plinth, ...(wall ? { wall } : {}) });
    } else {
      const own = plinthWall && top <= plinth ? plinthWall : wall;
      body.block({ ...spec, base, storeys: top - base, ...(own ? { wall: own } : {}) });
    }
  }
  const made = body.build();

  // 3. Facade: each bay as the model shows it.
  const probe = { ...made, id: 0, x: 0, y: 0, rotation: 0 } as Building;
  for (const v of made.volumes as Volume[]) {
    const marble = plinthWall !== undefined && v.materials?.wall === plinthWall;
    const sides = v.outline?.length ?? 4;
    for (let side = 0; side < sides; side++) {
      const e = edgeFrame(v, side);
      const count = baysOn(probe, v, side);
      const bw = e.length / count;
      for (let st = 0; st < v.storeys.length; st++) {
        const L = v.base + st, z0 = height(L), z1 = height(L + 1);
        for (let i = 0; i < count; i++) {
          let dark = 0, n = 0;
          for (let a = 0; a < 7; a++) {
            const along = (i + 0.1 + 0.8 * a / 6) * bw;
            const x = (e.x + e.tx * along) / m(1) + e.nx * 0.05, y = (e.y + e.ty * along) / m(1) + e.ny * 0.05;
            for (let c = 0; c < 5; c++) {
              const col = sample(x, y, z0 + (z1 - z0) * (0.15 + 0.7 * c / 4), e.nx, e.ny);
              if (!col) continue;
              n++;
              if (luminance(col) < 0.42) dark++;
            }
          }
          if (n < 8) continue;
          const share = dark / n;
          const component: BayComponent =
            share <= 0.12 ? 'wall'
            : L === 0 && share > 0.45 ? 'doubleDoor'
            : share > 0.6 ? 'wideWindow'
            : 'sashWindow';
          const f = v.storeys[st]!.facade;
          f.bays = { ...(f.bays ?? {}), [bayKey(side, i)]: component };
        }
      }
      // Pilasters between the bays above the base: the vertical shadows of a masonry tower.
      if (!marble && v.storeys.length >= 3) v.facadeGeometry = { ...(v.facadeGeometry ?? {}), [side]: { pierWidth: m(0.55), pierDepth: m(0.45), pierEvery: 1 } };
    }
    // The roof in the colour the model shows from above.
    const roof = sample((v.x + v.w / 2) / m(1), (v.y + v.d / 2) / m(1), height(v.base + v.storeys.length) + 0.5, 0, 0);
    if (roof) v.materials = { ...(v.materials ?? {}), roof: mat('tile', toHex(roof)) };
  }

  // 4. Crown: what rises above the highest block, on its roof.
  const core = (made.volumes as Volume[]).reduce((p, q) => (q.base + q.storeys.length > p.base + p.storeys.length ? q : p));
  const coreTop = height(core.base + core.storeys.length);
  const cx = (core.x + core.w / 2) / m(1), cy = (core.y + core.d / 2) / m(1);
  let crown = coreTop;
  for (const t of tris) {
    for (const p of t) {
      if (p[2] > crown && Math.abs(p[0] - cx) < core.w / m(1) / 2 && Math.abs(p[1] - cy) < core.d / m(1) / 2) crown = p[2];
    }
  }
  if (crown - coreTop > 3) {
    const size = Math.min(core.w, core.d) * 0.6;
    core.roofDetails = [{
      id: 1, kind: 'lantern', x: core.x + core.w / 2, y: core.y + core.d / 2, rotation: 0,
      w: size, d: size, h: m(crown - coreTop), flag: 'plain',
      flagDesign: { pattern: 'stripes', colours: [0xffffff, 0x111418, 0xc8102e] },
    }];
  }
  return made;
}

/** A block's hull in its own box, 0..1, without points closer than a few centimetres. */
function normalisedOutline(b: ReferenceBlock, w: number, d: number): { x: number; y: number }[] | undefined {
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  const out: { x: number; y: number }[] = [];
  for (const [x, y] of b.hull) {
    const p = { x: clamp((x - b.x0) / w), y: clamp((y - b.y0) / d) };
    const last = out[out.length - 1];
    if (!last || Math.hypot((p.x - last.x) * w, (p.y - last.y) * d) > 0.05) out.push(p);
  }
  while (out.length > 1 && Math.hypot((out[0]!.x - out[out.length - 1]!.x) * w, (out[0]!.y - out[out.length - 1]!.y) * d) <= 0.05) out.pop();
  return out.length > 4 ? out : undefined;
}

function convexHull(points: readonly [number, number][]): [number, number][] {
  const unique = [...new Map(points.map((p) => [`${p[0].toFixed(2)},${p[1].toFixed(2)}`, p])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (unique.length < 3) return unique;
  const cross = (o: readonly number[], a: readonly number[], b: readonly number[]): number =>
    (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const chain = (list: [number, number][]): [number, number][] => {
    const out: [number, number][] = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2]!, out[out.length - 1]!, p) <= 1e-6) out.pop();
      out.push(p);
    }
    return out;
  };
  const lower = chain(unique), upper = chain([...unique].reverse());
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
