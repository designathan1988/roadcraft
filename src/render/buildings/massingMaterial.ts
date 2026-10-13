import { Color, MeshStandardMaterial } from 'three';
import { ROOM_LAMP_GLSL } from './roomLamps';

/**
 * The material of buildings seen from afar (`massing.ts`): their walls in the
 * colours of the detailed shells, and their windows drawn by the pixel shader
 * from the bays and storeys of each face - the regular spacing of floors and
 * walls a ray needs no geometry for (van Dongen, "Interior Mapping", CGI
 * 2008) - glazed, glossier than the wall, and lit at night as the detailed
 * panes are: the same rooms awake (`roomsAwake`) and the same glow.
 *
 * The windows are box-filtered over the pixel (Inigo Quilez, "Filterable
 * procedurals": the pattern integrated over the footprint `fwidth` gives),
 * so a facade far off settles to its mean tone instead of shimmering, and
 * which rooms are lit fades to the share awake as the windows shrink under
 * a pixel.
 */

/**
 * The glass a window is seen as from afar: what the detailed pane shows by
 * day, the room behind it at a fifth of its colour and the sky's sheen
 * (`kit.ts`), a neutral dark grey - not a blue.
 */
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

export function createMassingMaterial(uniforms: MassingUniforms): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0 });
  material.name = 'building-massing';
  const glass = `vec3(${GLASS.r.toFixed(5)}, ${GLASS.g.toFixed(5)}, ${GLASS.b.toFixed(5)})`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms['roomsAwake'] = uniforms.roomsAwake;
    shader.uniforms['massingNight'] = uniforms.massingNight;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 facade;\nattribute vec2 glazing;\nvarying vec4 vFacade;\nvarying vec2 vGlazing;\nvarying float vHeight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFacade = facade;\nvGlazing = glazing;\nvHeight = position.y;');
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
  // Which room is lit: its own lot near, the share awake once a window is under a pixel.
  vec2 room = floor(cell);
  float seed = fract(vGlazing.y), office = step(1.5, vGlazing.y);
  float lot = fract(sin(dot(room, vec2(12.9898, 78.233)) + seed * 437.585) * 43758.5453);
  float near = step(1.0 - roomsAwake, lot);
  float sub = smoothstep(0.5, 1.5, max(foot.x, foot.y));
  massLit = mix(near, roomsAwake, sub);
  // Its lamp from the mix the detailed panes draw from (\`roomLamps.ts\`);
  // under a pixel, the mix's mean, so a far block holds its colour.
  vec3 meanLamp = office > 0.5
    ? (roomLamp(0.1, 1.0) * 0.5 + roomLamp(0.6, 1.0) * 0.35 + roomLamp(0.95, 1.0) * 0.15)
    : (roomLamp(0.1, 0.0) * 0.36 + roomLamp(0.45, 0.0) * 0.24 + roomLamp(0.65, 0.0) * 0.1 + roomLamp(0.9, 0.0) * 0.3);
  massLamp = mix(roomLamp(fract(lot * 17.31), office), meanLamp, sub);
  // A curtain wall is its own colour (its finish's mean, \`finishes.ts\` \`finishAlbedo\`):
  // painted the windows' glass it turned navy blue from afar while the
  // detailed tower is near black (the player, 2026-10-13: "as cores mudam muito").
  if (share < 0.99) diffuseColor.rgb = mix(diffuseColor.rgb, ${glass}, massGlass);
}`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, massGlass);')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\ntotalEmissiveRadiance += massLamp * massingNight * massLit * massGlass;`);
  };
  material.customProgramCacheKey = () => 'building-massing-lamps';
  return material;
}
