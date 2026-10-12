import { Euler, Matrix4, Quaternion, Ray, Vector3, type PerspectiveCamera } from 'three';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { m } from '@world/units';
import type { FlightPose } from '../isoViewport';
import { planetCentre, planetPick } from './bend';

/**
 * THE FREE CAMERA: the view flies like a spaceship, with no ship drawn - the
 * mouse is a stick round the sight (`FlightStick`), and a drag with the
 * middle button held turns the view at once; either sets where it flies,
 * up and down too (the mouse never captured, `main.ts`); W/S forward and
 * back along the look, A/D sideways,
 * Space/Ctrl (or C) up and down, Shift boosts, the wheel sets the throttle.
 *
 * Over a planet "up" is the line from its centre to the eye, and the view
 * never rolls: a heading and a pitch about that up, as three's
 * PointerLockControls turns its camera (yaw about up, pitch about the right,
 * the pitch held short of straight up or down). The up is carried along as
 * the eye moves round the planet - the look turned by the least turn from
 * the last up to the new - so the horizon stays level (the player,
 * 2026-10-10: "mover o mouse lateralmente deve virar a câmera, sem fazê-la
 * rolar de lado").
 *
 * Far out in space there is no up: the planet's up fades away with the
 * height (`FREE_FROM`..`FREE_AT`) and the view turns about its own axes,
 * still never rolling of itself.
 *
 * It flies with weight (the player, 2026-10-11: "física de voo de verdade",
 * the start, the inertia; before, 2026-10-10, no sway, tremor or lean): the
 * velocity builds up to what the keys ask over half a second and, let go,
 * coasts on for about a second before it stops - X still brakes at once; H
 * goes back to where the flight took off; the camera's motion blur in the
 * post chain gives the speed its feel (`postprocess.ts` MOTION_BLUR). Nothing
 * bends the path - no gravity: W goes where the view looks.
 *  - the keys' speed: a fast car's along the ground, then growing with
 *    the height over the nearest body, the wheel scaling it;
 *  - the speed asked scales with the height over the nearest body - a walk
 *    over the street, thousands of metres a second out in space - up to a
 *    ceiling that crosses to the sun in `SUN_CROSSING_S` with the boost
 *    (the height alone would grow the speed without end: speed ~ height
 *    is an exponential once out);
 *  - closing on a body is braked by its distance (Elite's mass lock in
 *    spirit): the speed towards it never more than `CLOSE_PER_HEIGHT` times
 *    the height over it a second, so an arrival slows by itself and a frame
 *    never steps through the moon at full speed;
 *  - space ends a little past the sun (`SPACE_REACH`): the view is held
 *    there, as a game's play area;
 *  - the ground, the buildings (`FlightHost.groundAt`), the moon and the
 *    sun are never gone through: the brake keeps a frame's step towards a
 *    surface under the height over it, and the floor is read where the
 *    step ends too.
 */

export interface FlightBody {
  readonly name: 'planet' | 'moon' | 'sun' | 'asteroid' | 'station' | 'comet';
  readonly centre: Vector3;
  readonly radius: number;
}

export interface FlightHost {
  readonly camera: PerspectiveCamera;
  /** The moon and the sun (`space.ts` bodies), the station and the comet's nucleus (`allBodies`). */
  bodies(): readonly { readonly name: 'moon' | 'sun' | 'station' | 'comet'; readonly centre: Vector3; readonly radius: number }[];
  /** The asteroids nearest a point: solid, they slow the flight near them, but set no up. */
  rocks(at: Vector3): readonly { readonly centre: Vector3; readonly radius: number }[];
  /**
   * The asteroid swarm's own motion at a point, into `out` (`asteroids.ts`
   * driftAt): a ship among the rocks orbits with them, so its speed and its
   * brakes are its own against the swarm, not against the planet.
   */
  drift?(at: Vector3, out: Vector3): Vector3;
  /** The lowest the eye may go at an atlas point: the ground, or a building's roof. */
  groundAt(x: number, y: number): number;
  setPose(pose: FlightPose | null): void;
}

/** What the flight reports for its panel. */
export interface FlightReadout {
  /** Speed, world units / s. */
  readonly speed: number;
  /** The nearest body and the height over its surface, world units. */
  readonly near: 'planet' | 'moon' | 'sun' | 'asteroid' | 'station' | 'comet';
  readonly height: number;
  readonly throttle: number;
  readonly boost: boolean;
  /** The pitch of the look over the horizon (rad, up +) and how much a horizon there is (1 near a body, 0 far out): the cockpit's artificial horizon. */
  readonly pitch: number;
  readonly horizon: number;
  /** The speed as a share of the most the keys ask here (0..1), the engine's push (0..1, the acceleration) and the jump to hyperspeed (0..1). */
  readonly rush: number;
  readonly push: number;
  readonly warp: number;
}

/** The keys: along the look, to the right, along the planet's up. */
const KEYS: Record<string, readonly [axis: 'forward' | 'right' | 'up', sign: 1 | -1]> = {
  KeyW: ['forward', 1], ArrowUp: ['forward', 1], KeyS: ['forward', -1], ArrowDown: ['forward', -1],
  KeyA: ['right', -1], ArrowLeft: ['right', -1], KeyD: ['right', 1], ArrowRight: ['right', 1],
  Space: ['up', 1], KeyR: ['up', 1],
  ControlLeft: ['up', -1], ControlRight: ['up', -1], KeyC: ['up', -1], KeyF: ['up', -1],
};

/** Brake (held) and back to the take-off point. */
const BRAKE_KEY = 'KeyX';
const HOME_KEY = 'KeyH';

/** Mouse steering, rad a pixel. */
const LOOK_PER_PX = 0.0022;
/** The pitch is held this short of straight up or down (rad): there the heading has no meaning. */
const PITCH_LIMIT = Math.PI / 2 - 0.02;
/** Time constants, s: the velocity reaching what the thrust asks; the coast's slowing; the turn following the mouse. */
const THRUST_TAU = 0.45;
const STOP_TAU = 0.9;
const BRAKE_TAU = 0.06;
const TURN_TAU = 0.03;

/**
 * THE STICK: the mouse's place on the screen, away from the sight in the
 * middle, turns the view - a virtual joystick, as space games fly with a
 * mouse (Elite Dangerous and Star Citizen's "virtual joystick", War
 * Thunder's mouse aim: the mouse sets where the craft goes and the craft
 * gets there). Held to the right it goes on turning right, as far as the
 * player likes: the cursor never runs into the screen's edge, as a drag did
 * (the player, 2026-10-11: "o controle ... com o mouse e ponto está muito
 * ruim, deveria obedecer melhor"). Its parts:
 *  - a dead zone round the sight, where it does nothing: no drift from a
 *    hand that rests;
 *  - a curve past it (a power), fine near the middle and quick at the edge,
 *    the rise past the dead zone eased so it does not jump (the overshoot of
 *    a mouse stick that leaps to full deflection out of the dead zone);
 *  - the turn rate following the stick over a short time constant, a
 *    first-order lag: it never overshoots, and back in the middle it stops.
 * Deflection is the cursor's offset over half the view's height (1 at the top edge).
 */
export const STICK = { deadZone: 0.06, power: 1.7, maxRate: 1.5, tau: 0.05 } as const;

/** The turn rate (rad/s, before the zoom) for a deflection along one axis. */
export function stickRate(d: number): number {
  const a = Math.abs(d);
  if (a <= STICK.deadZone) return 0;
  const u = Math.min(1, (a - STICK.deadZone) / (1 - STICK.deadZone));
  return Math.sign(d) * Math.pow(u, STICK.power) * STICK.maxRate;
}

/** The stick's rates, following its deflection (first order: no overshoot); out: rad/s about the up (left +) and the right (up +). */
export class FlightStick {
  private x = 0;
  private y = 0;
  yawRate = 0;
  pitchRate = 0;
  /** The cursor's offset from the sight over half the view's height (right +, down +); 0, 0 lets go. */
  set(x: number, y: number): void {
    const l = Math.hypot(x, y);
    const k = l > 1 ? 1 / l : 1;
    this.x = x * k;
    this.y = y * k;
  }
  update(dt: number): void {
    // The deflection's length through the curve, along its direction: a
    // diagonal turns as a straight push does.
    const l = Math.hypot(this.x, this.y);
    const r = l > 0 ? stickRate(l) / l : 0;
    const ease = dt > 0 ? 1 - Math.exp(-dt / STICK.tau) : 0;
    this.yawRate += (-this.x * r - this.yawRate) * ease;
    this.pitchRate += (-this.y * r - this.pitchRate) * ease;
    // Settled to nothing, nothing: no creep left over.
    if (r === 0 && Math.abs(this.yawRate) < 2e-3) this.yawRate = 0;
    if (r === 0 && Math.abs(this.pitchRate) < 2e-3) this.pitchRate = 0;
  }
}
/** Heights over the planet (in its radii) over which the eye goes from turning with the ground to staying with the stars (`spinWithSky`). */
const SPIN_FROM = 0.3;
const SPIN_AT = 1.2;
const spinQ = new Quaternion();
/** Heights over the planet (in its radii) where its up starts to fade, and where the view is free. */
const FREE_FROM = 1.5;
const FREE_AT = 6;
/** The speed a full throttle asks for, per world unit of height over the nearest surface, a second. */
const SPEED_PER_HEIGHT = 1.4;
/**
 * The least speed the keys ask for, however low: a fast car's along the
 * ground. Scaled by the height alone it fell to a walk next to the ground and
 * the flight seemed stuck there (the player, 2026-10-10: "quando chego num
 * planeta ou próximo dele o modo voo trava e não consigo mais sair do lugar").
 */
const MIN_SPEED = m(25);
/** The least speed towards a body the brake allows (`CLOSE_PER_HEIGHT`): a slow landing. */
const MIN_CLOSE = m(3);
const BOOST = 5;
/**
 * The boost on the speed a height allows: less than on the ceiling, or near a
 * body the boost asked five times the height a second and the view skimmed
 * past the moon's limb in a fraction of a second instead of arriving.
 */
const BOOST_NEAR = 2;
/** The most speed towards a body, per world unit of height over it, a second. */
const CLOSE_PER_HEIGHT = 1.5;
/** Seconds to the sun at the top speed, boosted. */
const SUN_CROSSING_S = 6;
/** How far out space goes, in distances to the sun from the planet's centre. */
const SPACE_REACH = 1.6;
/** The lens, degrees: fixed at any ordinary speed (no widening). */
const FOV_REST = 55;
/**
 * THE SHIP'S FEEL (the player, 2026-10-11: "ainda não parece que estou
 * viajando numa nave espacial"): what the effects read (`flightNow`, the
 * speed streaks in `skyLife.ts`, the cockpit in `ui/flightCockpit.ts`).
 *  - the push: the engine's acceleration over the most it gives, eased;
 *  - the tremor: a hull's shake with the push and the jump, small and
 *    smooth (sums of incommensurate sines: no two frames alike, no noise
 *    table) - the camera only, never the course;
 *  - the jump: boosted past `WARP_FROM` of the boosted ceiling the view goes
 *    to hyperspeed - the lens widens by `WARP_FOV` (the stretch of a jump to
 *    lightspeed in film and games), the streaks tunnel; under it the lens
 *    stays fixed.
 */
const PUSH_TAU = 0.25;
const SHAKE = { push: 0.0016, warp: 0.0035 } as const;
const WARP_FROM = 0.35;
const WARP_FULL = 0.8;
const WARP_FOV = 0.3;
const WARP_TAU = 0.6;
/** The eye never comes closer to a surface than this. */
const SURFACE_GAP = m(1.7);

/**
 * Whether a free flight is on and its velocity through the space round it
 * (three's space, world units a second: the flight's own, without the drift
 * of the swarm or the station it is carried by), for what is drawn only while
 * flying (the space dust, `skyLife.ts`). Written by the one flight (`enter`,
 * `step`, `exit`).
 */
export const flightNow = { active: false, velocity: new Vector3(), rush: 0, push: 0, warp: 0 };

const tmpQ = new Quaternion();
const basis = new Matrix4();
const v1 = new Vector3();
const v2 = new Vector3();
const right = new Vector3();
const cameraUp = new Vector3();
const back = new Vector3();
const want = new Vector3();
/** The asteroid swarm's motion where the eye is (`FlightHost.drift`). */
const swarm = new Vector3();
const ray = new Ray();
const shakeEuler = new Euler();
const shakeQ = new Quaternion();
const smoothstep01 = (v: number): number => { const t = Math.min(1, Math.max(0, v)); return t * t * (3 - 2 * t); };

export class Flight {
  active = false;
  private readonly position = new Vector3();
  private readonly orientation = new Quaternion();
  private readonly velocity = new Vector3();
  /** Where the eye looks (unit); the up it was last levelled to (the nearest body's centre to the eye); the level heading. */
  private readonly forward = new Vector3(0, 0, -1);
  private readonly up = new Vector3(0, 1, 0);
  private readonly heading = new Vector3(1, 0, 0);
  private readonly held = new Set<string>();
  private boost = false;
  private braking = false;
  /** Where the flight took off: H goes back there. */
  private readonly homePosition = new Vector3();
  private readonly homeForward = new Vector3();
  private throttle = 1;
  /** Mouse motion not yet turned (rad). */
  private pendingYaw = 0;
  /** The mouse as a stick (`FlightStick`), and its dead zone for the one drawing it (`ui/flightStick.ts`). */
  readonly stick = new FlightStick();
  readonly stickDeadZone = STICK.deadZone;
  private pendingPitch = 0;
  private fov = FOV_REST;
  private readout: FlightReadout = { speed: 0, near: 'planet', height: 0, throttle: 1, boost: false, pitch: 0, horizon: 1, rush: 0, push: 0, warp: 0 };
  /** The ship's feel (`PUSH_TAU`...): the push and the jump eased, the shake's clock. */
  private push = 0;
  private warp = 0;
  private clock = 0;
  private readonly lastVelocity = new Vector3();
  private readonly planet: FlightBody = { name: 'planet', centre: new Vector3(), radius: PLANET_RADIUS };
  private readonly pose = { position: new Vector3(), quaternion: new Quaternion(), fov: FOV_REST, near: 0.1, far: 1e5, globe: 0 };

  constructor(private readonly host: FlightHost) {}

  /** Takes off from where the camera is, looking where it looks (levelled: no roll). */
  enter(): void {
    if (this.active) return;
    this.active = true;
    flightNow.active = true;
    this.position.copy(this.host.camera.position);
    this.orientation.copy(this.host.camera.quaternion);
    this.velocity.set(0, 0, 0);
    this.pendingYaw = this.pendingPitch = 0;
    this.push = this.warp = this.clock = 0;
    this.lastVelocity.set(0, 0, 0);
    this.stick.set(0, 0);
    this.stick.yawRate = this.stick.pitchRate = 0;
    this.forward.set(0, 0, -1).applyQuaternion(this.orientation).normalize();
    this.up.subVectors(this.position, planetCentre(v1)).normalize();
    this.heading.copy(this.forward).addScaledVector(this.up, -this.forward.dot(this.up));
    // Looking straight down (the map's plan view): the heading is the camera's own up laid level.
    if (this.heading.lengthSq() < 1e-6) this.heading.set(0, 1, 0).applyQuaternion(this.orientation).addScaledVector(this.up, -this.up.dot(v2.set(0, 1, 0).applyQuaternion(this.orientation)));
    this.heading.normalize();
    this.fov = FOV_REST;
    this.homePosition.copy(this.position);
    this.homeForward.copy(this.forward);
    this.braking = false;
    this.step(0);
  }

  /** Back to where the flight took off, at rest, looking as it looked. */
  goHome(): void {
    this.position.copy(this.homePosition);
    this.forward.copy(this.homeForward);
    this.up.subVectors(this.position, planetCentre(v1)).normalize();
    this.heading.copy(this.forward).addScaledVector(this.up, -this.forward.dot(this.up));
    if (this.heading.lengthSq() < 1e-8) this.heading.set(1, 0, 0);
    this.heading.normalize();
    this.velocity.set(0, 0, 0);
    this.pendingYaw = this.pendingPitch = 0;
  }

  /** Back to the orbit view: the caller sets the orbit over `landing` (an atlas point, or null when none is under the view). */
  exit(): { landing: { x: number; y: number } | null; height: number } {
    this.active = false;
    flightNow.active = false;
    flightNow.velocity.set(0, 0, 0);
    flightNow.rush = flightNow.push = flightNow.warp = 0;
    this.held.clear();
    // The ground ahead of the eye, else under it.
    const centre = planetCentre(v1);
    ray.set(this.position, v2.copy(this.forward));
    let landing = planetPick(ray, 0);
    if (!landing) {
      ray.set(this.position, v2.subVectors(centre, this.position).normalize());
      landing = planetPick(ray, 0);
    }
    const height = Math.max(m(2), this.position.distanceTo(centre) - PLANET_RADIUS);
    this.host.setPose(null);
    return { landing, height };
  }

  press(code: string, shift: boolean): boolean {
    this.boost = shift;
    if (code === 'ShiftLeft' || code === 'ShiftRight') { this.boost = true; return true; }
    if (code === BRAKE_KEY) { this.braking = true; return true; }
    if (code === HOME_KEY) { this.goHome(); return true; }
    if (!(code in KEYS)) return false;
    this.held.add(code);
    return true;
  }

  release(code: string, shift: boolean): void {
    this.boost = shift && code !== 'ShiftLeft' && code !== 'ShiftRight';
    if (code === BRAKE_KEY) this.braking = false;
    this.held.delete(code);
  }

  /** Every key let go (the mouse freed, the window left): nothing goes on by itself. */
  releaseAll(): void {
    this.held.clear();
    this.boost = false;
    this.braking = false;
  }

  /** The mouse moved (CSS px): right turns right, up looks up. */
  look(dx: number, dy: number): void {
    this.pendingYaw -= dx * LOOK_PER_PX * (this.fov / FOV_REST);
    this.pendingPitch -= dy * LOOK_PER_PX * (this.fov / FOV_REST);
  }

  /** The mouse as a stick: its offset from the sight over half the view's height (right +, down +); 0, 0 lets go. */
  steer(x: number, y: number): void {
    this.stick.set(x, y);
  }

  /** A notch of the wheel: the throttle up (positive) or down, 1/32 .. 32. */
  wheel(notches: number): void {
    this.throttle = Math.min(32, Math.max(1 / 32, this.throttle * Math.pow(1.25, notches)));
  }

  /**
   * Turns the eye with the sky round the planet's axis (`axis`, three's
   * space, through the planet's centre) by `radians` times how far out it
   * is (`FREE_FROM`..`FREE_AT`): out in space the eye stays with the stars
   * and the planet turns under it; near the ground it stays with the ground
   * (Kerbal Space Program's frames: the body's own below a height, the
   * stars' above it).
   */
  spinWithSky(axis: Vector3, radians: number): void {
    if (!this.active || radians === 0) return;
    const centre = this.planet.centre;
    const over = (this.position.distanceTo(centre) - PLANET_RADIUS) / PLANET_RADIUS;
    const t = Math.min(1, Math.max(0, (over - SPIN_FROM) / (SPIN_AT - SPIN_FROM)));
    const angle = radians * t * t * (3 - 2 * t);
    if (angle === 0) return;
    spinQ.setFromAxisAngle(axis, angle);
    this.position.sub(centre).applyQuaternion(spinQ).add(centre);
    this.forward.applyQuaternion(spinQ);
    this.heading.applyQuaternion(spinQ);
    this.up.applyQuaternion(spinQ);
    this.velocity.applyQuaternion(spinQ);
  }

  /** The lens's vertical field now, degrees (it widens in the jump). */
  get lens(): number {
    return this.fov;
  }

  get state(): FlightReadout {
    return this.readout;
  }

  /** Advances `dt` seconds; sets the camera's pose. */
  step(dt: number): void {
    if (!this.active) return;
    const s = Math.min(0.1, Math.max(0, dt));
    // The bodies, and the nearest surface.
    planetCentre(this.planet.centre);
    const bodies: FlightBody[] = [this.planet];
    for (const b of this.host.bodies()) bodies.push(b);
    // The worlds that set an up are the planet, the moon and the sun; a rock
    // passed by would swing the horizon round it.
    const worlds = bodies.length;
    for (const r of this.host.rocks(this.position)) bodies.push({ name: 'asteroid', centre: r.centre, radius: r.radius });
    let sunDistance = PLANET_RADIUS * 60;
    for (const b of bodies) if (b.name === 'sun') sunDistance = b.centre.distanceTo(this.planet.centre);
    let near: FlightBody = this.planet;
    let height = Infinity;
    let world: FlightBody = this.planet;
    let worldHeight = Infinity;
    // The planet's own ground under the eye (its relief, its roads' cuts).
    let planetFloor = PLANET_RADIUS;
    ray.set(this.position, v1.subVectors(this.planet.centre, this.position).normalize());
    const under = planetPick(ray, 0);
    if (under) planetFloor = PLANET_RADIUS + this.host.groundAt(under.x, under.y);
    for (const b of bodies) {
      const floor = b === this.planet ? planetFloor : b.radius;
      const h = this.position.distanceTo(b.centre) - floor;
      if (h < height) { height = h; near = b; }
      if (bodies.indexOf(b) < worlds && h < worldHeight) { worldHeight = h; world = b; }
    }

    // Up: the nearest body's centre to the eye. The look and the heading
    // carried by the least turn from the last up to this one, so the
    // horizon stays level as the eye goes round the planet.
    // Far out the up fades: towards the view's own up, so the view is free
    // there and the change is gradual on the way.
    v2.copy(this.up);
    const radial = v1.subVectors(this.position, world.centre).normalize();
    const overNear = (this.position.distanceTo(world.centre) - world.radius) / world.radius;
    const bound = 1 - Math.min(1, Math.max(0, (overNear - FREE_FROM) / (FREE_AT - FREE_FROM)));
    // Far out the up stays as it was (a free, steady view); near, it is the
    // radial; between, it leans that far towards the radial. Taken from the
    // camera's own up it fed back into itself whenever the view was pitched,
    // and the view turned on and on (the player, 2026-10-10: "ao apertar V
    // fica tudo rodando e não para mais").
    this.up.lerp(radial, bound * bound * (3 - 2 * bound)).normalize();
    tmpQ.setFromUnitVectors(v2, this.up);
    this.forward.applyQuaternion(tmpQ);
    this.heading.applyQuaternion(tmpQ);
    // The stick's turn this step, then the mouse's motion spent smoothly:
    // the heading about up, the pitch about the right - never a roll.
    this.stick.update(s);
    const zoom = this.fov / FOV_REST;
    this.pendingYaw += this.stick.yawRate * zoom * s;
    this.pendingPitch += this.stick.pitchRate * zoom * s;
    const ease = 1 - Math.exp(-s / TURN_TAU);
    const yaw = this.pendingYaw * ease, pitchStep = this.pendingPitch * ease;
    this.pendingYaw -= yaw;
    this.pendingPitch -= pitchStep;
    const level = v2.copy(this.forward).addScaledVector(this.up, -this.forward.dot(this.up));
    if (level.lengthSq() > 1e-8) this.heading.copy(level);
    this.heading.addScaledVector(this.up, -this.heading.dot(this.up)).normalize().applyAxisAngle(this.up, yaw);
    const pitchNow = Math.asin(Math.min(1, Math.max(-1, this.forward.dot(this.up))));
    const pitch = Math.min(PITCH_LIMIT, Math.max(-PITCH_LIMIT, pitchNow + pitchStep));
    this.forward.copy(this.heading).multiplyScalar(Math.cos(pitch)).addScaledVector(this.up, Math.sin(pitch)).normalize();
    // The camera's frame: right = forward x up, its own up = right x forward, looking down -z.
    right.crossVectors(this.forward, this.up).normalize();
    cameraUp.crossVectors(right, this.forward);
    back.copy(this.forward).negate();
    this.orientation.setFromRotationMatrix(basis.makeBasis(right, cameraUp, back));

    // Thrust: along the look, sideways, and along the planet's up, at a speed scaled by the height.
    let ahead = 0, side = 0, lift = 0;
    for (const code of this.held) {
      const [axis, sign] = KEYS[code]!;
      if (axis === 'forward') ahead += sign;
      else if (axis === 'right') side += sign;
      else lift += sign;
    }
    want.copy(this.forward).multiplyScalar(ahead).addScaledVector(right, side).addScaledVector(this.up, lift);
    const thrusting = want.lengthSq() > 0;
    const ceiling = sunDistance / SUN_CROSSING_S / BOOST;
    const top = Math.min(
      ceiling * (this.boost ? BOOST : 1),
      Math.max(MIN_SPEED * (this.boost ? BOOST : 1), Math.max(0, height) * SPEED_PER_HEIGHT * (this.boost ? BOOST_NEAR : 1)) * this.throttle,
    );
    if (this.braking) this.velocity.multiplyScalar(Math.exp(-s / BRAKE_TAU));
    else if (thrusting) {
      want.normalize().multiplyScalar(top);
      this.velocity.lerp(want, 1 - Math.exp(-s / THRUST_TAU));
    } else this.velocity.multiplyScalar(Math.exp(-s / STOP_TAU));
    // Braked towards every body by the height over it.
    for (const b of bodies) {
      const floor = b === this.planet ? planetFloor : b.radius;
      const d = v2.subVectors(b.centre, this.position);
      const r = d.length();
      const closing = this.velocity.dot(d.divideScalar(r));
      // A frame's step towards it stays under the height over it (`CLOSE_PER_HEIGHT` < 1 / dt).
      const most = Math.max(MIN_CLOSE, (r - floor) * Math.min(CLOSE_PER_HEIGHT, 0.5 / Math.max(s, 1e-3)));
      if (closing > most) this.velocity.addScaledVector(d, most - closing);
    }
    this.position.addScaledVector(this.velocity, s);
    // Carried with the asteroid swarm's orbit while among its rocks.
    if (this.host.drift) this.position.addScaledVector(this.host.drift(this.position, swarm), s);
    // The floor where the step ends (a roof met on the way, a rise of the ground).
    ray.set(this.position, v1.subVectors(this.planet.centre, this.position).normalize());
    const landed = planetPick(ray, 0);
    if (landed) planetFloor = Math.max(planetFloor, PLANET_RADIUS + this.host.groundAt(landed.x, landed.y));
    // Never into a body: held at its surface, the velocity into it taken away.
    for (const b of bodies) {
      const floor = (b === this.planet ? planetFloor : b.radius * (b.name === 'sun' ? 1.2 : 1)) + SURFACE_GAP;
      const d = v2.subVectors(this.position, b.centre);
      const r = d.length();
      if (r >= floor) continue;
      d.divideScalar(r);
      this.position.copy(b.centre).addScaledVector(d, floor);
      const into = this.velocity.dot(d);
      if (into < 0) this.velocity.addScaledVector(d, -into);
    }
    // The end of space: held on its sphere, the velocity outwards taken away.
    const out = v2.subVectors(this.position, this.planet.centre);
    const reach = sunDistance * SPACE_REACH;
    if (out.length() > reach) {
      out.normalize();
      this.position.copy(this.planet.centre).addScaledVector(out, reach);
      const away = this.velocity.dot(out);
      if (away > 0) this.velocity.addScaledVector(out, -away);
    }
    const speed = this.velocity.length();
    flightNow.velocity.copy(this.velocity);
    // The ship's feel: the push (the acceleration over the most the engine
    // gives here), the jump to hyperspeed, the shake they make.
    const accel = s > 0 ? v1.subVectors(this.velocity, this.lastVelocity).length() / s : 0;
    this.lastVelocity.copy(this.velocity);
    const pushNow = thrusting ? Math.min(1, accel * THRUST_TAU / Math.max(top, 1e-6)) : 0;
    this.push += (pushNow - this.push) * (s > 0 ? 1 - Math.exp(-s / PUSH_TAU) : 0);
    const boosted = ceiling * BOOST;
    const warpNow = this.boost ? smoothstep01((speed / Math.max(boosted, 1e-6) - WARP_FROM) / (WARP_FULL - WARP_FROM)) : 0;
    this.warp += (warpNow - this.warp) * (s > 0 ? 1 - Math.exp(-s / WARP_TAU) : 0);
    this.fov = FOV_REST * (1 + WARP_FOV * this.warp);
    this.clock += s;
    const rush = Math.min(1, speed / Math.max(top / (this.boost ? BOOST : 1), 1e-6));
    flightNow.rush = rush; flightNow.push = this.push; flightNow.warp = this.warp;
    const p = this.pose;
    p.position.copy(this.position);
    p.quaternion.copy(this.orientation);
    const shake = SHAKE.push * this.push + SHAKE.warp * this.warp;
    if (shake > 1e-6) {
      const t = this.clock;
      shakeEuler.set(
        shake * (Math.sin(t * 37.1) * 0.6 + Math.sin(t * 23.7 + 1.3) * 0.4),
        shake * (Math.sin(t * 31.3 + 0.7) * 0.6 + Math.sin(t * 19.1 + 2.1) * 0.4),
        shake * 0.5 * Math.sin(t * 27.9 + 0.4),
      );
      p.quaternion.multiply(shakeQ.setFromEuler(shakeEuler));
    }
    p.fov = this.fov;
    // The depth range the view needs: close to the nearest surface, out past the planet.
    const toPlanet = this.position.distanceTo(this.planet.centre);
    p.near = Math.min(Math.max(0.05, height * 0.25), 2000);
    p.far = Math.max(toPlanet + PLANET_RADIUS * 1.3, p.near * 100);
    // From the ground's sky out to space, by the height over the planet.
    const over = toPlanet - PLANET_RADIUS;
    p.globe = Math.min(1, Math.max(0, (over - PLANET_RADIUS * 0.05) / (PLANET_RADIUS * 0.6)));
    this.host.setPose(p);
    this.readout = {
      speed, near: near.name, height: Math.max(0, height), throttle: this.throttle, boost: this.boost,
      pitch: Math.asin(Math.min(1, Math.max(-1, this.forward.dot(this.up)))), horizon: bound, rush, push: this.push, warp: this.warp,
    };
  }
}
