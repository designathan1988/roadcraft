import { bodyClassOf, type BodyClass } from '@world/conflictPoints';
import { m } from '@world/units';

/** Vehicle classes, in world units. */

/** Body plan the renderer builds from. */
export type VehicleShape = 'car' | 'bus' | 'truck' | 'motorcycle' | 'bicycle';

/** Silhouette of a `car`: where the roof ends and how the tail is cut. */
type BodyStyle = 'hatch' | 'sedan' | 'suv' | 'van';

export interface Archetype {
  readonly id: string;
  /** Which body plan the renderer assembles for this class. */
  readonly shape: VehicleShape;
  /** For a `car`, the silhouette it is drawn with. */
  readonly style?: BodyStyle;
  readonly length: number;
  readonly width: number;
  /** Overall height above the road surface, roof included. */
  readonly height: number;
  /** Greenhouse length as a fraction of the body length. */
  readonly cabinFraction: number;
  /** Greenhouse centre, forward of the body centre, as a fraction of length. */
  readonly cabinShift: number;
  /** Number of axles, which decides the wheel count and their spacing. */
  readonly axles: number;
  /** Radius of one road wheel. */
  readonly wheelRadius: number;
  /** Seats the renderer may fill with occupants, driver included. */
  readonly seats: number;
  /** Doors on each side, each serving the seat behind it (a car's body model has `2 * doorsPerSide` seats). */
  readonly doorsPerSide: number;
  /** Comfortable acceleration. */
  readonly a: number;
  /** Comfortable deceleration, used by the IDM interaction term. */
  readonly b: number;
  /** Emergency deceleration, used by the safe-speed cap. */
  readonly bEmergency: number;
  /** Desired time headway, in seconds. */
  readonly T: number;
  /** Standstill gap. */
  readonly s0: number;
  /** Multiplier on the road's speed limit. */
  readonly speedFactor: number;
  readonly weight: number;
  readonly palette: readonly string[];
}

export const ARCHETYPES: readonly Archetype[] = [
  {
    id: 'hatch',
    shape: 'car',
    style: 'hatch',
    length: m(3.9),
    width: m(1.72),
    height: m(1.48),
    cabinFraction: 0.54,
    cabinShift: -0.04,
    axles: 2,
    wheelRadius: m(0.31),
    seats: 4,
    doorsPerSide: 2,
    a: m(2.9),
    b: m(3.2),
    bEmergency: m(6.5),
    T: 1.0,
    s0: m(1.8),
    speedFactor: 1.08,
    weight: 0.3,
    palette: ['#e7dfd3', '#e06056', '#5f8fca', '#e5b64d', '#74a36d', '#3c4147'],
  },
  {
    id: 'sedan',
    shape: 'car',
    style: 'sedan',
    length: m(4.7),
    width: m(1.84),
    height: m(1.45),
    cabinFraction: 0.46,
    cabinShift: -0.02,
    axles: 2,
    wheelRadius: m(0.33),
    seats: 4,
    doorsPerSide: 2,
    a: m(2.4),
    b: m(2.9),
    bEmergency: m(6.0),
    T: 1.2,
    s0: m(2.0),
    speedFactor: 1.0,
    weight: 0.27,
    palette: ['#d6d8dc', '#2f6a86', '#b993d1', '#cf7b43', '#dbe6ec', '#22262b'],
  },
  {
    id: 'suv',
    shape: 'car',
    style: 'suv',
    length: m(4.9),
    width: m(1.95),
    height: m(1.78),
    cabinFraction: 0.52,
    cabinShift: -0.01,
    axles: 2,
    wheelRadius: m(0.37),
    seats: 4,
    doorsPerSide: 2,
    a: m(2.2),
    b: m(2.8),
    bEmergency: m(5.8),
    T: 1.3,
    s0: m(2.1),
    speedFactor: 0.97,
    weight: 0.14,
    palette: ['#3f4a52', '#7d8f7a', '#c0c4c8', '#6b4f3a'],
  },
  {
    id: 'van',
    shape: 'car',
    style: 'van',
    length: m(5.6),
    width: m(2.0),
    height: m(2.35),
    // The cabin runs forward and long
    cabinFraction: 0.4,
    cabinShift: 0.24,
    axles: 2,
    wheelRadius: m(0.35),
    seats: 2,
    doorsPerSide: 1,
    a: m(1.9),
    b: m(2.6),
    bEmergency: m(5.5),
    T: 1.4,
    s0: m(2.2),
    speedFactor: 0.95,
    weight: 0.08,
    palette: ['#eceae4', '#d8d3c6', '#9aa7b1', '#f0f2f4'],
  },
  {
    id: 'bus',
    shape: 'bus',
    length: m(12.0),
    width: m(2.55),
    height: m(3.2),
    // Glazing runs nearly the whole length, so the "cabin" here is the roof cap rather than a separate passenger box.
    cabinFraction: 0.98,
    cabinShift: 0,
    axles: 3,
    wheelRadius: m(0.5),
    seats: 7,
    doorsPerSide: 0,
    a: m(0.9),
    b: m(1.6),
    bEmergency: m(4.2),
    T: 2.0,
    s0: m(3.2),
    speedFactor: 0.8,
    weight: 0.025,
    palette: ['#1f5fa8', '#c9342d', '#2e7d5b', '#e4e7ea', '#d8a32a'],
  },
  {
    id: 'truck',
    shape: 'truck',
    length: m(9.8),
    width: m(2.5),
    height: m(3.5),
    cabinFraction: 0.24,
    cabinShift: 0.35,
    axles: 3,
    wheelRadius: m(0.52),
    seats: 2,
    doorsPerSide: 0,
    a: m(0.85),
    b: m(1.7),
    bEmergency: m(4.4),
    T: 2.1,
    s0: m(3.4),
    speedFactor: 0.82,
    weight: 0.035,
    palette: ['#8c9195', '#5d6a72', '#b4b0a5', '#2c4f6b', '#8f3d34'],
  },
  {
    id: 'motorcycle',
    shape: 'motorcycle',
    length: m(2.1),
    width: m(0.8),
    height: m(1.25),
    cabinFraction: 0.3,
    cabinShift: 0.26,
    axles: 2,
    wheelRadius: m(0.3),
    seats: 1,
    doorsPerSide: 0,
    a: m(3.6),
    b: m(3.6),
    bEmergency: m(7.0),
    T: 0.8,
    s0: m(1.2),
    speedFactor: 1.12,
    weight: 0.11,
    palette: ['#1b1d21', '#b02a25', '#1d4f86', '#d9dde1', '#c6761f'],
  },
  {
    id: 'bicycle',
    shape: 'bicycle',
    length: m(1.8),
    width: m(0.6),
    height: m(1.1),
    cabinFraction: 0.3,
    cabinShift: 0.2,
    axles: 2,
    wheelRadius: m(0.34),
    seats: 1,
    doorsPerSide: 0,
    // A bicycle is not a slow car: it accelerates gently, brakes far worse than anything with four wheels
    a: m(1.2),
    b: m(2.2),
    bEmergency: m(3.5),
    T: 1.3,
    s0: m(0.8),
    speedFactor: 0.3,
    weight: 0.04,
    palette: ['#2f8f7a', '#c4c8cc', '#9c3f5e', '#3b5fa0', '#dfc65a'],
  },
];

export const archetypeWeights = (): readonly (readonly [Archetype, number])[] =>
  ARCHETYPES.map((a) => [a, a.weight] as const);

/** Lookup by id, falling back to the sedan. */
export const archetypeById = (id: string): Archetype =>
  ARCHETYPES.find((a) => a.id === id) ?? (ARCHETYPES[1] as Archetype);

/** The conflict-zone size class a body of this archetype is measured with. */
export const bodyClassOfArchetype = (a: Archetype): BodyClass => bodyClassOf(a.length, a.width);
