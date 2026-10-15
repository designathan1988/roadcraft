import { EPS } from './scalar';

/** 2D vector helpers. */
export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (a: Vec2, k: number): Vec2 => ({ x: a.x * k, y: a.y * k });
export const neg = (a: Vec2): Vec2 => ({ x: -a.x, y: -a.y });

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;
/** Scalar cross product (z component of the 3D cross). */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const lenSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const len = (a: Vec2): number => Math.hypot(a.x, a.y);
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);

/** The left-hand normal: a quarter turn counter-clockwise. */
export const perp = (a: Vec2): Vec2 => ({ x: -a.y, y: a.x });

export function normalize(a: Vec2): Vec2 {
  const l = Math.hypot(a.x, a.y);
  return l < EPS ? { x: 1, y: 0 } : { x: a.x / l, y: a.y / l };
}

export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});

export const angleOf = (a: Vec2): number => Math.atan2(a.y, a.x);

export const fromAngle = (a: number, r = 1): Vec2 => ({
  x: Math.cos(a) * r,
  y: Math.sin(a) * r,
});

/** `a + b * k` without an intermediate allocation at the call site. */
export const addScaled = (a: Vec2, b: Vec2, k: number): Vec2 => ({
  x: a.x + b.x * k,
  y: a.y + b.y * k,
});
