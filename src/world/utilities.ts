import type { Vec2 } from '@core/vec2';
import type { PoleId, SpanId } from './ids';
import { m } from './units';
import { ROAD_TUNING } from './roads/tuning';

/** The overhead utility network: poles, the wires strung between them, and the lamps they carry. */

/** Height of a pole's mast, from the ground to the crown. */
export const POLE_HEIGHT = m(8.5);
/** Radius at the crown and at the foot. A pole tapers. */
export const POLE_TOP_RADIUS = m(0.11);
export const POLE_BASE_RADIUS = m(0.18);
/** Half-length of the cross-arm the wires are strung from. */
export const POLE_ARM_HALF = m(0.85);
/** How far below the crown the cross-arm sits. */
export const POLE_ARM_DROP = m(0.55);
export const POLE_ARM_THICK = m(0.1);
/** Vertical spacing between the wire courses on the arm. */
export const WIRE_COURSES: readonly number[] = [0, -m(0.45), -m(0.9)];
/** Lateral position of each wire on the cross-arm, as a fraction of its half. */
export const WIRE_OFFSETS: readonly number[] = [-0.8, 0, 0.8];

/** Lamp arm reach and head, for the poles that carry a light. */
export const POLE_LAMP_REACH = m(1.6);
export const POLE_LAMP_DROP = m(1.1);
export const POLE_LAMP_LONG = m(0.5);
export const POLE_LAMP_TALL = m(0.14);
export const POLE_LAMP_WIDE = m(0.26);

/** Default distance between poles along a drawn run, in world units. */
export const DEFAULT_POLE_SPACING = ROAD_TUNING.poles.spacing;
export const MIN_POLE_SPACING = ROAD_TUNING.poles.minSpacing;
export const MAX_POLE_SPACING = ROAD_TUNING.poles.maxSpacing;

/** Sag of a span, as a fraction of its length. */
const WIRE_SAG_RATIO = 0.018;
/** However long the span, the sag stops growing past this. */
export const WIRE_MAX_SAG = m(1.4);

/** How many points a span is flattened into. */
export const WIRE_SEGMENTS = 8;

export interface UtilityPole {
  readonly id: PoleId;
  x: number;
  y: number;
  /** Whether this pole carries a street light. */
  lamp: boolean;
}

export interface UtilitySpan {
  readonly id: SpanId;
  a: PoleId;
  b: PoleId;
}

/** Sag at the middle of a span of this length. */
export function spanSag(length: number): number {
  return Math.min(WIRE_MAX_SAG, length * WIRE_SAG_RATIO);
}

/** Height of a catenary above the chord, at normalised position `t` in [0, 1]. */
export function wireDrop(t: number, sag: number): number {
  const u = t * 2 - 1;
  return sag * (1 - u * u);
}

/** Which poles of a run carry a lamp. */
export const poleCarriesLamp = (index: number): boolean => index % 2 === 0;

/** What the poles of a new run carry: a street light on none, every other one, or all of them. */
export const POLE_LAMP_MODES = ['none', 'alternate', 'all'] as const;
export type PoleLampMode = (typeof POLE_LAMP_MODES)[number];

/** Deflection at and above which a pole is a CORNER: each line leaving it gets its own cross-arm, square to that line */
const CORNER_DEFLECTION = (60 * Math.PI) / 180;

/** The cross-arms of one pole: every distinct arm, and the one each span hangs from. */
export interface PoleArms {
  /** Unit directions of the arms on this pole, one per physical arm. */
  readonly arms: readonly Vec2[];
  /** Per span reaching this pole: the arm it hangs from, oriented to the LEFT of the span's a -> b. */
  readonly bySpan: ReadonlyMap<SpanId, Vec2>;
}

const perp = (v: Vec2): Vec2 => ({ x: -v.y, y: v.x });
const unit = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.y);
  return l > 1e-9 ? { x: v.x / l, y: v.y / l } : { x: 0, y: 1 };
};

/** Which way every pole's cross-arm lies, as line construction standards frame a pole */
export function poleArms(
  poles: ReadonlyMap<PoleId, UtilityPole>,
  spans: ReadonlyMap<SpanId, UtilitySpan>,
  idle: (pole: UtilityPole) => Vec2 = () => ({ x: 0, y: 1 }),
): Map<PoleId, PoleArms> {
  const reaching = new Map<PoleId, UtilitySpan[]>();
  for (const span of spans.values()) {
    if (!poles.has(span.a) || !poles.has(span.b)) continue;
    for (const end of [span.a, span.b]) {
      const list = reaching.get(end);
      if (list) list.push(span);
      else reaching.set(end, [span]);
    }
  }
  const out = new Map<PoleId, PoleArms>();
  for (const pole of poles.values()) out.set(pole.id, poleArmsAt(pole, reaching.get(pole.id) ?? [], poles, idle));
  return out;
}

/** One pole's arms (`poleArms`), from the spans reaching it in the order they were strung */
export function poleArmsAt(
  pole: UtilityPole,
  reaching: Iterable<UtilitySpan>,
  poles: ReadonlyMap<PoleId, UtilityPole>,
  idle: (pole: UtilityPole) => Vec2 = () => ({ x: 0, y: 1 }),
): PoleArms {
  const lines: { span: UtilitySpan; d: Vec2 }[] = [];
  for (const span of reaching) {
    const a = poles.get(span.a);
    const b = poles.get(span.b);
    if (!a || !b) continue;
    if (span.a === pole.id) lines.push({ span, d: unit({ x: b.x - a.x, y: b.y - a.y }) });
    if (span.b === pole.id) lines.push({ span, d: unit({ x: a.x - b.x, y: a.y - b.y }) });
  }
  const bySpan = new Map<SpanId, Vec2>();
  /** The arm for a span, turned to lie left of the span's own a -> b. */
  const oriented = (arm: Vec2, span: UtilitySpan): Vec2 => {
    const a = poles.get(span.a)!;
    const b = poles.get(span.b)!;
    const along = { x: b.x - a.x, y: b.y - a.y };
    return along.x * arm.y - along.y * arm.x >= 0 ? arm : { x: -arm.x, y: -arm.y };
  };
  if (lines.length === 0) return { arms: [unit(idle(pole))], bySpan };
  if (lines.length === 1) {
    const arm = perp(lines[0]!.d);
    bySpan.set(lines[0]!.span.id, oriented(arm, lines[0]!.span));
    return { arms: [arm], bySpan };
  }
  if (lines.length === 2) {
    const [p, q] = lines as [{ span: UtilitySpan; d: Vec2 }, { span: UtilitySpan; d: Vec2 }];
    // Deflection: how far the line turns here (0 on a straight run).
    const cos = Math.max(-1, Math.min(1, -(p.d.x * q.d.x + p.d.y * q.d.y)));
    if (Math.acos(cos) < CORNER_DEFLECTION) {
      // The line's direction through the pole; the arm square to it lies on the bisector.
      const arm = perp(unit({ x: p.d.x - q.d.x, y: p.d.y - q.d.y }));
      bySpan.set(p.span.id, oriented(arm, p.span));
      bySpan.set(q.span.id, oriented(arm, q.span));
      return { arms: [arm], bySpan };
    }
  }
  const arms: Vec2[] = [];
  for (const line of lines) {
    const arm = perp(line.d);
    bySpan.set(line.span.id, oriented(arm, line.span));
    // Two lines leaving straight through each other share one arm.
    if (!arms.some((other) => Math.abs(other.x * arm.y - other.y * arm.x) < 0.09)) arms.push(arm);
  }
  return { arms, bySpan };
}
