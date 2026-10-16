import {
  BoxGeometry,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { laneOffset } from '@world/roadTypes';
import { m } from '@world/units';
import type { SimClient } from '@sim/host/simClient';
import { MESO_INSIDE, MESO_PRESENT, MESO_RECORD, MH, MICRO_RADIUS, ML, MesoMemory } from '@sim/meso/memory';
import { JAM_SPACING } from '@sim/meso/model';

/** THE FAR TRAFFIC: the meso model's cars on every road outside the micro window, as Cidade's density cars, in one draw */
// Each car an instance (its road, place, lane, speed); the vertex shader places it on the road's centreline in a float texture (`texelFetch`).

/** Points of a road's centreline in the texture, evenly spaced along it (a bend between two of them is a straight chord). */
const LINK_POINTS = 8;
/** Texels a row of the centreline texture: a whole number of roads a row. */
const TEX_WIDTH = 1024;
const ROADS_PER_ROW = TEX_WIDTH / LINK_POINTS;
/** Slots the page's first buffer holds (two a segment); a bigger one is made when the worker asks for more (`MesoMemory.wanted`). */
const FIRST_CAPACITY = 1 << 15;
/** How far the view's centre moves from the window's before the window is moved. */
const RECENTRE = MICRO_RADIUS * 0.3;
/** Seconds of the wall a window message may go unanswered (the worker not up yet) before it is sent again. */
const RESEND_MS = 2000;
/** Most far cars drawn: past it the farthest roads' are not written. */
const MOST_CARS = 1 << 18;
/** The shader's clock wraps here (seconds): a float keeps a car's place to a few centimetres. */
const TIME_WRAP = 4096;

/** The car: a body and a cabin, 4.3 m by 1.8 m, its length along x, its width along z, standing on y = 0. */
function carGeometry(): BufferGeometry {
  const body = new BoxGeometry(m(4.3), m(0.75), m(1.8)).translate(0, m(0.2) + m(0.375), 0);
  const cabin = new BoxGeometry(m(2.2), m(0.55), m(1.6)).translate(-m(0.2), m(0.95) + m(0.275), 0);
  for (const g of [body, cabin]) g.deleteAttribute('uv');
  const merged = mergeGeometries([body, cabin], false);
  body.dispose();
  cabin.dispose();
  return merged;
}

const VERTEX_PARS = /* glsl */ `
uniform highp sampler2D uLinks;
uniform float uTime;
uniform vec3 uWindow;
attribute vec4 aLink;
attribute vec4 aMove;
varying vec3 vCarColour;
vec4 linkPoint(float segment, int k) {
  int i = int(segment) * ${LINK_POINTS} + k;
  return texelFetch(uLinks, ivec2(i % ${TEX_WIDTH}, i / ${TEX_WIDTH}), 0);
}
`;

// aLink: segment, place along its travel (m), lateral offset to the right of travel (m), direction (1: from b to a).
// aMove: speed (m/s), the stretch it moves round (0: standing in the queue), seed.
const VERTEX_PLACE = /* glsl */ `
float roadLength = linkPoint(aLink.x, 0).w;
float travel = aMove.y > 0.0 ? mod(aLink.y + aMove.x * uTime, aMove.y) : aLink.y;
float along = aLink.w > 0.5 ? roadLength - travel : travel;
float u = clamp(along / max(roadLength, 0.001), 0.0, 1.0) * float(${LINK_POINTS - 1});
int i0 = int(min(floor(u), float(${LINK_POINTS - 2})));
vec3 p0 = linkPoint(aLink.x, i0).xyz;
vec3 p1 = linkPoint(aLink.x, i0 + 1).xyz;
vec3 carAt = mix(p0, p1, u - float(i0));
vec2 carT = (p1 - p0).xz;
carT = dot(carT, carT) > 1e-8 ? normalize(carT) : vec2(1.0, 0.0);
if (aLink.w > 0.5) carT = -carT;
vec2 carRight = vec2(-carT.y, carT.x);
carAt.xz += carRight * aLink.z;
// Inside the micro window its cars are the micro simulation's: this one is folded to a point (no triangle drawn).
bool carHidden = roadLength <= 0.0 || length(vec2(carAt.x, -carAt.z) - uWindow.xy) < uWindow.z;
vec3 carX = vec3(carT.x, 0.0, carT.y);
vec3 carZ = vec3(carRight.x, 0.0, carRight.y);
float carHash = fract(sin(aMove.z * 12.9898 + 78.233) * 43758.5453);
vCarColour = carHash < 0.24 ? vec3(0.8) : carHash < 0.44 ? vec3(0.03) : carHash < 0.6 ? vec3(0.25)
  : carHash < 0.7 ? vec3(0.45, 0.04, 0.03) : carHash < 0.8 ? vec3(0.05, 0.1, 0.3) : carHash < 0.9 ? vec3(0.5, 0.5, 0.52) : vec3(0.12, 0.2, 0.12);
vec3 objectNormal = carX * normal.x + vec3(0.0, normal.y, 0.0) + carZ * normal.z;
`;

const VERTEX_TRANSFORM = /* glsl */ `
vec3 transformed = carHidden ? carAt : carAt + carX * position.x + vec3(0.0, position.y, 0.0) + carZ * position.z;
`;

export interface DensityCars {
  readonly object: Mesh;
  /** Each frame: the window told the worker, the roads' centrelines the network changed written, the cars of a new meso step written. */
  update(net: Network, sim: SimClient, focusX: number, focusY: number): void;
  dispose(): void;
}

/** `heightAt`: the road's deck at a point (`renderer.ts` deckHeight). */
export function createDensityCars(heightAt: (x: number, y: number, segment: SegmentId) => number): DensityCars {
  let memory = MesoMemory.make(FIRST_CAPACITY);
  let sent: { x: number; y: number; at: number; buffer: SharedArrayBuffer } | null = null;
  let serial = 0;
  let netState: object | null = null;

  // The centrelines, a road a run of `LINK_POINTS` texels: x, height, -y (three's axes) and the road's length.
  let rows = 1;
  let lines = new Float32Array(TEX_WIDTH * rows * 4);
  let texture = makeTexture(lines, rows);
  /** A texture made this frame is uploaded whole at its first draw: no ranges on it (three uploads only the ranges when it has some). */
  let whole = true;
  const uniforms = { uLinks: { value: texture }, uTime: { value: 0 }, uWindow: { value: new Vector3() } };

  const material = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.2 });
  material.onBeforeCompile = (shader) => {
    shader.uniforms['uLinks'] = uniforms.uLinks;
    shader.uniforms['uTime'] = uniforms.uTime;
    shader.uniforms['uWindow'] = uniforms.uWindow;
    shader.vertexShader = VERTEX_PARS + shader.vertexShader
      .replace('#include <beginnormal_vertex>', VERTEX_PLACE)
      .replace('#include <begin_vertex>', VERTEX_TRANSFORM);
    shader.fragmentShader = 'varying vec3 vCarColour;\n' + shader.fragmentShader
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= vCarColour;');
  };
  material.customProgramCacheKey = () => 'density-cars-v1';

  const shape = carGeometry();
  let capacity = 0;
  let link = new Float32Array(0), move = new Float32Array(0);
  let linkAttribute: InstancedBufferAttribute | null = null, moveAttribute: InstancedBufferAttribute | null = null;
  let geometry = makeGeometry(0);
  const mesh = new Mesh(geometry, material);
  mesh.name = 'densityCars';
  // Placed by the shader all over the map: no box to cull it by.
  mesh.frustumCulled = false;
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = false;
  mesh.receiveShadow = true;

  /** A geometry with room for `n` cars (the old one let go: three keeps a geometry's buffers until it is disposed). */
  function makeGeometry(n: number): InstancedBufferGeometry {
    const g = new InstancedBufferGeometry();
    g.index = shape.index;
    g.setAttribute('position', shape.getAttribute('position'));
    g.setAttribute('normal', shape.getAttribute('normal'));
    link = new Float32Array(Math.max(4, n * 4));
    move = new Float32Array(Math.max(4, n * 4));
    linkAttribute = new InstancedBufferAttribute(link, 4).setUsage(DynamicDrawUsage);
    moveAttribute = new InstancedBufferAttribute(move, 4).setUsage(DynamicDrawUsage);
    g.setAttribute('aLink', linkAttribute);
    g.setAttribute('aMove', moveAttribute);
    g.instanceCount = 0;
    capacity = n;
    return g;
  }

  /** Room in the texture for segment `id`: rows doubled, what was written kept. */
  function roomFor(id: number): void {
    const need = Math.floor(id / ROADS_PER_ROW) + 1;
    if (need <= rows) return;
    let next = rows;
    while (next < need) next *= 2;
    const grown = new Float32Array(TEX_WIDTH * next * 4);
    grown.set(lines);
    lines = grown;
    rows = next;
    texture.dispose();
    texture = makeTexture(lines, rows);
    uniforms.uLinks.value = texture;
    whole = true;
  }

  /** One segment's centreline into the texture, its range marked for upload (none: length 0, its cars hidden). */
  function writeLine(net: Network, id: SegmentId): void {
    roomFor(id);
    const at = id * LINK_POINTS * 4;
    const ribbon = net.ribbons.get(id);
    const line = ribbon?.full;
    if (!line || line.length <= 0) lines.fill(0, at, at + LINK_POINTS * 4);
    else {
      for (let k = 0; k < LINK_POINTS; k++) {
        const f = line.sampleAt((line.length * k) / (LINK_POINTS - 1)).p;
        lines[at + k * 4] = f.x;
        lines[at + k * 4 + 1] = heightAt(f.x, f.y, id);
        lines[at + k * 4 + 2] = -f.y;
        lines[at + k * 4 + 3] = line.length;
      }
    }
    if (!whole) texture.addUpdateRange(at, LINK_POINTS * 4);
    texture.needsUpdate = true;
  }

  /** DO NOT write every road again for an edit: only those the network's delta names. */
  function syncLines(net: Network): void {
    if (netState === net.state) return;
    const delta = netState === null ? null : net.changesSince(netState);
    netState = net.state;
    if (delta === null) {
      // @rebuild A map opened: every road's line.
      lines.fill(0);
      texture.clearUpdateRanges();
      whole = true;
      for (const id of net.ribbons.keys()) writeLine(net, id);
      texture.needsUpdate = true;
      return;
    }
    for (const id of delta.segments) writeLine(net, id);
  }

  /** The window told the worker (again when the view moved far enough, the buffer changed, or nobody answered). */
  function tellWindow(sim: SimClient, x: number, y: number): void {
    if (memory.wanted > memory.capacity) {
      let next = memory.capacity;
      while (next < memory.wanted) next *= 2;
      memory = MesoMemory.make(next);
      serial = 0;
    }
    const now = performance.now();
    const moved = !sent || Math.hypot(x - sent.x, y - sent.y) > RECENTRE || sent.buffer !== memory.buffer;
    const unanswered = !!sent && memory.serial === 0 && now - sent.at > RESEND_MS;
    if (!moved && !unanswered) return;
    const cx = moved || !sent ? x : sent.x, cy = moved || !sent ? y : sent.y;
    sim.window(cx, cy, MICRO_RADIUS, memory.buffer);
    sent = { x: cx, y: cy, at: now, buffer: memory.buffer };
  }

  /** The cars of the meso step just written: each road's count, its queue packed at its end, the rest moving round the free stretch. */
  function writeCars(net: Network): void {
    const recs = memory.links;
    let n = 0;
    const put = (segment: number, s: number, lateral: number, dir: number, speed: number, wrap: number, seed: number): void => {
      if (n >= capacity) {
        const old = geometry;
        const keepLink = link, keepMove = move;
        geometry = makeGeometry(Math.min(MOST_CARS, Math.max(1024, capacity * 2)));
        link.set(keepLink.subarray(0, n * 4));
        move.set(keepMove.subarray(0, n * 4));
        mesh.geometry = geometry;
        old.dispose();
      }
      const at = n * 4;
      link[at] = segment; link[at + 1] = s; link[at + 2] = lateral; link[at + 3] = dir;
      move[at] = speed; move[at + 1] = wrap; move[at + 2] = seed; move[at + 3] = 0;
      n++;
    };
    const slots = Math.min(memory.capacity, memory.wanted);
    for (let slot = 0; slot < slots && n < MOST_CARS; slot++) {
      const r = slot * MESO_RECORD;
      const flags = recs[r + ML.flags]!;
      if (!(flags & MESO_PRESENT) || flags & MESO_INSIDE) continue;
      const count = Math.round(recs[r + ML.count]!);
      if (count <= 0) continue;
      const segment = slot >> 1, dir = slot & 1;
      const ribbon = net.ribbons.get(segment as SegmentId);
      const L = ribbon?.full.length ?? 0;
      if (!ribbon || L <= 0) continue;
      const lanes = Math.max(1, Math.round(recs[r + ML.lanes]!));
      const cars = Math.min(count, Math.floor((L * lanes) / JAM_SPACING));
      const queued = Math.min(cars, Math.round(recs[r + ML.queued]!));
      const lateral = (k: number): number => -laneOffset(ribbon.road, k % lanes, ribbon.direction, dir === 0);
      for (let k = 0; k < queued && n < MOST_CARS; k++) {
        put(segment, L - (Math.floor(k / lanes) + 0.5) * JAM_SPACING, lateral(k), dir, 0, 0, slot * 31 + k);
      }
      const free = cars - queued, stretch = Math.max(0, L - Math.ceil(queued / lanes) * JAM_SPACING);
      const speed = recs[r + ML.speed]!;
      for (let k = 0; k < free && stretch > 0 && n < MOST_CARS; k++) {
        put(segment, ((k + 0.5) / free) * stretch, lateral(queued + k), dir, speed, stretch, slot * 31 + queued + k);
      }
    }
    for (const attribute of [linkAttribute!, moveAttribute!]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, n * 4);
      attribute.needsUpdate = true;
    }
    geometry.instanceCount = n;
  }

  return {
    object: mesh,
    update(net, sim, focusX, focusY) {
      // The texture made or rewritten whole last frame was drawn (uploaded whole) since: ranges again from now.
      whole = false;
      tellWindow(sim, focusX, focusY);
      syncLines(net);
      const head = memory.head;
      // The window the worker stands at (its numbers in this step), not the one asked for: its cars and these meet at its edge.
      uniforms.uWindow.value.set(head[MH.windowX]!, head[MH.windowY]!, head[MH.windowR]!);
      uniforms.uTime.value = sim.clock.time % TIME_WRAP;
      const now = memory.serial;
      if (now === serial) return;
      serial = now;
      writeCars(net);
    },
    dispose() {
      geometry.dispose();
      shape.dispose();
      material.dispose();
      texture.dispose();
    },
  };
}

function makeTexture(data: Float32Array, rows: number): DataTexture {
  const t = new DataTexture(data, TEX_WIDTH, rows, RGBAFormat, FloatType);
  t.minFilter = NearestFilter;
  t.magFilter = NearestFilter;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}
