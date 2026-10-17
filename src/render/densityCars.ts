import {
  BoxGeometry,
  DataTexture,
  DynamicDrawUsage,
  FloatType,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  Sphere,
  Vector3,
  type BufferGeometry,
} from 'three';
import { TILE } from '@world/tiles';
import { pinned } from './pinned';
import { TERRAIN_MAX_HEIGHT, TERRAIN_MIN_HEIGHT } from '@world/terrain';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Network } from '@world/network';
import type { SegmentId } from '@world/ids';
import { laneOffset } from '@world/roadTypes';
import { m } from '@world/units';
import type { SimClient } from '@sim/host/simClient';
import { MESO_INSIDE, MESO_ONE_WAY, MESO_PRESENT, MESO_RECORD, MH, MICRO_RADIUS, ML, MesoMemory } from '@sim/meso/memory';
import { JAM_SPACING } from '@sim/meso/model';
import { linkDirection, linkSegment } from '@sim/meso/tileLinks';

/** THE FAR TRAFFIC: the meso model's cars on every road outside the micro window, as Cidade's density cars, a draw a tile */
/** DO NOT write every far car again at each meso step nor draw the tiles off the view: each link's cars belong to the tile of its middle, a mesh a tile culled by its sphere, and only the tiles where a link's numbers changed are written and sent. */
// Each car an instance (its link's slot, place, lane, speed); the vertex shader places it on the link's road in a float texture (`texelFetch`):
// the page's roads by their centreline, the far tiles' straight through the start, middle and end their link tables give (`meso/tileLinks.ts`).

/** Points of a road's centreline in the texture, evenly spaced along it (a bend between two of them is a straight chord). */
const LINK_POINTS = 8;
/** Texels a row of the centreline texture: a whole number of roads a row. */
const TEX_WIDTH = 1024;
const ROADS_PER_ROW = TEX_WIDTH / LINK_POINTS;
/** Slots the page's first buffer holds; a bigger one is made when the worker asks for more (`MesoMemory.wanted`). */
const FIRST_CAPACITY = 1 << 15;
/** How far the view's centre moves from the window's before the window is moved. */
const RECENTRE = MICRO_RADIUS * 0.3;
/** Seconds of the wall a window message may go unanswered (the worker not up yet) before it is sent again. */
const RESEND_MS = 2000;
/** Most far cars drawn: past it the roads of a tile written last are not written. */
const MOST_CARS = 1 << 18;
/** A link's numbers its cars are written from (`SIGNATURE` floats a slot): their count, queue, speed, lanes, road length and flags. */
const SIGNATURE = 6;
/** A tile's mesh starts with room for this many cars; it doubles with them. */
const TILE_START = 256;
/** A tile's sphere: its half diagonal and the land's heights, with a car's room over the highest deck. */
const TILE_RADIUS = Math.hypot(TILE / 2, TILE / 2, (TERRAIN_MAX_HEIGHT - TERRAIN_MIN_HEIGHT) / 2 + m(80));
/** The shader's clock wraps here (seconds): a float keeps a car's place to a few centimetres. */
const TIME_WRAP = 4096;
/** A far road's lane, for its cars' places across it (its profile is the store's, not on the page). */
const FAR_LANE = m(3.5);

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
vec4 linkPoint(float slot, int k) {
  int i = int(slot) * ${LINK_POINTS} + k;
  return texelFetch(uLinks, ivec2(i % ${TEX_WIDTH}, i / ${TEX_WIDTH}), 0);
}
`;

// aLink: the link's slot, place along its travel (m), lateral offset to the right of travel (m), direction (1: from the road's b to its a).
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
  readonly object: Group;
  /** Each frame: the window told the worker, the roads' lines the network or the meso changed written, the cars of a new meso step written. */
  update(net: Network, sim: SimClient, focusX: number, focusY: number): void;
  dispose(): void;
}

/** A far road's car across it, to the right of its travel (`laneOffset` without the road's profile: a two-way road's lanes right of its centre, a one-way's about it). */
const farLateral = (lane: number, lanes: number, oneWay: boolean): number =>
  oneWay ? FAR_LANE * (lane - (lanes - 1) / 2) : FAR_LANE * (lane + 0.5);

/** `heightAt`: the road's deck at a point, or the ground's for a road not on the page (`renderer.ts` deckHeight). */
export function createDensityCars(heightAt: (x: number, y: number, segment: SegmentId | undefined) => number): DensityCars {
  let memory = MesoMemory.make(FIRST_CAPACITY);
  let sent: { x: number; y: number; at: number; buffer: SharedArrayBuffer } | null = null;
  let serial = 0;
  let netState: object | null = null;
  /** Each slot's link as its line was written (NaN: none), the worker's serial of that line, and the slots by their segment (the network's delta names segments). */
  let slotLink = new Float64Array(0);
  let seenShape = new Float32Array(0);
  const bySegment = new Map<number, Set<number>>();

  // The lines, a link's slot a run of `LINK_POINTS` texels: x, height, -y (three's axes) and the road's length; in the road's own order (a to b).
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
  const group = new Group();
  group.name = 'densityCars';
  pinned(group);

  /** The cars of one tile: a mesh culled by the tile's sphere, its links (slots), and whether one of them changed since it was written. */
  interface CarTile {
    readonly mesh: Mesh;
    geometry: InstancedBufferGeometry;
    link: Float32Array;
    move: Float32Array;
    linkAttribute: InstancedBufferAttribute;
    moveAttribute: InstancedBufferAttribute;
    capacity: number;
    n: number;
    readonly slots: Set<number>;
    dirty: boolean;
  }
  const tiles = new Map<number, CarTile>();
  /** Each slot's tile, and the numbers its cars were last written from (NaN: write them). */
  let slotTile: (CarTile | undefined)[] = [];
  let signature = new Float32Array(0);
  /** Cars written in every tile. */
  let total = 0;

  /** A geometry for a tile with room for `n` cars (the old one let go: three keeps a geometry's buffers until it is disposed), its sphere the tile's. */
  function tileGeometry(tile: Pick<CarTile, 'link' | 'move' | 'linkAttribute' | 'moveAttribute' | 'capacity'>, n: number, sphere: Sphere): InstancedBufferGeometry {
    const g = new InstancedBufferGeometry();
    g.index = shape.index;
    g.setAttribute('position', shape.getAttribute('position'));
    g.setAttribute('normal', shape.getAttribute('normal'));
    tile.link = new Float32Array(n * 4);
    tile.move = new Float32Array(n * 4);
    tile.linkAttribute = new InstancedBufferAttribute(tile.link, 4).setUsage(DynamicDrawUsage);
    tile.moveAttribute = new InstancedBufferAttribute(tile.move, 4).setUsage(DynamicDrawUsage);
    g.setAttribute('aLink', tile.linkAttribute);
    g.setAttribute('aMove', tile.moveAttribute);
    g.instanceCount = 0;
    // The cars are placed by the shader inside their tile: the tile's sphere is what the view culls.
    g.boundingSphere = sphere;
    tile.capacity = n;
    return g;
  }

  /** The tile at (cx, cy), made on first use. */
  function tileAt(cx: number, cy: number): CarTile {
    const key = cx * 65536 + cy;
    let tile = tiles.get(key);
    if (tile) return tile;
    const sphere = new Sphere(new Vector3((cx + 0.5) * TILE, (TERRAIN_MAX_HEIGHT + TERRAIN_MIN_HEIGHT) / 2, -(cy + 0.5) * TILE), TILE_RADIUS);
    const made = { link: new Float32Array(0), move: new Float32Array(0), capacity: 0 } as unknown as CarTile;
    const geometry = tileGeometry(made, TILE_START, sphere);
    const mesh = new Mesh(geometry, material);
    mesh.name = `densityCars-${cx},${cy}`;
    pinned(mesh);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // Nothing drawn until a car is written.
    mesh.visible = false;
    tile = Object.assign(made, { mesh, geometry, n: 0, slots: new Set<number>(), dirty: false });
    tiles.set(key, tile);
    group.add(mesh);
    return tile;
  }

  /** The slot's link filed in the tile of its middle (`ML.mx`, `ML.my`); the tiles it left and joined written again. */
  function fileSlot(slot: number): void {
    const r = slot * MESO_RECORD, recs = memory.links;
    const present = (recs[r + ML.flags]! & MESO_PRESENT) !== 0 && !Number.isNaN(slotLink[slot] ?? Number.NaN);
    const mx = recs[r + ML.mx]!, my = recs[r + ML.my]!;
    const next = present && Number.isFinite(mx) && Number.isFinite(my) ? tileAt(Math.floor(mx / TILE), Math.floor(my / TILE)) : undefined;
    const was = slotTile[slot];
    if (was === next) return;
    if (was) { was.slots.delete(slot); was.dirty = true; }
    if (next) { next.slots.add(slot); next.dirty = true; }
    slotTile[slot] = next;
  }

  /** Room in the texture for slot `slot`: rows doubled, what was written kept. */
  function roomFor(slot: number): void {
    const need = Math.floor(slot / ROADS_PER_ROW) + 1;
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

  /** Room to note `n` slots' links. */
  function track(n: number): void {
    if (slotLink.length >= n) return;
    const links = new Float64Array(n).fill(Number.NaN);
    links.set(slotLink);
    slotLink = links;
    const shapes = new Float32Array(n);
    shapes.set(seenShape);
    seenShape = shapes;
    const signatures = new Float32Array(n * SIGNATURE).fill(Number.NaN);
    signatures.set(signature);
    signature = signatures;
    slotTile.length = n;
  }

  /** One slot's line into the texture, its range marked for upload: the page's road by its centreline and deck, a far one straight through its table's points on the ground (none: its cars hidden). */
  function writeLine(net: Network, slot: number): void {
    roomFor(slot);
    const at = slot * LINK_POINTS * 4;
    const id = slotLink[slot] ?? Number.NaN;
    const segment = linkSegment(id) as SegmentId;
    const line = Number.isNaN(id) ? undefined : net.ribbons.get(segment)?.full;
    if (line && line.length > 0) {
      for (let k = 0; k < LINK_POINTS; k++) {
        const f = line.sampleAt((line.length * k) / (LINK_POINTS - 1)).p;
        lines[at + k * 4] = f.x;
        lines[at + k * 4 + 1] = heightAt(f.x, f.y, segment);
        lines[at + k * 4 + 2] = -f.y;
        lines[at + k * 4 + 3] = line.length;
      }
    } else {
      const r = slot * MESO_RECORD, recs = memory.links;
      const ax = recs[r + ML.ax]!, ay = recs[r + ML.ay]!, mx = recs[r + ML.mx]!, my = recs[r + ML.my]!, bx = recs[r + ML.bx]!, by = recs[r + ML.by]!;
      const first = Math.hypot(mx - ax, my - ay), second = Math.hypot(bx - mx, by - my), L = first + second;
      if (Number.isNaN(id) || !(L > 0)) lines.fill(0, at, at + LINK_POINTS * 4);
      else {
        for (let k = 0; k < LINK_POINTS; k++) {
          const d = (L * k) / (LINK_POINTS - 1);
          const onFirst = d <= first;
          const t = onFirst ? (first > 0 ? d / first : 0) : (second > 0 ? (d - first) / second : 1);
          const x = onFirst ? ax + (mx - ax) * t : mx + (bx - mx) * t;
          const y = onFirst ? ay + (my - ay) * t : my + (by - my) * t;
          lines[at + k * 4] = x;
          lines[at + k * 4 + 1] = heightAt(x, y, undefined);
          lines[at + k * 4 + 2] = -y;
          lines[at + k * 4 + 3] = L;
        }
      }
    }
    if (!whole) texture.addUpdateRange(at, LINK_POINTS * 4);
    texture.needsUpdate = true;
    // Its cars written again (their length and lanes across the road come from the line).
    if (slot * SIGNATURE < signature.length) signature[slot * SIGNATURE] = Number.NaN;
    const tile = slotTile[slot];
    if (tile) tile.dirty = true;
  }

  /** DO NOT write every line again for an edit or a tile come or gone: only the slots of the segments the network's delta names (a road on the page now drawn by its centreline, or gone back to its table's line). */
  function syncLines(net: Network): void {
    if (netState === net.state) return;
    const delta = netState === null ? null : net.changesSince(netState);
    netState = net.state;
    if (delta === null) {
      // @rebuild A map opened: every known slot's line.
      for (const slots of bySegment.values()) for (const slot of slots) writeLine(net, slot);
      return;
    }
    for (const id of delta.segments) for (const slot of bySegment.get(id) ?? []) writeLine(net, slot);
  }

  /** The slots whose link or line the worker changed (`ML.shape`): their link noted and their line written. */
  function readLines(net: Network, slots: number): void {
    track(slots);
    const recs = memory.links;
    const changed: number[] = [];
    for (let slot = 0; slot < slots; slot++) {
      const r = slot * MESO_RECORD;
      if ((recs[r + ML.flags]! & MESO_PRESENT) !== 0 && recs[r + ML.shape]! !== seenShape[slot]) changed.push(slot);
    }
    // Many rows changed (a buffer or a reach filled): one upload of the whole texture, not a range a row (`WebGLTextures.updateTexture`).
    if (changed.length > ROADS_PER_ROW * 4) { texture.clearUpdateRanges(); whole = true; }
    for (const slot of changed) {
      seenShape[slot] = recs[slot * MESO_RECORD + ML.shape]!;
      const was = slotLink[slot]!, now = memory.ids[slot]!;
      if (was !== now) {
        if (!Number.isNaN(was)) bySegment.get(linkSegment(was))?.delete(slot);
        slotLink[slot] = now;
        let set = bySegment.get(linkSegment(now));
        if (!set) bySegment.set(linkSegment(now), set = new Set());
        set.add(slot);
      }
      fileSlot(slot);
      writeLine(net, slot);
    }
  }

  /** The window told the worker (again when the view moved far enough, the buffer changed, or nobody answered). */
  function tellWindow(sim: SimClient, x: number, y: number): void {
    if (memory.wanted > memory.capacity) {
      let next = memory.capacity;
      while (next < memory.wanted) next *= 2;
      // The worker writes every line into a new buffer: each slot's read again from it.
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

  /** The tiles of the slots whose numbers the meso step changed (their count, queue, speed, lanes, line or flags), marked to be written. */
  function noteChanges(slots: number): void {
    const recs = memory.links;
    for (let slot = 0; slot < slots; slot++) {
      const tile = slotTile[slot];
      if (!tile) continue;
      const r = slot * MESO_RECORD, o = slot * SIGNATURE;
      const flags = recs[r + ML.flags]! & (MESO_PRESENT | MESO_INSIDE | MESO_ONE_WAY);
      const count = recs[r + ML.count]!, queued = recs[r + ML.queued]!, speed = recs[r + ML.speed]!, lanes = recs[r + ML.lanes]!;
      const L = lines[slot * LINK_POINTS * 4 + 3]!;
      if (signature[o] === count && signature[o + 1] === queued && signature[o + 2] === speed && signature[o + 3] === lanes
        && signature[o + 4] === L && signature[o + 5] === flags) continue;
      signature[o] = count; signature[o + 1] = queued; signature[o + 2] = speed; signature[o + 3] = lanes; signature[o + 4] = L; signature[o + 5] = flags;
      tile.dirty = true;
    }
  }

  /** Lanes across a road, to the right of travel (at most a road's lanes; one each, not one a car). */
  const lateralOf: number[] = [];

  /** One tile's cars of the meso step: each road's count, its queue packed at its end, the rest moving round the free stretch; only its buffer sent. */
  function writeTile(net: Network, tile: CarTile): void {
    const recs = memory.links;
    total -= tile.n;
    const room = MOST_CARS - total;
    let n = 0;
    const put = (slot: number, s: number, lateral: number, dir: number, speed: number, wrap: number, seed: number): void => {
      if (n >= tile.capacity) {
        const old = tile.geometry;
        const keepLink = tile.link, keepMove = tile.move;
        tile.geometry = tileGeometry(tile, tile.capacity * 2, old.boundingSphere!);
        tile.link.set(keepLink.subarray(0, n * 4));
        tile.move.set(keepMove.subarray(0, n * 4));
        tile.mesh.geometry = tile.geometry;
        old.dispose();
      }
      const at = n * 4;
      const link = tile.link, move = tile.move;
      link[at] = slot; link[at + 1] = s; link[at + 2] = lateral; link[at + 3] = dir;
      move[at] = speed; move[at + 1] = wrap; move[at + 2] = seed; move[at + 3] = 0;
      n++;
    };
    for (const slot of tile.slots) {
      if (n >= room) break;
      const r = slot * MESO_RECORD;
      const flags = recs[r + ML.flags]!;
      if (!(flags & MESO_PRESENT) || flags & MESO_INSIDE) continue;
      const count = Math.round(recs[r + ML.count]!);
      const id = slotLink[slot]!;
      if (count <= 0 || Number.isNaN(id)) continue;
      const dir = linkDirection(id);
      const ribbon = net.ribbons.get(linkSegment(id) as SegmentId);
      // The road's length as its line was written (the page's centreline, or the table's points).
      const L = lines[slot * LINK_POINTS * 4 + 3]!;
      if (!(L > 0)) continue;
      const lanes = Math.max(1, Math.round(recs[r + ML.lanes]!));
      const oneWay = (flags & MESO_ONE_WAY) !== 0;
      const cars = Math.min(count, Math.floor((L * lanes) / JAM_SPACING));
      const queued = Math.min(cars, Math.round(recs[r + ML.queued]!));
      for (let lane = 0; lane < lanes; lane++) {
        lateralOf[lane] = ribbon ? -laneOffset(ribbon.road, lane, ribbon.direction, dir === 0) : farLateral(lane, lanes, oneWay);
      }
      for (let k = 0; k < queued && n < room; k++) {
        put(slot, L - (Math.floor(k / lanes) + 0.5) * JAM_SPACING, lateralOf[k % lanes]!, dir, 0, 0, slot * 31 + k);
      }
      const free = cars - queued, stretch = Math.max(0, L - Math.ceil(queued / lanes) * JAM_SPACING);
      const speed = recs[r + ML.speed]!;
      for (let k = 0; k < free && stretch > 0 && n < room; k++) {
        put(slot, ((k + 0.5) / free) * stretch, lateralOf[(queued + k) % lanes]!, dir, speed, stretch, slot * 31 + queued + k);
      }
    }
    for (const attribute of [tile.linkAttribute, tile.moveAttribute]) {
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(0, n * 4);
      attribute.needsUpdate = true;
    }
    tile.geometry.instanceCount = n;
    tile.mesh.visible = n > 0;
    tile.n = n;
    total += n;
    tile.dirty = false;
  }

  return {
    object: group,
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
      if (now !== serial) {
        serial = now;
        const slots = Math.min(memory.capacity, memory.wanted);
        readLines(net, slots);
        noteChanges(slots);
      }
      // The tiles a step or an edit changed: written and sent, the others left as they are.
      for (const tile of tiles.values()) if (tile.dirty) writeTile(net, tile);
    },
    dispose() {
      for (const tile of tiles.values()) tile.geometry.dispose();
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
