import { SIT_DOWN_SECONDS, STAND_UP_SECONDS, type PedView } from '@sim/people/view';
import { DT } from '@sim/dt';
import { m } from '@world/units';
import type { LibraryClip, WalkAmplitude } from './citizenWalk';

/** What a pedestrian's legs play, decided from what the simulation says the body is doing — and nothing else. */

export interface GaitClip {
  /** Intervals between baked frames. */
  readonly frames: number;
  readonly duration: number;
  readonly loop: boolean;
  /** Ground one cycle covers on this body at scale 1, metres. */
  readonly stride: number;
  /** Ground covered by each baked frame (walk start, stop), metres at scale 1. */
  readonly travel?: Float32Array;
  /** Angle turned by each baked frame (turns), radians, unsigned. */
  readonly yaw?: Float32Array;
}

export type GaitClipName =
  | 'walk' | 'walkElder' | 'walkSlow' | 'walkShuffle' | 'walkRest' | 'walkBack' | 'walkLeft' | 'walkRight' | 'run' | 'walkDrunk' | 'walkHandL' | 'walkHandR' | 'start' | 'stop' | 'turnLeft' | 'turnRight'
  | 'idle' | 'look' | 'phone' | 'talk' | 'listen' | 'sitDown' | 'sitIdle' | 'standUp'
  | 'read' | 'bag' | 'trolley' | 'umbrella' | 'cheer' | 'dance' | 'wave' | 'drink' | 'photo' | 'crouchDown' | 'crouchIdle' | 'crouchUp' | 'laugh' | 'angry' | 'argue' | 'knock' | 'headphones' | 'eatIdle' | 'workTable'
  | 'walkN1' | 'walkN2' | 'walkN3' | 'walkStroll' | 'walkCool' | 'walkFast';
export type GaitClips = Readonly<Record<GaitClipName, GaitClip>>;
/** The walk and run cycles, which 'loco' blends on one phase. */
type Cycle = 'walk' | 'walkElder' | 'walkSlow' | 'walkShuffle' | 'walkRest' | 'walkBack' | 'walkLeft' | 'walkRight' | 'run' | 'walkDrunk'
  | 'walkHandL' | 'walkHandR' | WalkStyle;
type Single = Exclude<GaitClipName, Cycle>;
type PlayKey = 'loco' | Single;
interface Play {
  key: PlayKey;
  /** Fraction through the clip, 0..1. */
  phase: number;
  /** Distance (start, stop) or angle (turns) this play has covered. */
  acc: number;
}

/** One pedestrian's gait: what is playing and how the body is moving. */
export interface Gait {
  time: number;
  /** The simulation's heading, followed smoothly. */
  base: number;
  /** Drawn heading last frame. */
  drawn: number;
  /** Velocity of the drawn body, smoothed, m/s. */
  vx: number;
  vy: number;
  speed: number;
  /** Rate of change of `speed`, smoothed, m/s². */
  accel: number;
  /** Shared phase of every walk and the run, 0..1. */
  cycle: number;
  run: number;
  /** The two walk cycles blended at this pace, and the second one's weight. */
  walkA: Cycle;
  walkB: Cycle;
  walkW: number;
  /** Ground the legs cover per cycle at this pace on this body, metres. */
  stride: number;
  /** Physical travel relative to the drawn torso, radians; never writes to PedView. */
  direction: number;
  /** Actual pose amplitude below the shortest captured stride. */
  stepScale: number;
  backScale: number;
  leftScale: number;
  rightScale: number;
  /** Directional group weights, calibrated by their effective ground travel. */
  forwardWeight: number;
  backWeight: number;
  leftWeight: number;
  rightWeight: number;
  cur: Play;
  prev: Play | null;
  /** Weight of `cur` against `prev`, rising to 1 over `fadeTime`. */
  fade: number;
  fadeTime: number;
  /** Seconds the body has been turning slowly enough to stop the turn. */
  settling: number;
  /** A walk stop may begin: not again until the body has walked on or stood. */
  armed: boolean;
  /** The stop, or kerb wait, a look round has already been played for. */
  looked: unknown;
}

/** One clip of the mix: which, at what baked frame, at what weight. */
export interface GaitPlay {
  name: GaitClipName;
  frame: number;
  weight: number;
}

/** An older walker: a step about a fifth shorter, arms that swing about half as far, hips that rise and roll less. */
export const ELDER_AMPLITUDE: WalkAmplitude = { arms: 0.5, legs: 0.78, hips: 0.6 };
/** The shuffle: the slow walk with its swing roughly halved. */
export const SHUFFLE_AMPLITUDE: WalkAmplitude = { arms: 0.4, legs: 0.5, hips: 0.55 };
/** Mean walking stance, not the rig's T-pose; used to shorten actual foot travel. */
export const REST_AMPLITUDE: WalkAmplitude = { arms: 0, legs: 0, hips: 0 };

/** Baking rate of a clip: long, slow loops at 10 fps, everything else at the capture's 30. */
export const bakeFps = (clip: { readonly loop: boolean; readonly duration: number }): number =>
  clip.loop && clip.duration > 6 ? 10 : 30;

/** Samples a per-source-frame curve of a library clip at a fraction of it. */
function curveAt(curve: Float32Array, loop: boolean, fraction: number): number {
  const count = curve.length;
  const x = loop ? fraction * count : fraction * (count - 1);
  const k0 = Math.min(count - 1, Math.max(0, Math.floor(x)));
  const k1 = loop ? (k0 + 1) % count : Math.min(count - 1, k0 + 1);
  const f = x - Math.floor(x);
  return curve[k0]! * (1 - f) + curve[k1]! * f;
}

/** The gait facts of one library clip on a body of `scale`: its baked frame count, its stride, and its travel */
export function gaitClipOf(clip: LibraryClip, scale: number, frames: number): GaitClip {
  const travel = new Float32Array(frames + 2);
  const yaw = new Float32Array(frames + 2);
  for (let i = 0; i <= frames + 1; i++) {
    const fraction = Math.min(1, i / frames);
    travel[i] = curveAt(clip.travel, clip.loop, clip.loop ? fraction % 1 : fraction) * scale;
    yaw[i] = Math.abs(curveAt(clip.yaw, clip.loop, fraction));
  }
  return {
    frames, duration: clip.duration, loop: clip.loop, stride: clip.advance * scale,
    ...(clip.kind === 'forward' ? { travel } : {}), ...(clip.kind === 'turn' ? { yaw } : {}),
  };
}

// ------------------------------------------------------------- clip curves

/** Fraction of a clip at which its travel curve reaches `distance` (monotone curves). */
function fractionAtTravel(clip: GaitClip, distance: number): number {
  const curve = clip.travel;
  if (!curve) return 1;
  const last = clip.frames;
  if (distance <= curve[0]!) return 0;
  if (distance >= curve[last]!) return 1;
  let lo = 0, hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid]! < distance) lo = mid; else hi = mid;
  }
  const span = curve[hi]! - curve[lo]!;
  return (lo + (span > 1e-6 ? (distance - curve[lo]!) / span : 0)) / last;
}

/** Ground a clip has covered at a fraction of it, metres at scale 1. */
function travelAt(clip: GaitClip, fraction: number): number {
  const curve = clip.travel;
  if (!curve) return 0;
  const x = Math.min(1, Math.max(0, fraction)) * clip.frames;
  const k = Math.min(clip.frames - 1, Math.floor(x));
  return curve[k]! + (curve[k + 1]! - curve[k]!) * (x - k);
}

/** Fraction of a turn clip at which it has turned `angle` radians. */
function fractionAtYaw(clip: GaitClip, angle: number): number {
  const curve = clip.yaw;
  if (!curve) return 1;
  let best = clip.frames;
  for (let i = 0; i <= clip.frames; i++) if (curve[i]! >= angle) { best = i; break; }
  if (best === 0) return 0;
  const a = curve[best - 1]!, b = curve[best]!;
  return (best - 1 + (b > a ? (angle - a) / (b - a) : 1)) / clip.frames;
}

/** Speed of a forward clip at each baked frame on a body of `size`, m/s. */
const clipSpeed = (clip: GaitClip, i: number, size: number): number =>
  (clip.travel![i]! - clip.travel![i - 1]!) * size / (clip.duration / clip.frames);

/** Fraction of the walk stop at which the clip moves at `speed` on a body of `size`, after its fastest point */
function stopEntry(clip: GaitClip, speed: number, size: number): number {
  if (!clip.travel) return 0;
  let peak = 0, peakAt = 0;
  for (let i = 1; i <= clip.frames; i++) {
    const v = clipSpeed(clip, i, size);
    if (v > peak) { peak = v; peakAt = i; }
  }
  for (let i = Math.max(1, peakAt); i <= clip.frames; i++) {
    if (clipSpeed(clip, i, size) <= speed) return (i - 1) / clip.frames;
  }
  return 1;
}

/** Fraction of the walk start at which the clip first moves at `speed` */
function startEntry(clip: GaitClip, speed: number, size: number): number {
  if (!clip.travel) return 0;
  for (let i = 1; i <= clip.frames; i++) {
    if (clipSpeed(clip, i, size) >= speed) return (i - 1) / clip.frames;
  }
  return 0;
}

// ------------------------------------------------------------------ pacing

/** Speed at which a person breaks into a run, m/s; fixed for life from their id. */
const runAt = (hash: number): number => 1.75 + 0.35 * ((hash >>> 9) & 255) / 255;

/** Walk cycles for a body, slowest first. */
const ADULT_WALKS = ['walkShuffle', 'walkSlow', 'walk'] as const satisfies readonly Cycle[];
const ELDER_WALKS = ['walkShuffle', 'walkSlow', 'walkElder'] as const satisfies readonly Cycle[];
/** Somebody unsteady on their feet: the stagger in place of the stride. */
const DRUNK_WALKS = ['walkShuffle', 'walkSlow', 'walkDrunk'] as const satisfies readonly Cycle[];
/** Walking hand in hand: the walk with the hand on the partner's side held out to them. */
const HAND_L_WALKS = ['walkHandL'] as const satisfies readonly Cycle[];
const HAND_R_WALKS = ['walkHandR'] as const satisfies readonly Cycle[];
/** Carrying a box: the clips the arms are baked holding it in (`riggedCitizens` CARRY_AT). */
const CARRY_WALKS = ['walkShuffle', 'walk'] as const satisfies readonly Cycle[];

/** The walks people walk in, one each for life (`walkStyle`): several Rocketbox captures of ordinary walking */
export const WALK_STYLES = ['walkN1', 'walkN2', 'walkN3', 'walkStroll', 'walkCool', 'walkFast'] as const;
type WalkStyle = (typeof WALK_STYLES)[number];
/** Which walk somebody walks in, from their id. */
const walkStyle = (id: number): WalkStyle => WALK_STYLES[id % WALK_STYLES.length]!;
/** A person's walks, slowest first: the shuffle, the slow walk, their own, and the brisk walk on top. */
const styleWalks = new WeakMap<GaitClips, Map<WalkStyle, readonly Cycle[]>>();
function walksOf(clips: GaitClips, style: WalkStyle): readonly Cycle[] {
  let byStyle = styleWalks.get(clips);
  if (!byStyle) styleWalks.set(clips, byStyle = new Map());
  let walks = byStyle.get(style);
  if (!walks) {
    const set = [...new Set<Cycle>(['walkShuffle', 'walkSlow', style, 'walkFast'])];
    walks = set.sort((a, b) => naturalPace(clips[a], 1) - naturalPace(clips[b], 1));
    byStyle.set(style, walks);
  }
  return walks;
}

/** Natural pace of a walk cycle on a body of `size`, m/s. */
const naturalPace = (clip: GaitClip, size: number): number => clip.stride * size / clip.duration;

/** Chooses the two walk cycles for a pace, the second one's weight, and the ground one blended cycle covers. */
function pace(g: Gait, clips: GaitClips, elder: boolean, size: number, speed: number, drunk = false, hand?: 'L' | 'R',
  carry = false, style?: WalkStyle): void {
  const walks = carry ? CARRY_WALKS : drunk ? DRUNK_WALKS : hand === 'L' ? HAND_L_WALKS : hand === 'R' ? HAND_R_WALKS
    : elder ? ELDER_WALKS : style ? walksOf(clips, style) : ADULT_WALKS;
  const first = clips[walks[0]!];
  const last = clips[walks[walks.length - 1]!];
  g.walkA = g.walkB = walks[0]!;
  g.walkW = 0;
  g.stepScale = 1;
  if (speed <= naturalPace(first, size)) {
    const own = naturalPace(first, size);
    g.stepScale = Math.pow(Math.max(speed, Number.EPSILON) / own, STRIDE_EXPONENT);
    g.stride = first.stride * size * g.stepScale;
    return;
  }
  for (let i = 0; i < walks.length - 1; i++) {
    const a = clips[walks[i]!], b = clips[walks[i + 1]!];
    const va = naturalPace(a, size), vb = naturalPace(b, size);
    if (speed > vb || vb <= va) continue;
    const w = (speed - va) / (vb - va);
    g.walkA = walks[i]!;
    g.walkB = walks[i + 1]!;
    g.walkW = w;
    g.stride = (a.stride + (b.stride - a.stride) * w) * size;
    return;
  }
  g.walkA = g.walkB = walks[walks.length - 1]!;
  g.stride = last.stride * size;
}

// ---------------------------------------------------------------- tuning

/** Body turning rate, rad/s, at which the feet have to step round. */
const TURN_STEPS = 0.35;
/** The same for a body standing or creeping, which no stride carries round. */
const TURN_STEPS_STANDING = 0.2;
/** Turning rate, rad/s, a fully played turn clip carries a standing body round at. */
const STEPPED_TURN_RATE = 3.2;
/** Yaw rate, rad/s, a turn clip steps at before the body has begun to follow it. */
const FEET_LEAD_RATE = 1.2;
/** Angle, rad, a standing body may lag where it is facing before it steps round. */
const LAG_STEPS = 0.12;
/** Drawn speed below which a turn that fast is stepped with the turn clips. */
const TURN_IN_PLACE = 0.3;
/** Seconds a turn clip is held once the turning has stopped. */
const TURN_SETTLE = 0.35;
/** Angle a turn clip is entered at: into its steps, not its wind-up. */
const TURN_WINDUP = 0.05;
/** Half the width between the feet, metres: how far each foot travels as the body pivots. */
const TURN_FOOT = 0.3;
/** Walking speed, m/s, below which a braking walker plays the walk stop, and the braking it needs. */
const STOP_BELOW = 0.6;
const STOP_DECEL = 0.35;
/** Speed, m/s, below which setting off plays the walk start. */
const START_BELOW = 1.0;
/** Slowest share of its own rate a start or stop is played at. */
const CLIP_FLOOR = 0.75;
/** Rate a stop the body has already come out of finishes at, as a share of its own. */
const STOP_SETTLE = 1.25;
/** How stride follows pace below the slowest capture (stride ∝ pace^0.6, as measured in people). */
const STRIDE_EXPONENT = 0.6;
/** Crossfades, seconds: between steps of the gait, into a turn, and between anything else. */
const GAIT_FADE = 0.18;
const TURN_FADE = 0.22;
const FADE = 0.3;
const RUN_TIME = 0.6;
/** Smoothing of the drawn velocity and of its rate of change, seconds. */
const VELOCITY_TIME = 0.12;
const ACCEL_TIME = 0.2;
/** A tick's displacement faster than this is a re-seat, not a step, m/s. */
const JUMP = 4;

const smoothstep = (lo: number, hi: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
};
const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
const approach = (dt: number, time: number): number => 1 - Math.exp(-dt / time);

// ------------------------------------------------------------------- state

/** The heading to draw the body at. */
export const gaitHeading = (g: Gait): number => g.base;

/** Velocity of the drawn body over the last simulation tick, m/s. */
function drawnVelocity(ped: PedView): { x: number; y: number } {
  const x = (ped.x - ped.prev.x) / m(1) / DT;
  const y = (ped.y - ped.prev.y) / m(1) / DT;
  if (Math.hypot(x, y) <= JUMP) return { x, y };
  const v = ped.v / m(1);
  return { x: Math.cos(ped.heading) * v, y: Math.sin(ped.heading) * v };
}

export function createGait(ped: PedView, time: number, heading: number, hash: number): Gait {
  const v = drawnVelocity(ped);
  const speed = Math.hypot(v.x, v.y);
  return {
    time, base: heading, drawn: heading, vx: v.x, vy: v.y, speed, accel: 0,
    cycle: (hash % 997) / 997, run: 0, walkA: 'walk', walkB: 'walk', walkW: 0, stride: 1, direction: 0,
    stepScale: 1, backScale: 1, leftScale: 1, rightScale: 1,
    forwardWeight: 1, backWeight: 0, leftWeight: 0, rightWeight: 0,
    cur: { key: speed > 0 ? 'loco' : 'idle', phase: (hash % 613) / 613, acc: 0 },
    prev: null, fade: 1, fadeTime: FADE, settling: 0, armed: true, looked: null,
  };
}

/** Starts playing `key`, crossfading from whatever was playing. */
function play(g: Gait, key: PlayKey, phase = 0, fade = FADE): void {
  if (g.cur.key === key) return;
  g.prev = g.cur;
  g.cur = { key, phase, acc: 0 };
  g.fade = 0;
  g.fadeTime = fade;
}

/** What a person standing still is doing, from what the simulation says they are doing */
function standingKey(ped: PedView, g: Gait, hash: number, clips: GaitClips): Single {
  const act = ped.gesture;
  // Arms full: just standing, holding it, whatever else is going on.
  if (ped.carry) return 'idle';
  if (act?.kind === 'talk' && act.phase === 'hold') {
    // One speaks at a time, and the turn passes round the party.
    const turn = Math.floor((ped.age + (ped.party.id % 7) * 1.3) / 6.5) % Math.max(1, ped.party.size);
    const mood = ped.party.id % 11;
    if (turn !== ped.rank) return mood === 3 ? 'angry' : 'listen';
    const beat = Math.floor(ped.age / 4.3) % 5;
    return mood === 3 ? 'argue' : mood % 4 === 1 && beat === 2 ? 'laugh' : 'talk';
  }
  if (act?.kind === 'phone') return 'phone';
  // Fallen and not drawn as a ragdoll (`ragdoll.ts`): down on the haunches, never a stiff body tipped over about its feet.
  if (act?.kind === 'fall') return 'crouchIdle';
  if (act?.kind === 'crouch') {
    // Down, a while there (tying a lace, a word to a child), and up again.
    const hold = act.hold ?? 8;
    if (act.t < clips.crouchDown.duration) return 'crouchDown';
    if (hold - act.t < clips.crouchUp.duration) return 'crouchUp';
    return 'crouchIdle';
  }
  const doing = act ? ACTIVITY[act.kind] : undefined;
  if (doing) return doing;
  // Waiting at a kerb a while, some find something to do with their hands.
  if (ped.kerbWait > 3 && (hash & 7) === 5) return 'headphones';
  if (ped.kerbWait > 3 && (hash & 7) === 6) return 'bag';
  const lookFor: unknown = act?.kind === 'look' ? act : (hash & 3) === 1 && ped.kerbWait > 1.5 ? ped.waitingFor : null;
  if (lookFor !== null && lookFor !== undefined) {
    if (g.looked !== lookFor) { g.looked = lookFor; return 'look'; }
    if (g.cur.key === 'look' && g.cur.phase < 1) return 'look';
  }
  if ((hash & 3) === 0 && ped.kerbWait > 2.5) return 'phone';
  return 'idle';
}

/** What a person stopped to do plays (the gestures of `sim/people/view.ts`). */
const ACTIVITY: Partial<Record<string, Single>> = {
  // Reading: the book held up in both hands, as a phone is (the library's newspaper clip only carries one by the side).
  read: 'phone', bag: 'bag', trolley: 'trolley', umbrella: 'umbrella', cheer: 'cheer', dance: 'dance',
  wave: 'wave', drink: 'drink', photo: 'photo', laugh: 'laugh', argue: 'argue', knock: 'knock',
  headphones: 'headphones', eat: 'eatIdle', work: 'workTable',
};

/** Advances one pedestrian's gait to `time` (the pedestrian's own clock, interpolated). */
export function stepGait(g: Gait, ped: PedView, clips: GaitClips, time: number, heading: number,
  size: number, hash: number): void {
  const dt = Math.min(Math.max(0, time - g.time), 0.2);
  g.time = time;

  // How the drawn body is moving.
  const raw = drawnVelocity(ped);
  const distanceSpeed = Math.hypot(raw.x, raw.y);
  const kv = approach(dt, VELOCITY_TIME);
  g.vx += (raw.x - g.vx) * kv;
  g.vy += (raw.y - g.vy) * kv;
  const speed = Math.hypot(g.vx, g.vy);
  if (dt > 0) g.accel += ((speed - g.speed) / dt - g.accel) * approach(dt, ACCEL_TIME);
  g.speed = speed;

  // The simulation turns the visual heading smoothly.
  const want = wrap(heading - g.base);
  let swing = want * approach(dt, 1 / 18);
  if (speed < TURN_IN_PLACE) {
    // Standing or creeping, the body turns only as far as its feet step it round, by the weight of the turn clip now playing.
    const stepWeight = g.cur.key === 'turnLeft' || g.cur.key === 'turnRight'
      ? g.fade * g.fade * (3 - 2 * g.fade)
      : g.prev && (g.prev.key === 'turnLeft' || g.prev.key === 'turnRight') ? 1 - g.fade : 0;
    // Only once the steps carry most of the pose
    const limit = STEPPED_TURN_RATE * Math.max(0, stepWeight * 2 - 1) * dt;
    swing = Math.max(-limit, Math.min(limit, swing));
  }
  g.base = wrap(g.base + swing);
  const drawn = gaitHeading(g);
  if (speed > 0) g.direction = wrap(Math.atan2(g.vy, g.vx) - drawn);
  const turned = Math.abs(wrap(drawn - g.drawn));
  g.drawn = drawn;

  const act = ped.gesture;
  const elder = ped.ageClass === 'elder';
  const cur = g.cur;
  const isTurn = cur.key === 'turnLeft' || cur.key === 'turnRight';
  // Standing, a slower turn already needs the feet
  const lagging = speed < TURN_IN_PLACE && Math.abs(wrap(heading - g.base)) > LAG_STEPS;
  const spin = lagging || Math.abs(ped.turnV) > (speed < TURN_IN_PLACE ? TURN_STEPS_STANDING : TURN_STEPS);
  const turnSign = Math.abs(ped.turnV) > TURN_STEPS_STANDING ? Math.sign(ped.turnV) : Math.sign(wrap(heading - g.base));
  const seat = act?.kind === 'bench' ? act.phase : null;

  if (seat === 'sitDown' || seat === 'seated' || seat === 'standUp') {
    const key = seat === 'seated' ? 'sitIdle' : seat;
    play(g, key, 0, FADE);
    g.cur.phase = seat === 'sitDown' ? Math.min(1, act!.t / SIT_DOWN_SECONDS[ped.gender])
      : seat === 'standUp' ? Math.min(1, act!.t / STAND_UP_SECONDS[ped.gender])
        : (act!.t / clips.sitIdle.duration) % 1;
  } else if (Math.hypot(raw.x, raw.y) > STILL_BELOW && speed > STILL_BELOW && (!spin || speed >= TURN_IN_PLACE)) {
    // A fast turn while barely creeping is a turn on the spot, even out of a walk
    moving(g, ped, clips, dt, speed, distanceSpeed, size, hash, elder || ped.carry !== undefined);
  } else {
    standing(g, ped, clips, dt, turned, spin, isTurn, hash, turnSign);
    // A walk fading out under a turn or a stop keeps stepping with whatever motion is left
    g.cycle = (g.cycle + Math.hypot(distanceSpeed, TURN_FOOT * ped.turnV) * dt / Math.max(1e-3, g.stride)) % 1;
  }

  // Whatever is fading out finishes its own steps meanwhile.
  const prev = g.prev;
  if (prev?.key === 'stop') prev.phase = Math.min(1, prev.phase + STOP_SETTLE * dt / clips.stop.duration);
  else if (prev?.key === 'start') prev.phase = Math.min(1, prev.phase + dt / clips.start.duration);
  else if (prev?.key === 'turnLeft' || prev?.key === 'turnRight') {
    // A turn handing over - to its own next step or to a walk
    prev.phase = Math.min(1, prev.phase + dt / clips[prev.key].duration);
  }
  if (g.fade < 1) g.fade = Math.min(1, g.fade + dt / g.fadeTime);
  if (g.fade >= 1) g.prev = null;
}

/** Below this drawn speed a body is standing (m/s, as everything in the gait is - `drawnVelocity`) */
const STILL_BELOW = 0.05;

/** The branch of `stepGait` for a body not going anywhere: turning, settling, or standing. */
function standing(g: Gait, ped: PedView, clips: GaitClips, dt: number, turned: number, spin: boolean,
  isTurn: boolean, hash: number, turnSign: number): void {
  const cur = g.cur;
  if (spin || (isTurn && g.settling < TURN_SETTLE)) {
    // Turning on the spot: the feet step round, the turn clip advanced by the angle the body has actually turned.
    const key: Single = spin ? (turnSign > 0 ? 'turnLeft' : 'turnRight') : (cur.key as Single);
    if (spin) g.settling = 0; else g.settling += dt;
    if (g.cur.key !== key) {
      play(g, key, 0, TURN_FADE);
      g.cur.acc = TURN_WINDUP;
    }
    const clip = clips[key];
    // The feet lead a turn: they step from its first moment, and the body follows once the steps carry the pose
    g.cur.acc += spin ? Math.max(turned, FEET_LEAD_RATE * dt) : turned;
    g.cur.phase = fractionAtYaw(clip, g.cur.acc);
    if (g.cur.phase >= 0.96) {
      // Still turning past the end of the clip: step round again.
      g.prev = { ...g.cur };
      g.cur = { key, phase: 0, acc: TURN_WINDUP };
      g.fade = 0;
      g.fadeTime = 0.2;
    }
    g.armed = true;
  } else if (cur.key === 'stop' && cur.phase < 1) {
    // Come to rest before the stop has played out: its last steps settle the feet, a little quicker than captured.
    cur.phase = Math.min(1, cur.phase + STOP_SETTLE * dt / clips.stop.duration);
    g.armed = true;
  } else {
    const key = standingKey(ped, g, hash, clips);
    // A one-shot (a wave, a photo, crouching down) plays from its start.
    if (key !== g.cur.key) play(g, key, key === 'look' || !clips[key].loop ? 0 : ((hash >>> 4) % 997) / 997, FADE);
    const clip = clips[key];
    g.cur.phase = clip.loop ? (g.cur.phase + dt / clip.duration) % 1 : Math.min(1, g.cur.phase + dt / clip.duration);
    g.armed = true;
  }
}

/** The moving branch of `stepGait`: set off, walk or run, or stop. */
function moving(g: Gait, ped: PedView, clips: GaitClips, dt: number, speed: number, distanceSpeed: number, size: number,
  hash: number, elder: boolean): void {
  g.settling = 0;
  const cur = g.cur;
  // Start/stop captures have no lateral travel.
  const forwardMotion = Math.abs(g.direction) < 1e-6;
  if (!forwardMotion && (cur.key === 'start' || cur.key === 'stop')) play(g, 'loco', 0, GAIT_FADE);
  if (cur.key !== 'loco' && cur.key !== 'start' && cur.key !== 'stop') {
    // Setting off from a standstill: the walk start, joined where it moves at this pace, unless already going too fast for it.
    if (speed >= naturalPace(clips.walkShuffle, size) && speed < START_BELOW && !elder && forwardMotion) {
      play(g, 'start', startEntry(clips.start, speed, size), GAIT_FADE);
      g.cur.acc = travelAt(clips.start, g.cur.phase) * size;
    } else {
      play(g, 'loco', 0, GAIT_FADE);
    }
  } else if (cur.key === 'loco' && g.armed && speed < STOP_BELOW && g.accel < -STOP_DECEL && !elder && g.run < 0.1 && forwardMotion) {
    // Braking to a stop: join the walk stop where it moves at this pace.
    const entry = stopEntry(clips.stop, speed, size);
    if (entry < 0.9) {
      play(g, 'stop', entry, GAIT_FADE);
      g.cur.acc = travelAt(clips.stop, entry) * size;
      g.armed = false;
    }
  } else if (cur.key === 'stop' && (speed > STOP_BELOW + 0.2 || g.accel > STOP_DECEL || cur.phase >= 0.97)) {
    // Not stopping after all, or the stop is done and the body still moves: walk on, in short steps if slowly.
    play(g, 'loco', 0, GAIT_FADE);
  }
  if (speed > STOP_BELOW + 0.1) g.armed = true;

  const now = g.cur;
  const travel = speed * dt;
  if (now.key === 'start') {
    now.acc += travel;
    now.phase = Math.max(fractionAtTravel(clips.start, now.acc / size), now.phase + CLIP_FLOOR * dt / clips.start.duration);
    if (now.phase >= 0.999) { g.cycle = 0; play(g, 'loco', 0, GAIT_FADE); }
  } else if (now.key === 'stop') {
    now.acc += travel;
    now.phase = Math.min(1, Math.max(fractionAtTravel(clips.stop, now.acc / size),
      now.phase + CLIP_FLOOR * dt / clips.stop.duration));
  }

  pace(g, clips, elder, size, speed, ped.style === 'drunk', ped.hand, ped.carry !== undefined, walkStyle(ped.id));
  // Non-forward locomotion uses the short capture: long lateral strides would cross the legs.
  const x = Math.cos(g.direction), y = Math.sin(g.direction);
  const share = (clip: GaitClip): number => Math.min(1, Math.pow(Math.max(speed, Number.EPSILON) / naturalPace(clip, size), STRIDE_EXPONENT));
  g.backScale = share(clips.walkBack); g.leftScale = share(clips.walkLeft); g.rightScale = share(clips.walkRight);
  // Running is a blend INSIDE the forward group.
  const runs = elder ? 0 : smoothstep(runAt(hash), runAt(hash) + 0.6, speed * Math.max(0, x));
  g.run += (runs - g.run) * approach(dt, RUN_TIME);
  const forwardStride = g.stride * (1 - g.run) + clips.run.stride * size * g.run;
  const backStride = clips.walkBack.stride * size * g.backScale;
  const leftStride = clips.walkLeft.stride * size * g.leftScale;
  const rightStride = clips.walkRight.stride * size * g.rightScale;
  // A shorter lateral capture needs more weight per metre.
  const forward = Math.max(0, x) / Math.max(Number.EPSILON, forwardStride);
  const back = Math.max(0, -x) / Math.max(Number.EPSILON, backStride);
  const left = Math.max(0, y) / Math.max(Number.EPSILON, leftStride);
  const right = Math.max(0, -y) / Math.max(Number.EPSILON, rightStride);
  const total = forward + back + left + right;
  g.forwardWeight = forward / total; g.backWeight = back / total;
  g.leftWeight = left / total; g.rightWeight = right / total;
  g.stride = Math.hypot(g.forwardWeight * forwardStride - g.backWeight * backStride,
    g.leftWeight * leftStride - g.rightWeight * rightStride);
  // A turn made while barely moving is footwork too.
  const stepping = Math.hypot(distanceSpeed, TURN_FOOT * ped.turnV);
  g.cycle = (g.cycle + stepping * dt / Math.max(1e-3, g.stride)) % 1;
}

/** What the body plays now, as weighted clips at baked frames, written into `out` from its start: how many. DO NOT make the plays anew each frame (some 8 objects a walker a frame, 16 thousand with a crowd, AGT-32): `out`'s own are written over, made only while it is shorter. */
export function gaitPlays(g: Gait, clips: GaitClips, out: GaitPlay[]): number {
  const eased = g.fade * g.fade * (3 - 2 * g.fade);
  let n = add(g, clips, g.cur, eased, out, 0);
  if (g.prev) n = add(g, clips, g.prev, 1 - eased, out, n);
  return n;
}

/** A play written at `out[n]` (made if `out` is that short), at or over the least weight: the next free place. */
function put(out: GaitPlay[], n: number, name: GaitClipName, frame: number, weight: number): number {
  if (weight < 0.001) return n;
  const play = out[n];
  if (play) { play.name = name; play.frame = frame; play.weight = weight; } else out.push({ name, frame, weight });
  return n + 1;
}

function add(g: Gait, clips: GaitClips, entry: Play, weight: number, out: GaitPlay[], n: number): number {
  if (weight < 0.001) return n;
  if (entry.key === 'loco') {
    const forwardWalk = weight * g.forwardWeight * (1 - g.run);
    const strideWeight = forwardWalk * g.stepScale;
    n = put(out, n, 'walkRest', g.cycle * clips.walkRest.frames, forwardWalk * (1 - g.stepScale) + weight * (g.backWeight * (1 - g.backScale) + g.leftWeight * (1 - g.leftScale) + g.rightWeight * (1 - g.rightScale)));
    n = put(out, n, 'walkBack', g.cycle * clips.walkBack.frames, weight * g.backScale * g.backWeight);
    n = put(out, n, 'walkLeft', g.cycle * clips.walkLeft.frames, weight * g.leftScale * g.leftWeight);
    n = put(out, n, 'walkRight', g.cycle * clips.walkRight.frames, weight * g.rightScale * g.rightWeight);
    if (g.walkA === g.walkB) n = put(out, n, g.walkA, g.cycle * clips[g.walkA].frames, strideWeight);
    else {
      n = put(out, n, g.walkA, g.cycle * clips[g.walkA].frames, strideWeight * (1 - g.walkW));
      n = put(out, n, g.walkB, g.cycle * clips[g.walkB].frames, strideWeight * g.walkW);
    }
    return put(out, n, 'run', g.cycle * clips.run.frames, weight * g.forwardWeight * g.run);
  }
  return put(out, n, entry.key, entry.phase * clips[entry.key].frames, weight);
}
