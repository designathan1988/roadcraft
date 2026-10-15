/** Walls, fences and hedges drawn along a path, as roads are */
export type BarrierKind = 'fence' | 'wall' | 'hedge' | 'guardrail' | 'railing';

export const BARRIER_KINDS: readonly BarrierKind[] = ['fence', 'wall', 'hedge', 'guardrail', 'railing'];

/** Kinds that stand at the KERB, on the footway's road edge, rather than along its back: a road guardrail */
export const KERB_BARRIERS: ReadonlySet<BarrierKind> = new Set<BarrierKind>(['guardrail', 'railing']);

export interface Barrier {
  readonly id: number;
  readonly kind: BarrierKind;
  /** The path, in world units on the ground; two points or more. */
  readonly points: readonly { readonly x: number; readonly y: number }[];
}

/** Each kind's height and thickness, metres. */
export const BARRIER_SIZE: Readonly<Record<BarrierKind, { readonly height: number; readonly thickness: number }>> = {
  fence: { height: 1.1, thickness: 0.12 },
  wall: { height: 1.8, thickness: 0.25 },
  hedge: { height: 1.2, thickness: 0.8 },
  guardrail: { height: 0.75, thickness: 0.3 },
  railing: { height: 1.0, thickness: 0.06 },
};

export function isBarrierKind(value: unknown): value is BarrierKind {
  return value === 'fence' || value === 'wall' || value === 'hedge' || value === 'guardrail' || value === 'railing';
}
