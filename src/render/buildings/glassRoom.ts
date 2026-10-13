import { Color, type MeshStandardMaterial } from 'three';
import { FURNITURE_KINDS } from '@world/buildings/interior';
import { SLOT_WIDTH, litTableDriven, litTexture } from './lightSlots';
import { ROOM_LAMP_GLSL, TV_SHARE } from './roomLamps';

/**
 * The window panes' material: the room behind each pane drawn by interior
 * mapping (`roomBehind.ts` gives its box), what hangs in the window, and the
 * room's light at night. Set once on the kit's glass materials.
 */
export function roomBehindGlass(
  material: MeshStandardMaterial,
  kind: 'glass' | 'glassDark',
  shared: {
    /** The furniture's colours (`furnitureKit.ts` `furnitureTones`). */
    readonly tones: Float32Array;
    readonly roomsAwake: { value: number };
    readonly roomDaylight: { value: number };
    /** Seconds, for a television's flicker. */
    readonly tvClock: { value: number };
  },
): void {
  const { tones, roomsAwake, roomDaylight, tvClock } = shared;
  const lin = (hex: number): string => { const c = new Color().setHex(hex); return `vec3(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)})`; };
  // At night not every window is lit, nor all alike: each pane draws its own
  // lot from where it stands - a third dark, the rest from dim to bright,
  // some cooler (a television) - so a block reads as rooms, not a lamp.
  const glassy = material;
  glassy.onBeforeCompile = (shader) => {
    shader.uniforms.litTable = { value: litTexture };
    shader.uniforms.litTableDriven = litTableDriven;
    shader.uniforms.roomsAwake = roomsAwake;
    shader.uniforms.roomDaylight = roomDaylight;
    shader.uniforms.tvClock = tvClock;
    shader.uniforms.furnitureTone = { value: tones };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
varying float vRoomLot;
varying float vLit;
varying vec2 vPane;
attribute float litSlot;
uniform sampler2D litTable;
uniform float litTableDriven;
uniform float roomsAwake;
attribute vec4 roomA;
attribute vec4 roomB;
attribute vec4 roomC;
varying vec4 vRoomA;
varying vec4 vRoomB;
varying vec4 vRoomC;
varying vec3 vRoomEye;
varying vec3 vRoomRay;
varying vec2 vPaneSize;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vPane = position.xy;
// The room behind the pane (roomBehind.ts), and the view ray in its
// frame: x across the pane, y up, z into the building, metres.
vRoomA = roomA; vRoomB = roomB; vRoomC = roomC;
#ifdef USE_INSTANCING
mat4 paneToWorld = modelMatrix * instanceMatrix;
#else
mat4 paneToWorld = modelMatrix;
#endif
float paneW = length(paneToWorld[0].xyz), paneH = length(paneToWorld[1].xyz);
vec3 paneX = paneToWorld[0].xyz / paneW, paneY = paneToWorld[1].xyz / paneH, paneZ = normalize(paneToWorld[2].xyz);
vec3 sight = (paneToWorld * vec4(position, 1.0)).xyz - cameraPosition;
vRoomEye = vec3(position.x * paneW, position.y * paneH, 0.0);
vPaneSize = vec2(paneW, paneH);
vRoomRay = vec3(dot(sight, paneX), dot(sight, paneY), -dot(sight, paneZ));
#ifdef USE_INSTANCING
vec3 roomAt = instanceMatrix[3].xyz;
#else
vec3 roomAt = vec3(0.0);
#endif
vRoomLot = fract(sin(dot(floor(roomAt * 0.37), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
// The room behind the pane (lightSlots.ts): lit exactly when somebody is
// in it and awake, when a simulation of the residents drives the table.
// Without one (the residents are not simulated) each space draws its own
// lot - every window of a flat with the flat - against the share of people
// awake at this hour (\`roomsAwake\`, ATUS): lit in the evening, most dark
// after midnight. A pane with no room known draws by where it stands.
if (litSlot > -0.5 && litTableDriven > 0.5) {
  vLit = texture2D(litTable, vec2((mod(litSlot, ${SLOT_WIDTH}.0) + 0.5) / ${SLOT_WIDTH}.0, (floor(litSlot / ${SLOT_WIDTH}.0) + 0.5) / 64.0)).r;
} else {
  float spaceLot = litSlot > -0.5 ? fract(sin(litSlot * 12.9898 + 4.1414) * 43758.5453) : vRoomLot;
  vLit = step(1.0 - roomsAwake, spaceLot);
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying float vRoomLot;
varying float vLit;
varying vec2 vPane;
uniform float roomDaylight;
uniform float tvClock;
varying vec4 vRoomA;
varying vec4 vRoomB;
varying vec4 vRoomC;
varying vec3 vRoomEye;
varying vec3 vRoomRay;
varying vec2 vPaneSize;
uniform vec3 furnitureTone[${FURNITURE_KINDS.length}];
float roomHash(float n) { return fract(sin(n * 91.345 + 7.13) * 43758.5453); }
${ROOM_LAMP_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
// The room behind the pane. Where the building's interior is known
// (roomBehind.ts): its own box - side walls, back wall, floor and
// ceiling where the rooms the cut-open view draws have them - traced by
// the view ray (interior mapping, van Dongen 2008: the nearest of the
// room's planes the ray leaves by), its floor wood or stone as that view
// draws it, and the largest piece of its furniture in that piece's own
// colours, as a box in the same place. Lit by its window: brighter by the
// glass, darker deep in, darker in the corners. Elsewhere (a pane with no
// room known), the painted room of before.
vec3 roomSeen;
if (vRoomA.z > 0.05) {
  vec3 o = vRoomEye;
  vec3 d = vRoomRay;
  d = vec3(abs(d.x) < 1e-4 ? 1e-4 : d.x, abs(d.y) < 1e-4 ? 1e-4 : d.y, max(d.z, 1e-4));
  vec3 lo = vec3(-vRoomA.x, -vRoomA.w, 0.0), hi = vec3(vRoomA.y, vRoomB.x, vRoomA.z);
  vec3 tFar = max((lo - o) / d, (hi - o) / d);
  float t = min(min(tFar.x, tFar.y), tFar.z);
  vec3 p = o + d * t;
  vec3 wallC = ${lin(0xece6da)};
  vec3 c;
  float shade;
  if (t == tFar.y && d.y < 0.0) {
    if (vRoomB.y > 1.5) {
      // Porcelain tiles, 60 cm, light, thin joints, a faint sheen of the window on them.
      vec2 tile = fract(vec2(p.x, p.z) / 0.6);
      float joint = step(0.015, tile.x) * step(0.015, tile.y);
      c = ${lin(0xd9d3c7)} * mix(0.8, 1.0, joint) * (0.97 + 0.03 * roomHash(floor(p.x / 0.6) + 17.0 * floor(p.z / 0.6)));
    } else if (vRoomB.y > 0.5) {
      // Stone tiles, 60 cm, their joints.
      vec2 tile = fract(vec2(p.x, p.z) / 0.6);
      float joint = step(0.035, tile.x) * step(0.035, tile.y);
      c = ${lin(0xb9b2a5)} * mix(0.72, 1.0, joint) * (0.94 + 0.06 * roomHash(floor(p.x / 0.6) + 17.0 * floor(p.z / 0.6)));
    } else {
      // Floorboards, 14 cm across, running into the room, each its own shade.
      float board = floor(p.x / 0.14);
      float seam = step(0.06, fract(p.x / 0.14)) * step(0.02, fract((p.z + roomHash(board) * 3.0) / 2.4));
      c = ${lin(0xa27548)} * mix(0.6, 1.0, seam) * (0.85 + 0.25 * roomHash(board));
    }
    shade = 0.85;
  } else if (t == tFar.y) {
    c = ${lin(0xf4f1ea)};
    shade = 0.9;
    if (vRoomB.y > 0.5 && vRoomB.y < 1.5) {
      // An office or a shop: its ceiling's light panels on by day, 60 x 120 cm in a grid.
      vec2 grid = fract(vec2(p.x / 2.4, p.z / 2.4));
      float panel = step(0.35, grid.x) * step(grid.x, 0.6) * step(0.25, grid.y) * step(grid.y, 0.75);
      c = mix(c, vec3(2.6, 2.55, 2.4), panel);
    }
  } else {
    c = wallC;
    // A skirting along the foot of every wall.
    c *= mix(0.62, 1.0, step(0.1, p.y + vRoomA.w));
    shade = t == tFar.x ? 0.72 : 0.84;
    if (t == tFar.z) {
      // On the back wall of a home, a picture or a television, of its own size and place.
      float up = p.y + vRoomA.w;
      float h4 = fract(vRoomLot * 29.17), h5 = fract(vRoomLot * 41.3);
      float cx = (h4 - 0.5) * (vRoomA.x + vRoomA.y) * 0.4 + (vRoomA.y - vRoomA.x) * 0.5;
      if (vRoomB.y > 1.5 || vRoomB.y < 0.5) {
        if (h5 < 0.45) {
          float wide = 0.35 + 0.4 * h4;
          float inside = step(abs(p.x - cx), wide) * step(abs(up - 1.6), 0.3 + 0.15 * h5);
          float rim = inside * (1.0 - step(abs(p.x - cx), wide - 0.04) * step(abs(up - 1.6), 0.26 + 0.15 * h5));
          vec3 art = mix(vec3(0.55, 0.32, 0.2), vec3(0.25, 0.4, 0.55), h4);
          c = mix(c, mix(art, vec3(0.12, 0.1, 0.08), rim), inside);
        } else if (h5 < 0.7) {
          float tv = step(abs(p.x - cx), 0.55) * step(abs(up - 1.25), 0.32);
          c = mix(c, vec3(0.02, 0.02, 0.025), tv);
        }
      }
    }
  }
  // Into the room the daylight falls off; the corners and edges in shade.
  shade *= mix(1.0, 0.42, clamp(p.z / 7.0, 0.0, 1.0));
  vec3 edge = min(p - lo, hi - p);
  float nearEdge = t == tFar.x ? min(edge.y, edge.z) : t == tFar.y ? min(edge.x, edge.z) : min(edge.x, edge.y);
  shade *= mix(0.55, 1.0, smoothstep(0.0, 0.6, nearEdge));
  if (vRoomB.z > -0.5) {
    // The piece of furniture: a box standing on the floor (the slab test).
    vec3 flo = vec3(vRoomC.x - vRoomC.y, -vRoomA.w, vRoomC.z), fhi = vec3(vRoomC.x + vRoomC.y, -vRoomA.w + vRoomB.w, vRoomC.w);
    vec3 fa = (flo - o) / d, fb = (fhi - o) / d;
    vec3 fn = min(fa, fb), ff = max(fa, fb);
    float tn = max(max(fn.x, fn.y), fn.z), tf = min(min(ff.x, ff.y), ff.z);
    if (tn <= tf && tn > 0.0 && tn < t) {
      vec3 q = o + d * tn;
      c = furnitureTone[int(vRoomB.z + 0.5)];
      shade = (tn == fn.y ? 0.95 : tn == fn.x ? 0.62 : 0.78) * mix(1.0, 0.45, clamp(q.z / 7.0, 0.0, 1.0));
      // Its foot in its own shadow on the floor.
      shade *= mix(0.7, 1.0, smoothstep(0.0, 0.25, q.y - flo.y));
    }
  }
  roomSeen = c * shade * 0.9 + diffuseColor.rgb * 0.04;
  {
    // What hangs in the window, 12 cm behind the glass, each room its
    // own: curtains drawn to the sides, a roller blind part way down,
    // venetian slats, a sheer across - or nothing. Lit by the window, so
    // brighter than the room.
    float h1 = fract(vRoomLot * 13.71), h2 = fract(vRoomLot * 7.37), h3 = fract(vRoomLot * 3.13);
    vec3 cq = o + d * ((0.12 - o.z) / d.z);
    vec2 pu = vec2(cq.x / max(vPaneSize.x, 0.1) + 0.5, cq.y / max(vPaneSize.y, 0.1) + 0.5);
    vec3 cloth = h2 < 0.25 ? vec3(0.86, 0.8, 0.68) : h2 < 0.45 ? vec3(0.9, 0.89, 0.86) : h2 < 0.6 ? vec3(0.5, 0.51, 0.53)
      : h2 < 0.72 ? vec3(0.72, 0.6, 0.45) : h2 < 0.84 ? vec3(0.4, 0.47, 0.58) : h2 < 0.93 ? vec3(0.6, 0.34, 0.26) : vec3(0.42, 0.5, 0.38);
    float cover = 0.0;
    vec3 hung = cloth;
    // The weave: a fine grain in the cloth, and the light coming through
    // it brighter at the top of the window than at the foot.
    float weave = 0.94 + 0.06 * roomHash(floor(pu.x * vPaneSize.x * 90.0) + 131.0 * floor(pu.y * vPaneSize.y * 90.0));
    float daylight = 0.85 + 0.25 * clamp(pu.y, 0.0, 1.0);
    if (h1 < 0.36) {
      // Drawn to the sides: gathered in folds (a pleat every 9 cm), each
      // fold lit on one flank and shaded on the other, the cloth's edge a
      // soft wave, its hem a darker band at the foot.
      float side = 0.14 + 0.2 * h3;
      float sway = 0.03 * sin(pu.y * 7.0 + h2 * 6.0);
      float left = step(pu.x, side + sway), right = step(1.0 - side - sway, pu.x);
      cover = clamp(left + right, 0.0, 1.0);
      float fold = sin(pu.x * vPaneSize.x * 70.0 + h3 * 3.0);
      float relief = 0.72 + 0.28 * (0.5 + 0.5 * fold) * (0.6 + 0.4 * fold);
      float hem = mix(0.82, 1.0, step(0.04, pu.y));
      hung = cloth * relief * hem * weave * daylight;
    } else if (h1 < 0.56) {
      // A roller blind part way down: its bar along the bottom, a little
      // light through the cloth.
      float down = 0.15 + 0.65 * h3;
      cover = step(1.0 - down, pu.y);
      float bar = step(abs(pu.y - (1.0 - down)), 0.012);
      hung = mix(cloth * weave * daylight * 0.92, vec3(0.2), bar);
    } else if (h1 < 0.68) {
      float slat = 0.5 + 0.5 * sin(pu.y * vPaneSize.y * 62.0);
      cover = smoothstep(0.3, 0.6, slat) * 0.9;
      hung = vec3(0.78, 0.77, 0.73) * (0.75 + 0.25 * slat) * daylight;
    } else if (h1 < 0.8) {
      // A sheer across the whole window: the room seen dimly through its soft folds.
      float fold = 0.5 + 0.5 * sin(pu.x * vPaneSize.x * 55.0 + h3 * 5.0);
      cover = 0.4 + 0.2 * fold;
      hung = vec3(0.9, 0.89, 0.86) * weave * daylight;
    }
    roomSeen = mix(roomSeen, hung * 0.8, cover);
  }
  // Seen through the glass, less of the room as the glass turns to a
  // mirror towards grazing (Schlick's Fresnel, F0 4 %): what is not
  // transmitted is the sky's reflection, drawn by the lighting.
  float cosView = clamp(abs(vRoomRay.z) / max(length(vRoomRay), 1e-4), 0.0, 1.0);
  roomSeen *= 1.0 - (0.04 + 0.96 * pow(1.0 - cosView, 5.0));
} else {
  float lot = vRoomLot;
  vec3 wallC = mix(vec3(0.78, 0.72, 0.62), vec3(0.62, 0.68, 0.72), step(0.5, fract(lot * 5.3)));
  wallC = mix(wallC, vec3(0.85, 0.8, 0.7), step(0.8, fract(lot * 2.9)));
  float yy = vPane.y + 0.5, xx = vPane.x + 0.5;
  vec3 room = wallC * (0.55 + 0.25 * yy);
  room = mix(room, vec3(0.32, 0.24, 0.18), smoothstep(0.22, 0.12, yy));
  room = mix(room, wallC * 1.05, smoothstep(0.86, 0.95, yy) * 0.6);
  float side = step(0.45, fract(lot * 11.0)) > 0.5 ? xx : 1.0 - xx;
  room = mix(room, vec3(0.86, 0.82, 0.74), step(0.62, fract(lot * 13.0)) * step(side, 0.22));
  float furniture = step(0.5, fract(lot * 17.0)) * step(abs(xx - 0.55), 0.22) * step(yy, 0.42);
  room = mix(room, vec3(0.28, 0.22, 0.18), furniture * 0.85);
  roomSeen = mix(diffuseColor.rgb, room, 0.55);
}
// A pane a few pixels across or less: its own room, its dark or light
// glass and its own reflection averaged into one quiet tone. Each pane
// drawn as its own random shade was the "chuvisco" over every facade from
// the middle distance out (the player, 2026-10-09). Measured on screen
// (\`vPane\` spans the pane), so it holds at any zoom and lens.
float paneTiny = smoothstep(0.12, 0.45, max(fwidth(vPane.x), fwidth(vPane.y)));
roomSeen = mix(roomSeen, vec3(0.42, 0.45, 0.47), paneTiny);
// The glass itself scatters next to nothing: what a pane shows is the
// room through it (sent out below, \`roomDaylight\`) and its Fresnel
// reflection. Lit as a wall, the room took the sun on the facade and
// every sunny pane read as a painted beige panel.
diffuseColor.rgb *= 0.06;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.55, paneTiny);`)
      .replace('#include <envmap_physical_pars_fragment>', `#include <envmap_physical_pars_fragment>`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
// Not every occupied room shows its light (blinds, a lamp in the next
// room): about a third stay dark, and the lit ones range from a dim lamp
// to a bright ceiling light - so a night tower reads as windows, not as a
// sheet of cream (the player, 2026-10-09: "incandescente").
float shown = step(fract(vRoomLot * 5.31), 0.64);
float level = 0.3 + 0.85 * fract(vRoomLot * 7.13) * fract(vRoomLot * 2.17 + 0.4);
float roomLit = shown * (vLit >= 0.0 ? vLit * level : step(0.34, vRoomLot) * level);
// The lamp's colour by the room (\`roomLamps.ts\`): warm or cool white in a
// home, neutral to daylight in an office or a shop (a stone floor), and in
// some homes only the television's blue light, jumping at each cut.
float office = vRoomA.z > 0.05 && vRoomB.y > 0.5 && vRoomB.y < 1.5 ? 1.0 : 0.0;
vec3 roomTint = roomLamp(fract(vRoomLot * 17.31), office);
roomTint = mix(roomTint, tvLight(tvClock, vRoomLot), (1.0 - office) * step(1.0 - ${TV_SHARE.toFixed(2)}, fract(vRoomLot * 3.71)));
// At night the lamp lights the room: its walls, floor and furniture seen, not a sheet of light.
totalEmissiveRadiance *= roomLit * roomTint * (0.35 + 1.3 * clamp(roomSeen / 0.55, 0.0, 1.6));
totalEmissiveRadiance += roomSeen * roomDaylight;`);
  };
  glassy.customProgramCacheKey = () => `room-lights-awake-interior-v9-${kind}`;
}
