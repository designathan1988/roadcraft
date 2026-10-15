import { m } from '../units';
import { edgeFrame, localFootprint, volumeSides } from './footprints';
import {
  bayWidth,
  footprintBox,
  isMass,
  levelElevation,
  levelHeight,
  localDirToWorld,
  localToWorld,
  reliefAt,
  roofRise,
  sideStart,
  topLevel,
  volumeElevation,
  volumeHeight,
  volumeLift,
} from './geometry';
import { type Building, type FaceId, volumeById } from './types';

/** Where the edit handles of a selected building stand, in world 3D. */
type HandleKind = 'storeys' | 'side' | 'move' | 'rotate' | 'scale' | 'relief' | 'vertex' | 'lift';

/** A rectangle of bays and storeys of one face (see `editor/buildings.ts`, `FaceRegion`). */
export interface HandleRegion {
  readonly side: FaceId;
  readonly bay0: number;
  readonly bay1: number;
  readonly storey0: number;
  readonly storey1: number;
}

export interface Handle {
  readonly kind: HandleKind;
  readonly side?: FaceId;
  readonly vertex?: number;
  readonly x: number;
  readonly y: number;
  /** Absolute height. */
  readonly z: number;
  /** World direction the handle drags along (sides: the outward normal). */
  readonly dx: number;
  readonly dy: number;
}

const HANDLE_OUT = m(1.6);
/** How far the move, turn and scale handles stand off the footprint's corner. */
const CORNER_OUT = m(1.4);
/** How far the lift handle stands off its block's corner (the scale handle's 0.8 m). */
const LIFT_OUT = m(0.6);

/** The lift of the ground block nearest a corner of the footprint's box (local frame) */
function liftNear(b: Building, x: number, y: number): number {
  let best = Infinity, lift = 0;
  for (const o of b.volumes) {
    if (o.base !== 0 || o.open || !isMass(o)) continue;
    const ring = localFootprint(o);
    const x0 = Math.min(...ring.map((p) => p.x)), x1 = Math.max(...ring.map((p) => p.x));
    const y0 = Math.min(...ring.map((p) => p.y)), y1 = Math.max(...ring.map((p) => p.y));
    const d = Math.hypot(Math.max(x0 - x, 0, x - x1), Math.max(y0 - y, 0, y - y1));
    if (d < best - 1e-9) { best = d; lift = volumeLift(o); }
  }
  return lift;
}

/** `nearest` orders the four footprint corners */
export function buildingHandles(
  b: Building,
  volumeId: number,
  floor: number,
  nearest: (corners: readonly { x: number; y: number }[]) => readonly number[] = () => [0, 1],
  region: HandleRegion | null = null,
): Handle[] {
  const v = volumeById(b, volumeId) ?? b.volumes[0];
  if (!v) return [];
  const out: Handle[] = [];
  const top = localToWorld(b, v.x + v.w / 2, v.y + v.d / 2);
  out.push({
    kind: 'storeys',
    x: top.x,
    y: top.y,
    z: floor + volumeHeight(b, v) + roofRise(b, v) + m(1.8),
    dx: 0,
    dy: 0,
  });
  // At the block's own floor (a split level stands at its own, `Volume.lift`).
  const baseZ = floor + volumeElevation(b, v, v.base) + m(0.3);
  for (const side of volumeSides(v)) {
    const f = edgeFrame(v, side);
    const n = { x: f.nx, y: f.ny };
    const cx = v.outline ? f.x + f.tx * f.length / 2 + n.x * HANDLE_OUT : v.x + v.w / 2 + n.x * (v.w / 2 + HANDLE_OUT);
    const cy = v.outline ? f.y + f.ty * f.length / 2 + n.y * HANDLE_OUT : v.y + v.d / 2 + n.y * (v.d / 2 + HANDLE_OUT);
    const p = localToWorld(b, cx, cy);
    const d = localDirToWorld(b, n.x, n.y);
    out.push({ kind: 'side', side, x: p.x, y: p.y, z: baseZ, dx: d.x, dy: d.y });
  }
  for (const [vertex, point] of localFootprint(v).entries()) {
    const p = localToWorld(b, point.x, point.y);
    out.push({ kind: 'vertex', vertex, x: p.x, y: p.y, z: baseZ, dx: 0, dy: 0 });
  }
  // The block's own floor, raised or lowered (a split level, `Volume.lift`)
  if (v.base === 0 && !v.open) {
    const ring = localFootprint(v);
    const x0 = Math.min(...ring.map((p) => p.x)) - LIFT_OUT, x1 = Math.max(...ring.map((p) => p.x)) + LIFT_OUT;
    const y0 = Math.min(...ring.map((p) => p.y)) - LIFT_OUT, y1 = Math.max(...ring.map((p) => p.y)) + LIFT_OUT;
    const own = [localToWorld(b, x0, y0), localToWorld(b, x1, y0), localToWorld(b, x1, y1), localToWorld(b, x0, y1)];
    const at = own[nearest(own)[0] ?? 0] as { x: number; y: number };
    out.push({ kind: 'lift', x: at.x, y: at.y, z: floor + volumeElevation(b, v, 0) + levelHeight(b, 0) / 2, dx: 0, dy: 0 });
  }
  const f = footprintBox(b);
  const corners = [
    localToWorld(b, f.x0 - CORNER_OUT, f.y0 - CORNER_OUT),
    localToWorld(b, f.x1 + CORNER_OUT, f.y0 - CORNER_OUT),
    localToWorld(b, f.x1 + CORNER_OUT, f.y1 + CORNER_OUT),
    localToWorld(b, f.x0 - CORNER_OUT, f.y1 + CORNER_OUT),
  ];
  const order = nearest(corners);
  const move = corners[order[0] ?? 0] as { x: number; y: number };
  const turn = corners[order[1] ?? 1] as { x: number; y: number };
  // At the foot of the corner's own block: a block lowered or raised
  const local = [[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]] as const;
  const footOf = (i: number): number => { const q = local[i] ?? local[0]; return floor + liftNear(b, q[0], q[1]); };
  out.push({ kind: 'move', x: move.x, y: move.y, z: footOf(order[0] ?? 0), dx: 0, dy: 0 });
  out.push({ kind: 'rotate', x: turn.x, y: turn.y, z: footOf(order[1] ?? 1), dx: 0, dy: 0 });
  // Scale: the nearest corner, at the eaves - the corner of the box one pulls to make the whole plan bigger or smaller.
  const masses = b.volumes.filter((o) => !o.open && isMass(o));
  const eaves = floor + (masses.length ? Math.max(...masses.map((o) => volumeHeight(b, o))) : levelElevation(b, topLevel(b)));
  const box = [
    localToWorld(b, f.x0, f.y0), localToWorld(b, f.x1, f.y0), localToWorld(b, f.x1, f.y1), localToWorld(b, f.x0, f.y1),
  ];
  const corner = box[order[0] ?? 0] as { x: number; y: number };
  const centre = localToWorld(b, (f.x0 + f.x1) / 2, (f.y0 + f.y1) / 2);
  const out2 = { x: corner.x - centre.x, y: corner.y - centre.y };
  const len = Math.hypot(out2.x, out2.y) || 1;
  out.push({
    kind: 'scale', x: corner.x + (out2.x / len) * m(0.8), y: corner.y + (out2.y / len) * m(0.8), z: eaves,
    dx: out2.x / len, dy: out2.y / len,
  });
  if (region) {
    // Push-pull: an arrow standing off the middle of the picked region, at the depth the region is pushed to now.
    const edge = edgeFrame(v, region.side);
    const n = { x: edge.nx, y: edge.ny };
    const s = sideStart(v, region.side);
    const a = ((region.bay0 + region.bay1 + 1) / 2) * bayWidth(b, v, region.side);
    const depth = reliefAt(v, region.side, region.bay0, region.storey0)?.depth ?? 0;
    const off = depth + HANDLE_OUT * 0.7;
    const p = localToWorld(b, s.x + s.tx * a + n.x * off, s.y + s.ty * a + n.y * off);
    const d = localDirToWorld(b, n.x, n.y);
    const z0 = volumeElevation(b, v, v.base + region.storey0);
    const z1 = volumeElevation(b, v, v.base + region.storey1 + 1);
    out.push({ kind: 'relief', side: region.side, x: p.x, y: p.y, z: floor + (z0 + z1) / 2, dx: d.x, dy: d.y });
  }
  return out;
}
