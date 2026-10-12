import {
  AddEquation, ClampToEdgeWrapping, CustomBlending, HalfFloatType, LinearFilter, Matrix4, Mesh, NoBlending, OneFactor, OrthographicCamera, Scene,
  ShaderMaterial, SrcAlphaFactor, Vector3, WebGLRenderTarget, ZeroFactor,
  type Camera, type Material, type WebGLRenderer,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import { PLANET_RADIUS } from '@core/cubeSphere';
import { fullScreenTriangle } from '../uploads';

/**
 * THE AIR ROUND THE PLANET, from the ground to space, one model for all of it:
 * Sebastien Hillaire, "A Scalable and Production Ready Sky and Atmosphere
 * Rendering Technique" (EGSR 2020) and its reference code
 * (github.com/sebh/UnrealEngineSkyAtmosphere, `RenderSkyRayMarching.hlsl`,
 * `RenderSkyCommon.hlsl`), the sky of Unreal's SkyAtmosphere.
 *
 * - Rayleigh, Mie and ozone, their densities falling with height (the
 *   coefficients of the paper's Table 1, after Bruneton 2017).
 * - TRANSMITTANCE LUT, 256 x 64, baked once: how much of the sun reaches a
 *   height from a zenith angle (Bruneton and Neyret's parameterisation).
 * - MULTIPLE SCATTERING LUT, 32 x 32, baked once: the light scattered twice
 *   and more, as the paper's Psi_ms = L_2nd / (1 - f_ms) (equations 5-10),
 *   64 directions round each texel. What makes a dense sky bright and wide
 *   instead of a thin single-scattered line.
 * - SKY-VIEW LUT, 192 x 108, each frame while the eye is inside the air: the
 *   whole sky round the eye, its latitude squeezed towards the horizon
 *   (section 5.3); the sky is one lookup a pixel.
 * - AERIAL PERSPECTIVE volume, 32 x 32 cells x 32 slices (tiled side by side
 *   in one 2-D texture, as a 3-D texture is drawn a layer at a time), each
 *   frame while the eye is inside the air: the air between the eye and
 *   anything at a depth (section 5.4), applied to the scene after it is lit.
 * - From space (the eye above the air) every pixel of the air is marched,
 *   with the two baked LUTs in place of a march to the sun (section 7: "we
 *   seamlessly switch to simple ray marching on screen").
 * - THE AIR OVER THE GROUND AS DRAWN: near the ground the planet is drawn on
 *   a sphere of radius R / k tangent to it at the point looked at (`bend.ts`
 *   planetDrawnSphere; k = 0.02 under 400 m, rising to 1 at the top of the
 *   air), and the clouds, the night side and the horizon are measured against
 *   that one (PL12). The sky round the eye and the aerial perspective are too:
 *   a horizontal ray's air mass grows as the square root of the radius over
 *   the scale height, and on the planet's own small sphere it was 4.7 against
 *   the Earth's ~38 - the horizon never filled with light, the street's sky
 *   was a flat navy to the ground line. Over the drawn sphere it is the
 *   Earth's again: a pale horizon, the haze on far land, red sunsets. The
 *   transmittance and multiple scattering LUTs of that sphere are baked again
 *   only when its radius moves (`DRAWN_REBAKE`); out of the air k is 1 and the
 *   planet's own LUTs serve, so nothing jumps at the top.
 *
 * The planet is a few kilometres round; the air's heights are the Earth's
 * scaled to it (`RAYLEIGH_HEIGHT`), so the limb, the dusk and the blue are
 * the Earth's in shape, and denser (`DENSITY`) as a small world's air is
 * drawn (the paper's "artistic vision of a tiny planet", figure 1).
 */

const R = PLANET_RADIUS;
/**
 * The Rayleigh scale height: 7 % of the radius (the Earth's 8 km of 6360 km
 * is 0.13 %): a tall, soft limb. At 3 % the blue hugged the ground - under
 * a 60-storey tower's top, a thin line on the horizon from mid altitude (the
 * player, 2026-10-10: "a atmosfera está muito baixa"). Unreal's sky
 * atmosphere draws its small planets so (a 300 km ground radius, the
 * Rayleigh height 8 to 32 km, the air 100 km tall: "Sky Atmosphere
 * Component", Epic). The air's thickness straight up stays the Earth's
 * (`METRES` follows the height), so the sky's colour over the ground does not
 * change: only how high it reaches.
 */
const RAYLEIGH_HEIGHT = R * 0.07;
/** The aerosols' scale height, the Earth's ratio to the Rayleigh one (1.2 km : 8 km) and a little more haze. */
const MIE_HEIGHT = R * 0.02;
/** The top of the air: six Rayleigh heights (what is left above is e^-6 of the ground's air, a quarter of a percent). */
export const ATMOSPHERE_TOP = R + RAYLEIGH_HEIGHT * 6;
/**
 * How much of the air's own light and dimming the ground takes, seen from the
 * top of the air and out in space (Unreal's "Aerial Perspective View
 * Distance Scale" carried out to the shell): the air's heights are the
 * Earth's stretched over a small world, so a ray down to the ground crosses a
 * whole Earth's column of air at every angle, and the land came out teal and
 * the woods navy from a few kilometres up (the player, 2026-10-10: "manchas
 * azuladas"). The sky, the limb and the dusk keep the full air: only the
 * rays that reach the ground are scaled, eased in towards the limb. The post
 * pass's own scale inside the air rises to this same value at the air's top,
 * so crossing it changes nothing.
 */
export const SURFACE_AIR = 0.4;
/** Earth metres per world unit for the gases and the aerosols: their heights over ours. */
const METRES = 8000 / RAYLEIGH_HEIGHT;
const MIE_METRES = 1200 / MIE_HEIGHT;
/** The gases a fifth denser than the Earth's, the aerosols three times: a fuller blue, a brighter glow round the sun. */
const DENSITY = 1.2;
const MIE_DENSITY = 3;
/** How far the aerial perspective volume reaches: the longest chord of the air over the ground, world units. */
const PERSPECTIVE_RANGE = 2 * Math.sqrt(ATMOSPHERE_TOP * ATMOSPHERE_TOP - R * R);
/** The sky-view LUT (Hillaire's 192 x 108), the multiple scattering LUT's side, the volume's cells and slices. */
const SKY_W = 192;
const SKY_H = 108;
const MULTI = 32;
const SLICES = 32;
/**
 * The sun's illuminance on the air, in the scene's linear units: the sky's
 * light is its luminance per unit of it (the LUTs are made with the sun at 1,
 * as the paper's "ILLUMINANCE_IS_ONE"). The sun's light on the ground
 * (`environment.ts`, 4.2 at midday): the air and the land under it lit alike.
 */
const SUN_ILLUMINANCE = 4.2;

/**
 * Light added over the sky - the stars, the Milky Way, the sun, the comet,
 * the aurora, a station's lamps: its colour added, the alpha under it left as
 * it is. three's AdditiveBlending (not premultiplied) is one
 * `blendFunc(SRC_ALPHA, ONE)` for colour and alpha alike (`WebGLState`
 * `setBlending`): it added to the alpha too, the post-processing passes the
 * alpha on, and the sun's quad stood out as a lighter rectangle over the dawn
 * sky, the moon behind it with it. Colour and alpha apart (`blendFuncSeparate`).
 */
export const SKY_ADDITIVE = {
  blending: CustomBlending, blendEquation: AddEquation,
  blendSrc: SrcAlphaFactor, blendDst: OneFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor,
} as const;
/**
 * How far the drawn sphere's radius may move before its transmittance LUT is
 * baked again (a share of it), and its multiple scattering LUT (a smooth,
 * low-frequency term). Moved only while the view climbs or comes down
 * between 400 m and the top of the air.
 */
const DRAWN_REBAKE = 0.005;
const DRAWN_REBAKE_MULTI = 0.03;

/**
 * The work counter of the drawn ground's LUTs (`src/core/perfBudget.ts`, as
 * `padsWork`): frames that baked them again, summed. At most one a frame by
 * construction; the budget's spec takes the difference over frames.
 */
export const airWork = { drawnBakeFrames: 0 };

const f = (v: number): string => v.toExponential(7);
const v3 = (a: number, b: number, c: number, k: number): string => `vec3(${f(a * k)}, ${f(b * k)}, ${f(c * k)})`;

/** Constants, the medium, the phase functions and the LUTs' coordinates: no uniforms. */
const AIR_MEDIUM = /* glsl */ `
  const float AIR_PI = 3.14159265;
  const float AIR_R = ${f(R)};
  const float AIR_TOP = ${f(ATMOSPHERE_TOP)};
  const vec3 AIR_RAYLEIGH = ${v3(5.802e-6, 13.558e-6, 33.1e-6, METRES * DENSITY)};
  const float AIR_RAYLEIGH_H = ${f(RAYLEIGH_HEIGHT)};
  const float AIR_MIE_SCATTER = ${f(3.996e-6 * MIE_METRES * MIE_DENSITY)};
  const float AIR_MIE_EXTINCT = ${f((3.996e-6 + 4.4e-6) * MIE_METRES * MIE_DENSITY)};
  const float AIR_MIE_H = ${f(MIE_HEIGHT)};
  const vec3 AIR_OZONE = ${v3(0.65e-6, 1.881e-6, 0.085e-6, METRES * DENSITY)};
  const float AIR_OZONE_MID = ${f(25000 / METRES)};
  const float AIR_OZONE_HALF = ${f(15000 / METRES)};
  const float AIR_MIE_G = 0.8;
  const float AIR_ALBEDO = 0.3;
  const float AIR_RANGE = ${f(PERSPECTIVE_RANGE)};
  // Near and far distances along a ray to a sphere at the origin (far < near: a miss).
  vec2 airSphere(vec3 r0, vec3 rd, float sr) {
    float b = dot(rd, r0);
    float c = dot(r0, r0) - sr * sr;
    float d = b * b - c;
    if (d < 0.0) return vec2(1e9, -1e9);
    float s = sqrt(d);
    return vec2(-b - s, -b + s);
  }
  // The medium at a height: its extinction, and what of it scatters (Rayleigh, Mie).
  vec3 airMedium(float h, out vec3 scatterR, out float scatterM) {
    float dr = exp(-max(h, 0.0) / AIR_RAYLEIGH_H);
    float dm = exp(-max(h, 0.0) / AIR_MIE_H);
    float dozone = max(0.0, 1.0 - abs(h - AIR_OZONE_MID) / AIR_OZONE_HALF);
    scatterR = AIR_RAYLEIGH * dr;
    scatterM = AIR_MIE_SCATTER * dm;
    return scatterR + AIR_MIE_EXTINCT * dm + AIR_OZONE * dozone;
  }
  float airRayleighPhase(float c) { return 3.0 / (16.0 * AIR_PI) * (1.0 + c * c); }
  // Cornette-Shanks.
  float airMiePhase(float c) {
    const float g = AIR_MIE_G;
    float k = 3.0 / (8.0 * AIR_PI) * (1.0 - g * g) / (2.0 + g * g);
    return k * (1.0 + c * c) / pow(1.0 + g * g - 2.0 * g * c, 1.5);
  }
  float airToSub(float u, float n) { return (u + 0.5 / n) * (n / (n + 1.0)); }
  float airFromSub(float u, float n) { return (u - 0.5 / n) * (n / (n - 1.0)); }
  // The transmittance LUT's coordinates for a height (radius) and a zenith
  // cosine (Bruneton), over a ground of radius R under an air reaching \`top\`.
  // Differences of squares as products: the drawn sphere is up to 50 times
  // the planet, and r * r - R * R lost the height in single precision.
  vec2 airTransmittanceUvOn(float R, float top, float r, float mu) {
    float H = sqrt(max(0.0, (top - R) * (top + R)));
    float rho = sqrt(max(0.0, (r - R) * (r + R)));
    float disc = (top - r) * (top + r) + r * r * mu * mu;
    float d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
    float dMin = top - r, dMax = rho + H;
    return vec2((d - dMin) / max(dMax - dMin, 1e-3), rho / H);
  }
  vec2 airTransmittanceUv(float r, float mu) { return airTransmittanceUvOn(AIR_R, AIR_TOP, r, mu); }
`;

/**
 * The light of the air over one ground: the sun's transmittance and the
 * multiple scattering read from that ground's LUTs, and a ray marched through
 * them. Made twice (`AIR_LIGHT`): over the planet's own sphere (no suffix,
 * constants: the view from space) and over the sphere drawn under the eye
 * (suffix `D`, uniforms: the sky round the eye and the aerial perspective).
 */
const lightOver = (s: string, R: string, TOP: string, T: string, M: string): string => /* glsl */ `
  vec3 airSunTransmittance${s}(float r, float mu) { return texture2D(${T}, airTransmittanceUvOn(${R}, ${TOP}, r, mu)).rgb; }
  vec3 airMultiple${s}(float r, float mu) {
    vec2 uv = clamp(vec2(mu * 0.5 + 0.5, (r - ${R}) / (${TOP} - ${R})), 0.0, 1.0);
    return texture2D(${M}, vec2(airToSub(uv.x, ${MULTI}.0), airToSub(uv.y, ${MULTI}.0))).rgb;
  }
  // A light's scattering at a point: single (the ground's shadow, the sun's
  // transmittance, the phases) and all the higher orders (the LUT).
  vec3 airLit${s}(vec3 up, float r, vec3 light, float pR, float pM, vec3 sR, float sM) {
    float mu = dot(light, up);
    // The light under this point's horizon, softened over a sliver.
    float horizon = -sqrt(max(0.0, (r - ${R}) * (r + ${R}))) / r;
    float lit = smoothstep(horizon - 0.012, horizon + 0.012, mu);
    return lit * airSunTransmittance${s}(r, mu) * (sR * pR + sM * pM) + airMultiple${s}(r, mu) * (sR + sM);
  }
  // The light scattered towards the eye along a ray from p (relative to the
  // ground's centre, inside the air) for a length, per unit illuminance of
  // the sun (and of the moon, by \`moon\`), and what comes through (Hillaire's
  // IntegrateScatteredLuminance; each step integrated over its length,
  // Frostbite's energy-conserving form). \`squared\`: samples crowded towards
  // the start, for rays from inside the air.
  void airIntegrate${s}(vec3 p, vec3 rd, float len, float steps, float squared, vec3 sun, vec3 moonDir, float moon, out vec3 L, out vec3 T) {
    L = vec3(0.0);
    T = vec3(1.0);
    // Whole steps that cover the whole length: a fractional count left the
    // last piece of the ray out, and the disc seen from space in rings where
    // the count went up by one (Hillaire's SampleCountFloor / tMaxFloor).
    steps = max(floor(steps), 1.0);
    float cs = dot(rd, sun);
    float pRs = airRayleighPhase(cs), pMs = airMiePhase(cs);
    // The moon's light without its forward glow: the sky-view LUT keeps one
    // side of the sun's plane only, and a glow round the moon there showed on
    // both sides of it.
    float pRm = airRayleighPhase(dot(rd, moonDir)), pMm = 1.0 / (4.0 * AIR_PI);
    for (int i = 0; i < 32; i++) {
      if (float(i) >= steps) break;
      float a = float(i) / steps, b = float(i + 1) / steps;
      a = mix(a, a * a, squared);
      b = mix(b, b * b, squared);
      float dt = (b - a) * len;
      vec3 q = p + rd * (a * len + dt * 0.3);
      float r = length(q);
      vec3 up = q / r;
      vec3 sR; float sM;
      vec3 ext = max(airMedium(r - ${R}, sR, sM), vec3(1e-9));
      vec3 S = airLit${s}(up, r, sun, pRs, pMs, sR, sM);
      if (moon > 0.0) S += moon * airLit${s}(up, r, moonDir, pRm, pMm, sR, sM);
      vec3 stepT = exp(-ext * dt);
      L += T * (S - S * stepT) / ext;
      T *= stepT;
    }
  }
`;

/**
 * The baked LUTs and what is marched through them: the planet's own (the
 * view from space) and those of the ground drawn under the eye (the sky round
 * it and the aerial perspective, `uAirDrawnR`).
 */
const AIR_LIGHT = /* glsl */ `
  ${AIR_MEDIUM}
  uniform sampler2D tAirTransmittance;
  uniform sampler2D tAirMulti;
  uniform sampler2D tAirTransmittanceD;
  uniform sampler2D tAirMultiD;
  // The ground drawn under the eye: its radius and the top of its air.
  uniform float uAirDrawnR;
  uniform float uAirDrawnTop;
  ${lightOver('', 'AIR_R', 'AIR_TOP', 'tAirTransmittance', 'tAirMulti')}
  ${lightOver('D', 'uAirDrawnR', 'uAirDrawnTop', 'tAirTransmittanceD', 'tAirMultiD')}
  // The sky-view LUT's directions (Hillaire's UvToSkyViewLutParams): view
  // zenith cosine and the cosine round from the sun, for an eye at radius r
  // over a ground of radius R.
  void airSkyParams(float R, vec2 uv, float r, out float cosV, out float cosL) {
    uv = vec2(airFromSub(uv.x, ${SKY_W}.0), airFromSub(uv.y, ${SKY_H}.0));
    float beta = acos(sqrt(max(0.0, (r - R) * (r + R))) / r);
    float zh = AIR_PI - beta;
    if (uv.y < 0.5) {
      float c = 1.0 - 2.0 * uv.y;
      c = 1.0 - c * c;
      cosV = cos(zh * c);
    } else {
      float c = uv.y * 2.0 - 1.0;
      cosV = cos(zh + beta * c * c);
    }
    float c = uv.x * uv.x;
    cosL = -(c * 2.0 - 1.0);
  }
  vec2 airSkyUv(float R, bool ground, float cosV, float cosL, float r) {
    float beta = acos(sqrt(max(0.0, (r - R) * (r + R))) / r);
    float zh = AIR_PI - beta;
    vec2 uv;
    float v = acos(clamp(cosV, -1.0, 1.0));
    if (!ground) uv.y = (1.0 - sqrt(max(0.0, 1.0 - v / zh))) * 0.5;
    else uv.y = sqrt(clamp((v - zh) / beta, 0.0, 1.0)) * 0.5 + 0.5;
    uv.x = sqrt(clamp(-cosL * 0.5 + 0.5, 0.0, 1.0));
    return vec2(airToSub(uv.x, ${SKY_W}.0), airToSub(uv.y, ${SKY_H}.0));
  }
`;

/**
 * What the drawn scene reads (the shell, the stars, the sun, the clouds'
 * pass): `airRay` marches a ray from space, `airSky` reads the sky round an
 * eye inside the air, `airPerspective` the air in front of a depth. All
 * return (light, mean transmittance): drawn with ONE, SRC_ALPHA it is the
 * air over whatever lies behind.
 */
export const AIR_GLSL = /* glsl */ `
  ${AIR_LIGHT}
  uniform vec3 uAirCentre;
  // The centre of the ground drawn under the eye (\`uAirDrawnR\`).
  uniform vec3 uAirDrawnCentre;
  uniform vec3 uAirSun;
  uniform float uAirIntensity;
  // 1 with the eye inside the air (the sky-view LUT and the volume made this frame).
  uniform float uAirInside;
  uniform sampler2D tAirSky;
  uniform sampler2D tAirPerspective;
  // The air along a ray from \`eye\` (world space) to the ground, out of the air or \`limit\` away.
  vec4 airRay(vec3 eye, vec3 rd, float limit) {
    vec3 ro = eye - uAirCentre;
    vec2 top = airSphere(ro, rd, AIR_TOP);
    if (top.x > top.y || top.y < 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
    vec2 ground = airSphere(ro, rd, AIR_R);
    float t0 = max(top.x, 0.0);
    float t1 = top.y;
    if (ground.x < ground.y && ground.x > 0.0) t1 = min(t1, ground.x);
    t1 = min(t1, limit);
    if (t1 <= t0) return vec4(0.0, 0.0, 0.0, 1.0);
    // More steps the longer the path through the air (Hillaire's variable count).
    float steps = mix(10.0, 24.0, clamp((t1 - t0) / (AIR_TOP - AIR_R) * 0.25, 0.0, 1.0));
    vec3 L, T;
    airIntegrate(ro + rd * t0, rd, t1 - t0, steps, 0.0, uAirSun, uAirSun, 0.0, L, T);
    return vec4(L * uAirIntensity, dot(T, vec3(1.0 / 3.0)));
  }
  // The sky round an eye inside the air, towards rd: one read of the sky-view
  // LUT, made over the ground drawn under the eye.
  vec4 airSky(vec3 eye, vec3 rd) {
    vec3 p = eye - uAirDrawnCentre;
    float r = max(length(p), uAirDrawnR + 0.5);
    vec3 up = normalize(p);
    float cosV = dot(rd, up);
    vec3 side = cross(up, rd);
    float sl = length(side);
    side = sl > 1e-5 ? side / sl : normalize(cross(up, abs(up.x) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0)));
    vec3 forward = cross(side, up);
    vec2 onPlane = vec2(dot(uAirSun, forward), dot(uAirSun, side));
    float pl = length(onPlane);
    float cosL = pl > 1e-5 ? onPlane.x / pl : 1.0;
    bool ground = cosV < -sqrt(max(0.0, (r - uAirDrawnR) * (r + uAirDrawnR))) / r;
    vec4 s = texture2D(tAirSky, airSkyUv(uAirDrawnR, ground, cosV, cosL, r));
    return vec4(s.rgb * uAirIntensity, s.a);
  }
  // The air between the eye and a depth t along the pixel at uv (the
  // aerial perspective volume, its slices squared towards the eye).
  vec4 airPerspective(vec2 uv, float t) {
    float slice = t / AIR_RANGE * ${SLICES}.0;
    float weight = 1.0;
    if (slice < 0.5) { weight = clamp(slice * 2.0, 0.0, 1.0); slice = 0.5; }
    float w = sqrt(slice / ${SLICES}.0) * ${SLICES}.0 - 0.5;
    w = clamp(w, 0.0, ${SLICES - 1}.0);
    float i0 = floor(w);
    float i1 = min(i0 + 1.0, ${SLICES - 1}.0);
    float x = clamp(uv.x * ${SLICES}.0, 0.5, ${SLICES}.0 - 0.5);
    float y = clamp(uv.y, 0.5 / ${SLICES}.0, 1.0 - 0.5 / ${SLICES}.0);
    vec4 a = texture2D(tAirPerspective, vec2((i0 * ${SLICES}.0 + x) / ${SLICES * SLICES}.0, y));
    vec4 b = texture2D(tAirPerspective, vec2((i1 * ${SLICES}.0 + x) / ${SLICES * SLICES}.0, y));
    vec4 ap = mix(a, b, w - i0);
    return vec4(ap.rgb * weight * uAirIntensity, mix(1.0, ap.a, weight));
  }
`;

const QUAD_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

/** The LUTs are baked over a ground of radius `uR` under an air reaching `uTop`: the planet's own, or the one drawn under the eye. */
const TRANSMITTANCE_FRAGMENT = /* glsl */ `
  ${AIR_MEDIUM}
  uniform float uR;
  uniform float uTop;
  varying vec2 vUv;
  void main() {
    // Bruneton's parameterisation back to a height and a zenith cosine (Hillaire's UvToLutTransmittanceParams).
    float H = sqrt(max(0.0, (uTop - uR) * (uTop + uR)));
    float rho = H * vUv.y;
    float r = sqrt(rho * rho + uR * uR);
    float dMin = uTop - r, dMax = rho + H;
    float d = dMin + vUv.x * (dMax - dMin);
    float mu = d == 0.0 ? 1.0 : clamp((H * H - rho * rho - d * d) / (2.0 * r * d), -1.0, 1.0);
    vec3 p = vec3(0.0, 0.0, r);
    vec3 rd = vec3(0.0, sqrt(1.0 - mu * mu), mu);
    float len = airSphere(p, rd, uTop).y;
    vec3 depth = vec3(0.0);
    const int STEPS = 40;
    float dt = len / float(STEPS);
    for (int i = 0; i < STEPS; i++) {
      vec3 sR; float sM;
      depth += airMedium(length(p + rd * (float(i) + 0.3) * dt) - uR, sR, sM) * dt;
    }
    gl_FragColor = vec4(exp(-depth), 1.0);
  }
`;

const MULTI_FRAGMENT = /* glsl */ `
  ${AIR_MEDIUM}
  uniform float uR;
  uniform float uTop;
  uniform sampler2D tAirTransmittance;
  varying vec2 vUv;
  void main() {
    // Hillaire's NewMultiScattCS: second-order light and the transfer f_ms
    // over 64 directions round a point at this height and sun angle.
    vec2 uv = vec2(airFromSub(vUv.x, ${MULTI}.0), airFromSub(vUv.y, ${MULTI}.0));
    float muS = clamp(uv.x * 2.0 - 1.0, -1.0, 1.0);
    vec3 sun = vec3(0.0, sqrt(max(0.0, 1.0 - muS * muS)), muS);
    float r = uR + clamp(uv.y + 0.001, 0.0, 1.0) * (uTop - uR - 0.01);
    vec3 p0 = vec3(0.0, 0.0, r);
    const float ISO = 1.0 / (4.0 * AIR_PI);
    vec3 L2 = vec3(0.0), fms = vec3(0.0);
    for (int k = 0; k < 64; k++) {
      float theta = 2.0 * AIR_PI * (float(k / 8) + 0.5) / 8.0;
      float phi = acos(1.0 - 2.0 * (float(k - (k / 8) * 8) + 0.5) / 8.0);
      vec3 rd = vec3(cos(theta) * sin(phi), sin(theta) * sin(phi), cos(phi));
      vec2 top = airSphere(p0, rd, uTop);
      vec2 ground = airSphere(p0, rd, uR);
      bool hitsGround = ground.x < ground.y && ground.x > 0.0;
      float len = hitsGround ? ground.x : top.y;
      const int STEPS = 20;
      float dt = len / float(STEPS);
      vec3 T = vec3(1.0), L = vec3(0.0), f = vec3(0.0);
      for (int i = 0; i < STEPS; i++) {
        vec3 q = p0 + rd * (float(i) + 0.3) * dt;
        float rq = length(q);
        vec3 up = q / rq;
        vec3 sR; float sM;
        vec3 ext = max(airMedium(rq - uR, sR, sM), vec3(1e-9));
        vec3 scatter = sR + sM;
        vec3 stepT = exp(-ext * dt);
        float mu = dot(sun, up);
        float horizon = -sqrt(max(0.0, (rq - uR) * (rq + uR))) / rq;
        float lit = mu > horizon ? 1.0 : 0.0;
        vec3 S = lit * texture2D(tAirTransmittance, airTransmittanceUvOn(uR, uTop, rq, mu)).rgb * scatter * ISO;
        L += T * (S - S * stepT) / ext;
        f += T * (scatter - scatter * stepT) / ext;
        T *= stepT;
      }
      if (hitsGround) {
        // The light the ground (a diffuse albedo) sends back up.
        vec3 up = normalize(p0 + rd * len);
        float mu = dot(sun, up);
        L += T * texture2D(tAirTransmittance, airTransmittanceUvOn(uR, uTop, uR, mu)).rgb * max(mu, 0.0) * AIR_ALBEDO / AIR_PI;
      }
      L2 += L / 64.0;
      fms += f / 64.0;
    }
    // Psi_ms = L_2nd / (1 - f_ms): every order beyond the first as a geometric series.
    gl_FragColor = vec4(L2 / (1.0 - min(fms, vec3(0.99))), 1.0);
  }
`;

const SKY_FRAGMENT = /* glsl */ `
  ${AIR_LIGHT}
  uniform float uEyeR;
  uniform float uSunCos;
  uniform float uMoonCos;
  uniform float uMoonSide;
  uniform float uMoon;
  varying vec2 vUv;
  void main() {
    // Over the ground drawn under the eye (uAirDrawnR): its horizon, its air mass.
    float r = max(uEyeR, uAirDrawnR + 0.5);
    float cosV, cosL;
    airSkyParams(uAirDrawnR, vUv, r, cosV, cosL);
    vec3 sun = normalize(vec3(sqrt(max(0.0, 1.0 - uSunCos * uSunCos)), 0.0, uSunCos));
    // The moon in the same frame (the LUT's x runs round from the sun).
    float ms = sqrt(max(0.0, 1.0 - uMoonCos * uMoonCos));
    vec3 moon = vec3(ms * cos(uMoonSide), ms * abs(sin(uMoonSide)), uMoonCos);
    vec3 p = vec3(0.0, 0.0, r);
    float sv = sqrt(max(0.0, 1.0 - cosV * cosV));
    vec3 rd = vec3(sv * cosL, sv * sqrt(max(0.0, 1.0 - cosL * cosL)), cosV);
    vec2 top = airSphere(p, rd, uAirDrawnTop);
    vec2 ground = airSphere(p, rd, uAirDrawnR);
    float len = top.y;
    if (ground.x < ground.y && ground.x > 0.0) len = min(len, ground.x);
    vec3 L, T;
    airIntegrateD(p, rd, len, mix(12.0, 30.0, clamp(len / (uAirDrawnTop - uAirDrawnR) * 0.3, 0.0, 1.0)), 1.0, sun, moon, uMoon, L, T);
    gl_FragColor = vec4(L, dot(T, vec3(1.0 / 3.0)));
  }
`;

const PERSPECTIVE_FRAGMENT = /* glsl */ `
  ${AIR_LIGHT}
  // The centre of the ground drawn under the eye.
  uniform vec3 uCentre;
  uniform vec3 uSun;
  uniform vec3 uMoonDir;
  uniform float uMoon;
  uniform mat4 uProjectionInverse;
  uniform mat4 uCameraWorld;
  vec3 worldAt(vec2 uv, float depth) {
    vec4 view = uProjectionInverse * vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
    return (uCameraWorld * vec4(view.xyz / view.w, 1.0)).xyz;
  }
  void main() {
    float slice = floor(gl_FragCoord.x / ${SLICES}.0);
    vec2 cell = vec2(mod(gl_FragCoord.x, ${SLICES}.0), gl_FragCoord.y) / ${SLICES}.0;
    // From the near plane along the pixel's ray (either camera), as the post pass measures depth.
    vec3 ro = worldAt(cell, 0.0) - uCentre;
    vec3 rd = normalize(worldAt(cell, 0.5) - uCentre - ro);
    float s = (slice + 0.5) / ${SLICES}.0;
    float len = s * s * AIR_RANGE;
    // A cell under the ground is taken on the ground (Hillaire's RenderCameraVolumePS).
    vec3 q = ro + rd * len;
    if (length(q) < uAirDrawnR + 0.5) {
      q = normalize(q) * (uAirDrawnR + 0.5);
      rd = normalize(q - ro);
      len = length(q - ro);
    }
    vec3 L, T;
    airIntegrateD(ro, rd, len, min(24.0, 4.0 + slice), 0.0, uSun, uMoonDir, uMoon, L, T);
    gl_FragColor = vec4(L, dot(T, vec3(1.0 / 3.0)));
  }
`;

export interface AirFrame {
  /** The planet's centre as drawn, the eye, the sun and the moon (unit, three's space). */
  readonly centre: Vector3;
  readonly eye: Vector3;
  readonly sun: Vector3;
  readonly moon: Vector3;
  /** The moon's light on the air, as a share of the sun's (its phase in it). */
  readonly moonLight: number;
  /**
   * The ground drawn under the eye (`bend.ts` planetDrawnSphere): its centre
   * (three's space) and radius, R / k - the planet's own at k = 1.
   */
  readonly drawnCentre: Vector3;
  readonly drawnRadius: number;
}

export interface Air {
  /**
   * The uniforms `AIR_GLSL` reads, shared by every material that draws the
   * air (the same objects: set once here, read by all).
   */
  readonly uniforms: Record<string, { value: unknown }>;
  /** Whether the eye is inside the air this frame (the sky-view LUT and the volume are then in use). */
  readonly inside: boolean;
  /** The LUTs of the ground drawn under the eye baked so far (transmittance, multiple scattering): for the browser checks and the specs. */
  readonly drawnBakes: { readonly transmittance: number; readonly multi: number };
  /** The frame's sky round the eye (inside the air only). */
  update(renderer: WebGLRenderer, frame: AirFrame): void;
  /** The aerial perspective volume for this camera (inside the air only): before the pass that reads it. */
  renderPerspective(renderer: WebGLRenderer, camera: Camera): void;
  dispose(): void;
}

const target = (w: number, h: number): WebGLRenderTarget => {
  const t = new WebGLRenderTarget(w, h, { type: HalfFloatType, depthBuffer: false, magFilter: LinearFilter, minFilter: LinearFilter });
  t.texture.wrapS = t.texture.wrapT = ClampToEdgeWrapping;
  t.texture.generateMipmaps = false;
  return t;
};

const quad = (fragmentShader: string, uniforms: Record<string, { value: unknown }>): FullScreenQuad =>
  new FullScreenQuad(new ShaderMaterial({ uniforms, vertexShader: QUAD_VERTEX, fragmentShader, blending: NoBlending, depthTest: false, depthWrite: false }));

/**
 * The air: the planet's two LUTs baked now, those of the ground drawn under
 * the eye when it moves, the sky and the volume made each frame.
 */
export function createAir(renderer: WebGLRenderer): Air {
  const transmittance = target(256, 64);
  const multi = target(MULTI, MULTI);
  // The same two over the ground drawn under the eye (R / k, `drawnRadius`).
  const transmittanceD = target(256, 64);
  const multiD = target(MULTI, MULTI);
  const sky = target(SKY_W, SKY_H);
  const perspective = target(SLICES * SLICES, SLICES);
  // Every program built ahead, in parallel (KHR_parallel_shader_compile:
  // three's compileAsync), each for the target it draws into, and nothing of
  // the air drawn until they are: built in the frame they were first drawn,
  // the volume's alone stopped the opening for 2 s (profile of 2026-10-10) -
  // drawn while the driver still builds it, a frame waits all the same.
  const quadCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  // FullScreenQuad's own triangle: a program's key holds the geometry's attributes (`postprocess.ts` fullScreenTriangle).
  const quadPlane = fullScreenTriangle();
  const compileFor = (material: Material, into: WebGLRenderTarget): Promise<unknown> => {
    const scene = new Scene();
    scene.add(new Mesh(quadPlane, material));
    const before = renderer.getRenderTarget();
    renderer.setRenderTarget(into);
    const built = renderer.compileAsync(scene, quadCamera).catch(() => {});
    renderer.setRenderTarget(before);
    return built;
  };
  let ready = false;
  // The two bakes, kept: the planet's LUTs once, the drawn ground's whenever it moves.
  const bakeU = { uR: { value: R }, uTop: { value: ATMOSPHERE_TOP } };
  const bake = quad(TRANSMITTANCE_FRAGMENT, bakeU);
  const ms = quad(MULTI_FRAGMENT, { ...bakeU, tAirTransmittance: { value: transmittance.texture } });
  const msU = (ms.material as ShaderMaterial).uniforms;
  /** The LUTs over a ground of radius `radius` into the targets given: the transmittance, then the multiple scattering read from it. */
  const bakeOver = (radius: number, into: WebGLRenderTarget | null, intoMulti: WebGLRenderTarget | null, from: WebGLRenderTarget): void => {
    bakeU.uR.value = radius;
    bakeU.uTop.value = radius + (ATMOSPHERE_TOP - R);
    msU['tAirTransmittance']!.value = from.texture;
    const before = renderer.getRenderTarget();
    if (into) { renderer.setRenderTarget(into); bake.render(renderer); }
    if (intoMulti) { renderer.setRenderTarget(intoMulti); ms.render(renderer); }
    renderer.setRenderTarget(before);
  };
  const baked = Promise.all([compileFor(bake.material, transmittance), compileFor(ms.material, multi)]).then(() => {
    // The planet's two LUTs, once: as soon as their programs are in.
    bakeOver(R, transmittance, multi, transmittance);
  });

  const uniforms: Record<string, { value: unknown }> = {
    uAirCentre: { value: new Vector3() },
    uAirSun: { value: new Vector3(0, 1, 0) },
    uAirIntensity: { value: SUN_ILLUMINANCE },
    uAirInside: { value: 0 },
    tAirTransmittance: { value: transmittance.texture },
    tAirMulti: { value: multi.texture },
    tAirSky: { value: sky.texture },
    tAirPerspective: { value: perspective.texture },
    // The ground drawn under the eye: the planet's own until it is flattened.
    uAirDrawnCentre: { value: new Vector3() },
    uAirDrawnR: { value: R },
    uAirDrawnTop: { value: ATMOSPHERE_TOP },
    tAirTransmittanceD: { value: transmittance.texture },
    tAirMultiD: { value: multi.texture },
  };
  const drawnU = {
    uAirDrawnR: uniforms['uAirDrawnR']!, uAirDrawnTop: uniforms['uAirDrawnTop']!,
    tAirTransmittanceD: uniforms['tAirTransmittanceD']!, tAirMultiD: uniforms['tAirMultiD']!,
  };
  const skyQuad = quad(SKY_FRAGMENT, {
    ...drawnU,
    uEyeR: { value: R }, uSunCos: { value: 1 }, uMoonCos: { value: -1 }, uMoonSide: { value: 0 }, uMoon: { value: 0 },
  });
  const skyU = (skyQuad.material as ShaderMaterial).uniforms;
  const volumeQuad = quad(PERSPECTIVE_FRAGMENT, {
    ...drawnU,
    uCentre: { value: new Vector3() }, uSun: { value: new Vector3() }, uMoonDir: { value: new Vector3() }, uMoon: { value: 0 },
    uProjectionInverse: { value: new Matrix4() }, uCameraWorld: { value: new Matrix4() },
  });
  const volumeU = (volumeQuad.material as ShaderMaterial).uniforms;
  void Promise.all([baked, compileFor(skyQuad.material, sky), compileFor(volumeQuad.material, perspective)])
    .finally(() => { ready = true; quadPlane.dispose(); });
  const up = new Vector3();
  const side = new Vector3();
  const forward = new Vector3();
  const drawnCentre = uniforms['uAirDrawnCentre']!.value as Vector3;
  let inside = false;
  /** The drawn ground's radius its LUTs were last baked for (0: never), and how many times each was. */
  let bakedT = 0, bakedM = 0;
  const drawnBakes = { transmittance: 0, multi: 0 };
  return {
    uniforms,
    get inside() {
      return inside;
    },
    drawnBakes,
    update(gl, frame) {
      (uniforms['uAirCentre']!.value as Vector3).copy(frame.centre);
      (uniforms['uAirSun']!.value as Vector3).copy(frame.sun);
      up.subVectors(frame.eye, frame.centre);
      inside = up.length() < ATMOSPHERE_TOP;
      uniforms['uAirInside']!.value = inside ? 1 : 0;
      // The ground drawn under the eye: the planet itself within half a metre
      // of its radius (at k = 1, and out of the air), else its own sphere and
      // LUTs - baked again only when its radius has moved (`DRAWN_REBAKE`).
      const flattened = Math.abs(frame.drawnRadius - R) > 0.5;
      drawnCentre.copy(flattened ? frame.drawnCentre : frame.centre);
      const groundR = flattened ? frame.drawnRadius : R;
      uniforms['uAirDrawnR']!.value = groundR;
      uniforms['uAirDrawnTop']!.value = groundR + (ATMOSPHERE_TOP - R);
      if (flattened && inside && ready) {
        const redoT = bakedT === 0 || Math.abs(groundR - bakedT) > groundR * DRAWN_REBAKE;
        const redoM = redoT && (bakedM === 0 || Math.abs(groundR - bakedM) > groundR * DRAWN_REBAKE_MULTI);
        if (redoT) {
          bakeOver(groundR, transmittanceD, redoM ? multiD : null, transmittanceD);
          airWork.drawnBakeFrames++;
          bakedT = groundR;
          drawnBakes.transmittance++;
          if (redoM) { bakedM = groundR; drawnBakes.multi++; }
        }
      }
      uniforms['tAirTransmittanceD']!.value = flattened && bakedT > 0 ? transmittanceD.texture : transmittance.texture;
      uniforms['tAirMultiD']!.value = flattened && bakedM > 0 ? multiD.texture : multi.texture;
      up.subVectors(frame.eye, drawnCentre);
      const eyeR = up.length();
      up.divideScalar(Math.max(1e-6, eyeR));
      (volumeU['uCentre']!.value as Vector3).copy(drawnCentre);
      (volumeU['uSun']!.value as Vector3).copy(frame.sun);
      (volumeU['uMoonDir']!.value as Vector3).copy(frame.moon);
      volumeU['uMoon']!.value = frame.moonLight;
      if (!inside || !ready) return;
      // The LUT's frame: the eye's up as z, the sun in the xz plane.
      const sunCos = Math.max(-1, Math.min(1, frame.sun.dot(up)));
      forward.copy(frame.sun).addScaledVector(up, -sunCos);
      if (forward.lengthSq() < 1e-10) forward.set(1, 0, 0).addScaledVector(up, -up.x);
      forward.normalize();
      side.crossVectors(up, forward);
      skyU['uEyeR']!.value = eyeR;
      skyU['uSunCos']!.value = sunCos;
      skyU['uMoonCos']!.value = Math.max(-1, Math.min(1, frame.moon.dot(up)));
      skyU['uMoonSide']!.value = Math.atan2(frame.moon.dot(side), frame.moon.dot(forward));
      skyU['uMoon']!.value = frame.moonLight;
      const previousTarget = gl.getRenderTarget();
      gl.setRenderTarget(sky);
      skyQuad.render(gl);
      gl.setRenderTarget(previousTarget);
    },
    renderPerspective(gl, camera) {
      if (!inside || !ready) return;
      camera.updateMatrixWorld();
      (volumeU['uProjectionInverse']!.value as Matrix4).copy(camera.projectionMatrixInverse);
      (volumeU['uCameraWorld']!.value as Matrix4).copy(camera.matrixWorld);
      const previousTarget = gl.getRenderTarget();
      gl.setRenderTarget(perspective);
      volumeQuad.render(gl);
      gl.setRenderTarget(previousTarget);
    },
    dispose() {
      for (const q of [skyQuad, volumeQuad, bake, ms]) { q.material.dispose(); q.dispose(); }
      for (const t of [transmittance, multi, transmittanceD, multiD, sky, perspective]) t.dispose();
    },
  };
}
