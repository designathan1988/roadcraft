import { Color, type MeshStandardMaterial } from 'three';
import { FURNITURE_KINDS } from '@world/buildings/interior';
import { ROOM_LAMP_GLSL, TV_SHARE } from './roomLamps';
import { HEAD_SHADE, REVEAL_SHADE, SILL_SHADE } from './roomBehind';

/** The kit's window frame (\`kit.ts\` frameGeometry, its material): its bars in the unit square (border \`t\`, a mullion and a transom 0.8 t wide,
 *  the transom 0.18 up), and how it is lit. */
const FRAME_T = 0.045;
export const PANE_FRAME_LOOK = { roughness: 0.55, metalness: 0.05 } as const;
/** How far in front of its pane a frame's middle stands (\`buildingMesh.ts\` \`glazed\`: the frame put 3 cm out of the glass). */
const FRAME_OUT = 0.03;

/** GLSL: the share of the pixel a pane's frame covers and the normal of the face of it seen (view space), drawn on the pane itself.
 *  Near, each bar is an exact box hit by the eye's ray (a slab test each: front, sides, the bar's depth in front of the glass); its bars
 *  under ~2 pixels, their area box-filtered over the pixel instead (Quilez, "filterable procedurals"), so they neither shimmer nor vanish. */
const PANE_FRAME_GLSL = /* glsl */ `
// The overlap of [a, b] with a pixel's footprint k round x, as a share of k.
float paneSpan(float x, float k, float a, float b) { return clamp((min(x + 0.5 * k, b) - max(x - 0.5 * k, a)) / k, 0.0, 1.0); }
float paneFrameCover(vec2 p, vec3 ray, vec2 size, float thick, inout vec3 nOut, inout vec4 hitOut) {
  vec2 hs = 0.5 * size;
  vec2 t = ${FRAME_T.toFixed(4)} * size;
  // The bars: x0, x1, y0, y1 each (the borders, the mullion, the transom).
  vec4 bars[6];
  bars[0] = vec4(-hs.x, hs.x, hs.y - t.y, hs.y);
  bars[1] = vec4(-hs.x, hs.x, -hs.y, -hs.y + t.y);
  bars[2] = vec4(hs.x - t.x, hs.x, -hs.y, hs.y);
  bars[3] = vec4(-hs.x, -hs.x + t.x, -hs.y, hs.y);
  bars[4] = vec4(-0.4 * t.x, 0.4 * t.x, -hs.y, hs.y);
  bars[5] = vec4(-hs.x, hs.x, 0.18 * size.y - 0.4 * t.y, 0.18 * size.y + 0.4 * t.y);
  vec2 foot = max(fwidth(p), vec2(1e-5));
  float thin = min(0.8 * t.x / foot.x, 0.8 * t.y / foot.y);
  // Far: the bars' area over the pixel (their faces in front of the glass seen square on).
  float coverX = 0.0, coverY = 0.0;
  for (int i = 0; i < 6; i++) {
    vec4 b = bars[i];
    if (b.y - b.x < size.x * 0.99) coverX += paneSpan(p.x, 1.5 * foot.x, b.x, b.y);
    else coverY += paneSpan(p.y, 1.5 * foot.y, b.z, b.w);
  }
  float filtered = 1.0 - (1.0 - clamp(coverX, 0.0, 1.0)) * (1.0 - clamp(coverY, 0.0, 1.0));
  if (thin < 1.0) return filtered;
  // Near: the eye's ray back from the glass (s from 0 at the glass towards the eye) through each bar's box, the frame's depth in front of the glass.
  vec3 d = vec3(abs(ray.x) < 1e-5 ? 1e-5 : ray.x, abs(ray.y) < 1e-5 ? 1e-5 : ray.y, max(ray.z, 1e-5));
  float zNear = ${FRAME_OUT.toFixed(3)} + 0.5 * thick, zFar = ${FRAME_OUT.toFixed(3)} - 0.5 * thick;
  float sz0 = max(zFar, 0.0) / d.z, sz1 = zNear / d.z;
  float best = -1.0;
  vec3 face = vec3(0.0, 0.0, 1.0);
  for (int i = 0; i < 6; i++) {
    vec4 b = bars[i];
    float sx0 = (p.x - b.y) / d.x, sx1 = (p.x - b.x) / d.x;
    float sy0 = (p.y - b.w) / d.y, sy1 = (p.y - b.z) / d.y;
    vec2 sx = vec2(min(sx0, sx1), max(sx0, sx1)), sy = vec2(min(sy0, sy1), max(sy0, sy1));
    float lo = max(max(sx.x, sy.x), sz0), hi = min(min(sx.y, sy.y), sz1);
    if (lo <= hi && hi > best) {
      best = hi;
      // The face the ray comes in by, from the eye's side: the bound that closes the interval first.
      face = hi == sz1 ? vec3(0.0, 0.0, 1.0) : hi == sx.y ? vec3(-sign(d.x), 0.0, 0.0) : vec3(0.0, -sign(d.y), 0.0);
    }
  }
  float exact = best >= 0.0 ? 1.0 : 0.0;
  if (exact > 0.5) nOut = normalize(vPaneXv * face.x + vPaneYv * face.y + vPaneZv * face.z);
  // The face met (its z towards the eye) and how far in front of the glass along the ray: where a recessed pane lights it.
  if (exact > 0.5) hitOut = vec4(face, best);
  return mix(filtered, exact, smoothstep(1.0, 2.0, thin));
}`;

/** How an opening's reveals are drawn (`PANE_RECESS_GLSL`), as the shell's trim finishes are (`bake/finishRecipes.ts`: render, stone and
 *  concrete): their maps' mean albedo, their roughness, the sky's share they reflect. */
const REVEAL_LOOK = { albedo: 0.9, roughness: 0.9, env: 0.55 } as const;

/** GLSL, first in the pane's colour: a pane laid on the wall's face (`buildingMesh.ts` glazedRecessed, its glass `vRoomE.x` behind it). The
 *  eye's ray into the opening's box meets a side, the sill, the head or the glass, each an exact ray-plane hit (no loop, no texture: Quilez,
 *  box functions, https://iquilezles.org/articles/boxfunctions; van Dongen, interior mapping, 2008). The frame stands in front of the glass,
 *  so a side met behind the frame's front is the frame's (`paneFrameCover` finds it from the glass, and says where). DO NOT write
 *  `gl_FragDepth`: the pane stays at the wall's face, early depth kept (Qualcomm, Adreno best practices). */
const PANE_RECESS_GLSL = /* glsl */ `
vec3 paneEye = vRoomEye;
vec2 paneUv = vPane;
float paneSolid = 0.0;
vec3 paneSolidColour = vec3(0.0);
vec3 paneSolidNormal = vPaneZv;
// The point met in the recess (pane-local: x, y on the face, z into the wall) and its outward normal there.
vec3 paneHit = vec3(0.0);
vec3 paneHitNormal = vec3(0.0, 0.0, -1.0);
vec3 paneRay = vec3(abs(vRoomRay.x) < 1e-5 ? 1e-5 : vRoomRay.x, abs(vRoomRay.y) < 1e-5 ? 1e-5 : vRoomRay.y, max(vRoomRay.z, 1e-5));
if (vRoomE.x > 0.0) {
  float deep = vRoomE.x;
  vec2 hs = 0.5 * vPaneSize;
  vec3 o = vRoomEye;
  vec3 d = paneRay;
  float tGlass = deep / d.z;
  float tx = ((d.x > 0.0 ? hs.x : -hs.x) - o.x) / d.x;
  float ty = ((d.y > 0.0 ? hs.y : -hs.y) - o.y) / d.y;
  float tSide = min(tx, ty);
  float tFront = vRoomD.w > 0.0 ? max(deep - ${FRAME_OUT.toFixed(3)} - 0.5 * vRoomD.w, 0.0) / d.z : tGlass;
  vec3 p = o + d * tGlass;
  if (tSide < tFront) {
    p = o + d * tSide;
    paneSolid = 1.0;
    paneHitNormal = tx < ty ? vec3(-sign(d.x), 0.0, 0.0) : vec3(0.0, d.y < 0.0 ? 1.0 : -1.0, 0.0);
    paneSolidColour = vRoomD.rgb * ${REVEAL_LOOK.albedo.toFixed(2)} * (tx < ty ? ${REVEAL_SHADE.toFixed(4)} : d.y < 0.0 ? ${SILL_SHADE.toFixed(4)} : ${HEAD_SHADE.toFixed(4)});
    // The pane's z runs into the wall: in view space its axes, the face's outward one turned.
    paneSolidNormal = normalize(vPaneXv * paneHitNormal.x + vPaneYv * paneHitNormal.y - vPaneZv * paneHitNormal.z);
  }
  paneHit = p;
  paneEye = vec3(p.xy, 0.0);
  paneUv = p.xy / max(vPaneSize, vec2(1e-4));
}
`;

/** GLSL, after the frame: the light at the point met in a recess (`PANE_RECESS_GLSL`), on a side, the glass or the frame's face.
 *  The sun reaches it where its ray back to the sun leaves by the opening, not where the wall round it stands: the recess's own shadow,
 *  exact, where the shadow map's texels are a hand wide. The sky reaches it by the opening alone: the share of its hemisphere the opening
 *  fills, cosine-weighted, Lambert's form factor of a polygon (exact, four edges; Baum, Rushmeier and Winget 1989, "Improving radiosity
 *  solutions through the use of analytically determined form-factors"). DO NOT leave the recess to the screen's ambient occlusion: the pane
 *  lies flat on the wall and GTAO, reading depth, never sees the hole it darkened when the reveals were faces. */
const PANE_RECESS_LIGHT_GLSL = /* glsl */ `
float paneSunLit = 1.0;
float paneOpen = 1.0;
if (vRoomE.x > 0.0) {
  vec2 hs = 0.5 * vPaneSize;
  vec3 q = paneHit;
  vec3 n = paneHitNormal;
  if (paneFrameHit.w >= 0.0) {
    q = vec3(paneEye.xy - paneRay.xy * paneFrameHit.w, vRoomE.x - paneRay.z * paneFrameHit.w);
    n = vec3(paneFrameHit.x, paneFrameHit.y, -paneFrameHit.z);
  }
  // Off the surface a hair, so a point on a side sees the opening's edge in that side's plane on the right side.
  q += n * 1e-3;
#if NUM_DIR_LIGHTS > 0
  vec3 toSun = directionalLights[0].direction;
  vec3 s = vec3(dot(toSun, vPaneXv), dot(toSun, vPaneYv), -dot(toSun, vPaneZv));
  vec2 out2 = q.xy + s.xy * (q.z / max(-s.z, 1e-5));
  paneSunLit = s.z < -1e-4 ? step(abs(out2.x), hs.x) * step(abs(out2.y), hs.y) : 0.0;
#endif
  vec3 c0 = normalize(vec3(-hs.x, -hs.y, 0.0) - q), c1 = normalize(vec3(hs.x, -hs.y, 0.0) - q);
  vec3 c2 = normalize(vec3(hs.x, hs.y, 0.0) - q), c3 = normalize(vec3(-hs.x, hs.y, 0.0) - q);
  vec3 e = acos(clamp(dot(c0, c1), -1.0, 1.0)) * normalize(cross(c0, c1) + 1e-9)
    + acos(clamp(dot(c1, c2), -1.0, 1.0)) * normalize(cross(c1, c2) + 1e-9)
    + acos(clamp(dot(c2, c3), -1.0, 1.0)) * normalize(cross(c2, c3) + 1e-9)
    + acos(clamp(dot(c3, c0), -1.0, 1.0)) * normalize(cross(c3, c0) + 1e-9);
  paneOpen = clamp(abs(dot(e, n)) / ${(2 * Math.PI).toFixed(6)}, 0.0, 1.0);
}
`;

/** The window panes' material: the room behind each pane drawn by interior mapping */
export function roomBehindGlass(
  material: MeshStandardMaterial,
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
  // At night not every window is lit, nor all alike: each pane draws its own lot from where it stands
  const glassy = material;
  glassy.onBeforeCompile = (shader) => {
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
uniform float roomsAwake;
attribute vec4 roomA;
attribute vec4 roomB;
attribute vec4 roomC;
attribute vec4 roomD;
attribute vec4 roomE;
varying vec4 vRoomD;
varying vec4 vRoomE;
varying vec3 vPaneXv;
varying vec3 vPaneYv;
varying vec3 vPaneZv;
varying vec4 vRoomA;
varying vec4 vRoomB;
varying vec4 vRoomC;
varying vec3 vRoomEye;
varying vec3 vRoomRay;
varying vec2 vPaneSize;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vPane = position.xy;
// The room behind the pane (roomBehind.ts), and the view ray in its frame
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
// The pane's frame (\`PANE_FRAME_GLSL\`): its trim and thickness, and the pane's axes in view space for its bars' faces.
vRoomD = roomD;
vRoomE = roomE;
vPaneXv = (viewMatrix * vec4(paneX, 0.0)).xyz;
vPaneYv = (viewMatrix * vec4(paneY, 0.0)).xyz;
vPaneZv = (viewMatrix * vec4(paneZ, 0.0)).xyz;
#ifdef USE_INSTANCING
// Where the glass stands: a recessed pane's (laid on the wall's face, \`glazedRecessed\`) its depth back along its normal, so each window draws
// the same room, blinds and lamp as when the glass was its place.
vec3 roomAt = instanceMatrix[3].xyz - normalize(instanceMatrix[2].xyz) * roomE.x;
#else
vec3 roomAt = vec3(0.0);
#endif
vRoomLot = fract(sin(dot(floor(roomAt * 0.37), vec3(12.9898, 78.233, 37.719))) * 43758.5453);
// The room behind the pane (lightSlots.ts): each space draws its own lot from its seed
// of people awake at this hour (\`roomsAwake\`, ATUS): lit in the evening,
// most dark after midnight. A pane with no room known draws by where it stands.
float spaceLot = litSlot > -0.5 ? fract(sin(litSlot * 12.9898 + 4.1414) * 43758.5453) : vRoomLot;
vLit = step(1.0 - roomsAwake, spaceLot);`);
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
varying vec4 vRoomD;
varying vec4 vRoomE;
varying vec3 vPaneXv;
varying vec3 vPaneYv;
varying vec3 vPaneZv;
varying vec3 vRoomEye;
varying vec3 vRoomRay;
varying vec2 vPaneSize;
${PANE_FRAME_GLSL}
uniform vec3 furnitureTone[${FURNITURE_KINDS.length}];
float roomHash(float n) { return fract(sin(n * 91.345 + 7.13) * 43758.5453); }
${ROOM_LAMP_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
// A pane a few pixels across or less (\`vPane\` spans the pane), so it holds at any zoom and lens: worked out first, a pane under it shows its mean alone and its room is never looked into.
// Faded from ~20 px a pane down to ~3: past that the room's furniture, blinds and frames are under a pixel each and only shimmer (the town's towers read as noise, the player, 2026-10-20), and a pane faded skips the room's trace.
float paneTiny = smoothstep(0.05, 0.3, max(fwidth(vPane.x), fwidth(vPane.y)));
vec3 roomSeen = vec3(0.42, 0.45, 0.47);
${PANE_RECESS_GLSL}
// The frame over the pane: how much of the pixel it covers, and the face of it seen.
float paneFrame = 0.0;
vec3 paneFrameNormal = vPaneZv;
vec4 paneFrameHit = vec4(-1.0);
if (vRoomD.w > 0.0 && paneSolid < 0.5) paneFrame = paneFrameCover(paneEye.xy, vRoomRay, vPaneSize, vRoomD.w, paneFrameNormal, paneFrameHit);
${PANE_RECESS_LIGHT_GLSL}
if (paneTiny < 1.0 && paneFrame < 1.0 && paneSolid < 0.5) {
if (vRoomA.z > 0.05) {
  vec3 o = paneEye;
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
    // What hangs in the window, 12 cm behind the glass, each room its own
    float h1 = fract(vRoomLot * 13.71), h2 = fract(vRoomLot * 7.37), h3 = fract(vRoomLot * 3.13);
    vec3 cq = o + d * ((0.12 - o.z) / d.z);
    vec2 pu = vec2(cq.x / max(vPaneSize.x, 0.1) + 0.5, cq.y / max(vPaneSize.y, 0.1) + 0.5);
    vec3 cloth = h2 < 0.25 ? vec3(0.86, 0.8, 0.68) : h2 < 0.45 ? vec3(0.9, 0.89, 0.86) : h2 < 0.6 ? vec3(0.5, 0.51, 0.53)
      : h2 < 0.72 ? vec3(0.72, 0.6, 0.45) : h2 < 0.84 ? vec3(0.4, 0.47, 0.58) : h2 < 0.93 ? vec3(0.6, 0.34, 0.26) : vec3(0.42, 0.5, 0.38);
    float cover = 0.0;
    vec3 hung = cloth;
    // The weave: a fine grain in the cloth
    float weave = 0.94 + 0.06 * roomHash(floor(pu.x * vPaneSize.x * 90.0) + 131.0 * floor(pu.y * vPaneSize.y * 90.0));
    float daylight = 0.85 + 0.25 * clamp(pu.y, 0.0, 1.0);
    if (h1 < 0.36) {
      // Drawn to the sides: gathered in folds
      float side = 0.14 + 0.2 * h3;
      float sway = 0.03 * sin(pu.y * 7.0 + h2 * 6.0);
      float left = step(pu.x, side + sway), right = step(1.0 - side - sway, pu.x);
      cover = clamp(left + right, 0.0, 1.0);
      float fold = sin(pu.x * vPaneSize.x * 70.0 + h3 * 3.0);
      float relief = 0.72 + 0.28 * (0.5 + 0.5 * fold) * (0.6 + 0.4 * fold);
      float hem = mix(0.82, 1.0, step(0.04, pu.y));
      hung = cloth * relief * hem * weave * daylight;
    } else if (h1 < 0.56) {
      // A roller blind part way down: its bar along the bottom, a little light through the cloth.
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
  // Seen through the glass, less of the room as the glass turns to a mirror towards grazing (Schlick's Fresnel, F0 4 %)
  float cosView = clamp(abs(vRoomRay.z) / max(length(vRoomRay), 1e-4), 0.0, 1.0);
  roomSeen *= 1.0 - (0.04 + 0.96 * pow(1.0 - cosView, 5.0));
} else {
  float lot = vRoomLot;
  vec3 wallC = mix(vec3(0.78, 0.72, 0.62), vec3(0.62, 0.68, 0.72), step(0.5, fract(lot * 5.3)));
  wallC = mix(wallC, vec3(0.85, 0.8, 0.7), step(0.8, fract(lot * 2.9)));
  float yy = paneUv.y + 0.5, xx = paneUv.x + 0.5;
  vec3 room = wallC * (0.55 + 0.25 * yy);
  room = mix(room, vec3(0.32, 0.24, 0.18), smoothstep(0.22, 0.12, yy));
  room = mix(room, wallC * 1.05, smoothstep(0.86, 0.95, yy) * 0.6);
  float side = step(0.45, fract(lot * 11.0)) > 0.5 ? xx : 1.0 - xx;
  room = mix(room, vec3(0.86, 0.82, 0.74), step(0.62, fract(lot * 13.0)) * step(side, 0.22));
  float furniture = step(0.5, fract(lot * 17.0)) * step(abs(xx - 0.55), 0.22) * step(yy, 0.42);
  room = mix(room, vec3(0.28, 0.22, 0.18), furniture * 0.85);
  roomSeen = mix(diffuseColor.rgb, room, 0.55);
}
roomSeen = mix(roomSeen, vec3(0.42, 0.45, 0.47), paneTiny);
}
// The glass itself scatters next to nothing: what a pane shows is the
// room through it (sent out below, \`roomDaylight\`) and its Fresnel
// reflection. The frame is its trim, lit as the frames' own material is.
diffuseColor.rgb = mix(diffuseColor.rgb * 0.06, vRoomD.rgb, paneFrame);
// A reveal met: its own tone of the trim, matt (\`PANE_RECESS_GLSL\`).
diffuseColor.rgb = mix(diffuseColor.rgb, paneSolidColour, paneSolid);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(mix(mix(roughnessFactor, 0.55, paneTiny), ${PANE_FRAME_LOOK.roughness.toFixed(2)}, paneFrame), ${REVEAL_LOOK.roughness.toFixed(2)}, paneSolid);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(mix(metalnessFactor, ${PANE_FRAME_LOOK.metalness.toFixed(2)}, paneFrame), 0.0, paneSolid);`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize(mix(normal, paneFrameNormal, step(0.5, paneFrame)));
normal = normalize(mix(normal, paneSolidNormal, paneSolid));`)
      .replace('#include <lights_fragment_maps>', `#include <lights_fragment_maps>
#if defined( RE_IndirectSpecular ) && defined( USE_ENVMAP )
  // The frame and the reveals take the sky's light as their own materials do (the frames' envMapIntensity 1, the trim's finish), not as
  // the glass: its reflection and its diffuse light alike (three scales both, \`getIBLIrradiance\`, \`getIBLRadiance\`).
  float paneEnv = mix(mix(1.0, 1.0 / max(envMapIntensity, 1e-3), paneFrame), ${REVEAL_LOOK.env.toFixed(2)} / max(envMapIntensity, 1e-3), paneSolid);
  radiance *= paneEnv;
  iblIrradiance *= paneEnv;
#endif
// The sky into a recess: the share of it the opening lets in (\`PANE_RECESS_LIGHT_GLSL\`).
irradiance *= paneOpen;
iblIrradiance *= paneOpen;
#if defined( RE_IndirectSpecular ) && defined( USE_ENVMAP )
  radiance *= paneOpen;
#endif`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
// The sun into a recess: none where the wall round the opening stands between (\`PANE_RECESS_GLSL\`).
reflectedLight.directDiffuse *= paneSunLit;
reflectedLight.directSpecular *= paneSunLit;`)
      .replace('#include <envmap_physical_pars_fragment>', `#include <envmap_physical_pars_fragment>`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
// Not every occupied room shows its light (blinds, a lamp in the next room); by day the lamp's emissive is 0 (a uniform: one branch for every pixel) and none is worked out.
if (totalEmissiveRadiance != vec3(0.0)) {
float shown = step(fract(vRoomLot * 5.31), 0.64);
float level = 0.3 + 0.85 * fract(vRoomLot * 7.13) * fract(vRoomLot * 2.17 + 0.4);
float roomLit = shown * (vLit >= 0.0 ? vLit * level : step(0.34, vRoomLot) * level);
// The lamp's colour by the room (\`roomLamps.ts\`): warm or cool white in a
// home, neutral to daylight in an office or a shop
float office = vRoomA.z > 0.05 && vRoomB.y > 0.5 && vRoomB.y < 1.5 ? 1.0 : 0.0;
vec3 roomTint = roomLamp(fract(vRoomLot * 17.31), office);
roomTint = mix(roomTint, tvLight(tvClock, vRoomLot), (1.0 - office) * step(1.0 - ${TV_SHARE.toFixed(2)}, fract(vRoomLot * 3.71)));
// At night the lamp lights the room: its walls, floor and furniture seen, not a sheet of light.
totalEmissiveRadiance *= roomLit * roomTint * (0.35 + 1.3 * clamp(roomSeen / 0.55, 0.0, 1.6));
}
totalEmissiveRadiance += roomSeen * roomDaylight;
// The frame and the reveals show no room and no lamp.
totalEmissiveRadiance *= 1.0 - max(paneFrame, paneSolid);`);
  };
  // One key for the clear and the dark panes: their source is the same (no number of the kind in it), so one program (r186 `WebGLRenderer.getProgram`: each material its own uniforms, the program shared by key).
  glassy.customProgramCacheKey = () => 'room-lights-awake-interior-v15-recess';
}
