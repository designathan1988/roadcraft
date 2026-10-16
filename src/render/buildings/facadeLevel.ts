import type { MeshStandardMaterial } from 'three';
import { FINISHES, type Finish } from '@world/buildings/materials';
import { m } from '@world/units';
import type { MassingUniforms } from './massingMaterial';
import { ROOM_LAMP_GLSL } from './roomLamps';

/** THE BUILDINGS' FAR LEVEL (L1): the same building emitted again with its walls as runs of bays (`emitChunk` `far`) */

/** How the far level's shader fills a bay's opening (`buildingMesh.ts` `facadeKind` writes the same numbers), after `emitBay`'s panes */
export const FACADE_KIND = { none: 0, window: 1, clear: 2, darkQuarter: 3, darkFifth: 4, door: 5, shutterDoor: 6 } as const;

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
vec3 facadeLamp = vec3(1.0);
${ROOM_LAMP_GLSL}
// The integral of a pulse [a0, a1) repeated every 1, from 0 to x.
float facadePulseIntegral(float x, float a0, float a1) { return floor(x) * (a1 - a0) + clamp(fract(x), a0, a1) - a0; }
// The pulse averaged over a pixel's footprint w (a box filter): far away the facade's mean, no moire.
float facadePulse(float x, float w, float a0, float a1) {
  if (a1 <= a0) return 0.0;
  return (facadePulseIntegral(x + 0.5 * w, a0, a1) - facadePulseIntegral(x - 0.5 * w, a0, a1)) / w;
}
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
vec2 facadeFoot = max(fwidth(vFacadeGrid.xy), vec2(1e-4));
int facadeKind = int(vFacadeKey.x + 0.5);
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
  facadeDark = facadeKind == ${K.window} ? (facadeHash % 20u < 5u ? 1.0 : 0.0)
    : facadeKind == ${K.darkQuarter} ? (facadeHash % 4u == 0u ? 1.0 : 0.0)
    : facadeKind == ${K.darkFifth} ? (facadeHash % 5u == 0u ? 1.0 : 0.0) : 0.0;
  facadeFrame = max(hole - pane, 0.0);
  facadeGlass = pane;
  if (facadeKind == ${K.door} || facadeKind == ${K.shutterDoor}) {
    facadeSolid = pane;
    facadeShutter = facadeKind == ${K.shutterDoor} ? 1.0 : 0.0;
    facadeGlass = 0.0;
  } else if (facadeKind == ${K.window}) {
    // A roller shutter part way down in four bays of twenty, from the head.
    uint pick = facadeHash % 20u;
    if (pick >= 9u && pick < 13u) {
      float down = (o.w - o.z) * (0.25 + float(pick - 9u) * 0.15);
      facadeSolid = paneAcross * facadePulse(cell.y, facadeFoot.y, o.w - fh - down, o.w - fh);
      facadeShutter = 1.0;
      facadeGlass = max(pane - facadeSolid, 0.0);
    }
  }
  facadeWall = 1.0 - facadeFrame - facadeGlass - facadeSolid;
  vec3 glassColour = mix(FACADE_GLASS, FACADE_GLASS_DARK, facadeDark);
  vec3 solidColour = mix(FACADE_DOOR, FACADE_SHUTTER, facadeShutter);
  diffuseColor.rgb = diffuseColor.rgb * facadeWall + vFacadeTrim.rgb * facadeFrame + glassColour * facadeGlass + solidColour * facadeSolid;
  // Its room lit at night: the share awake once the window is under a pixel, its lamp from the mix the detailed panes draw from.
  float lot = float((facadeHash >> 8u) & 1023u) / 1024.0;
  float office = step(0.5, vFacadeTrim.a);
  float sub = smoothstep(0.5, 1.5, max(facadeFoot.x, facadeFoot.y));
  facadeLit = mix(step(1.0 - roomsAwake, lot), roomsAwake, sub);
  vec3 meanLamp = office > 0.5
    ? (roomLamp(0.1, 1.0) * 0.5 + roomLamp(0.6, 1.0) * 0.35 + roomLamp(0.95, 1.0) * 0.15)
    : (roomLamp(0.1, 0.0) * 0.36 + roomLamp(0.45, 0.0) * 0.24 + roomLamp(0.65, 0.0) * 0.1 + roomLamp(0.9, 0.0) * 0.3);
  facadeLamp = mix(roomLamp(fract(lot * 17.31), office), meanLamp, sub);
}
`;
}

/** The far level's material of one finish: the finish's own (maps, weathering, lots), its openings drawn from the window grid */
function facadeMaterial(base: MeshStandardMaterial, finish: Finish, p: FacadePanes, uniforms: MassingUniforms): MeshStandardMaterial {
  const material = base.clone();
  material.name = `building-facade-${finish}`;
  const baseCompile = base.onBeforeCompile.bind(base);
  const baseKey = base.customProgramCacheKey.bind(base);
  const solid = (k: 'roughness' | 'metalness' | 'envMapIntensity'): string =>
    `mix(${num(p.door[k])}, ${num(p.shutter[k])}, facadeShutter)`;
  const glass = (k: 'roughness' | 'metalness' | 'envMapIntensity'): string =>
    `mix(${num(p.glass[k])}, ${num(p.glassDark[k])}, facadeDark)`;
  material.onBeforeCompile = (shader, renderer) => {
    baseCompile(shader, renderer);
    shader.uniforms['roomsAwake'] = uniforms.roomsAwake;
    shader.uniforms['massingNight'] = uniforms.massingNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 facadeGrid;
attribute vec4 facadeKey;
attribute vec4 facadeOpening;
attribute vec4 facadeTrim;
varying vec4 vFacadeGrid;
varying vec4 vFacadeKey;
varying vec4 vFacadeOpening;
varying vec4 vFacadeTrim;
varying vec3 vFacadeWorld;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
vFacadeGrid = facadeGrid;
vFacadeKey = facadeKey;
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
totalEmissiveRadiance += facadeLamp * massingNight * facadeLit * facadeGlass * mix(1.0, 0.64, facadeDark);`)
      // The panes reflect the sky as the detail's do (their own envMapIntensity, not the wall's).
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular ) && defined( USE_ENVMAP )
  radiance *= facadeWall + (${num(p.frame.envMapIntensity)} * facadeFrame + ${glass('envMapIntensity')} * facadeGlass + ${solid('envMapIntensity')} * facadeSolid) / max(envMapIntensity, 1e-3);
#endif`);
  };
  material.customProgramCacheKey = () => `${baseKey()}-facade-level-v1`;
  return material;
}

/** Made once with the kit: each finish's far level material (`kit.ts` `shell`, its panes' looks, the massing's night uniforms) */
export function createFacadeMaterials(shell: Readonly<Record<Finish, MeshStandardMaterial>>, panes: FacadePanes, uniforms: MassingUniforms): Record<Finish, MeshStandardMaterial> {
  return Object.fromEntries(FINISHES.map((finish) => [finish, facadeMaterial(shell[finish], finish, panes, uniforms)])) as Record<Finish, MeshStandardMaterial>;
}
