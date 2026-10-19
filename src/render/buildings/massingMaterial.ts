import { Color, MeshDepthMaterial, MeshStandardMaterial } from 'three';
import { ROOM_LAMP_GLSL } from './roomLamps';
import { applyLotOverlay } from '../lotOverlay';

/** The material of buildings seen from afar (`massing.ts`) */

/** The glass a window is seen as from afar */
const GLASS = new Color(0x585f63);
/** Where a window sits in its storey, from the floor (shares of the storey height). */
const SILL = 0.3;
const HEAD = 0.85;

export interface MassingUniforms {
  /** Share of rooms lit at this hour (`kit.ts` `awakeShare`). */
  readonly roomsAwake: { value: number };
  /** How bright a lit window glows (0 by day), as the detailed panes' `emissiveIntensity`. */
  readonly massingNight: { value: number };
}

/** GLSL: a box of a box level laid from its instance (`farTiles.ts` `boxMass`, `massBoxes.ts`): each vertex of the unit box its corner (0-3 counter-clockwise), up (0 foot, 1 top), face (0-3 the wall from that corner, 4 the roof) and end of its wall (0, 1), as the boxes' mesh of masses laid them. */
const BOX_PARS = `
attribute vec4 boxVertex;
attribute vec4 boxA;
attribute vec4 boxB;
attribute vec4 boxC;
attribute vec4 boxD;
attribute vec2 boxE;
vec2 massBoxTurn(vec2 v) { float c = cos(boxB.x), s = sin(boxB.x); return vec2(c * v.x - s * v.y, s * v.x + c * v.y); }
vec3 massBoxPosition() {
  int corner = int(boxVertex.x + 0.5);
  vec2 toward = corner == 0 ? vec2(-1.0, -1.0) : corner == 1 ? vec2(1.0, -1.0) : corner == 2 ? vec2(1.0, 1.0) : vec2(-1.0, 1.0);
  vec2 plan = boxA.xy + massBoxTurn(toward * boxA.zw);
  // Three's axes: the plan's y is -z.
  return vec3(plan.x, mix(boxB.y, boxB.z, boxVertex.y), -plan.y);
}`;

/** GLSL: the rest a box's vertex is laid with in the masses' material: its face and normal. */
const BOX_LOOK = `
int massBoxFace() { return int(boxVertex.z + 0.5); }
vec3 massBoxNormal() {
  int face = massBoxFace();
  if (face == 4) return vec3(0.0, 1.0, 0.0);
  vec2 n = massBoxTurn(face == 0 ? vec2(0.0, -1.0) : face == 1 ? vec2(1.0, 0.0) : face == 2 ? vec2(0.0, 1.0) : vec2(-1.0, 0.0));
  return vec3(n.x, 0.0, -n.y);
}`;

/** The masses' material; `boxes`: the box levels' (`massBoxes.ts`), each box laid from its instance in place of its vertices. */
export function createMassingMaterial(uniforms: MassingUniforms, boxes = false): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  material.name = boxes ? 'building-massing-boxes' : 'building-massing';
  const glass = `vec3(${GLASS.r.toFixed(5)}, ${GLASS.g.toFixed(5)}, ${GLASS.b.toFixed(5)})`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms['roomsAwake'] = uniforms.roomsAwake;
    shader.uniforms['massingNight'] = uniforms.massingNight;
    shader.vertexShader = boxes
      ? shader.vertexShader
        .replace('#include <common>', `#include <common>\n${BOX_PARS}\n${BOX_LOOK}\nvarying vec4 vFacade;\nvarying vec2 vGlazing;\nvarying float vHeight;`)
        // DO NOT assign vColor whole: three r186 declares it vec4 always (`color_pars_vertex`), and a vec3 put in it left the box levels' program uncompiled, every box level drawn as nothing (esc20d, 2026-10-17).
        // A wall's colour, its facade (along it, bay, storey, its floor) and glass; the roof's colour, no windows (bay 0), its seed.
        .replace('#include <color_vertex>', `#include <color_vertex>\nvColor.rgb = massBoxFace() == 4 ? boxD.rgb : boxC.rgb;`)
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = massBoxNormal();')
        .replace('#include <begin_vertex>', `vec3 transformed = massBoxPosition();
{
  int face = massBoxFace();
  float side = face == 0 || face == 2 ? 2.0 * boxA.z : 2.0 * boxA.w;
  vFacade = face == 4 ? vec4(0.0, 0.0, 1.0, 0.0) : vec4(boxVertex.w * side, boxC.w, boxD.w, boxB.w);
  vGlazing = vec2(face == 4 ? 0.0 : boxE.x, boxE.y);
  vHeight = transformed.y;
}`)
      : shader.vertexShader
        // A vertex's facade (along, foot) in full floats, its grid (bay, storey, glass share) in half floats, its seed whole (`cellArrays.ts` `CellMass`).
        .replace('#include <common>', '#include <common>\nattribute vec2 facade;\nattribute vec4 facadeGrid;\nattribute float glazingSeed;\nvarying vec4 vFacade;\nvarying vec2 vGlazing;\nvarying float vHeight;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = vec4(facade.x, facadeGrid.x, facadeGrid.y, facade.y);\nvGlazing = vec2(facadeGrid.z, glazingSeed);\nvHeight = (modelMatrix * vec4(transformed, 1.0)).y;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float roomsAwake;
uniform float massingNight;
varying vec4 vFacade;
varying vec2 vGlazing;
varying float vHeight;
float massGlass = 0.0;
float massLit = 0.0;
vec3 massLamp = vec3(1.0);
${ROOM_LAMP_GLSL}
// The integral of a pulse [a0, a1) repeated every 1, from 0 to x.
float massPulseIntegral(float x, float a0, float a1) { return floor(x) * (a1 - a0) + clamp(fract(x), a0, a1) - a0; }
// The pulse averaged over a pixel's footprint w (a box filter).
float massPulse(float x, float w, float a0, float a1) {
  return (massPulseIntegral(x + 0.5 * w, a0, a1) - massPulseIntegral(x - 0.5 * w, a0, a1)) / w;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
if (vFacade.y > 0.0) {
  // Bays along the face and storeys up it.
  vec2 cell = vec2(vFacade.x / vFacade.y, (vHeight - vFacade.w) / max(vFacade.z, 0.01));
  vec2 foot = max(fwidth(cell), vec2(1e-4));
  float share = vGlazing.x;
  float across = share > 0.99 ? 1.0 : massPulse(cell.x, foot.x, 0.5 - 0.5 * share, 0.5 + 0.5 * share);
  float up = share > 0.99 ? 1.0 : massPulse(cell.y, foot.y, ${SILL.toFixed(2)}, ${HEAD.toFixed(2)});
  massGlass = across * up * step(0.0, cell.y);
  // Which room is lit: its own lot near, the share awake once a window is under a pixel; by day (\`massingNight\` 0, a uniform: one branch for every pixel) none glows, so none is worked out.
  if (massingNight > 0.0) {
    vec2 room = floor(cell);
    float seed = fract(vGlazing.y), office = step(1.5, vGlazing.y);
    float lot = fract(sin(dot(room, vec2(12.9898, 78.233)) + seed * 437.585) * 43758.5453);
    float near = step(1.0 - roomsAwake, lot);
    float sub = smoothstep(0.5, 1.5, max(foot.x, foot.y));
    massLit = mix(near, roomsAwake, sub);
    // Its lamp from the mix the detailed panes draw from (\`roomLamps.ts\`); under a pixel, the mix's mean, so a far block holds its colour.
    massLamp = mix(roomLamp(fract(lot * 17.31), office), roomLampMean(office), sub);
  }
  // A curtain wall is its own colour (its finish's mean, \`finishes.ts\` \`finishAlbedo\`):
  // painted the windows' glass it turned navy blue from afar while the detailed tower is near black
  if (share < 0.99) diffuseColor.rgb = mix(diffuseColor.rgb, ${glass}, massGlass);
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, massGlass);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += massLamp * massingNight * massLit * massGlass;`);
  };
  material.customProgramCacheKey = () => (boxes ? 'building-massing-boxes-v2' : 'building-massing-lamps-v4');
  // A built lot's yard, coloured from afar as up close (`lotOverlay.ts`).
  applyLotOverlay(material, { building: true });
  return material;
}

/** The box levels' shadow: each box laid from its instance, as the masses' material lays it (three's shadow pass takes a mesh's `customDepthMaterial`). */
export function createMassBoxDepth(): MeshDepthMaterial {
  // // No colour: the sun's maps are read by their depth texture alone (three r186 PCF compares `shadow.map.depthTexture`), nothing reads the packed colour (AGT-35).
  const material = new MeshDepthMaterial({ colorWrite: false });
  material.name = 'building-massing-boxes-depth';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${BOX_PARS}`)
      .replace('#include <begin_vertex>', 'vec3 transformed = massBoxPosition();');
  };
  material.customProgramCacheKey = () => 'building-massing-boxes-depth-v1';
  return material;
}
