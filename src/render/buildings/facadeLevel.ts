import type { MeshStandardMaterial } from 'three';
import { m } from '@world/units';
import { PULSE_GLSL, ROOM_SEEN_GLSL, type MassingUniforms } from './massingMaterial';
import { ROOM_LAMP_GLSL } from './roomLamps';

/** THE BUILDINGS' FAR LEVEL (L1): the same building emitted again with its walls as runs of bays (`emitChunk` `far`) */

/** How the far level's shader fills a bay's opening (`buildingMesh.ts` `facadeKind` writes the same numbers), after `emitBay`'s panes */
export const FACADE_KIND = { none: 0, window: 1, clear: 2, darkQuarter: 3, darkFifth: 4, door: 5, shutterDoor: 6 } as const;
/** Added to a vertex's kind where its run's bays go against its face's own horizontal (`shellUv`'s t): the shader turns the derived direction round. */
export const FACADE_FLIP = 8;
/** Its run's rain streak times this added to a vertex's kind (`buildingMesh.ts` `streakOf`): the shader darkens the wall under each sill as `emitStreak` does. */
export const FACADE_STREAK = 16;
/** How far under the opening a sill's streak starts, by the run's streak: the windows' sill, the shuttered window's deeper one (`emitBay`). */
export const STREAK_SILL: readonly number[] = [0, m(0.06), m(0.08)];

/** How wide a window's frame reads round its pane, m: the frame part's border (`kit.ts`), with the reveal beside it. */
const FRAME = m(0.08);

/** The detail's materials whose look the far level's openings take (`kit.ts`): the panes, the doors, the shutters, the frames. */
export interface FacadePanes {
  readonly glass: MeshStandardMaterial;
  readonly glassDark: MeshStandardMaterial;
  readonly door: MeshStandardMaterial;
  readonly shutter: MeshStandardMaterial;
  readonly frame: MeshStandardMaterial;
}

const vec3Of = (c: MeshStandardMaterial['color']): string => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
const num = (x: number): string => x.toFixed(4);

/** GLSL: the far level's window grid and its pick of each bay's pane, as `emitBay` picks it (`bayHash`) */
function facadeFragmentPars(p: FacadePanes): string {
  return `
uniform float roomsAwake;
uniform float massingNight;
uniform float roomDaylight;
varying vec4 vFacadeGrid;
varying vec4 vFacadeKey;
varying vec4 vFacadeOpening;
varying vec4 vFacadeTrim;
varying vec3 vFacadeWorld;
// The pixel's shares: wall, frame, glass, door or shutter; the glass's darker pane; the room's light.
float facadeWall = 1.0;
float facadeFrame = 0.0;
float facadeGlass = 0.0;
float facadeSolid = 0.0;
float facadeDark = 0.0;
float facadeShutter = 0.0;
float facadeLit = 0.0;
float facadeStreak = 1.0;
vec3 facadeLamp = vec3(1.0);
${ROOM_LAMP_GLSL}
${PULSE_GLSL('facade')}
// buildingMesh.ts bayHash, to the bit: Math.imul is a uint product, >>> a uint shift.
uint facadeBayHash(int volume, int level, int side, int index, int x7, int y7) {
  uint h = (uint(volume + 1) * 0x27d4eb2du) ^ (uint(level + 7) * 0x165667b1u) ^ (uint(side + 3) * 0x3c6ef372u) ^ (uint(index + 11) * 0x85ebca6bu);
  h ^= (uint(x7) * 0x2c1b3c6du) ^ (uint(y7) * 0x297a2d39u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  return h ^ (h >> 13u);
}
const vec3 FACADE_GLASS = ${vec3Of(p.glass.color)};
const vec3 FACADE_GLASS_DARK = ${vec3Of(p.glassDark.color)};
const vec3 FACADE_DOOR = ${vec3Of(p.door.color)};
const vec3 FACADE_SHUTTER = ${vec3Of(p.shutter.color)};
`;
}

/** GLSL after `color_fragment`: the bay's opening, its frame and its pane or door, by the share of the pixel each covers */
function facadeColour(): string {
  const K = FACADE_KIND;
  return `
vec2 facadeFoot = facadeFootprint(vFacadeGrid.xy);
// What a bay picks for itself (a dark pane, a shutter, a streak) faded to the share of bays that pick it as a bay drops under a few pixels:
// DO NOT let each pixel take one random bay's pick at full contrast (the sparkle of the district's facades).
float facadeSub = smoothstep(0.25, 0.5, max(facadeFoot.x, facadeFoot.y));
int facadeRaw = int(vFacadeKey.x + 0.5);
int facadeKind = facadeRaw & ${FACADE_FLIP - 1};
uint facadeHash = 0u;
if (facadeKind > ${K.none}) {
  vec2 cell = vFacadeGrid.xy;
  float bayW = max(vFacadeGrid.z, 0.01), storeyH = max(vFacadeGrid.w, 0.01);
  vec4 o = vFacadeOpening;
  float fu = ${num(FRAME)} / bayW, fh = ${num(FRAME)} / storeyH;
  float paneAcross = facadePulse(cell.x, facadeFoot.x, o.x + fu, o.y - fu);
  float hole = facadePulse(cell.x, facadeFoot.x, o.x, o.y) * facadePulse(cell.y, facadeFoot.y, o.z, o.w);
  float pane = paneAcross * facadePulse(cell.y, facadeFoot.y, o.z + fh, o.w - fh);
  // The bay under the pixel: its centre on the plan (the piece's middle on its facade line), and its pick.
  float index = floor(cell.x), level = floor(cell.y);
  vec2 centre = vec2(vFacadeWorld.x, -vFacadeWorld.z) + vFacadeKey.zw * (bayW * (index + 0.5 - cell.x));
  int key = int(vFacadeKey.y + 0.5);
  facadeHash = facadeBayHash(key / 4, int(level), key - (key / 4) * 4, int(index), int(floor(centre.x * 7.0 + 0.5)), int(floor(centre.y * 7.0 + 0.5)));
  float darkNear = facadeKind == ${K.window} ? (facadeHash % 20u < 5u ? 1.0 : 0.0)
    : facadeKind == ${K.darkQuarter} ? (facadeHash % 4u == 0u ? 1.0 : 0.0)
    : facadeKind == ${K.darkFifth} ? (facadeHash % 5u == 0u ? 1.0 : 0.0) : 0.0;
  float darkMean = facadeKind == ${K.darkFifth} ? 0.2 : (facadeKind == ${K.window} || facadeKind == ${K.darkQuarter}) ? 0.25 : 0.0;
  facadeDark = mix(darkNear, darkMean, facadeSub);
  facadeFrame = max(hole - pane, 0.0);
  facadeGlass = pane;
  if (facadeKind == ${K.door} || facadeKind == ${K.shutterDoor}) {
    facadeSolid = pane;
    facadeShutter = facadeKind == ${K.shutterDoor} ? 1.0 : 0.0;
    facadeGlass = 0.0;
  } else if (facadeKind == ${K.window}) {
    // A roller shutter part way down in four bays of twenty, from the head.
    uint pick = facadeHash % 20u;
    float solidNear = 0.0;
    if (pick >= 9u && pick < 13u) {
      float down = (o.w - o.z) * (0.25 + float(pick - 9u) * 0.15);
      solidNear = paneAcross * facadePulse(cell.y, facadeFoot.y, o.w - fh - down, o.w - fh);
    }
    // Far, the shutters' share: four bays in twenty, down 0.475 of the opening on average, within the pane.
    float paneH = max(o.w - o.z - 2.0 * fh, 1e-3);
    float solidMean = 0.2 * pane * min(0.475 * (o.w - o.z) / paneH, 1.0);
    facadeSolid = mix(solidNear, solidMean, facadeSub);
    facadeShutter = facadeSolid > 0.0 ? 1.0 : 0.0;
    facadeGlass = max(pane - facadeSolid, 0.0);
  }
  facadeWall = 1.0 - facadeFrame - facadeGlass - facadeSolid;
  // The rain streak under the sill (\`emitStreak\`): two bays in three, darkest at the sill, fading down its reach.
  int streak = facadeRaw / ${FACADE_STREAK};
  if (streak > 0) {
    float sill = o.z * storeyH - (streak == 1 ? ${num(STREAK_SILL[1]!)} : ${num(STREAK_SILL[2]!)});
    float reach = min(sill - ${num(m(0.05))}, ${num(m(0.7))} + float(facadeHash % 7u) * ${num(m(0.12))});
    float am = 0.5 * (o.x + o.y), spread = (o.y - o.x) * (0.32 + float(facadeHash % 5u) * 0.03);
    float bottom = sill - reach, top = sill - ${num(m(0.02))};
    float under = facadePulse(cell.x, facadeFoot.x, am - spread, am + spread) * facadePulse(cell.y, facadeFoot.y, bottom / storeyH, top / storeyH);
    // Two bays in three streaked, each darkest at its sill: far, their share and the ramp's mean.
    float rise = mix(clamp((fract(cell.y) * storeyH - bottom) / max(top - bottom, 1e-3), 0.0, 1.0), 0.5, facadeSub);
    float chosen = mix(facadeHash % 3u != 0u ? 1.0 : 0.0, 2.0 / 3.0, facadeSub);
    facadeStreak = 1.0 - chosen * under * rise * (0.07 + 0.12 * vDecay);
  }
  // The pane scatters next to nothing, as the detail's (\`glassRoom.ts\`: its albedo times 0.06): its sky reflection and the room behind it show (emissive). DO NOT draw it its base colour: black glass read pale blue at this level (the player, 2026-10-20).
  vec3 glassColour = mix(FACADE_GLASS, FACADE_GLASS_DARK, facadeDark) * 0.06;
  vec3 solidColour = mix(FACADE_DOOR, FACADE_SHUTTER, facadeShutter);
  diffuseColor.rgb = diffuseColor.rgb * facadeWall * facadeStreak + vFacadeTrim.rgb * facadeFrame + glassColour * facadeGlass + solidColour * facadeSolid;
  // Its room lit at night: the share awake once the window is under a pixel, its lamp from the mix the detailed panes draw from.
  // By day (\`massingNight\` 0, a uniform: every pixel takes the same branch) no window glows, so none is worked out.
  if (massingNight > 0.0) {
    float lot = float((facadeHash >> 8u) & 1023u) / 1024.0;
    float office = step(0.5, vFacadeTrim.a);
    float sub = smoothstep(0.5, 1.5, max(facadeFoot.x, facadeFoot.y));
    facadeLit = mix(step(1.0 - roomsAwake, lot), roomsAwake, sub);
    facadeLamp = mix(roomLamp(fract(lot * 17.31), office), roomLampMean(office), sub);
  }
}
`;
}

/** Made once with the kit: the far level's material, the shell's own (`finishes.ts`: every finish's maps, weathering, lots), its openings drawn from the window grid with the panes' looks and the massing's night uniforms */
export function createFacadeMaterial(base: MeshStandardMaterial, p: FacadePanes, uniforms: MassingUniforms): MeshStandardMaterial {
  const material = base.clone();
  material.name = 'building-facade';
  const baseCompile = base.onBeforeCompile.bind(base);
  const baseKey = base.customProgramCacheKey.bind(base);
  const solid = (k: 'roughness' | 'metalness' | 'envMapIntensity'): string =>
    `mix(${num(p.door[k])}, ${num(p.shutter[k])}, facadeShutter)`;
  const glass = (k: 'roughness' | 'metalness' | 'envMapIntensity'): string =>
    `mix(${num(p.glass[k])}, ${num(p.glassDark[k])}, facadeDark)`;
  material.onBeforeCompile = (shader, renderer) => {
    shader.uniforms['roomsAwake'] = uniforms.roomsAwake;
    shader.uniforms['massingNight'] = uniforms.massingNight;
    shader.uniforms['roomDaylight'] = uniforms.roomDaylight ?? { value: 0 };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec2 facadeSize;
attribute vec4 facadeCell;
attribute vec4 facadeOpening;
attribute vec4 facadeTrim;
varying vec4 vFacadeGrid;
varying vec4 vFacadeKey;
varying vec4 vFacadeOpening;
varying vec4 vFacadeTrim;
varying vec3 vFacadeWorld;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vFacadeGrid = vec4(facadeCell.xy, facadeSize);
{
  // The run's direction along the facade on the plan: the face's own horizontal (\`shellPlanarUv\`'s t), turned where the bays run the other way.
  int facadeRaw = int(facadeCell.z + 0.5);
  vec3 facadeOut = normalize(mat3(modelMatrix) * objectNormal);
  vec2 facadeAlong = vec2(facadeOut.z, facadeOut.x) / max(length(facadeOut.xz), 1e-6);
  if ((facadeRaw & ${FACADE_FLIP}) != 0) facadeAlong = -facadeAlong;
  vFacadeKey = vec4(float(facadeRaw - (facadeRaw & ${FACADE_FLIP})), facadeCell.w, facadeAlong);
}
vFacadeOpening = facadeOpening;
vFacadeTrim = facadeTrim;
vFacadeWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${facadeFragmentPars(p)}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${facadeColour()}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = roughnessFactor * facadeWall + ${num(p.frame.roughness)} * facadeFrame + ${glass('roughness')} * facadeGlass + ${solid('roughness')} * facadeSolid;`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = metalnessFactor * facadeWall + ${num(p.frame.metalness)} * facadeFrame + ${glass('metalness')} * facadeGlass + ${solid('metalness')} * facadeSolid;`)
      // The opening is flat: the wall's relief stays on the wall.
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize(mix(normal, nonPerturbedNormal, 1.0 - facadeWall));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += (facadeLamp * massingNight * facadeLit + ${ROOM_SEEN_GLSL} * roomDaylight) * facadeGlass * mix(1.0, 0.64, facadeDark);`)
      // The panes reflect the sky as the detail's do (their own envMapIntensity, not the wall's finish's, `shellEnvScale`).
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular ) && defined( USE_ENVMAP )
  radiance *= facadeWall + (${num(p.frame.envMapIntensity)} * facadeFrame + ${glass('envMapIntensity')} * facadeGlass + ${solid('envMapIntensity')} * facadeSolid) / max(envMapIntensity * shellEnvScale, 1e-3);
#endif`);
    // The shell's own after: each of its additions lands right after its chunk, so before these (its finish's map, roughness, metalness and relief first).
    baseCompile(shader, renderer);
  };
  material.customProgramCacheKey = () => `${baseKey()}-facade-level-v7`;
  return material;
}
