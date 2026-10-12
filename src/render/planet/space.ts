import { compileAhead } from '../uploads';
import { createAsteroids, type Asteroids } from './asteroids';
import { createSkyLife, type SkyLife, type SkyLifeFrame } from './skyLife';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { Rng } from '@core/rng';
import {
  BackSide, BufferGeometry, Color, CustomBlending, DoubleSide, Float32BufferAttribute, FrontSide, HalfFloatType,
  LinearFilter, Matrix3, Matrix4, Mesh, OneFactor, PlaneGeometry, Points, RepeatWrapping, ShaderMaterial,
  SphereGeometry, SrcAlphaFactor, Vector3, WebGLRenderTarget, ZeroFactor, type Camera, type Scene, type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { AIR_GLSL, ATMOSPHERE_TOP, createAir, type Air, SKY_ADDITIVE, SURFACE_AIR } from './air';
import { planetDrawnSphere } from './bend';
export { ATMOSPHERE_TOP } from './air';

/**
 * THE SPACE ROUND THE PLANET: the stars and the Milky Way, the sun, the moon
 * and the air. Drawn in the world's scene but never part of the world: none
 * of it is bent onto the planet (`bend.ts` - these shaders do not include its
 * chunks), none of it writes the world's depth, and all of it sits at the far
 * end of the depth range, so it shows only where no ground, road or building
 * stands in front of it (the sky dome's own trick, `environment.ts`).
 *
 * - The air: single scattering, Rayleigh and Mie, marched along each pixel's
 *   ray through a shell round the planet (Nishita et al. 1993; Sean O'Neil,
 *   "Accurate Atmospheric Scattering", GPU Gems 2 ch. 16; the coefficients
 *   and scale heights of wwwtyro/glsl-atmosphere). The Earth's are scaled by
 *   the ratio of the shells' thicknesses, so the optical depth - and so the
 *   colours of the sky, the limb and the dusk - are the Earth's. Blended as
 *   `in-scattered + behind * transmittance`: the ground is seen through it.
 * - The stars: points, by magnitude (counts tripling a magnitude) and by
 *   colour temperature (Tanner Helland's black-body fit), crowded towards the
 *   galactic plane; the Milky Way's glow baked once into a texture. They turn
 *   with the sun round the planet's axis, as the sky turns.
 * - The moon: tidally locked, lit by the sun (its phases from the angle
 *   between them), its craters a cellular field of bowls with raised rims
 *   (simple craters: depth about a fifth of the diameter, NASA), shaded by
 *   bump mapping from screen derivatives (three's `perturbNormalArb`, after
 *   Mikkelsen 2010).
 * - The sun: from space a white disc and its glow, bright past the bloom's
 *   threshold; from the ground the sky dome draws it.
 */

/** The moon: radius and distance from the planet's centre. */
const MOON_RADIUS = PLANET_RADIUS * 0.27;
const MOON_DISTANCE = PLANET_RADIUS * 16;
/**
 * The sun as a body one can fly to (\`flight.ts\`): its distance from the
 * planet's centre, and its radius - the angle its disc is drawn at from the
 * planet (0.0054 rad, about the real sun's from the Earth).
 */
export const SUN_DISTANCE = PLANET_RADIUS * 60;
const SUN_ANGLE = 0.16 * 0.034;
export const SUN_RADIUS = SUN_DISTANCE * Math.tan(SUN_ANGLE);
/** One turn of the sun's face on its axis, real seconds (the sun's own is some 27 days): its spots seen to move from close by. */
const SUN_SPIN = 1800;
/** A synodic month, in days of the game. */
const LUNAR_MONTH = 29.53;
/** The moon's orbit's tilt to the sun's path, radians. */
const MOON_TILT = (5.1 * Math.PI) / 180;
const STAR_COUNT = 9000;
/** The full moon's light on the air as a share of the sun's: far above the true 1/400 000, so a moonlit night has a sky, deep blue. */
const MOONLIGHT = 0.012;
/** Just inside the far plane: what is drawn there shows only where nothing stands in front. */
const FAR_GLSL = /* glsl */ `
  void atFar(inout vec4 clip, float k) { clip.z = clip.w * (1.0 - k * 1.0e-6); }
`;

/**
 * The shell is drawn by its far face at the far end of the depth range, or -
 * the eye out of the air and clear of it (`uFront`) - by its near face at its
 * true depth, depth tested: a moon, a rock or the station in front of the
 * planet then hides the air behind it. Drawn by the far face, untested, the
 * planet's blue ring showed through the moon's ground from 11 m above it.
 * Both faces are one program (`DoubleSide`, the face kept by
 * `gl_FrontFacing`): switching the material's side builds another.
 */
const ATMOSPHERE_VERTEX = /* glsl */ `
  uniform float uFront;
  varying vec3 vWorld;
  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    gl_Position = projectionMatrix * viewMatrix * world;
    if (uFront > 0.5) {
      // At its own depth, held inside the far plane, and a vertex nearer than
      // the near plane held on it (never clipped there: no hole under the eye).
      if (gl_Position.w > 0.0) gl_Position.z = clamp(gl_Position.z, -gl_Position.w * (1.0 - 1.0e-6), gl_Position.w * (1.0 - 4.0e-6));
    } else {
      // At the far end of the depth range, never cut by it: from inside the air
      // (depth tested) it shows only where nothing stands in front - the sky -
      // and over the moon, which writes its depth just behind it.
      gl_Position.z = gl_Position.w * (1.0 - 4.0e-6);
    }
  }
`;

const ATMOSPHERE_FRAGMENT = /* glsl */ `
  uniform float uFront;
  varying vec3 vWorld;
  ${AIR_GLSL}
  void main() {
    // The face this frame draws: the near one (front facing seen from outside) or the far one.
    if ((uFront > 0.5) != gl_FrontFacing) discard;
    vec3 rd = normalize(vWorld - cameraPosition);
    // Inside the air the sky round the eye (the sky-view LUT; the ground's
    // own air is the post pass's, by its depth); from space the march.
    if (uAirInside > 0.5) { gl_FragColor = airSky(cameraPosition, rd); return; }
    vec4 air = airRay(cameraPosition, rd, 1e9);
    // The ground's share of the air (\`SURFACE_AIR\`): rays that reach the
    // ground take it, those that pass over the limb the whole air, eased
    // between by how close to the ground the ray passes.
    vec3 ro = cameraPosition - uAirCentre;
    float pass = length(cross(ro, rd));
    float k = mix(${SURFACE_AIR.toFixed(3)}, 1.0, smoothstep(AIR_R * 0.9, AIR_R * 1.002, pass));
    gl_FragColor = vec4(air.rgb * k, mix(1.0, air.a, k));
  }
`;

/**
 * How much of the stars and the Milky Way shows through the sky's own light
 * where they are: none against the day's blue, all of them in a dark sky, the
 * first ones away from the sun at dusk (the sky-view LUT, \`air.ts\`). The
 * air in front still dims them (the shell, drawn over them).
 */
const SKY_GLOW_GLSL = /* glsl */ `
  float starsThrough(vec3 dir) {
    if (uAirInside < 0.5) return 1.0;
    vec3 sky = airSky(cameraPosition, dir).rgb;
    return 1.0 - smoothstep(0.004, 0.08, dot(sky, vec3(0.2126, 0.7152, 0.0722)));
  }
`;

const STARS_VERTEX = /* glsl */ `
  attribute vec3 tint;
  attribute float size;
  uniform mat3 uSky;
  uniform float uPixel;
  varying vec3 vTint;
  ${FAR_GLSL}
  ${AIR_GLSL}
  ${SKY_GLOW_GLSL}
  void main() {
    vec3 dir = uSky * position;
    vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + dir * 1000.0, 1.0);
    atFar(clip, 1.0);
    gl_Position = clip;
    gl_PointSize = size * uPixel;
    vTint = tint * starsThrough(dir);
  }
`;

const STARS_FRAGMENT = /* glsl */ `
  uniform float uShow;
  varying vec3 vTint;
  void main() {
    vec2 c = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(c, c);
    if (r2 > 1.0) discard;
    float core = exp(-r2 * 5.0);
    gl_FragColor = vec4(vTint * core * uShow, 1.0);
  }
`;

const GALAXY_BAKE = /* glsl */ `
  varying vec2 vUv;
  uniform vec3 uPole;
  uniform vec3 uCore;
  const float PI = 3.14159265;
  float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * noise(p); p *= 2.07; a *= 0.5; } return s; }
  void main() {
    float lon = (vUv.x - 0.5) * 2.0 * PI, lat = (vUv.y - 0.5) * PI;
    vec3 d = vec3(cos(lat) * cos(lon), cos(lat) * sin(lon), sin(lat));
    float b = asin(clamp(dot(d, uPole), -1.0, 1.0));
    float toCore = acos(clamp(dot(d, uCore), -1.0, 1.0));
    float bw = b / (0.09 + 0.08 * exp(-toCore * 1.6));
    float band = exp(-bw * bw);
    float clouds = fbm(d * 4.0) * 0.7 + fbm(d * 13.0) * 0.45;
    float dust = smoothstep(0.42, 0.68, fbm(d * 7.0 + 3.1)) * exp(-(b / 0.045) * (b / 0.045));
    float glow = band * pow(clouds, 1.6) * (1.0 - 0.8 * dust) * (1.0 + 2.6 * exp(-toCore * 2.2));
    vec3 tint = mix(vec3(0.7, 0.78, 1.0), vec3(1.0, 0.86, 0.7), exp(-toCore * 2.4));
    // Linear light, kept low: the display's curve lifts the dark a long way
    // (a 0.005 grain showed as blotches over the whole sky; at 0.045 the band
    // read as a brown smoke across the screen).
    gl_FragColor = vec4(tint * glow * 0.022, 1.0);
  }
`;

const GALAXY_VERTEX = /* glsl */ `
  uniform mat3 uSky;
  varying vec3 vDir;
  varying float vThrough;
  ${FAR_GLSL}
  ${AIR_GLSL}
  ${SKY_GLOW_GLSL}
  void main() {
    vDir = position;
    vThrough = starsThrough(normalize(uSky * position));
    vec4 clip = projectionMatrix * viewMatrix * vec4(cameraPosition + (uSky * position) * 1000.0, 1.0);
    atFar(clip, 1.0);
    gl_Position = clip;
  }
`;

const GALAXY_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uShow;
  varying vec3 vDir;
  varying float vThrough;
  const float PI = 3.14159265;
  void main() {
    vec3 d = normalize(vDir);
    vec2 uv = vec2(atan(d.y, d.x) / (2.0 * PI) + 0.5, asin(clamp(d.z, -1.0, 1.0)) / PI + 0.5);
    gl_FragColor = vec4(texture2D(uMap, uv).rgb * uShow * vThrough, 1.0);
  }
`;

const SUN_VERTEX = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uSunView;
  uniform float uSize;
  varying vec2 vUv;
  varying vec3 vTint;
  // The view's right and up (the quad's own axes) and the way from the sun to the eye: the disc's points back to its sphere.
  varying vec3 vRight;
  varying vec3 vUpward;
  varying vec3 vFacing;
  ${FAR_GLSL}
  ${AIR_GLSL}
  void main() {
    vUv = position.xy;
    vRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vUpward = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
    vFacing = -uSunView;
    // Its colour through the air towards it (the transmittance LUT, from
    // where its ray enters the air when the eye is above it): white in
    // space, orange and red low over the horizon. The shell over it takes
    // the mean of that light away; this keeps its hue. From inside the air,
    // over the ground drawn under the eye, as the sky round it is (\`air.ts\`).
    vec3 p = cameraPosition - uAirCentre;
    float r = length(p);
    bool inAir = r <= AIR_TOP;
    vTint = vec3(1.0);
    vec2 top = airSphere(p, uSun, AIR_TOP);
    bool through = inAir || (top.x < top.y && top.x > 0.0);
    if (!inAir && through) { p += uSun * top.x; r = length(p); }
    if (through) {
      vec3 T;
      if (inAir) {
        vec3 pd = cameraPosition - uAirDrawnCentre;
        float rd = max(length(pd), uAirDrawnR + 0.5);
        T = airSunTransmittanceD(rd, dot(uSun, normalize(pd)));
      } else T = airSunTransmittance(r, dot(uSun, p / r));
      vTint = clamp(T / max(dot(T, vec3(1.0 / 3.0)), 1e-3), 0.0, 3.0);
    }
    // Where the sun's body is seen from the eye (\`uSunView\`), as big as it is from there (\`uSize\`).
    vec4 view = viewMatrix * vec4(cameraPosition + uSunView * 1000.0, 1.0);
    view.xy += position.xy * uSize * 1000.0;
    vec4 clip = projectionMatrix * view;
    atFar(clip, 1.0);
    gl_Position = clip;
  }
`;

const SUN_FRAGMENT = /* glsl */ `
  uniform float uShow;
  uniform float uDisc;
  uniform float uSize;
  uniform float uTime;
  // Three's space into the sun's own turning frame (its axis z): its surface turns with it.
  uniform mat3 uSunTurn;
  varying vec2 vUv;
  varying vec3 vTint;
  varying vec3 vRight;
  varying vec3 vUpward;
  varying vec3 vFacing;
  vec3 sunHash3(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float sunNoise3(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(sunHash3(i).x, sunHash3(i + vec3(1, 0, 0)).x, f.x), mix(sunHash3(i + vec3(0, 1, 0)).x, sunHash3(i + vec3(1, 1, 0)).x, f.x), f.y),
               mix(mix(sunHash3(i + vec3(0, 0, 1)).x, sunHash3(i + vec3(1, 0, 1)).x, f.x), mix(sunHash3(i + vec3(0, 1, 1)).x, sunHash3(i + vec3(1, 1, 1)).x, f.x), f.y), f.z);
  }
  // Granulation: convection cells, bright centres and dark lanes between -
  // a cellular (Worley) field on the sun's sphere, the nearest of a point per
  // cell. Each point wanders on its own (a sine of the time, its own phase
  // and rate, held inside its cell), so the cells boil: a granule lasts some
  // 8-20 minutes on the sun, a few tens of seconds here, to be seen.
  float sunCells(vec3 p, float t) {
    vec3 i = floor(p), f = fract(p);
    float best = 8.0;
    for (int k = 0; k < 27; k++) {
      vec3 o = vec3(float(k - (k / 3) * 3 - 1), float((k / 3) - (k / 9) * 3 - 1), float(k / 9 - 1));
      vec3 h = sunHash3(i + o);
      h = 0.5 + 0.42 * sin(t * (0.08 + 0.07 * h.zxy) + 6.2831 * h);
      vec3 q = o + h - f;
      best = min(best, dot(q, q));
    }
    return sqrt(best);
  }
  void main() {
    float r = length(vUv);
    // The quad's uv times \`uSize\` is the angle from the sun's centre
    // (radians, near enough): the disc is \`uDisc\` of it, 0.0054 rad as the
    // sun is seen from the planet, as big as it is from wherever the free
    // camera flew (\`flight.ts\`). The glare is the eye's, not the sun's: it
    // reaches the same angle past the limb however big the disc is (scaled
    // with the disc, it covered the whole view near the sun). Near, the eye
    // adapts as a camera's exposure would - the disc no longer 40 times
    // white - and its face shows the limb darkening and the granulation
    // (Eddington's law, I/I0 = 0.4 + 0.6 mu).
    float near = smoothstep(0.16, 1.2, uSize);
    float g = r / uDisc;
    float beyond = max(r - uDisc, 0.0) * uSize + 0.0054;
    float disc = 1.0 - smoothstep(0.92, 1.0, g);
    float mu = sqrt(max(0.0, 1.0 - min(g, 1.0) * min(g, 1.0)));
    vec2 q = vUv / uDisc;
    // The point of the sphere this pixel sees, in the sun's own frame (it turns).
    vec3 n = uSunTurn * normalize(vRight * q.x + vUpward * q.y + vFacing * mu);
    float grain = 1.0, spots = 1.0;
    if (near > 0.0 && g < 1.0) {
      // Granulation: a fine mottling of bright cells in thin darker lanes, a
      // fifth darker at most (the granules' contrast is some 15-20 per cent;
      // at 0.75 they were pebbles). Two sizes, each faded out before a cell is
      // under two pixels; over them the supergranulation's faint network.
      float px = length(fwidth(n * 60.0));
      float fine = 1.0 - smoothstep(0.25, 0.6, px);
      float fine2 = 1.0 - smoothstep(0.25, 0.6, px * 3.0);
      float lanes = smoothstep(0.45, 0.85, sunCells(n * 60.0, uTime * 2.0)) * fine;
      if (fine2 > 0.0) lanes = mix(lanes, max(lanes, smoothstep(0.45, 0.85, sunCells(n * 180.0, uTime * 3.0))), 0.6 * fine2);
      grain = (1.0 - 0.2 * lanes) * (0.96 + 0.04 * (1.0 - smoothstep(0.3, 0.6, sunCells(n * 8.0, uTime * 0.2))));
      // Sunspot groups in the belts either side of the equator (some 5-33
      // degrees), a few round the sun: each a pair along the rotation, the
      // leader nearer the equator and the tilt growing with the latitude
      // (Joy's law); each spot a dark umbra some 0.4 of its radius (the
      // penumbra 5-6 times the umbra's area) in a penumbra of radial
      // filaments, its edge ragged. Round them the faculae: bright patches
      // that stand out towards the limb (their contrast grows from the centre
      // out), not at the centre.
      vec3 sq = n * 5.0;
      vec3 sid = floor(sq);
      float penumbra = 0.0, umbra = 0.0, faculae = 0.0;
      for (int k = 0; k < 27; k++) {
        vec3 cell = sid + vec3(float(k - (k / 3) * 3 - 1), float((k / 3) - (k / 9) * 3 - 1), float(k / 9 - 1));
        vec3 hs = sunHash3(cell + 41.0);
        if (hs.x > 0.03) continue;
        vec3 cn = normalize(cell + 0.25 + 0.5 * sunHash3(cell + 7.0));
        if (abs(cn.z) < 0.09 || abs(cn.z) > 0.55) continue;
        vec3 east = normalize(cross(vec3(0.0, 0.0, 1.0), cn));
        vec3 north = cross(cn, east);
        float tilt = 0.5 * cn.z;
        vec3 along = east * cos(tilt) - north * sign(cn.z) * sin(tilt);
        float sep = 0.08 + 0.07 * hs.y;
        faculae = max(faculae, (1.0 - smoothstep(0.1, 0.32, length(n - cn))) * smoothstep(0.45, 0.75, sunNoise3(n * 18.0 + cell)));
        // The leader, the follower, and small spots (pores) strung between.
        for (int s = 0; s < 5; s++) {
          vec3 hp = sunHash3(cell * 1.7 + float(s) * 5.1);
          float off = s == 0 ? sep : s == 1 ? -sep : mix(-0.8, 0.6, hp.x) * sep;
          vec3 at = normalize(cn + along * off + cross(cn, along) * (hp.y - 0.5) * (s < 2 ? 0.02 : 0.06));
          float rad = (s == 0 ? 0.05 : s == 1 ? 0.034 : 0.01 + 0.012 * hp.z) * (0.7 + 0.6 * hs.z);
          vec3 d3 = n - at;
          float d = length(d3) / rad;
          if (d > 1.4) continue;
          float fil = sunNoise3(normalize(d3 + 1e-6) * 9.0 + cell * 3.0);
          float edge = 1.0 + 0.18 * (fil - 0.5);
          penumbra = max(penumbra, (1.0 - smoothstep(0.82 * edge, edge, d)) * (0.8 + 0.4 * sunNoise3(normalize(d3 + 1e-6) * 30.0 + cell)));
          umbra = max(umbra, 1.0 - smoothstep(0.34, 0.44, d * (1.0 + 0.1 * (fil - 0.5))));
        }
      }
      // The umbra a fifth as bright (some 4 000 K against 5 800), the penumbra three quarters.
      spots = (1.0 - 0.28 * min(penumbra, 1.0)) * (1.0 - 0.72 * umbra);
      grain *= 1.0 + faculae * 0.35 * (1.0 - mu) * (1.0 - penumbra);
    }
    // Near, its photosphere's colour: yellow-white at the centre, deeper
    // orange and darker towards the limb (the light from higher, cooler gas).
    // Limb darkening at 550 nm, I/I0 = 0.3 + 0.93 mu - 0.23 mu^2 (Limb
    // darkening), the edge a third of the centre; the colour warmer there.
    // A cream white (1, 0.95, 0.86) read as a beige plate: the warm yellow
    // of a white-light photograph.
    float limbLaw = 0.3 + 0.93 * mu - 0.23 * mu * mu;
    vec3 photosphere = mix(vec3(1.0, 0.5, 0.17), vec3(1.0, 0.8, 0.48), pow(max(mu, 0.0), 0.6)) * limbLaw * grain * spots * 1.05;
    vec3 face = mix(vec3(1.0, 0.96, 0.9), photosphere, near);
    // Near, the glare and the corona start no brighter than the darkened limb
    // (at 0.3 of near, and the corona at 0.55, they drew a white ring three
    // times the limb's light round the disc - an outline).
    float glow = (exp(-beyond * 75.0) * 1.6 + exp(-beyond * 28.0) * 0.22) * mix(1.0, 0.1, near);
    // A faint six-point star of the eye's lashes over the glare.
    float a = atan(vUv.y, vUv.x);
    float rays = pow(abs(cos(a * 3.0)), 40.0) * exp(-beyond * 37.5) * 0.5 * mix(1.0, 0.15, near) * (1.0 - disc * near);
    // Down to nothing before the quad's edge: any step there, with the bloom
    // over it, drew the square the glow is painted on.
    float window = 1.0 - smoothstep(0.55, 0.98, r);
    // The corona near: the pearl-white K corona falling off steeply past the
    // limb, in streamers (helmets over the belts, plumes at the poles) - drawn
    // softly, as a long exposure shows it.
    float corona = 0.0;
    if (near > 0.0 && g > 0.99) {
      vec3 limbDir = uSunTurn * normalize(vRight * q.x + vUpward * q.y);
      float streamers = 0.55 + 0.45 * sunNoise3(limbDir * 3.0 + vec3(0.0, 0.0, uTime * 0.002));
      corona = pow(max(g, 1.0), -3.2) * streamers * 0.25 * near * (1.0 - smoothstep(2.4, 4.0, g));
    }
    vec3 c = vTint * (face * disc * mix(40.0, 0.95, near) + vec3(1.0, mix(0.96, 0.78, near), mix(0.9, 0.55, near)) * (glow * (1.0 - disc) + rays) * window
      + vec3(1.0, 0.95, 0.88) * corona * (1.0 - disc) * window);
    // Over the limb, near: the prominences - arches of cooler gas anchored
    // in the photosphere at both feet, the sheet widening towards them (Solar
    // prominence), red in their hydrogen light (no chromosphere ring: it is
    // seen only in an eclipse, and a thin pink line outlined the disc). Each a site fixed on the turning sun: it rises over the
    // limb as the sun turns it there and sets behind it (a fringe of noise
    // threads round the limb read as pink fur).
    if (near > 0.0 && g > 0.995 && g < 1.5) {
      float x = g - 1.0;
      vec2 round2 = normalize(q);
      float arch = 0.0;
      for (int k = 0; k < 9; k++) {
        vec3 hk = sunHash3(vec3(float(k) * 13.1, 5.3, 2.7));
        vec3 site = normalize(hk - 0.5) * uSunTurn;
        float onLimb = 1.0 - smoothstep(0.1, 0.28, abs(dot(site, vFacing)));
        if (onLimb <= 0.0) continue;
        vec2 at = normalize(vec2(dot(site, vRight), dot(site, vUpward)));
        float halfW = 0.05 + 0.08 * hk.y;
        float s = atan(at.x * round2.y - at.y * round2.x, dot(at, round2)) / halfW;
        if (abs(s) > 1.3) continue;
        float top = (0.04 + 0.1 * hk.z) * (0.85 + 0.15 * sin(uTime * 0.05 + float(k) * 2.0));
        float line = top * sqrt(max(0.0, 1.0 - s * s));
        float thick = 0.01 + 0.012 * hk.x + 0.02 * (1.0 - smoothstep(0.0, 0.5, line / top));
        float threads = 0.55 + 0.45 * sunNoise3(vec3(s * 7.0, x * 60.0, uTime * 0.04 + float(k)));
        float loop = exp(-((x - line) / thick) * ((x - line) / thick)) + 0.35 * (1.0 - smoothstep(line - 0.006, line + 0.006, x));
        arch = max(arch, loop * threads * onLimb * (1.0 - smoothstep(1.0, 1.3, abs(s))));
      }
      c += vec3(1.0, 0.22, 0.28) * arch * smoothstep(-0.004, 0.004, x) * 0.9 * near * window;
    }
    gl_FragColor = vec4(c * uShow, 1.0);
  }
`;

const MOON_VERTEX = /* glsl */ `
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vWorld;
  void main() {
    vLocal = position;
    vNormal = normalize(mat3(modelMatrix) * normal);
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    vec4 clip = projectionMatrix * viewMatrix * world;
    // Beyond the far plane it is still drawn, just inside it, behind everything near.
    clip.z = min(clip.z, clip.w * (1.0 - 2.0e-6));
    gl_Position = clip;
  }
`;

const MOON_FRAGMENT = /* glsl */ `
  uniform vec3 uSun;
  uniform float uShow;
  uniform float uGain;
  uniform vec3 uEarth;
  uniform float uEarthLight;
  varying vec3 vLocal;
  varying vec3 vNormal;
  varying vec3 vWorld;
  vec3 hash33(vec3 p) {
    p = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p += dot(p, p.yxz + 33.33);
    return fract((p.xxy + p.yxx) * p.zyx);
  }
  float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
  }
  float noise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
               mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y), f.z);
  }
  // Simple craters on a cellular field: a bowl a fifth as deep as it is
  // wide, a raised rim and the ejecta round it.
  float craters(vec3 p, float cells, float seed, float keep) {
    vec3 q = p * cells;
    vec3 id = floor(q);
    float h = 0.0;
    for (int k = 0; k < 27; k++) {
      vec3 c = id + vec3(float(k - (k / 3) * 3 - 1), float((k / 3) - (k / 9) * 3 - 1), float(k / 9 - 1));
      if (hash13(c + seed) > keep) continue;
      vec3 centre = c + 0.15 + 0.7 * hash33(c + seed * 1.3);
      float r = 0.12 + 0.33 * hash13(c - seed);
      float d = length(q - centre) / r;
      // Every term continuous (a step in the height drew a dotted ring
      // through the bump), and gone before the 27 cells' reach (r * 2.2 <
      // one cell), where a crater was cut along a straight line.
      if (d > 2.2) continue;
      // Its age: the young sharp and deep, the old worn down to a shallow
      // ring - every crater the same depth and rim was the stamped look.
      float age = hash13(c + seed * 2.7);
      float fresh = 1.0 - 0.75 * age;
      float bowl = d < 1.0 ? (d * d - 1.0) * mix(0.18, 0.42, fresh) : 0.0;
      // A square, not pow(x, 2.0): pow of a negative base is undefined in GLSL (NaN on some drivers).
      float rimW = mix(0.32, 0.18, fresh);
      float rim = exp(-((d - 1.0) / rimW) * ((d - 1.0) / rimW)) * 0.15 * fresh;
      // The big ones lift a peak in the middle (complex craters).
      float peak = r > 0.33 ? exp(-(d / 0.2) * (d / 0.2)) * 0.18 * fresh : 0.0;
      float ejecta = d > 1.0 ? 0.05 * fresh * (1.0 - exp(-(d - 1.0) * 10.0)) * exp(-(d - 1.0) * 2.5) : 0.0;
      h += (bowl + rim + peak + ejecta) * r * (1.0 - smoothstep(1.6, 2.2, d));
    }
    return h / cells;
  }
  void main() {
    vec3 p = normalize(vLocal);
    // The sizes as the Moon's are: few big, more and more of the small
    // (the crater count rising steeply as the size falls); each scale fewer
    // where the maria flooded the older ones.
    float h = craters(p, 2.0, 1.0, 0.35) + craters(p, 5.0, 4.0, 0.45) + craters(p, 12.0, 7.0, 0.55) * 0.9 + craters(p, 30.0, 13.0, 0.6) * 0.7;
    // Close by (the free camera, \`flight.ts\`): smaller craters and the
    // regolith's lumps, each faded out before it is finer than a pixel.
    float px = length(fwidth(p));
    if (px < 0.004) {
      h += craters(p, 90.0, 21.0, 0.4) * 0.8 * (1.0 - smoothstep(0.0015, 0.004, px));
      float a = 0.0012;
      float f = 300.0;
      for (int o = 0; o < 4; o++) {
        a *= 0.5;
        h += (noise(p * f) - 0.5) * a * (1.0 - smoothstep(0.25, 0.8, px * f));
        f *= 3.1;
      }
    }
    // Maria: the dark basalt plains, a sixth of the surface and nearly all of
    // it on the near side (Lunar mare: Procellarum, Imbrium...), broad
    // smooth-edged basins, the old craters under them drowned.
    float basins = noise(p * 1.6 + 4.0) * 0.55 + noise(p * 3.4 + 9.0) * 0.3 + noise(p * 8.0) * 0.15;
    float maria = smoothstep(0.5, 0.58, basins + 0.12 * p.x) * smoothstep(-0.5, 0.2, p.x);
    h *= 1.0 - 0.65 * maria;
    // Rays: the bright streaks thrown out by a few young craters, across
    // everything round them.
    float rays = 0.0;
    for (int k = 0; k < 3; k++) {
      vec3 at = normalize(hash33(vec3(float(k) * 17.0, 3.0, 5.0)) - 0.5);
      float dd = acos(clamp(dot(p, at), -1.0, 1.0));
      vec3 side = normalize(cross(at, abs(at.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0)));
      float ang = atan(dot(p, cross(at, side)), dot(p, side));
      float streak = noise(vec3(ang * 9.0, float(k) * 7.0, 0.0));
      rays += smoothstep(0.62, 0.9, streak) * exp(-dd * 3.5) * smoothstep(0.02, 0.06, dd);
    }
    // Albedos as measured: the highlands 0.11-0.16, the maria half that.
    float albedo = mix(0.14, 0.065, maria) * (0.88 + 0.24 * noise(p * 26.0)) * (1.0 + 0.6 * rays);
    // Bump from the height's screen derivatives (three's perturbNormalArb).
    vec3 n = normalize(vNormal);
    vec3 dpdx = dFdx(vWorld), dpdy = dFdy(vWorld);
    float scale = 1100.0 * (1.0 - 0.6 * maria);
    float dhdx = dFdx(h) * scale, dhdy = dFdy(h) * scale;
    vec3 r1 = cross(dpdy, n), r2 = cross(n, dpdx);
    float det = dot(dpdx, r1);
    vec3 grad = sign(det) * (dhdx * r1 + dhdy * r2);
    n = normalize(abs(det) * n - grad);
    float mu0 = max(dot(n, uSun), 0.0);
    vec3 view = normalize(cameraPosition - vWorld);
    // The eye's angle on the smooth sphere, not the bumped ground: at the
    // limb it goes to nothing and Lommel-Seeliger's mu0 / (mu0 + mu) to its
    // most, and read off the bump, single pixels of the rim did - a ring of
    // white sparks round the small moon.
    float mu = max(dot(normalize(vNormal), view), 0.0);
    // Lommel-Seeliger with a little Lambert: the full moon bright to its limb.
    float lit = mix(mu0 / max(mu0 + mu, 1e-3) * 2.0, mu0, 0.35);
    // The terminator from the smooth sphere: past it the bump alone lit
    // single pixels (a crater's far wall turned to the sun), white specks
    // scattered over the night side. The shading in the bump kept up to it,
    // the line itself soft over a few degrees.
    lit *= smoothstep(-0.02, 0.09, dot(normalize(vNormal), uSun));
    // Earthshine: the planet's lit side lights the moon's night (strongest
    // at the new moon, when the planet is full from there).
    float earth = max(dot(n, uEarth), 0.0) * uEarthLight;
    vec3 c = vec3(1.0, 0.98, 0.95) * albedo * lit * uGain + vec3(0.55, 0.68, 0.95) * albedo * earth + vec3(0.02, 0.025, 0.035) * albedo;
    gl_FragColor = vec4(c * uShow, 1.0);
  }
`;

/** Tanner Helland's fit of a black body's colour (1000..40000 K), linear-ish 0..1. */
function kelvin(t: number, out: Color): Color {
  const k = t / 100;
  const r = k <= 66 ? 255 : 329.698727446 * (k - 60) ** -0.1332047592;
  const g = k <= 66 ? 99.4708025861 * Math.log(k) - 161.1195681661 : 288.1221695283 * (k - 60) ** -0.0755148492;
  const b = k >= 66 ? 255 : k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  const c = (v: number): number => Math.min(255, Math.max(0, v)) / 255;
  // The fit is in display values: to linear light.
  return out.setRGB(c(r) ** 2.2, c(g) ** 2.2, c(b) ** 2.2);
}

/** The galactic plane's pole and the core's direction, in the planet's frame (unit). */
const GALACTIC_POLE = new Vector3(0.35, -0.55, 0.76).normalize();
const GALACTIC_CORE = new Vector3(0.9, 0.4, 0).projectOnPlane(GALACTIC_POLE).normalize();

function makeStars(): BufferGeometry {
  const rng = new Rng(0x5747a2);
  const position = new Float32Array(STAR_COUNT * 3);
  const tint = new Float32Array(STAR_COUNT * 3);
  const size = new Float32Array(STAR_COUNT);
  const colour = new Color();
  // Temperatures as the naked eye sees them: hot blue-white and cool orange
  // giants over-represented against the galaxy's red dwarfs.
  const kinds = [[25000, 0.04], [11000, 0.18], [8000, 0.18], [6500, 0.16], [5600, 0.16], [4500, 0.2], [3400, 0.08]] as const;
  const MIN = -1.4, MAX = 7.2;
  const span = 10 ** (0.47 * (MAX - MIN)) - 1;
  const d = new Vector3(), a = new Vector3(), b = new Vector3();
  a.copy(GALACTIC_CORE);
  b.crossVectors(GALACTIC_POLE, GALACTIC_CORE);
  for (let i = 0; i < STAR_COUNT; i++) {
    // Magnitude: counts about tripling a magnitude down.
    const m = MIN + Math.log10(1 + rng.float() * span) / 0.47;
    // Direction: the faint ones crowd towards the galactic plane.
    if (rng.float() < 0.15 + 0.4 * ((m - MIN) / (MAX - MIN))) {
      const lon = rng.float() * Math.PI * 2;
      const lat = Math.max(-1.5, Math.min(1.5, rng.normal(0, 0.16)));
      d.copy(a).multiplyScalar(Math.cos(lat) * Math.cos(lon)).addScaledVector(b, Math.cos(lat) * Math.sin(lon)).addScaledVector(GALACTIC_POLE, Math.sin(lat));
    } else {
      const z = rng.range(-1, 1), t = rng.float() * Math.PI * 2, s = Math.sqrt(1 - z * z);
      d.set(s * Math.cos(t), s * Math.sin(t), z);
    }
    position.set([d.x, d.y, d.z], i * 3);
    let pick = rng.float(), temperature = 5600;
    for (const [t, w] of kinds) { if (pick < w) { temperature = t; break; } pick -= w; }
    kelvin(temperature * rng.range(0.9, 1.1), colour);
    // Brightness by magnitude, its range squeezed as a photograph's is (a
    // true 2.512 a step left all but a few dozen invisible); the brightest
    // pass the bloom's threshold and glint.
    const energy = 2.6 * 10 ** (-0.21 * (m + 1));
    const px = 1.3 + Math.max(0, 5 - m) * 0.4;
    tint.set([colour.r * energy, colour.g * energy, colour.b * energy], i * 3);
    size[i] = px;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('tint', new Float32BufferAttribute(tint, 3));
  geometry.setAttribute('size', new Float32BufferAttribute(size, 1));
  return geometry;
}

export interface SpaceFrame {
  readonly camera: Camera;
  /** How far out at the globe the view is (0 at the ground .. 1 the whole planet). */
  readonly globe: number;
  /** How dark it is where the view looks (0 day .. 1 night). */
  readonly dark: number;
  /** The game's clock: minutes since the first midnight (days run on). */
  readonly minutes: number;
  /** The sun's direction, three's space, unit. */
  readonly sun: Vector3;
  /** The planet's centre as drawn. */
  readonly centre: Vector3;
  /** The motion setting the planet down (`bend.ts`): the planet's frame to three's space. */
  readonly motion: Matrix4;
  /** The view's height, CSS pixels. */
  readonly height: number;
  /**
   * The world drawn flat (`isoViewport.ts` `setFlatView`): the air's shell,
   * a sphere round the planet's own centre, is not drawn from above the air
   * - over the plane it stood as a ring round the world.
   */
  readonly flat?: boolean;
  /** Device pixels per CSS pixel. */
  readonly pixelRatio: number;
}

export interface Space {
  update(frame: SpaceFrame): void;
  /** How far the sky has gone to space (0 the ground's sky .. 1 black space): what the sky dome fades by. */
  readonly spaceShare: number;
  /** Parts kept hidden by name (`space-stars`, `space-air`...): for the browser checks. */
  readonly hidden: Set<string>;
  /** The air round the planet (`air.ts`): its LUTs and uniforms, for the post pass's aerial perspective and clouds. */
  readonly air: Air;
  /** The bodies the free camera can fly to and is pulled by (`flight.ts`): their centres (three's space) and radii, as last updated. */
  bodies(): readonly { readonly name: 'moon' | 'sun' | 'station'; readonly centre: Vector3; readonly radius: number }[];
  /**
   * Those and the comet's nucleus (`skyLife.ts`): what the flight flies to
   * and against, and what its marks show, once the renderer reads this
   * instead of \`bodies\` (its marks need a slot and a name for the comet).
   */
  allBodies(): readonly { readonly name: 'moon' | 'sun' | 'station' | 'comet'; readonly centre: Vector3; readonly radius: number }[];
  /** The asteroid field (`asteroids.ts`): its rocks nearest a point, for the flight. */
  readonly asteroids: Asteroids;
  /** The satellites, the shooting stars and the station (`skyLife.ts`). */
  readonly life: SkyLife;
  dispose(): void;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createSpace(scene: Scene, renderer: WebGLRenderer): Space {
  const skip = { planetSkip: true };
  // The air (`air.ts`): its LUTs baked now; the stars, the sun and the shell read them.
  const airModel = createAir(renderer);
  const air$ = airModel.uniforms;
  // THE MILKY WAY, baked once.
  const galaxyTarget = new WebGLRenderTarget(2048, 1024, { type: HalfFloatType, depthBuffer: false, magFilter: LinearFilter, minFilter: LinearFilter });
  galaxyTarget.texture.wrapS = RepeatWrapping;
  {
    const bake = new FullScreenQuad(new ShaderMaterial({
      uniforms: { uPole: { value: GALACTIC_POLE }, uCore: { value: GALACTIC_CORE } },
      vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: GALAXY_BAKE,
      depthTest: false,
      depthWrite: false,
    }));
    const previous = renderer.getRenderTarget();
    renderer.setRenderTarget(galaxyTarget);
    bake.render(renderer);
    renderer.setRenderTarget(previous);
    bake.material.dispose();
    bake.dispose();
  }
  const sky = new Matrix3();
  const galaxyMaterial = new ShaderMaterial({
    uniforms: { ...air$, uMap: { value: galaxyTarget.texture }, uShow: { value: 0 }, uSky: { value: sky } },
    vertexShader: GALAXY_VERTEX,
    fragmentShader: GALAXY_FRAGMENT,
    side: BackSide,
    depthWrite: false,
    transparent: true,
    ...SKY_ADDITIVE,
  });
  const galaxy = new Mesh(new SphereGeometry(1, 48, 24), galaxyMaterial);
  galaxy.name = 'space-galaxy';
  galaxy.frustumCulled = false;
  galaxy.renderOrder = -998;
  galaxy.userData = skip;

  const starsMaterial = new ShaderMaterial({
    uniforms: { ...air$, uSky: { value: sky }, uShow: { value: 0 }, uPixel: { value: 1 } },
    vertexShader: STARS_VERTEX,
    fragmentShader: STARS_FRAGMENT,
    depthWrite: false,
    transparent: true,
    ...SKY_ADDITIVE,
  });
  const stars = new Points(makeStars(), starsMaterial);
  stars.name = 'space-stars';
  stars.frustumCulled = false;
  stars.renderOrder = -997;
  stars.userData = skip;

  const sunMaterial = new ShaderMaterial({
    uniforms: {
      ...air$, uSun: { value: new Vector3() }, uSunView: { value: new Vector3() }, uShow: { value: 0 }, uSize: { value: 0.16 }, uDisc: { value: 0.034 },
      uTime: { value: 0 }, uSunTurn: { value: new Matrix3() },
    },
    vertexShader: SUN_VERTEX,
    fragmentShader: SUN_FRAGMENT,
    depthWrite: false,
    transparent: true,
    ...SKY_ADDITIVE,
  });
  const sun = new Mesh(new PlaneGeometry(2, 2), sunMaterial);
  sun.name = 'space-sun';
  sun.frustumCulled = false;
  sun.renderOrder = -996;
  sun.userData = skip;

  const moonMaterial = new ShaderMaterial({
    uniforms: { uSun: { value: new Vector3() }, uShow: { value: 0 }, uGain: { value: 9 }, uEarth: { value: new Vector3() }, uEarthLight: { value: 0 } },
    vertexShader: MOON_VERTEX,
    fragmentShader: MOON_FRAGMENT,
    side: FrontSide,
  });
  const moon = new Mesh(new SphereGeometry(1, 64, 32), moonMaterial);
  moon.name = 'space-moon';
  moon.frustumCulled = false;
  moon.renderOrder = -999;
  moon.scale.setScalar(MOON_RADIUS);
  moon.userData = skip;

  // The asteroid field, far out (`asteroids.ts`).
  const asteroids = createAsteroids();
  let rocksAt = performance.now();
  // The satellites, the shooting stars and the station (`skyLife.ts`).
  const life = createSkyLife();
  /** What \`life.update\` is given, one object written each frame. */
  const lifeFrame: SkyLifeFrame = {
    camera: null as unknown as Camera, motion: new Matrix4(), sky, centre: new Vector3(), sun: new Vector3(), sunBody: new Vector3(),
    seconds: 0, pixelRatio: 1, height: 1, width: 1, airUniforms: air$ as Record<string, { value: unknown }>,
  };

  const front = { value: 0 };
  const airMaterial = new ShaderMaterial({
    // The air's own uniform objects: what it sets each frame, this reads.
    uniforms: { ...airModel.uniforms, uFront: front },
    vertexShader: ATMOSPHERE_VERTEX,
    fragmentShader: ATMOSPHERE_FRAGMENT,
    // Both faces in one program, the one drawn chosen by `uFront` (`ATMOSPHERE_VERTEX`).
    side: DoubleSide,
    forceSinglePass: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    // The air's light over what is behind it, dimmed by what the air lets
    // through (alpha). The picture's own alpha left as it is: without alpha
    // factors three uses the colour's for it too (`blendFuncSeparate`), the
    // frame's alpha came out 2T - under 1 wherever the air is thick - and the
    // page behind the canvas showed through the night sky (PL47 b).
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: SrcAlphaFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor,
  });
  const air = new Mesh(new SphereGeometry(1, 96, 48), airMaterial);
  air.name = 'space-air';
  air.frustumCulled = false;
  // Over everything the world draws: the ground is seen through the air.
  air.renderOrder = 1e9;
  air.scale.setScalar(ATMOSPHERE_TOP);
  air.userData = skip;

  for (const object of [galaxy, stars, sun, moon, air]) scene.add(object);
  // The rocks join the scene once their programs are built (`compileAhead`).
  void compileAhead(asteroids.group).then(() => scene.add(asteroids.group));
  void compileAhead(life.group).then(() => scene.add(life.group));

  const axis = new Vector3();
  const spin = new Matrix4();
  const rotation = new Matrix4();
  const toward = new Vector3();
  const moonDir = new Vector3();
  const up = new Vector3();
  const side = new Vector3();
  const basis = new Matrix4();
  const sunBody = new Vector3();
  /** The sun's face: its clock (real seconds) and three's space into its turning frame. */
  let sunTime = 0;
  const sunTurn = sunMaterial.uniforms['uSunTurn']!.value as Matrix3;
  /** What the air is given each frame, one object written in place. */
  const airFrame = { centre: new Vector3(), eye: new Vector3(), sun: new Vector3(), moon: new Vector3(), moonLight: 0, drawnCentre: new Vector3(), drawnRadius: PLANET_RADIUS };
  let spaceShare = 0;
  const hidden = new Set<string>();
  // The same lists every call (their centres are the bodies' own, moved in
  // place): asked for by the flight and its marks every frame.
  const bodyList = [
    { name: 'moon' as const, centre: moon.position, radius: MOON_RADIUS },
    { name: 'sun' as const, centre: sunBody, radius: SUN_RADIUS },
    { name: 'station' as const, centre: life.station.centre, radius: life.station.radius },
  ];
  const allBodyList = [...bodyList, { name: 'comet' as const, centre: life.comet.centre, radius: life.comet.radius }];

  return {
    hidden,
    air: airModel,
    get spaceShare() {
      return spaceShare;
    },
    asteroids,
    life,
    bodies: () => bodyList,
    allBodies: () => allBodyList,
    update(frame) {
      const { globe, minutes, centre, motion, camera } = frame;
      // From the ground's sky to space as the view climbs to the globe.
      spaceShare = smooth(0.0, 0.12, globe);
      // The sky turns with the sun round the planet's axis (`world/planet/sun.ts`).
      const sigma = (-(minutes - 720) / 1440) * Math.PI * 2;
      rotation.extractRotation(motion);
      spin.makeRotationZ(sigma);
      sky.setFromMatrix4(spin.premultiply(rotation));
      // The stars, the Milky Way and the sun are always there: the sky's own
      // light hides the stars by day (`starsThrough`), and the air in front
      // dims and reddens the sun (the shell over them, its tint).
      starsMaterial.uniforms['uShow']!.value = 1;
      starsMaterial.uniforms['uPixel']!.value = frame.pixelRatio;
      galaxyMaterial.uniforms['uShow']!.value = 1;
      stars.visible = galaxy.visible = true;
      sunMaterial.uniforms['uShow']!.value = 1;
      (sunMaterial.uniforms['uSun']!.value as Vector3).copy(frame.sun);
      // The body: from the eye, its direction and its size (it grows as the free camera flies to it).
      sunBody.copy(centre).addScaledVector(frame.sun, SUN_DISTANCE);
      const toSun = (sunMaterial.uniforms['uSunView']!.value as Vector3).subVectors(sunBody, camera.position);
      const sunFar = Math.max(SUN_RADIUS * 1.01, toSun.length());
      toSun.divideScalar(sunFar);
      sunMaterial.uniforms['uSize']!.value = Math.min(22, Math.asin(SUN_RADIUS / sunFar) / 0.034);
      sun.visible = true;
      // The moon: phase by its lag behind the sun, on an orbit tilted a little.
      const phase = (minutes / 1440 / LUNAR_MONTH) % 1;
      const lunar = sigma - phase * Math.PI * 2;
      axis.set(0, 0, 1).applyMatrix4(rotation);
      moonDir.set(Math.cos(lunar), Math.sin(lunar), Math.sin(MOON_TILT) * Math.sin(lunar * 0.5 + 1.3)).normalize().applyMatrix4(rotation);
      moon.position.copy(centre).addScaledVector(moonDir, MOON_DISTANCE);
      // Tidally locked: its +x always to the planet.
      toward.copy(moonDir).negate();
      side.crossVectors(axis, toward).normalize();
      up.crossVectors(toward, side);
      basis.makeBasis(toward, side, up);
      moon.quaternion.setFromRotationMatrix(basis);
      (moonMaterial.uniforms['uSun']!.value as Vector3).copy(frame.sun);
      // Its light as the eye adapts: 9 times its albedo while it is a disc in
      // the sky (bright against the blue), as the planet's ground once the
      // free camera is close enough for it to fill the view - at 9 the lit
      // side was all white there.
      const moonAngle = Math.asin(Math.min(1, MOON_RADIUS / Math.max(MOON_RADIUS, camera.position.distanceTo(moon.position))));
      // Close, as a camera exposed for its sunlit ground: the highlands a
      // mid grey, the maria darker (at 2.4 from three radii it was a white
      // plaster ball, the maria lost in it).
      moonMaterial.uniforms['uGain']!.value = 9 + (1.6 - 9) * smooth(0.03, 0.3, moonAngle);
      (moonMaterial.uniforms['uEarth']!.value as Vector3).copy(moonDir).negate();
      moonMaterial.uniforms['uEarthLight']!.value = 0.45 * (1 + moonDir.dot(frame.sun)) / 2;
      // By day too, pale against the blue (the shell adds the sky over it).
      moonMaterial.uniforms['uShow']!.value = 1;
      moon.visible = true;
      const nowRocks = performance.now();
      const seconds = Math.min(0.1, (nowRocks - rocksAt) / 1000);
      asteroids.update(camera, motion, seconds);
      rocksAt = nowRocks;
      // The sun's face turns with the stars and on its own axis (a turn in
      // \`SUN_SPIN\` s), and boils (\`SUN_FRAGMENT\`): three's space into its frame.
      sunTime += seconds;
      const spinAngle = (sunTime / SUN_SPIN) * Math.PI * 2;
      const c = Math.cos(spinAngle), s = Math.sin(spinAngle);
      const e = sky.elements;
      // The stars' frame's axes in three's space are the sky's columns; the sun's turned about the third.
      sunTurn.set(
        c * e[0]! + s * e[3]!, c * e[1]! + s * e[4]!, c * e[2]! + s * e[5]!,
        -s * e[0]! + c * e[3]!, -s * e[1]! + c * e[4]!, -s * e[2]! + c * e[5]!,
        e[6]!, e[7]!, e[8]!,
      );
      sunMaterial.uniforms['uTime']!.value = sunTime;
      lifeFrame.camera = camera; lifeFrame.motion = motion; lifeFrame.centre = centre; lifeFrame.sun = frame.sun;
      lifeFrame.sunBody = sunBody; lifeFrame.seconds = seconds; lifeFrame.pixelRatio = frame.pixelRatio; lifeFrame.height = frame.height;
      lifeFrame.width = frame.height * ((camera as Camera & { aspect?: number }).aspect ?? 1);
      life.update(lifeFrame);
      // The air round the planet, from the ground to space: the sky round the
      // eye inside it, over everything from above it (\`air.ts\`). The moon
      // lights it a little at night, by its phase (the lit share of its disc).
      const lit = (1 - moonDir.dot(frame.sun)) / 2;
      // Over the ground as drawn under the eye (\`bend.ts\`): flattened near the ground, the planet's own from the top of the air.
      airFrame.drawnRadius = planetDrawnSphere(airFrame.drawnCentre);
      airFrame.centre.copy(centre); airFrame.eye.copy(camera.position); airFrame.sun.copy(frame.sun); airFrame.moon.copy(moonDir);
      airFrame.moonLight = MOONLIGHT * lit;
      airModel.update(renderer, airFrame);
      air.position.copy(centre);
      // Out of the air and clear of it, the shell's near face at its true
      // depth, depth tested (\`ATMOSPHERE_VERTEX\`): within twice the near
      // plane's distance of it, the far face as before (a near face cut by
      // the near plane would leave a hole in the air under the eye).
      const clear = camera.position.distanceTo(centre) - ATMOSPHERE_TOP > 2 * ((camera as Camera & { near?: number }).near ?? 0);
      front.value = !airModel.inside && clear ? 1 : 0;
      airMaterial.depthTest = airModel.inside || front.value === 1;
      air.visible = !frame.flat || airModel.inside;
      for (const object of [galaxy, stars, sun, moon, air]) if (hidden.has(object.name)) object.visible = false;
    },
    dispose() {
      asteroids.dispose();
      life.dispose();
      for (const object of [galaxy, stars, sun, moon, air]) {
        scene.remove(object);
        object.geometry.dispose();
        (object.material as ShaderMaterial).dispose();
      }
      galaxyTarget.dispose();
      airModel.dispose();
    },
  };
}
