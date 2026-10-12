import {
  FRONT_WIDTH,
  ICE_FRONT,
  ICE_CUT,
  ICE_EDGE,
  ICE_METRES_PER_Z,
  ICE_WANDER,
  ICE_WANDER_MAX,
  PACK_REACH,
} from '@world/planet/ice';
import { m } from '@world/units';

/**
 * THE PLANET'S ICE in the shaders: `world/planet/ice.ts` `iceInside`, written
 * in GLSL with the same integer hash (uint arithmetic wraps as Math.imul
 * does), so the ground's paint (`terrain.ts`) and the sea's pack ice
 * (`ocean.ts`) find the ice's edge where the relief stands it - the white
 * stops at the foot of the cliff, not a cell away. Needs the planet's GLSL
 * (`bend.ts`: `PLANET_R`).
 *
 * Also the ice's bump: three's `perturbNormalArb` (Mikkelsen, "Bump Mapping
 * Unparametrized Surfaces on the GPU": the height's screen derivatives tilt
 * the normal, no tangent frame needed), defined here as three only defines it
 * with a bump map.
 */
const f = (v: number): string => v.toFixed(6);

export const ICE_FIELD_GLSL = `
  float iceHashU(int a, int b, int c, uint salt) {
    uint v = (uint(a) * 374761393u) ^ (uint(b) * 668265263u) ^ (uint(c) * 1440670441u) ^ (salt * 2246822519u);
    v = (v ^ (v >> 13u)) * 1274126177u;
    return float(v ^ (v >> 16u)) / 4294967296.0;
  }
  float iceLayerU(ivec3 c, vec2 sm, int z, uint salt) {
    float top = mix(iceHashU(c.x, c.y, z, salt), iceHashU(c.x + 1, c.y, z, salt), sm.x);
    float bottom = mix(iceHashU(c.x, c.y + 1, z, salt), iceHashU(c.x + 1, c.y + 1, z, salt), sm.x);
    return mix(top, bottom, sm.y);
  }
  // \`ice.ts\` iceNoise at a point of the sphere (world units), 0..1.
  float iceNoise(vec3 p, float scale, uint salt) {
    vec3 g = p / scale, c = floor(g), fr = g - c;
    vec3 sm = fr * fr * (3.0 - 2.0 * fr);
    ivec3 ci = ivec3(c);
    return mix(iceLayerU(ci, sm.xy, ci.z, salt), iceLayerU(ci, sm.xy, ci.z + 1, salt), sm.z);
  }
  // \`ice.ts\` iceInside: world units within the ice's edge at a unit
  // direction (negative outside); y: the same from the edge's broad shape
  // only (its two slow octaves) - the lines the ice flows across, which the
  // crevasses follow (the full edge's ragged metres bent them into snakes).
  vec2 iceInside2(vec3 d) {
    float lat = abs(d.z);
    if (lat < ${f(ICE_CUT)}) return vec2((lat + ${f(ICE_WANDER_MAX)} - ${f(ICE_EDGE)}) * ${f(ICE_METRES_PER_Z)});
    vec3 p = d * PLANET_R;
    float broad = ${ICE_WANDER.slice(0, 2).map(([scale, amplitude, salt]) => `${f(amplitude)} * (2.0 * iceNoise(p, ${f(scale)}, ${salt}u) - 1.0)`).join(' + ')};
    float fine = ${ICE_WANDER.slice(2).map(([scale, amplitude, salt]) => `${f(amplitude)} * (2.0 * iceNoise(p, ${f(scale)}, ${salt}u) - 1.0)`).join(' + ')};
    return vec2(lat + broad + fine - ${f(ICE_EDGE)}, lat + broad - ${f(ICE_EDGE)}) * ${f(ICE_METRES_PER_Z)};
  }
  float iceInside(vec3 d) { return iceInside2(d).x; }
  const float ICE_FRONT_WIDTH = ${f(FRONT_WIDTH)};
  const float ICE_FRONT_HEIGHT = ${f(ICE_FRONT)};
  const float ICE_PACK_REACH = ${f(PACK_REACH)};
  const float ICE_CUT_Z = ${f(ICE_CUT)};
  const float ICE_METRE = ${f(m(1))};
  // three's perturbNormalArb (bumpmap_pars_fragment), Mikkelsen 2010, the
  // surface's screen derivatives taken by the caller (out of any branch, so
  // the rest can be skipped where there is no ice).
  vec3 icePerturbNormal(vec3 sigmaX, vec3 sigmaY, vec3 surfNorm, vec2 dHdxy, float faceDirection) {
    sigmaX = normalize(sigmaX);
    sigmaY = normalize(sigmaY);
    vec3 r1 = cross(sigmaY, surfNorm);
    vec3 r2 = cross(surfNorm, sigmaX);
    float det = dot(sigmaX, r1) * faceDirection;
    vec3 grad = sign(det) * (dHdxy.x * r1 + dHdxy.y * r2);
    return normalize(abs(det) * surfNorm - grad);
  }
`;
