import { m } from '../units';
import type { BlueprintBody } from './blueprints';
import { ON_FACADE } from './elements';
import { ACCESS_COMPONENTS, PLINTH_MIN, STEP_RISE } from './foundation';
import { EPS, GRID, bayWidth, baysOn, isMass, levelHeight, planOverlap, volumeLift } from './geometry';
import { type BayComponent, type Building, type BuildingElement, type FaceId, MAX_LIFT, type Storey, type Volume, volumeById, volumeTop } from './types';

/** A building that follows its hillside */

/** The shallowest a part of a split block may be. */
const MIN_PART = m(3.5);
/** A fill costs this much more than a cut of the same depth. */
const FILL_WEIGHT = 1.3;
/** The least a step must save in mean cut and fill under the back to be built. */
const GAIN = m(0.45);
/** How far a block's side may stand from the envelope's side and still look onto the side strip. */
const ON_EDGE = m(0.6);

export interface SlopeSite {
  /** The natural ground under a point of the body's local plan. */
  readonly groundAt: (x: number, y: number) => number;
  /** The ground floor the street gives the building (same units). */
  readonly floor: number;
  /** Local x of the envelope's two sides: a face on one looks onto a side strip at the street's floor. */
  readonly x0: number;
  readonly x1: number;
  /** A car park or a loading yard behind the building (a rectangle of the local plan), laid at the back's level with it */
  readonly yard?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly maxLift?: number;
}

export interface SplitLevel {
  /** Local y from which the building, and the lot behind it, stand at their own level. */
  readonly y: number;
  /** That level's lift (world units). */
  readonly lift: number;
  /** Half storeys up (+) or down (-): 1 a split level, 2 a whole storey. */
  readonly steps: number;
}

const isAccess = (c: BayComponent | undefined): boolean => c !== undefined && ACCESS_COMPONENTS.has(c);

/** Whether storey 0 of a block has a way in on `side`. */
function doorOn(v: Volume, side: FaceId): boolean {
  const f = v.storeys[0]?.facade;
  if (!f) return false;
  if (Object.entries(f.bays ?? {}).some(([key, c]) => key.startsWith(`${side}:`) && isAccess(c))) return true;
  return isAccess(f.sides?.[side] ?? f.fill);
}

const snap = (v: number): number => Math.round(v / GRID) * GRID;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** A storey's facade with the overrides of `drop` sides' bays taken out (their bay count changes with the block). */
function withoutBays(s: Storey, drop: readonly FaceId[]): Storey {
  const out = clone(s);
  if (out.facade.bays) {
    out.facade.bays = Object.fromEntries(Object.entries(out.facade.bays).filter(([key]) => !drop.includes(Number(key.split(':')[0]))));
  }
  return out;
}

/** Splits block `v` across its depth at local `y` */
function splitBlock(v: Volume, y: number, id: number): Volume {
  const end = v.y + v.d;
  // The ridge as it ran on the whole block (absent, it follows the longer side).
  if ((v.roof === 'gable' || v.roof === 'hip') && !v.ridge) v.ridge = v.w >= v.d ? 'x' : 'y';
  const back: Volume = { ...clone(v), id, y, d: end - y };
  v.d = y - v.y;
  v.storeys = v.storeys.map((s) => withoutBays(s, [1, 2, 3]));
  back.storeys = back.storeys.map((s) => withoutBays(s, [0, 1, 3]));
  const keep = (part: Volume, side: FaceId): void => {
    const reliefs = (part.reliefs ?? []).filter((r) => r.side === side);
    if (reliefs.length) part.reliefs = reliefs; else delete part.reliefs;
    for (const face of [1, 3] as const) if (part.facadeGeometry?.[face]) delete part.facadeGeometry[face]!.bays;
    if (part.roofDetails) part.roofDetails = part.roofDetails.filter((d) => d.y >= part.y && d.y <= part.y + part.d);
  };
  keep(v, 0);
  keep(back, 2);
  return back;
}

/** The block a part hung on a face belongs to: the one whose face, on its side, is nearest. */
function ownerOf(el: BuildingElement, blocks: readonly Volume[]): Volume | null {
  let best: Volume | null = null;
  let bestD = m(1.2);
  for (const v of blocks) {
    const inX = el.x >= v.x - m(0.5) && el.x <= v.x + v.w + m(0.5);
    const inY = el.y >= v.y - m(0.5) && el.y <= v.y + v.d + m(0.5);
    const d = el.facing === 0 ? (inX ? Math.abs(el.y - v.y) : Infinity)
      : el.facing === 2 ? (inX ? Math.abs(el.y - (v.y + v.d)) : Infinity)
        : el.facing === 1 ? (inY ? Math.abs(el.x - (v.x + v.w)) : Infinity)
          : inY ? Math.abs(el.x - v.x) : Infinity;
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

/** Steps the back of a body (local frame, its volumes in place on the lot) to the ground under it. */
export function stepToSlope(body: BlueprintBody, site: SlopeSite): SplitLevel | null {
  const b = body as Building;
  const solids = body.volumes.filter((v) => !v.open && isMass(v) && v.base === 0);
  if (!solids.length || body.volumes.some((v) => v.outline || v.mode) || solids.some((v) => v.lift)) return null;
  const front = [...solids].sort((p, q) => Number(doorOn(q, 0)) - Number(doorOn(p, 0)) || p.y - q.y)[0]!;
  const frontBack = front.y + front.d;
  // The line: the back of the door block, or across its middle - and behind every shaft
  let y = solids.some((v) => v.y >= frontBack - EPS) ? frontBack : snap(front.y + front.d / 2);
  const coreBack = Math.max(-Infinity, ...(body.cores ?? []).map((c) => c.y + body.module));
  if (coreBack > y + EPS) y = Math.ceil((coreBack - EPS) / GRID) * GRID;
  // Nor is a block standing on the ground floor's roof across the line (a tower on its podium)
  const uppers = body.volumes.filter((v) => !v.open && v.base > 0);
  const upperBack = Math.max(-Infinity, ...uppers.filter((v) => v.y < y - EPS && v.y + v.d > y + EPS).map((v) => v.y + v.d));
  if (upperBack > y + EPS) y = Math.ceil((upperBack - EPS) / GRID) * GRID;
  const behind = solids.filter((v) => v.y >= y - EPS);
  const crossing = solids.filter((v) => v.y < y - EPS && v.y + v.d > y + EPS);
  if (!behind.length && !crossing.length) return null;
  if (crossing.some((v) => y - v.y < MIN_PART || v.y + v.d - y < MIN_PART)) return null;
  // Nothing above the ground may straddle the line now.
  if (uppers.some((v) => v.y < y - EPS && v.y + v.d > y + EPS)) return null;

  // The ground under the back, against the floors it could have.
  const samples: number[] = [];
  for (const v of [...behind, ...crossing]) {
    const y0 = Math.max(v.y, y), y1 = v.y + v.d;
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const g = site.groundAt(v.x + (v.w * i) / 4, y0 + ((y1 - y0) * j) / 4);
      if (Number.isFinite(g)) samples.push(g);
    }
  }
  // The yard behind, at the same level: its ground too.
  const yard = site.yard;
  if (yard) {
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const g = site.groundAt(yard.x0 + ((yard.x1 - yard.x0) * i) / 4, yard.y0 + ((yard.y1 - yard.y0) * j) / 4);
      if (Number.isFinite(g)) samples.push(g);
    }
  }
  if (!samples.length) return null;
  const H = levelHeight(b, 0);
  const costAt = (lift: number): number => {
    const pad = site.floor + lift - PLINTH_MIN;
    let sum = 0;
    for (const g of samples) sum += pad > g ? (pad - g) * FILL_WEIGHT : g - pad;
    return sum / samples.length;
  };
  const backs = [...behind, ...crossing];
  // The steps a back may take: half a storey or a whole one either way
  const options: { k: number; lift: number }[] = [
    { k: -2, lift: -H }, { k: -1, lift: -H / 2 }, { k: 1, lift: H / 2 },
    ...(backs.every((v) => v.storeys.length >= 2) ? [{ k: 2, lift: H }] : []),
  ];
  if (site.yard) {
    const most = Math.floor(Math.min(site.maxLift ?? MAX_LIFT, MAX_LIFT) / STEP_RISE + 1e-9);
    for (let n = 1; n <= most; n++) options.push({ k: -1, lift: -n * STEP_RISE }, { k: 1, lift: n * STEP_RISE });
  }
  let k = 0, lift = 0;
  let best = costAt(0);
  for (const o of options) {
    if (Math.abs(o.lift) > (site.maxLift ?? Infinity) + 1e-9 || Math.abs(o.lift) > MAX_LIFT) continue;
    const s = costAt(o.lift);
    if (s < best - 1e-9) { best = s; k = o.k; lift = o.lift; }
  }
  if (k === 0 || costAt(0) - best < GAIN) return null;

  // ---- the step made
  let nextId = Math.max(body.nextVolumeId, ...body.volumes.map((v) => v.id + 1));
  const parts: Volume[] = [...behind];
  for (const v of crossing) {
    const back = splitBlock(v, y, nextId++);
    body.volumes.push(back);
    parts.push(back);
  }
  body.nextVolumeId = nextId;
  const raised = uppers.filter((v) => v.y >= y - EPS);
  const onEdge = (v: Volume, side: 1 | 3): boolean => side === 3 ? Math.abs(v.x - site.x0) < ON_EDGE : Math.abs(v.x + v.w - site.x1) < ON_EDGE;
  /** A storey with no openings on the faces that look onto a side strip laid higher than it. */
  const blind = (v: Volume, s: Storey): void => {
    for (const side of [1, 3] as const) {
      if (!onEdge(v, side)) continue;
      s.facade.sides = { ...(s.facade.sides ?? {}), [side]: 'wall' };
      if (s.facade.bays) for (const key of Object.keys(s.facade.bays)) if (key.startsWith(`${side}:`)) delete s.facade.bays[key];
    }
  };
  const backDoor = (s: Storey | undefined): string | null =>
    Object.entries(s?.facade.bays ?? {}).find(([key, c]) => key.startsWith('2:') && isAccess(c))?.[0] ?? null;
  for (const v of parts) {
    if (k === -2) {
      // A lower ground floor under it: a storey like the one above, walled where earth stands against it
      const above = v.storeys[0]!;
      const lower = clone(above);
      lower.facade.sides = { ...(lower.facade.sides ?? {}), 0: 'wall' };
      if (lower.facade.bays) for (const key of Object.keys(lower.facade.bays)) if (key.startsWith('0:')) delete lower.facade.bays[key];
      blind(v, lower);
      const door = backDoor(above);
      if (door) {
        above.facade.bays = { ...(above.facade.bays ?? {}), [door]: isAccess(above.facade.fill) ? 'window' : above.facade.fill };
        lower.facade.bays = { ...(lower.facade.bays ?? {}), [door]: 'door' };
      }
      v.storeys.unshift(lower);
    } else if (k === 2) {
      const gone = v.storeys.shift()!;
      const door = backDoor(gone);
      if (door) v.storeys[0]!.facade.bays = { ...(v.storeys[0]!.facade.bays ?? {}), [door]: 'door' };
    } else if (k < 0) blind(v, v.storeys[0]!);
    v.lift = lift;
  }
  for (const v of raised) {
    v.base += k === -2 ? 1 : k === 2 ? -1 : 0;
    v.lift = lift;
  }

  // ---- the parts hung on the moved faces move with them
  const moved = new Set([...parts, ...raised].map((v) => v.id));
  const all = body.volumes.filter((v) => !v.open && isMass(v));
  const elements = body.elements ?? [];
  let nextElement = Math.max(body.nextElementId ?? 1, ...elements.map((e) => e.id + 1));
  // A whole storey keeps every floor where it was; a half storey moves them.
  const dz = Math.abs(k) === 2 ? 0 : lift;
  const out: BuildingElement[] = [];
  for (const el of elements) {
    if (!ON_FACADE.has(el.kind)) { out.push(el); continue; }
    const owner = ownerOf(el, all);
    if (!owner) { out.push(el); continue; }
    const side = el.facing === 1 || el.facing === 3;
    const y0 = el.y - (side ? el.w : el.d) / 2, y1 = el.y + (side ? el.w : el.d) / 2;
    if (side && y0 < y - EPS && y1 > y + EPS) {
      // A band along a split side: in two, the back piece at the back's level.
      out.push({ ...el, y: (y0 + y) / 2, w: y - y0 });
      if (k !== 2 || el.z >= lift) out.push({ ...el, id: nextElement++, y: (y + y1) / 2, w: y1 - y, z: el.z + dz });
      continue;
    }
    if (!moved.has(owner.id)) { out.push(el); continue; }
    // Below the floor of a block that lost its bottom storey to the hill: gone with it.
    if (k === 2 && el.z < lift - EPS) continue;
    out.push({ ...el, z: el.z + dz });
  }
  body.elements = out;
  body.nextElementId = nextElement;
  return { y, lift, steps: k };
}

/** The step a block's floor is snapped to when it is dragged */
const liftStep = (b: Building): number => levelHeight(b, 0) / 2;

/** A lift snapped to the nearest half storey (`liftStep`) and held within `MAX_LIFT`. */
export function snapLift(b: Building, lift: number): number {
  const step = liftStep(b);
  const max = Math.floor(MAX_LIFT / step + 1e-9) * step;
  return Math.max(-max, Math.min(max, Math.round(lift / step) * step));
}

/** Sets the floor of block `id` to stand `lift` above (negative: below) the building's ground floor */
export function opSetLift(b: Building, id: number, lift: number): boolean {
  const v = volumeById(b, id);
  if (!v || v.open || !Number.isFinite(lift)) return false;
  const target = Math.max(-MAX_LIFT, Math.min(MAX_LIFT, lift));
  const was = volumeLift(v);
  const dz = target - was;
  if (Math.abs(dz) < EPS) return false;
  // What stands on it: blocks on its roof at its floor, and on theirs.
  const moved: Volume[] = [v];
  for (let i = 0; i < moved.length; i++) {
    const under = moved[i]!;
    for (const o of b.volumes) {
      if (o.open || moved.includes(o) || o.base !== volumeTop(under)) continue;
      if (Math.abs(volumeLift(o) - volumeLift(under)) > EPS || !planOverlap(o, under)) continue;
      moved.push(o);
    }
  }
  // The parts hung on the faces of the blocks that move, found before they do.
  const all = b.volumes.filter((o) => !o.open && isMass(o));
  const ids = new Set(moved.map((o) => o.id));
  const hung = (b.elements ?? []).filter((el) => ON_FACADE.has(el.kind) && ids.has(ownerOf(el, all)?.id ?? -1));
  for (const o of moved) {
    const next = volumeLift(o) + dz;
    if (Math.abs(next) < EPS) delete o.lift; else o.lift = next;
  }
  for (const el of hung) el.z += dz;
  return true;
}

/** The narrowest bay a car's garage door is set in: a 2.4 m door and its jambs. */
const GARAGE_BAY = m(2.6);

/** A garage in the lower ground floor of a house stepped a whole storey down its hillside, on the side its drive runs down */
export function garageUnder(body: BlueprintBody, side: 'left' | 'right'): { readonly x: number; readonly y: number; readonly w: number } | null {
  const b = body as Building;
  const H = levelHeight(b, 0);
  // On the back of the building: the apron before its door is laid behind the building.
  const back = Math.max(...body.volumes.filter((v) => !v.open && isMass(v) && v.base === 0).map((v) => v.y + v.d));
  const lower = body.volumes.filter((v) => !v.open && isMass(v) && v.base === 0 && !v.outline && v.storeys.length >= 2 &&
    Math.abs(volumeLift(v) + H) < EPS && v.y + v.d >= back - EPS);
  if (!lower.length) return null;
  const v = [...lower].sort((p, q) => (side === 'left' ? p.x - q.x : q.x + q.w - (p.x + p.w)))[0]!;
  const n = baysOn(b, v, 2), w = bayWidth(b, v, 2);
  if (w < GARAGE_BAY - EPS) return null;
  const storey = v.storeys[0]!;
  const order = side === 'left' ? [...Array(n).keys()] : [...Array(n).keys()].reverse();
  for (const i of order.slice(0, 2)) {
    const key = `2:${i}`;
    const now = storey.facade.bays?.[key] ?? storey.facade.sides?.[2] ?? storey.facade.fill;
    if (isAccess(now)) continue;
    storey.facade.bays = { ...(storey.facade.bays ?? {}), [key]: 'garageDoor' };
    return { x: v.x + (i + 0.5) * w, y: v.y + v.d, w };
  }
  return null;
}
