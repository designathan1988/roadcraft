import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix3,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Points,
  Quaternion,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Camera,
} from 'three';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { AIR_GLSL, ATMOSPHERE_TOP, SKY_ADDITIVE } from './air';
import { rockGeometry } from './asteroids';
import { flightNow } from './flight';

/**
 * THE SKY'S LIFE: what moves round the planet besides the moon and the
 * rocks (the player, 2026-10-11: space "hoje está morto, sem vida nenhuma";
 * then "mais dinâmica e coisas para explorar", "efeitos especiais bonitos e
 * otimizados").
 *
 *  - SATELLITES: points on orbits of their own (inclinations from the
 *    equator's to the poles'), each going round at its radius's Keplerian
 *    rate (a^-3/2). They shine only by the sunlight they reflect - out of
 *    the planet's shadow - so from the ground they are seen moving across
 *    the night sky in the hours after dusk and before dawn, as satellites
 *    are ("Satellite watching": lit solely by reflected sunlight, best a few
 *    hours after dusk or before dawn; a steady point, now and then a flare).
 *    Worked out in the vertex shader from their elements and the time.
 *  - SHOOTING STARS: a few slots, each lighting now and then a streak high
 *    in the air (meteors glow some 80-120 km up, AMS: high in the shell
 *    here) over the place looked at, a bright head and a fading trail,
 *    hidden by the day's sky light as the stars are.
 *  - A SPACE STATION on the International Space Station's inclination
 *    (51.6 degrees), modules, a truss and solar wings, lit by the sun -
 *    something to fly to (`flight.ts` reads it as a body, the panel marks it).
 *    Its navigation lights as a spacecraft's (Dragon, Cygnus: red to port,
 *    green to starboard, white strobes on top, a yellow one below,
 *    en.wikipedia.org/wiki/Navigation_light): seen blinking in the planet's
 *    shadow, where the station itself is dark.
 *  - A COMET on a Keplerian ellipse round the planet (the eccentric anomaly
 *    from Kepler's equation by Newton's method), in the stars' frame: it
 *    rises and sets with them and its tails keep away from the sun. A dark
 *    nucleus (an asteroid's shape), a green coma (C2's glow), a straight blue
 *    ion tail streaming straight away from the sun with streamers running out
 *    along it, and a broad yellowish dust tail curving back along the orbit
 *    (NASA comet facts; APOD 2020-07-11, the tails of NEOWISE). The coma is
 *    the column through a 1/r^2 cloud along each pixel's ray, so it is right
 *    from far off and from inside it.
 *  - THE AURORA: the ovals round both geomagnetic poles (67 degrees, a band
 *    nearer the pole on the day side and further on the night side,
 *    en.wikipedia.org/wiki/Aurora), curtains folded along the oval with rays
 *    running along them, green low with a sharp lower edge, red high up and a
 *    pink fringe at the foot, seen on the night side only; brighter where a
 *    fold is seen edge-on (the path through a thin emitting sheet). One mesh,
 *    folded and moved in the vertex shader (Lawlor and Genetti, "Interactive
 *    Volume Rendering Aurora on the GPU": an emissive curtain, a height
 *    profile times a flux along a footprint curve).
 *  - SPACE DUST, while flying: a field of grains round the eye in five scales
 *    eight times apart, each wrapped round it in its own box (a grain leaving
 *    one side comes back on the other, as jME's StarDust and Elite's
 *    stardust keep a fixed number), faded by its distance in the box, each
 *    scale shown by how its box suits the speed (crossed in about a second),
 *    every grain stretched by the eye's motion over a short exposure (Unity's
 *    stretched billboard by camera movement): the speed felt in empty space.
 *    One instanced draw; nothing on the CPU a frame but a few uniforms.
 *
 * Set down with the planet each frame (`planetMotion`), as the moon and the
 * rocks are; nothing of it bent onto the planet.
 */

const SATELLITES = 64;
/** The orbits' radii, in the planet's radii. */
const SATELLITE_LOW = 1.22;
const SATELLITE_HIGH = 1.9;
/** One turn at the lowest orbit, real seconds: a crossing of the sky in about a minute seen from the ground. */
const SATELLITE_PERIOD = 300;
const METEORS = 8;
/** A meteor's life, s, and the mean time between two from one slot. */
const METEOR_LIFE = 0.9;
const METEOR_EVERY = 14;
/** The station's orbit: radius (planet radii), inclination, one turn (real seconds). */
const STATION_RADIUS = 1.45;
const STATION_INCLINATION = (51.6 * Math.PI) / 180;
const STATION_PERIOD = 420;
/** Within this distance of the station a ship flies on with it, fading out by the second (world units). */
const STATION_NEAR = 300;
const STATION_FAR = 900;
/** The station's size, world units (the planet's radius is 3.8 km). */
const STATION_SPAN = 90;

/** The comet's orbit round the planet (the stars' frame): semi-major axis, eccentricity, one turn (real seconds), its plane. */
const COMET_A = 18 * PLANET_RADIUS;
const COMET_E = 0.5;
const COMET_PERIOD = 2400;
const COMET_INCLINATION = (30 * Math.PI) / 180;
const COMET_NODE = 1.1;
/**
 * The argument of the periapsis: a quarter turn from the node, so the comet
 * crosses the equator's plane at 13.5 radii both ways - never through the
 * moon's orbit (16 radii, near that plane).
 */
const COMET_PERIAPSIS_ARG = Math.PI / 2;
/** The nucleus, the coma and the tails, world units. */
const COMET_NUCLEUS = 0.1 * PLANET_RADIUS;
const COMET_COMA = 0.9 * PLANET_RADIUS;
const COMET_ION = 10 * PLANET_RADIUS;
const COMET_DUST = 7 * PLANET_RADIUS;
/** Segments along each tail. */
const COMET_SEGMENTS = 48;
/** Within these distances of the nucleus a ship flies on with it (as with the station). */
const COMET_NEAR = 4 * COMET_COMA;
const COMET_FAR = 10 * COMET_COMA;

/** The aurora: segments round each oval, its colatitude from the magnetic pole and the swing to the night side, the magnetic axis's tilt. */
const AURORA_SEGMENTS = 360;
const AURORA_COLATITUDE = (21 * Math.PI) / 180;
const AURORA_SWING = (4 * Math.PI) / 180;
const MAGNETIC_TILT = (11 * Math.PI) / 180;
const MAGNETIC_LONGITUDE = 2.0;
/**
 * The curtains' foot and top, in heights of the air over the ground (meteors
 * burn at 0.55-0.85 of it): inside the air drawn round the planet. The
 * Earth's run from some 100 to 300 km over a 6400 km planet; a planet's
 * share of that here would be a few dozen metres, and the air's scale
 * heights would put them far out in space (they stood up to 2.6 km, over the
 * station's orbit, enormous beside the planet).
 */
const AURORA_FOOT = 0.6;
const AURORA_TOP = 0.95;
/** The diffuse glow under the curtains seen from above (half its width, radians of colatitude). */
const AURORA_BAND = (1.6 * Math.PI) / 180;

/**
 * THE SPEED STREAKS (the player, 2026-10-11: "ainda não parece que estou
 * viajando numa nave espacial"): lines rushing out of the point the ship
 * flies towards, at any height - the space dust only shows out in space -
 * as racing and space games draw their speed (SuperTuxKart's boost lines: the
 * screen cut in 60-100 radial sections, each its own random offset, the edges
 * smoothstepped, the middle left clear, the lines moving outwards; the
 * stretched streaks of a jump to lightspeed). One full-screen quad, drawn
 * last, its light added (`SKY_ADDITIVE`), off when the ship is still.
 *  - sparse and faint at a cruise (`flightNow.rush`), dense, long and blue in
 *    the jump (`flightNow.warp`), with the jump's blue round the edges;
 *  - flying backwards, the lines run in towards the point behind;
 *  - the engine's warm glow at the foot of the view while it pushes (`flightNow.push`).
 */
const STREAK_VERTEX = /* glsl */ `
  varying vec2 vNdc;
  void main() { vNdc = position.xy; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;
const STREAK_FRAGMENT = /* glsl */ `
  uniform vec2 uFocus;
  uniform float uAspect;
  uniform float uRush;
  uniform float uWarp;
  uniform float uPush;
  uniform float uTime;
  uniform float uDir;
  varying vec2 vNdc;
  float streakHash(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
  void main() {
    vec2 d = vNdc - uFocus;
    d.x *= uAspect;
    float r = length(d);
    float a = atan(d.y, d.x) / 6.2831853 + 0.5;
    float n = floor(mix(72.0, 180.0, uWarp));
    float cell = floor(a * n);
    float f = fract(a * n);
    float seed = streakHash(cell);
    float seed2 = streakHash(cell + 71.0);
    // Its own width; edges smoothed over a pixel's share of the cell.
    float w = mix(0.06, 0.1, uWarp) * (0.5 + seed);
    float aa = max(fwidth(a * n), 1e-3);
    float line = 1.0 - smoothstep(w, w + aa, abs(f - 0.5));
    // A dash running outwards (inwards flying backwards), each at its own speed.
    float speed = mix(0.7, 2.6, uWarp) * (0.6 + seed2);
    float phase = fract(r * mix(1.4, 0.55, uWarp) - uTime * speed * uDir + seed * 9.0);
    float len = mix(0.18, 0.75, uWarp);
    float dash = smoothstep(0.0, 0.04, phase) * (1.0 - smoothstep(len - 0.12, len, phase));
    // The middle clear, the lines growing to the edges.
    float edge = smoothstep(mix(0.32, 0.22, uWarp), mix(1.0, 0.8, uWarp), r);
    // Few at a cruise, all of them in the jump.
    float shown = step(mix(0.62, 0.55, uWarp), seed2);
    float k = line * dash * edge * shown * (uRush * uRush * 0.2 + uWarp * 0.16);
    vec3 c = mix(vec3(0.82, 0.88, 1.0), vec3(0.55, 0.72, 1.0), uWarp) * k;
    // The jump's blue round the edges, the engine's glow at the foot of the view.
    c += vec3(0.2, 0.42, 1.0) * uWarp * 0.06 * smoothstep(0.45, 1.4, r);
    c += vec3(1.0, 0.55, 0.25) * uPush * 0.1 * smoothstep(0.55, 1.0, -vNdc.y);
    gl_FragColor = vec4(c, 1.0);
  }
`;

/** The space dust: each scale's box, world units (eight times apart), and its grains. */
export const DUST_BOXES = [40, 320, 2560, 20480, 163840] as const;
const DUST_PER_BOX = 384;
/** The exposure the grains are stretched over, s (a film camera's at 30 frames, its shutter open). */
const DUST_EXPOSURE = 1 / 30;
/** The time a box should take to be crossed, s: shown from `DUST_IN` (fading in from a quarter of it) to `DUST_OUT`. */
const DUST_IN = 0.4;
const DUST_OUT = 6;

/** A deterministic 0..1 sequence. */
function sequence(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * How much of each scale of the space dust shows at a speed (world units a
 * second), into `out`: a scale whose box is crossed in `DUST_IN`..`DUST_OUT`
 * seconds shows whole, fading out a factor of four past either end. At rest
 * none; eight times apart, at least one scale shows at any flying speed.
 */
export function dustWeights(speed: number, out: number[]): number[] {
  for (let i = 0; i < DUST_BOXES.length; i++) {
    const crossing = Math.log2(DUST_BOXES[i]! / Math.max(1e-6, speed));
    out[i] = smooth(Math.log2(DUST_IN / 4), Math.log2(DUST_IN), crossing) * (1 - smooth(Math.log2(DUST_OUT), Math.log2(DUST_OUT * 4), crossing));
  }
  return out;
}

/**
 * The comet's place and motion round the planet at `seconds` (the stars'
 * frame, world units and units a second), into `at` and `velocity`: Kepler's
 * equation M = E - e sin E solved by Newton's method from E = M (fine below
 * e = 0.8), x = a (cos E - e), y = b sin E on the orbit's plane.
 */
export function cometAt(seconds: number, at: Vector3, velocity: Vector3): void {
  const n = (Math.PI * 2) / COMET_PERIOD;
  const mean = (((n * seconds) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  let E = mean;
  for (let k = 0; k < 8; k++) E -= (E - COMET_E * Math.sin(E) - mean) / (1 - COMET_E * Math.cos(E));
  const b = COMET_A * Math.sqrt(1 - COMET_E * COMET_E);
  const cosE = Math.cos(E), sinE = Math.sin(E);
  const x = COMET_A * (cosE - COMET_E), y = b * sinE;
  const rate = n / (1 - COMET_E * cosE);
  const vx = -COMET_A * sinE * rate, vy = b * cosE * rate;
  // The orbit's plane to the stars' frame (the node, the inclination, the periapsis's argument).
  const cO = Math.cos(COMET_NODE), sO = Math.sin(COMET_NODE), ci = Math.cos(COMET_INCLINATION), si = Math.sin(COMET_INCLINATION);
  const cw = Math.cos(COMET_PERIAPSIS_ARG), sw = Math.sin(COMET_PERIAPSIS_ARG);
  const px = cO * cw - sO * sw * ci, py = sO * cw + cO * sw * ci, pz = sw * si;
  const qx = -cO * sw - sO * cw * ci, qy = -sO * sw + cO * cw * ci, qz = cw * si;
  at.set(px * x + qx * y, py * x + qy * y, pz * x + qz * y);
  velocity.set(px * vx + qx * vy, py * vx + qy * vy, pz * vx + qz * vy);
}

/** Whether a point (relative to the planet's centre) is in the planet's shadow, sun `s` (unit): the cylinder behind it. */
const SHADOW_GLSL = /* glsl */ `
  float sunlit(vec3 p, vec3 s) {
    float along = dot(p, s);
    float off = length(p - along * s);
    return along > 0.0 ? 1.0 : smoothstep(${PLANET_RADIUS.toFixed(1)} * 0.98, ${PLANET_RADIUS.toFixed(1)} * 1.04, off);
  }
`;

/** Hidden by the sky's own light, as the stars are (`space.ts` starsThrough). */
const SKY_GLOW_GLSL = /* glsl */ `
  float lifeThrough(vec3 dir) {
    if (uAirInside < 0.5) return 1.0;
    vec3 sky = airSky(cameraPosition, dir).rgb;
    return 1.0 - smoothstep(0.004, 0.08, dot(sky, vec3(0.2126, 0.7152, 0.0722)));
  }
`;

/** Value noise for the shaders below. */
const NOISE_GLSL = /* glsl */ `
  float lifeHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float lifeNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(lifeHash(i), lifeHash(i + vec2(1.0, 0.0)), f.x), mix(lifeHash(i + vec2(0.0, 1.0)), lifeHash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
`;

const SATELLITE_VERTEX = /* glsl */ `
  attribute vec4 aOrbit;   // radius, rate (rad/s), phase, flare phase
  attribute vec4 aPlane;   // the orbit's node axis (xyz) and inclination (w)
  uniform float uTime;
  uniform vec3 uSun;
  uniform vec3 uCentre;
  uniform float uPixel;
  varying float vLight;
  ${AIR_GLSL}
  ${SHADOW_GLSL}
  ${SKY_GLOW_GLSL}
  vec3 turnAbout(vec3 v, vec3 k, float a) { return v * cos(a) + cross(k, v) * sin(a) + k * dot(k, v) * (1.0 - cos(a)); }
  void main() {
    // On the orbit's plane: the equator's circle, tipped about the node by the inclination.
    float a = aOrbit.z + aOrbit.y * uTime;
    vec3 p = vec3(cos(a), sin(a), 0.0) * aOrbit.x;
    p = turnAbout(p, aPlane.xyz, aPlane.w);
    vec4 world = modelMatrix * vec4(p, 1.0);
    vec4 clip = projectionMatrix * viewMatrix * world;
    gl_Position = clip;
    vec3 rel = world.xyz - uCentre;
    vec3 dir = normalize(world.xyz - cameraPosition);
    // A flare now and then, as a panel turns the sun to the eye.
    float flare = pow(max(0.0, sin(uTime * 0.21 + aOrbit.w)), 60.0) * 5.0;
    vLight = sunlit(rel, uSun) * lifeThrough(dir) * (0.6 + flare);
    gl_PointSize = (2.2 + flare * 1.5) * uPixel;
  }
`;

const SATELLITE_FRAGMENT = /* glsl */ `
  varying float vLight;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0 || vLight < 0.002) discard;
    gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * exp(-r2 * 4.0) * vLight, 1.0);
  }
`;

const METEOR_VERTEX = /* glsl */ `
  attribute vec3 aSlot;    // slot, along the trail (0 head .. 1 tail), side (-1, 1)
  uniform float uTime;
  uniform vec3 uCentre;
  uniform vec3 uUp;        // the place looked at, from the planet's centre (unit)
  uniform float uPixelSize; // world units a pixel spans a unit away
  uniform vec3 uSun;
  varying float vLight;
  varying float vAlong;
  ${AIR_GLSL}
  ${SKY_GLOW_GLSL}
  float hash(float n) { return fract(sin(n * 127.1 + 311.7) * 43758.5453); }
  void main() {
    float slot = aSlot.x;
    float period = ${METEOR_EVERY.toFixed(1)} * (0.6 + 0.8 * hash(slot * 7.0 + 1.0));
    float cycle = floor((uTime + hash(slot) * period) / period);
    float age = mod(uTime + hash(slot) * period, period);
    float life = ${METEOR_LIFE.toFixed(2)} * (0.6 + 0.8 * hash(slot * 3.0 + cycle * 1.7));
    float t = age / life;
    float seed = slot * 17.0 + cycle * 3.1;
    // Where: over the place looked at, within some 40 degrees of its zenith, high in the air.
    vec3 e1 = normalize(cross(uUp, abs(uUp.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
    vec3 e2 = cross(uUp, e1);
    float ang = hash(seed) * 6.2832, off = sqrt(hash(seed + 1.0)) * 0.7;
    vec3 where = normalize(uUp + (e1 * cos(ang) + e2 * sin(ang)) * off);
    float radius = ${PLANET_RADIUS.toFixed(1)} + (${ATMOSPHERE_TOP.toFixed(1)} - ${PLANET_RADIUS.toFixed(1)}) * (0.55 + 0.3 * hash(seed + 2.0));
    vec3 start = uCentre + where * radius;
    // Its way: along the ground, a little down, fast.
    float heading = hash(seed + 3.0) * 6.2832;
    vec3 tangent = normalize(cross(where, vec3(cos(heading), sin(heading), 0.37)));
    vec3 way = normalize(tangent - where * 0.25);
    float path = (${ATMOSPHERE_TOP.toFixed(1)} - ${PLANET_RADIUS.toFixed(1)}) * (0.35 + 0.4 * hash(seed + 4.0));
    vec3 head = start + way * path * clamp(t, 0.0, 1.0);
    float trail = path * 0.45 * clamp(t * 2.0, 0.0, 1.0);
    vec3 p = head - way * trail * aSlot.y;
    // A ribbon a pixel and a half wide, turned to the eye.
    vec3 toEye = normalize(cameraPosition - p);
    vec3 across = normalize(cross(way, toEye));
    float width = 1.6 * uPixelSize * length(cameraPosition - p);
    p += across * aSlot.z * width;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    float alive = step(0.0, t) * step(t, 1.0) * sin(clamp(t, 0.0, 1.0) * 3.1416);
    // Only over the night: by day, from inside the air its light hides them,
    // and from space the sunlit ground under them does.
    float night = 1.0 - smoothstep(-0.12, 0.05, dot(where, uSun));
    vLight = alive * night * lifeThrough(normalize(p - cameraPosition)) * (1.0 - aSlot.y);
    vAlong = aSlot.y;
  }
`;

const METEOR_FRAGMENT = /* glsl */ `
  varying float vLight;
  varying float vAlong;
  void main() {
    if (vLight < 0.002) discard;
    // A white-green head going to an orange trail.
    vec3 colour = mix(vec3(0.85, 1.0, 0.9), vec3(1.0, 0.55, 0.25), vAlong);
    gl_FragColor = vec4(colour * vLight * 2.4, 1.0);
  }
`;

/** The station's lights (its own frame): where, colour, and how they blink (period s, phase, flashes a period, lit share). */
const STATION_LIGHT_VERTEX = /* glsl */ `
  attribute vec3 aColour;
  attribute vec4 aBlink;
  uniform float uTime;
  uniform float uPixel;
  varying vec3 vColour;
  void main() {
    vec4 view = viewMatrix * modelMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * view;
    // A strobe flashes \`aBlink.z\` times a period, each for a share \`aBlink.w\`
    // of it; a running light (\`z\` 0) stays lit.
    float t = fract(uTime / aBlink.x + aBlink.y);
    float on = aBlink.z < 0.5 ? 1.0 : (step(t, aBlink.w) + (aBlink.z > 1.5 ? step(0.18, t) * step(t, 0.18 + aBlink.w) : 0.0));
    vColour = aColour * on;
    // A few pixels whatever the distance: a light, not a surface (an unlit one discarded).
    gl_PointSize = 5.0 * uPixel;
    // Just in front of what it sits on.
    gl_Position.z -= 2.0e-4 * gl_Position.w;
  }
`;

const STATION_LIGHT_FRAGMENT = /* glsl */ `
  varying vec3 vColour;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0 || dot(vColour, vec3(1.0)) < 0.001) discard;
    gl_FragColor = vec4(vColour * (exp(-r2 * 6.0) * 2.6 + exp(-r2 * 1.5) * 0.35), 1.0);
  }
`;

const AURORA_VERTEX = /* glsl */ `
  // Round the oval (0..1); up the curtain (0..1), or across the glow under it
  // (-1..1); the hemisphere (-1, 1) - doubled (-2, 2) for the glow.
  attribute vec3 aAurora;
  uniform float uTime;
  uniform vec3 uSunLocal;  // the sun in the planet's frame
  varying vec3 vCurtain;   // round the oval, up the curtain or across the glow, the glow (1) or a curtain (0)
  varying float vLight;
  ${AIR_GLSL}
  ${SKY_GLOW_GLSL}
  const vec3 POLE = vec3(${(Math.sin(MAGNETIC_TILT) * Math.cos(MAGNETIC_LONGITUDE)).toFixed(6)}, ${(Math.sin(MAGNETIC_TILT) * Math.sin(MAGNETIC_LONGITUDE)).toFixed(6)}, ${Math.cos(MAGNETIC_TILT).toFixed(6)});
  // The foot of the curtain at a turn round the oval (its midnight \`night\`), some colatitude \`shift\` off it.
  vec3 footAt(float phi, vec3 pole, vec3 a, vec3 b, float night, float shift) {
    float colatitude = ${AURORA_COLATITUDE.toFixed(6)} + ${AURORA_SWING.toFixed(6)} * cos(phi - night) + shift
      // The folds: the footprint wanders, slowly, at several scales.
      + 0.020 * sin(phi * 9.0 + uTime * 0.05) + 0.011 * sin(phi * 23.0 - uTime * 0.11 + 2.0) + 0.005 * sin(phi * 61.0 + uTime * 0.23);
    return pole * cos(colatitude) + (a * cos(phi) + b * sin(phi)) * sin(colatitude);
  }
  void main() {
    bool glow = abs(aAurora.z) > 1.5;
    vec3 pole = POLE * sign(aAurora.z);
    vec3 a = normalize(cross(pole, abs(pole.z) < 0.9 ? vec3(0.0, 0.0, 1.0) : vec3(1.0, 0.0, 0.0)));
    vec3 b = cross(pole, a);
    // The oval's midnight: away from the sun round the pole.
    vec3 away = -uSunLocal;
    float night = atan(dot(away, b), dot(away, a));
    float phi = aAurora.x * 6.2831853;
    float air = ${ATMOSPHERE_TOP.toFixed(1)} - ${PLANET_RADIUS.toFixed(1)};
    vec3 foot = footAt(phi, pole, a, b, night, glow ? aAurora.y * ${AURORA_BAND.toFixed(6)} : 0.0);
    vec3 next = footAt(phi + 0.002, pole, a, b, night, 0.0);
    // The curtains stand from their foot to their top; the glow lies a little over the foot.
    float h = ${PLANET_RADIUS.toFixed(1)} + air * (glow ? ${(AURORA_FOOT + 0.04).toFixed(3)} : mix(${AURORA_FOOT.toFixed(3)}, ${AURORA_TOP.toFixed(3)}, aAurora.y));
    vec4 world = modelMatrix * vec4(foot * h, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;
    vec3 along = normalize(mat3(modelMatrix) * (next - foot));
    vec3 up = normalize(mat3(modelMatrix) * foot);
    vec3 view = normalize(world.xyz - cameraPosition);
    // A curtain is brighter seen edge-on (a longer path through the sheet); the
    // glow under it is what the curtains add up to seen from above, faint seen
    // from the side.
    vec3 normal = glow ? up : normalize(cross(along, up));
    float facing = abs(dot(normal, view));
    float shown = glow ? smoothstep(0.15, 0.7, facing) : min(2.0, 0.35 / max(facing, 0.175));
    // On the night side only (Wikipedia: brighter on the dark side; by day the sunlit ground under it outshines it).
    float dark = 1.0 - smoothstep(-0.2, 0.12, dot(foot, uSunLocal));
    vLight = dark * shown * lifeThrough(view);
    vCurtain = vec3(aAurora.x * 2.0 + sign(aAurora.z) * 0.37, aAurora.y, glow ? 1.0 : 0.0);
  }
`;

const AURORA_FRAGMENT = /* glsl */ `
  uniform float uTime;
  varying vec3 vCurtain;
  varying float vLight;
  ${NOISE_GLSL}
  void main() {
    if (vLight < 0.001) discard;
    float u = vCurtain.x, v = vCurtain.y;
    // Arcs, not a whole ring: the oval broken where its slow flux is low.
    float arcs = smoothstep(0.32, 0.62, lifeNoise(vec2(u * 7.0 + uTime * 0.004, 3.1)));
    // A surge travelling round the oval, now and then.
    float surge = 0.55 + 0.45 * smoothstep(0.4, 1.0, sin(u * 18.85 - uTime * 0.07));
    vec3 c;
    if (vCurtain.z > 0.5) {
      // The glow under the curtains: green, softly edged, rays across it.
      float across = 1.0 - v * v;
      float rays = 0.6 + 0.4 * lifeNoise(vec2(u * 420.0 + uTime * 0.9, 0.5));
      c = vec3(0.12, 1.0, 0.38) * across * across * rays * 0.16;
    } else {
      // Rays: light and dark stripes up the curtain, running along it.
      float rays = 0.6 + 0.4 * lifeNoise(vec2(u * 420.0 + uTime * 0.9, v * 1.5)) * (0.6 + 0.4 * lifeNoise(vec2(u * 90.0 - uTime * 0.3, 7.0)));
      // Green from the sharp lower edge up, red above, a pink fringe at the
      // foot; all of it fading out before the top (no edge against the sky).
      float green = smoothstep(0.0, 0.06, v) * exp(-max(0.0, v - 0.06) * 3.0);
      float red = smoothstep(0.3, 0.6, v) * (1.0 - smoothstep(0.7, 1.0, v));
      float pink = smoothstep(0.0, 0.02, v) * (1.0 - smoothstep(0.02, 0.08, v));
      c = (vec3(0.12, 1.0, 0.38) * green * 0.3 + vec3(1.0, 0.1, 0.16) * red * 0.07 + vec3(0.85, 0.2, 0.75) * pink * 0.18) * rays * (1.0 - smoothstep(0.75, 1.0, v));
    }
    gl_FragColor = vec4(c * arcs * surge * vLight, 1.0);
  }
`;

const COMET_GLOW_VERTEX = /* glsl */ `
  attribute vec3 aPart;    // part (0 the coma, 1 the ion tail, 2 the dust tail); along the tail or the quad's x; across or its y
  uniform vec3 uNucleus;
  uniform vec3 uAway;      // from the sun (unit)
  uniform vec3 uBack;      // back along the orbit, square to uAway (unit)
  uniform float uTime;
  uniform float uNear;
  varying vec3 vPart;
  varying vec3 vRay;
  varying float vThrough;
  // How broadside a tail's ribbon is seen (1 across the view, 0 along it).
  varying float vBroad;
  // A tail's offset from its axis and its half-width there (both affine in
  // the ribbon's plane): their ratio is the place across it, exact on each
  // trapezoid (\`COMET_GLOW_FRAGMENT\`).
  varying vec2 vAcross;
  ${AIR_GLSL}
  ${SKY_GLOW_GLSL}
  void main() {
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vec3 forward = -vec3(viewMatrix[0][2], viewMatrix[1][2], viewMatrix[2][2]);
    vec3 p;
    vBroad = 1.0;
    vAcross = vec2(aPart.z, 1.0);
    if (aPart.x < 0.5) {
      // The coma: a quad turned to the eye round the nucleus; from inside the
      // cloud it covers the view just in front of the eye (its light is the
      // column along each pixel's ray, \`COMET_GLOW_FRAGMENT\`).
      float size = ${(COMET_COMA * 4).toFixed(1)};
      float far = distance(cameraPosition, uNucleus);
      if (far < size * 1.3) p = cameraPosition + forward * uNear * 4.0 + (right * aPart.y + up * aPart.z) * uNear * 40.0;
      else p = uNucleus + (right * aPart.y + up * aPart.z) * size;
    } else {
      float t = aPart.y;
      bool ion = aPart.x < 1.5;
      float L = ion ? ${COMET_ION.toFixed(1)} : ${COMET_DUST.toFixed(1)};
      vec3 axis = uNucleus + uAway * L * t;
      vec3 tangent = uAway;
      if (ion) {
        // A kink running out along the ion tail now and then (the solar wind's gusts).
        axis += uBack * L * 0.012 * t * sin(t * 9.0 - uTime * 0.35);
      } else {
        // The dust left behind along the orbit: a curve back from the sun's line.
        axis += uBack * L * 0.35 * t * t;
        tangent = normalize(uAway + uBack * 0.7 * t);
      }
      vec3 toEye = normalize(cameraPosition - axis);
      vec3 across = cross(tangent, toEye);
      // A ribbon turned to the eye has no depth: seen along the tail it
      // would be a fan of edge-on strips. It fades out there (an axial
      // billboard's limit), and the coma's glow is what is seen.
      vBroad = smoothstep(0.3, 0.75, length(across));
      // Seen along its axis the ribbon has no breadth: turned to the screen's right then.
      across = length(across) > 1e-3 ? normalize(across) : right;
      float w = ion ? ${(COMET_COMA * 0.45).toFixed(1)} + L * 0.06 * t : ${(COMET_COMA * 0.8).toFixed(1)} + L * 0.2 * t;
      p = axis + across * aPart.z * w;
      vAcross = vec2(aPart.z * w, w);
    }
    vPart = aPart;
    vRay = p - cameraPosition;
    gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
    vThrough = lifeThrough(normalize(vRay));
  }
`;

const COMET_GLOW_FRAGMENT = /* glsl */ `
  uniform vec3 uNucleus;
  uniform float uTime;
  varying vec3 vPart;
  varying vec3 vRay;
  varying float vThrough;
  varying float vBroad;
  varying vec2 vAcross;
  ${NOISE_GLSL}
  void main() {
    vec3 c;
    if (vPart.x < 0.5) {
      // The column through a cloud whose density falls as 1 / (r^2 + c^2)
      // along this pixel's ray from the eye: (pi/2 + atan(t0 / s)) / s, s the
      // ray's closest approach softened by the core c, t0 how far along it
      // that approach is. Right seen from far off and from inside. Its
      // molecules last a while out of the nucleus (Haser's model: the density
      // Q / (4 pi v r^2) times e^(-r / l), l the scale length): the column
      // cut off as e^(-s / l) past the coma's radius.
      vec3 rd = normalize(vRay);
      vec3 toNucleus = uNucleus - cameraPosition;
      float t0 = dot(toNucleus, rd);
      float miss = length(toNucleus - rd * t0);
      float core = ${(COMET_COMA * 0.08).toFixed(1)};
      float s = sqrt(miss * miss + core * core);
      float column = (1.5707963 + atan(t0 / s)) / s * ${(COMET_COMA * 0.08).toFixed(1)};
      float edge = exp(-miss / ${(COMET_COMA * 0.9).toFixed(1)}) * (1.0 - smoothstep(${(COMET_COMA * 3.4).toFixed(1)}, ${(COMET_COMA * 3.95).toFixed(1)}, miss));
      // Green (C2) in the cloud, white at the false nucleus; the light of a
      // long column saturating (1 - e^-x) rather than growing without end:
      // from inside the cloud a glow round the eye, not a white-out.
      vec3 tint = mix(vec3(0.3, 1.0, 0.55), vec3(1.0, 1.0, 0.95), exp(-miss * miss / (${(COMET_NUCLEUS * 6).toFixed(1)} * ${(COMET_NUCLEUS * 6).toFixed(1)})));
      c = tint * (1.0 - exp(-column * 0.5)) * 0.42 * edge;
    } else if (vPart.x < 1.5) {
      // Across the ribbon from the offset and the half-width, not the place
      // across interpolated: on a trapezoid (the ribbon widening) the two
      // triangles of each step interpolate it differently, and a crease ran
      // diagonally through every step - fine bands over the tail (Reed,
      // "Quadrilateral Interpolation": the uvq division, q the width here).
      float t = vPart.y, a = clamp(vAcross.x / vAcross.y, -1.0, 1.0);
      // Streamers running out along it. (Every pow here takes a base held at
      // or over 0: pow of a negative is undefined in GLSL, and one NaN pixel,
      // spread by the bloom, left the whole frame empty - the page behind.)
      float streamers = 0.5 + 0.5 * lifeNoise(vec2(a * 7.0 + 3.0, t * 5.0 - uTime * 0.12));
      float ion = exp(-a * a * 4.0) * (1.0 - a * a) * streamers * pow(max(0.0, 1.0 - t), 1.4) * smoothstep(0.0, 0.1, t);
      c = vec3(0.25, 0.5, 1.0) * ion * 0.5;
    } else {
      // Across the ribbon from the offset and the half-width, not the place
      // across interpolated: on a trapezoid (the ribbon widening) the two
      // triangles of each step interpolate it differently, and a crease ran
      // diagonally through every step - fine bands over the tail (Reed,
      // "Quadrilateral Interpolation": the uvq division, q the width here).
      float t = vPart.y, a = clamp(vAcross.x / vAcross.y, -1.0, 1.0);
      // Faint striae across the fan; down to nothing at its edges (no rim against the sky).
      float across = (1.0 - a * a) * (1.0 - a * a) * exp(-a * a * 1.2);
      float dust = across * (0.9 + 0.1 * lifeNoise(vec2(a * 12.0, t * 3.0))) * pow(max(0.0, 1.0 - t), 1.1) * smoothstep(0.0, 0.12, t);
      c = vec3(1.0, 0.9, 0.72) * dust * 0.55;
    }
    gl_FragColor = vec4(c * vThrough * vBroad, 1.0);
  }
`;

const DUST_VERTEX = /* glsl */ `
  attribute vec2 aCorner;  // along the streak (0 now .. 1 back over the exposure), across (-1, 1)
  attribute vec4 aSeed;    // place in its box (0..1), its scale
  uniform vec3 uEye;       // the eye in the dust's own frame (\`DustFlow\`)
  uniform mat3 uTurn;      // the planet's frame to three's space
  uniform vec3 uVelocity;  // the eye's motion through the dust, three's space, units a second
  uniform float uBox[${DUST_BOXES.length}];
  uniform float uWeight[${DUST_BOXES.length}];
  uniform vec2 uViewport;  // drawing buffer, pixels
  uniform vec3 uSun;
  uniform vec3 uCentre;
  varying float vLight;
  varying float vAcross;
  ${SHADOW_GLSL}
  void main() {
    int scale = int(aSeed.w + 0.5);
    float box = uBox[scale];
    // The grain's place relative to the eye, wrapped round it in its box.
    vec3 local = mod(aSeed.xyz * box - uEye, box) - 0.5 * box;
    vec3 head = cameraPosition + uTurn * local;
    // Where it was a moment ago relative to the eye: the eye has moved on since.
    vec3 tail = head + uVelocity * ${DUST_EXPOSURE.toFixed(5)};
    vec4 h = viewMatrix * vec4(head, 1.0);
    vec4 tv = viewMatrix * vec4(tail, 1.0);
    // Never behind the eye: a grain there is not drawn (all its corners at one
    // point out of the view), a streak reaching back past it cut short.
    float nearZ = -0.5;
    if (h.z > nearZ) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); vLight = 0.0; vAcross = 0.0; return; }
    if (tv.z > nearZ && h.z < nearZ) tv = mix(h, tv, (nearZ - h.z) / (tv.z - h.z));
    vec4 hc = projectionMatrix * h;
    vec4 tc = projectionMatrix * tv;
    vec2 hs = hc.xy / hc.w * uViewport * 0.5;
    vec2 ts = tc.xy / tc.w * uViewport * 0.5;
    vec2 along = ts - hs;
    float length2 = length(along);
    vec2 dir = length2 > 1e-3 ? along / length2 : vec2(1.0, 0.0);
    vec2 side = vec2(-dir.y, dir.x);
    // A pixel and a little across, rounded at both ends.
    vec4 clip = aCorner.x < 0.5 ? hc : tc;
    vec2 offset = side * aCorner.y * 0.8 + dir * (aCorner.x < 0.5 ? -0.8 : 0.8);
    clip.xy += offset / (uViewport * 0.5) * clip.w;
    gl_Position = clip;
    // Faded towards its box's walls (no grain pops in or out) and close to the eye.
    float d = length(local) / box;
    float fade = (1.0 - smoothstep(0.28, 0.48, d)) * smoothstep(0.004, 0.03, d);
    // Lit by the sun, brighter towards it (dust scatters forward), dark in the planet's shadow.
    vec3 view = normalize(head - cameraPosition);
    float phase = 0.35 + 1.6 * pow(max(0.0, dot(view, uSun)), 6.0);
    float lit = sunlit(head - uCentre, uSun);
    // The same light spread along a longer streak.
    vLight = uWeight[scale] * fade * phase * lit * 0.6 / (1.0 + length2 * 0.08);
    vAcross = aCorner.y;
  }
`;

const DUST_FRAGMENT = /* glsl */ `
  varying float vLight;
  varying float vAcross;
  void main() {
    if (vLight < 0.002) discard;
    gl_FragColor = vec4(vec3(1.0, 0.96, 0.9) * vLight * (1.0 - vAcross * vAcross), 1.0);
  }
`;

export interface SkyLifeFrame {
  camera: Camera;
  motion: Readonly<Matrix4>;
  /** The stars' frame to three's space (`space.ts` sky): the comet goes round in it. */
  sky: Readonly<Matrix3>;
  centre: Vector3;
  sun: Vector3;
  /** The sun as a body (three's space): the comet's tails point away from it. */
  sunBody: Vector3;
  seconds: number;
  pixelRatio: number;
  height: number;
  /** The drawing buffer's size, pixels (the dust's streaks are a pixel and a half across). */
  width: number;
  airUniforms: Record<string, { value: unknown }>;
}

export interface SkyLife {
  readonly group: Group;
  /** The station's centre (three's space) and how far its parts reach, as last placed. */
  readonly station: { readonly centre: Vector3; readonly radius: number };
  /** The comet's nucleus (three's space) and its radius, as last placed. */
  readonly comet: { readonly centre: Vector3; readonly radius: number };
  /**
   * The station's and the comet's own motion at a point (three's space,
   * world units a second) into `out`: full within their neighbourhoods,
   * nothing past them. A ship come up beside one flies on with it
   * (`flight.ts` FlightHost.drift), as a ship rendezvousing matches its orbit.
   */
  driftAt(at: Vector3, out: Vector3): Vector3;
  update(frame: SkyLifeFrame): void;
  dispose(): void;
}

/** The space station: modules along a truss, four solar wings, radiators - one group of meshes - and its lights. */
function buildStation(time: { value: number }, pixel: { value: number }): Group {
  const station = new Group();
  station.name = 'space-station';
  const hull = new MeshStandardMaterial({ color: 0xd9dcd8, metalness: 0.55, roughness: 0.38 });
  const panel = new MeshStandardMaterial({ color: 0x1b2a4a, metalness: 0.35, roughness: 0.3, emissive: 0x050a14 });
  const gold = new MeshStandardMaterial({ color: 0xb8913a, metalness: 0.8, roughness: 0.35 });
  // Not bent round the planet (\`bend.ts\`): it stands in three's space where its orbit puts it, as the rocks do.
  for (const material of [hull, panel, gold]) material.defines = { PLANET_SKIP: '' };
  const s = STATION_SPAN;
  const add = (mesh: Mesh, x: number, y: number, z: number, rx = 0, rz = 0): void => {
    mesh.position.set(x, y, z);
    mesh.rotation.set(rx, 0, rz);
    station.add(mesh);
  };
  // The truss across, the modules along the way it flies.
  add(new Mesh(new BoxGeometry(s, s * 0.03, s * 0.03), hull), 0, 0, 0);
  add(new Mesh(new CylinderGeometry(s * 0.045, s * 0.045, s * 0.5, 16), hull), 0, 0, 0, Math.PI / 2);
  add(new Mesh(new CylinderGeometry(s * 0.04, s * 0.04, s * 0.18, 16), gold), 0, 0, s * 0.3, Math.PI / 2);
  add(new Mesh(new CylinderGeometry(s * 0.035, s * 0.035, s * 0.16, 16), hull), 0, -s * 0.06, -s * 0.12, 0);
  // Four solar wings at the truss's ends.
  for (const x of [-0.42, -0.3, 0.3, 0.42]) {
    for (const y of [-1, 1]) add(new Mesh(new BoxGeometry(s * 0.09, s * 0.003, s * 0.32), panel), x * s, 0, y * s * 0.18);
  }
  // Radiators, white, edge-on to the sun.
  for (const x of [-0.12, 0.12]) add(new Mesh(new BoxGeometry(s * 0.06, s * 0.16, s * 0.002), hull), x * s, s * 0.1, 0);
  // The lights: red to port and green to starboard at the truss's ends, white
  // strobes double-flashing on top of them, a yellow one under the modules,
  // a steady white docking light at the front module and warm windows.
  const lights: [number, number, number, number, number, number, number, number, number, number][] = [
    // x, y, z (in spans), colour, period s, phase, flashes, lit share
    [-0.5, 0, 0, 1, 0.08, 0.06, 1.0, 0.0, 1, 0.5],
    [0.5, 0, 0, 0.08, 1, 0.12, 1.0, 0.5, 1, 0.5],
    [-0.5, 0.025, 0, 1, 1, 1, 1.5, 0.1, 2, 0.05],
    [0.5, 0.025, 0, 1, 1, 1, 1.5, 0.6, 2, 0.05],
    [0, -0.1, -0.12, 1, 0.75, 0.15, 2.0, 0.3, 1, 0.12],
    [0, 0, 0.395, 1, 0.95, 0.8, 1, 0, 0, 1],
    [0.02, 0.045, 0.05, 1, 0.75, 0.45, 1, 0, 0, 1],
    [-0.02, 0.045, -0.08, 1, 0.75, 0.45, 1, 0, 0, 1],
    [0.0, 0.04, 0.3, 1, 0.8, 0.5, 1, 0, 0, 1],
  ];
  const at = new Float32Array(lights.length * 3), colour = new Float32Array(lights.length * 3), blink = new Float32Array(lights.length * 4);
  lights.forEach(([x, y, z, r, g, b, period, phase, flashes, share], i) => {
    at.set([x * s, y * s, z * s], i * 3);
    // The windows a dimmer glow than the running lights and the strobes.
    const k = flashes === 0 && i > 5 ? 0.35 : 1;
    colour.set([r * k, g * k, b * k], i * 3);
    blink.set([period, phase, flashes, share], i * 4);
  });
  const lightGeometry = new BufferGeometry();
  lightGeometry.setAttribute('position', new BufferAttribute(at, 3));
  lightGeometry.setAttribute('aColour', new BufferAttribute(colour, 3));
  lightGeometry.setAttribute('aBlink', new BufferAttribute(blink, 4));
  const lightMaterial = new ShaderMaterial({
    uniforms: { uTime: time, uPixel: pixel },
    vertexShader: STATION_LIGHT_VERTEX,
    fragmentShader: STATION_LIGHT_FRAGMENT,
    transparent: true,
    depthWrite: false,
    ...SKY_ADDITIVE,
  });
  const points = new Points(lightGeometry, lightMaterial);
  points.name = 'space-station-lights';
  points.frustumCulled = false;
  station.add(points);
  station.traverse((o) => { o.userData = { planetSkip: true }; if ((o as Mesh).isMesh) { (o as Mesh).castShadow = false; (o as Mesh).receiveShadow = false; } });
  return station;
}

/**
 * The aurora round both poles: a curtain a pole (round the oval, up the
 * curtain), and under each the glow seen from above (round the oval, across
 * it) - two strips a pole, one geometry.
 */
function auroraGeometry(): BufferGeometry {
  const per = (AURORA_SEGMENTS + 1) * 2;
  const strips = 4;
  const attribute = new Float32Array(per * strips * 3);
  const index: number[] = [];
  for (let strip = 0; strip < strips; strip++) {
    const hemisphere = strip % 2 === 0 ? 1 : -1;
    const glow = strip >= 2;
    for (let i = 0; i <= AURORA_SEGMENTS; i++) {
      for (let v = 0; v < 2; v++) {
        attribute.set([i / AURORA_SEGMENTS, glow ? v * 2 - 1 : v, glow ? hemisphere * 2 : hemisphere], (strip * per + i * 2 + v) * 3);
      }
      if (i < AURORA_SEGMENTS) {
        const a = strip * per + i * 2;
        index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(per * strips * 3), 3));
  geometry.setAttribute('aAurora', new BufferAttribute(attribute, 3));
  geometry.setIndex(index);
  return geometry;
}

/** The comet's glow: the coma's quad, then each tail's ribbon. */
function cometGlowGeometry(): BufferGeometry {
  const part: number[] = [];
  const index: number[] = [];
  for (const [x, y] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) part.push(0, x, y);
  index.push(0, 1, 2, 0, 2, 3);
  for (const kind of [1, 2]) {
    const first = part.length / 3;
    for (let i = 0; i <= COMET_SEGMENTS; i++) for (const side of [-1, 1]) part.push(kind, i / COMET_SEGMENTS, side);
    for (let i = 0; i < COMET_SEGMENTS; i++) {
      const a = first + i * 2;
      index.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(part.length), 3));
  geometry.setAttribute('aPart', new BufferAttribute(new Float32Array(part), 3));
  geometry.setIndex(index);
  return geometry;
}

/** The dust's grains: a streak's four corners, and a place in its box and a scale an instance. */
function dustGeometry(): InstancedBufferGeometry {
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(12), 3));
  geometry.setAttribute('aCorner', new BufferAttribute(new Float32Array([0, -1, 0, 1, 1, 1, 1, -1]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const random = sequence(0xd057);
  const count = DUST_BOXES.length * DUST_PER_BOX;
  const seeds = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) seeds.set([random(), random(), random(), Math.floor(i / DUST_PER_BOX)], i * 4);
  geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
  geometry.instanceCount = count;
  return geometry;
}

export function createSkyLife(): SkyLife {
  const group = new Group();
  group.name = 'space-life';
  group.userData = { planetSkip: true };
  const time = { value: 0 };
  const sun = { value: new Vector3(1, 0, 0) };
  const centre = { value: new Vector3() };
  const pixel = { value: 1 };
  /** The materials that read the air's uniforms, given them at the first frame. */
  const airReaders: ShaderMaterial[] = [];

  // The satellites.
  const random = sequence(0x5a7e);
  const orbit = new Float32Array(SATELLITES * 4), plane = new Float32Array(SATELLITES * 4), positions = new Float32Array(SATELLITES * 3);
  const lowRate = (Math.PI * 2) / SATELLITE_PERIOD;
  for (let i = 0; i < SATELLITES; i++) {
    const r = SATELLITE_LOW + (SATELLITE_HIGH - SATELLITE_LOW) * random() * random();
    orbit[i * 4] = r * PLANET_RADIUS;
    orbit[i * 4 + 1] = lowRate * Math.pow(r / SATELLITE_LOW, -1.5) * (random() < 0.1 ? -1 : 1);
    orbit[i * 4 + 2] = random() * Math.PI * 2;
    orbit[i * 4 + 3] = random() * Math.PI * 2;
    const node = random() * Math.PI * 2;
    plane[i * 4] = Math.cos(node); plane[i * 4 + 1] = Math.sin(node); plane[i * 4 + 2] = 0;
    // Most low and tipped some 50 degrees, some polar, a few equatorial.
    const kind = random();
    plane[i * 4 + 3] = kind < 0.55 ? (45 + random() * 12) * Math.PI / 180 : kind < 0.85 ? (85 + random() * 13) * Math.PI / 180 : random() * 0.2;
  }
  const satGeometry = new BufferGeometry();
  satGeometry.setAttribute('position', new BufferAttribute(positions, 3));
  satGeometry.setAttribute('aOrbit', new BufferAttribute(orbit, 4));
  satGeometry.setAttribute('aPlane', new BufferAttribute(plane, 4));
  const satMaterial = new ShaderMaterial({
    uniforms: { uTime: time, uSun: sun, uCentre: centre, uPixel: pixel },
    vertexShader: SATELLITE_VERTEX,
    fragmentShader: SATELLITE_FRAGMENT,
    transparent: true,
    depthWrite: false,
    ...SKY_ADDITIVE,
  });
  airReaders.push(satMaterial);
  const satellites = new Points(satGeometry, satMaterial);
  satellites.name = 'space-satellites';
  satellites.frustumCulled = false;
  satellites.matrixAutoUpdate = false;
  satellites.userData = { planetSkip: true };
  group.add(satellites);

  // The shooting stars: a ribbon of two triangles a slot.
  const meteorSlots = new Float32Array(METEORS * 6 * 3);
  let w = 0;
  for (let slot = 0; slot < METEORS; slot++) {
    for (const [along, side] of [[0, -1], [0, 1], [1, 1], [0, -1], [1, 1], [1, -1]] as const) {
      meteorSlots[w++] = slot; meteorSlots[w++] = along; meteorSlots[w++] = side;
    }
  }
  const meteorGeometry = new BufferGeometry();
  meteorGeometry.setAttribute('position', new BufferAttribute(new Float32Array(METEORS * 6 * 3), 3));
  meteorGeometry.setAttribute('aSlot', new BufferAttribute(meteorSlots, 3));
  const up = { value: new Vector3(0, 0, 1) };
  const pixelSize = { value: 0.001 };
  const meteorMaterial = new ShaderMaterial({
    uniforms: { uTime: time, uCentre: centre, uUp: up, uPixelSize: pixelSize, uSun: sun },
    vertexShader: METEOR_VERTEX,
    fragmentShader: METEOR_FRAGMENT,
    transparent: true,
    depthWrite: false,
    ...SKY_ADDITIVE,
    side: DoubleSide,
  });
  airReaders.push(meteorMaterial);
  const meteors = new Mesh(meteorGeometry, meteorMaterial);
  meteors.name = 'space-meteors';
  meteors.frustumCulled = false;
  meteors.userData = { planetSkip: true };
  group.add(meteors);

  // The station.
  const station = buildStation(time, pixel);
  station.matrixAutoUpdate = false;
  group.add(station);
  const stationCentre = new Vector3();
  const local = new Matrix4(), turn = new Quaternion(), place = new Vector3(), tilt = new Quaternion(), one = new Vector3(1, 1, 1);
  const xAxis = new Vector3(1, 0, 0), zAxis = new Vector3(0, 0, 1);
  const stationRate = (Math.PI * 2) / STATION_PERIOD;
  const tmp = new Vector3();
  const materials = stationMaterials(station);
  let airShared = false;
  let lastLit = -1;

  // The aurora round both poles.
  const sunLocal = { value: new Vector3(1, 0, 0) };
  const auroraMaterial = new ShaderMaterial({
    uniforms: { uTime: time, uSunLocal: sunLocal },
    vertexShader: AURORA_VERTEX,
    fragmentShader: AURORA_FRAGMENT,
    transparent: true,
    depthWrite: false,
    ...SKY_ADDITIVE,
    side: DoubleSide,
    forceSinglePass: true,
  });
  airReaders.push(auroraMaterial);
  const aurora = new Mesh(auroraGeometry(), auroraMaterial);
  aurora.name = 'space-aurora';
  aurora.frustumCulled = false;
  aurora.matrixAutoUpdate = false;
  aurora.userData = { planetSkip: true };
  group.add(aurora);

  // The comet: its nucleus (one of the asteroids' shapes, darker), its coma and tails.
  const nucleusMaterial = new MeshStandardMaterial({ vertexColors: true, color: 0x6a6660, roughness: 0.96, metalness: 0 });
  nucleusMaterial.defines = { PLANET_SKIP: '' };
  const nucleus = new Mesh(rockGeometry(5, 3), nucleusMaterial);
  nucleus.name = 'space-comet-nucleus';
  nucleus.scale.setScalar(COMET_NUCLEUS);
  nucleus.castShadow = false;
  nucleus.receiveShadow = false;
  nucleus.userData = { planetSkip: true };
  group.add(nucleus);
  const cometUniforms = {
    uNucleus: { value: new Vector3() }, uAway: { value: new Vector3(1, 0, 0) }, uBack: { value: new Vector3(0, 1, 0) },
    uTime: time, uNear: { value: 1 },
  };
  const glowMaterial = new ShaderMaterial({
    uniforms: cometUniforms,
    vertexShader: COMET_GLOW_VERTEX,
    fragmentShader: COMET_GLOW_FRAGMENT,
    transparent: true,
    depthWrite: false,
    ...SKY_ADDITIVE,
    side: DoubleSide,
    forceSinglePass: true,
  });
  airReaders.push(glowMaterial);
  const glow = new Mesh(cometGlowGeometry(), glowMaterial);
  glow.name = 'space-comet';
  glow.frustumCulled = false;
  glow.userData = { planetSkip: true };
  group.add(glow);
  const cometCentre = new Vector3();
  const cometVelocity = new Vector3();
  const cometOrbit = new Vector3();
  const cometMotion = new Vector3();
  const spinAxis = new Vector3(0.3, 1, 0.2).normalize();
  const spinStep = new Quaternion();

  // The space dust, while flying.
  const dustUniforms = {
    uEye: { value: new Vector3() }, uTurn: { value: new Matrix3() }, uVelocity: { value: new Vector3() },
    uBox: { value: [...DUST_BOXES] }, uWeight: { value: DUST_BOXES.map(() => 0) },
    uViewport: { value: [1, 1] as [number, number] }, uSun: sun, uCentre: centre,
  };
  const dustMaterial = new ShaderMaterial({
    uniforms: dustUniforms,
    vertexShader: DUST_VERTEX,
    fragmentShader: DUST_FRAGMENT,
    transparent: true,
    depthWrite: false,
    ...SKY_ADDITIVE,
    side: DoubleSide,
    forceSinglePass: true,
  });
  const dust = new Mesh(dustGeometry(), dustMaterial);
  dust.name = 'space-dust';
  dust.frustumCulled = false;
  dust.visible = false;
  dust.userData = { planetSkip: true };
  group.add(dust);
  /** The eye in the dust's own frame: the flight's motion through it summed (the planet's frame's directions). */
  const eyeFlow = dustUniforms.uEye.value;
  const turnOnly = new Matrix3(), turnBack = new Matrix3(), flowStep = new Vector3();
  const weights = DUST_BOXES.map(() => 0);
  const viewport = dustUniforms.uViewport.value;

  // The speed streaks (`STREAK_FRAGMENT`).
  const streakUniforms = {
    uFocus: { value: new Vector2() }, uAspect: { value: 1 }, uRush: { value: 0 }, uWarp: { value: 0 }, uPush: { value: 0 },
    uTime: time, uDir: { value: 1 },
  };
  const streakMaterial = new ShaderMaterial({
    uniforms: streakUniforms,
    vertexShader: STREAK_VERTEX,
    fragmentShader: STREAK_FRAGMENT,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    ...SKY_ADDITIVE,
  });
  const streaks = new Mesh(new PlaneGeometry(2, 2), streakMaterial);
  streaks.name = 'space-streaks';
  streaks.frustumCulled = false;
  streaks.visible = false;
  streaks.renderOrder = 1e9 + 3;
  streaks.userData = { planetSkip: true };
  group.add(streaks);
  const flyDir = new Vector3(), lookDir = new Vector3(), focusAt = new Vector3();

  const stationVelocity = new Vector3();
  return {
    group,
    station: { centre: stationCentre, radius: STATION_SPAN * 0.55 },
    comet: { centre: cometCentre, radius: COMET_NUCLEUS },
    driftAt(at, out) {
      const d = at.distanceTo(stationCentre);
      const fade = 1 - smooth(STATION_NEAR, STATION_FAR, d);
      out.copy(stationVelocity).multiplyScalar(fade);
      const c = at.distanceTo(cometCentre);
      return out.addScaledVector(cometVelocity, 1 - smooth(COMET_NEAR, COMET_FAR, c));
    },
    update(frame) {
      const seconds = Math.min(0.1, Math.max(0, frame.seconds));
      time.value += seconds;
      // The air's uniforms shared once (its objects, updated in place by \`air.ts\`).
      if (!airShared) {
        airShared = true;
        for (const [name, u] of Object.entries(frame.airUniforms)) for (const m of airReaders) m.uniforms[name] = u;
      }
      satellites.matrix.copy(frame.motion);
      satellites.matrixWorldNeedsUpdate = true;
      aurora.matrix.copy(frame.motion);
      aurora.matrixWorldNeedsUpdate = true;
      sun.value.copy(frame.sun);
      centre.value.copy(frame.centre);
      pixel.value = frame.pixelRatio;
      // The sun in the planet's own frame, for the aurora's night side.
      turnOnly.setFromMatrix4(frame.motion);
      turnBack.copy(turnOnly).transpose();
      sunLocal.value.copy(frame.sun).applyMatrix3(turnBack).normalize();
      // The meteors over the place the camera is above.
      up.value.subVectors(frame.camera.position, frame.centre).normalize();
      const fov = (frame.camera as Camera & { fov?: number }).fov ?? 45;
      pixelSize.value = (2 * Math.tan((fov * Math.PI) / 360)) / Math.max(1, frame.height * frame.pixelRatio);
      // The station on its orbit, its truss across the way it goes, facing the planet.
      const a = stationRate * time.value;
      tilt.setFromAxisAngle(xAxis, STATION_INCLINATION);
      place.set(Math.cos(a), Math.sin(a), 0).applyQuaternion(tilt).multiplyScalar(STATION_RADIUS * PLANET_RADIUS);
      turn.setFromAxisAngle(zAxis, a).premultiply(tilt);
      local.compose(place, turn, one);
      station.matrix.multiplyMatrices(frame.motion, local);
      // Its velocity: the orbit's tangent, three's space.
      stationVelocity.set(-Math.sin(a), Math.cos(a), 0).applyQuaternion(tilt)
        .multiplyScalar(STATION_RADIUS * PLANET_RADIUS * stationRate).applyMatrix3(turnOnly);
      station.matrixWorldNeedsUpdate = true;
      stationCentre.setFromMatrixPosition(station.matrix);
      // Dark in the planet's shadow (the scene's sun lights everything else).
      tmp.subVectors(stationCentre, frame.centre);
      const along = tmp.dot(frame.sun);
      const off = tmp.addScaledVector(frame.sun, -along).length();
      const lit = along > 0 || off > PLANET_RADIUS ? 1 : 0.06;
      if (lit !== lastLit) {
        lastLit = lit;
        for (const m of materials) m.color.copy(m.userData['base'] as Color).multiplyScalar(lit);
      }

      // The comet on its orbit, in the stars' frame; its tails away from the sun.
      cometAt(time.value, cometOrbit, cometMotion);
      cometCentre.copy(cometOrbit).applyMatrix3(frame.sky).add(frame.centre);
      cometVelocity.copy(cometMotion).applyMatrix3(frame.sky);
      nucleus.position.copy(cometCentre);
      nucleus.quaternion.multiply(spinStep.setFromAxisAngle(spinAxis, seconds * 0.02));
      const away = cometUniforms.uAway.value.subVectors(cometCentre, frame.sunBody).normalize();
      const back = cometUniforms.uBack.value.copy(cometVelocity).addScaledVector(away, -cometVelocity.dot(away)).negate();
      if (back.lengthSq() < 1e-8) back.set(0, 1, 0).addScaledVector(away, -away.y);
      back.normalize();
      cometUniforms.uNucleus.value.copy(cometCentre);
      cometUniforms.uNear.value = (frame.camera as Camera & { near?: number }).near ?? 1;
      // Seen from space after the air's shell (it is not behind the air), from inside the air through it.
      const inside = (frame.airUniforms['uAirInside']?.value as number | undefined) === 1;
      glow.renderOrder = aurora.renderOrder = dust.renderOrder = inside ? 0 : 1e9 + 1;

      // The space dust, while flying: the flight's own motion through it
      // (`flightNow`: at rest in the frame the flight flies in - the
      // planet's near it, the stars' far out, the swarm's among the rocks).
      dust.visible = flightNow.active;
      if (flightNow.active) {
        flowStep.copy(flightNow.velocity).applyMatrix3(turnBack);
        eyeFlow.addScaledVector(flowStep, seconds);
        // Out in space whole; faded out in the lower air, where the ground gives the speed.
        const height = (frame.camera.position.distanceTo(frame.centre) - PLANET_RADIUS) / (ATMOSPHERE_TOP - PLANET_RADIUS);
        const space = smooth(0.45, 0.95, height);
        dustWeights(flightNow.velocity.length(), weights);
        for (let i = 0; i < weights.length; i++) dustUniforms.uWeight.value[i] = weights[i]! * space;
        dustUniforms.uVelocity.value.copy(flightNow.velocity);
      }
      // The speed streaks: towards where the ship flies, as fast as it goes.
      const feel = flightNow.rush * flightNow.rush + flightNow.warp + flightNow.push;
      streaks.visible = flightNow.active && feel > 0.004;
      if (streaks.visible) {
        const v = flightNow.velocity.length();
        frame.camera.getWorldDirection(lookDir);
        if (v > 1e-6) flyDir.copy(flightNow.velocity).divideScalar(v); else flyDir.copy(lookDir);
        const ahead = flyDir.dot(lookDir);
        // Flying backwards: the point behind, the lines running in.
        streakUniforms.uDir.value = ahead >= 0 ? 1 : -1;
        if (ahead < 0) flyDir.negate();
        focusAt.copy(frame.camera.position).add(flyDir).project(frame.camera);
        // Sideways the point is far off the screen: the lines all but parallel.
        streakUniforms.uFocus.value.set(Math.max(-3, Math.min(3, focusAt.x)), Math.max(-3, Math.min(3, focusAt.y)));
        streakUniforms.uAspect.value = frame.width / Math.max(1, frame.height);
        streakUniforms.uRush.value = flightNow.rush;
        streakUniforms.uWarp.value = flightNow.warp;
        streakUniforms.uPush.value = flightNow.push;
      }
      dustUniforms.uTurn.value.copy(turnOnly);
      viewport[0] = frame.width * frame.pixelRatio;
      viewport[1] = frame.height * frame.pixelRatio;
    },
    dispose() {
      satGeometry.dispose(); satMaterial.dispose();
      streaks.geometry.dispose(); streakMaterial.dispose();
      meteorGeometry.dispose(); meteorMaterial.dispose();
      aurora.geometry.dispose(); auroraMaterial.dispose();
      nucleus.geometry.dispose(); nucleusMaterial.dispose();
      glow.geometry.dispose(); glowMaterial.dispose();
      dust.geometry.dispose(); dustMaterial.dispose();
      station.traverse((o) => {
        const mesh = o as Mesh;
        if (mesh.isMesh || (o as Points).isPoints) { mesh.geometry.dispose(); (mesh.material as MeshStandardMaterial).dispose(); }
      });
    },
  };
}

/** The station's materials, each with its own colour kept (`base`) so the shadow can dim it. */
const stationMaterialCache = new WeakMap<Group, MeshStandardMaterial[]>();
function stationMaterials(station: Group): MeshStandardMaterial[] {
  let list = stationMaterialCache.get(station);
  if (!list) {
    const set = new Set<MeshStandardMaterial>();
    station.traverse((o) => { const mesh = o as Mesh; if (mesh.isMesh) set.add(mesh.material as MeshStandardMaterial); });
    list = [...set];
    for (const m of list) m.userData['base'] = m.color.clone();
    stationMaterialCache.set(station, list);
  }
  return list;
}
