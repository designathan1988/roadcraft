import { BoxGeometry, Color, Group, InstancedMesh, MeshStandardMaterial, Object3D } from 'three';
export type { Box as TransitBox };

import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
import { onChartOf } from '@world/planet/charts';
import type { TrainView } from '@sim/transit/transit';

/**
 * The materials of the transport, made once and shared by every rebuild:
 * one made afresh on each rebuild (every road edit rebuilds the transport)
 * had its shader program dropped with the old one and linked again, a stall
 * on every road drawn (docs/performance.md). Keyed by everything set on them.
 */
const sharedMaterials = new Map<string, MeshStandardMaterial>();
function sharedMaterial(colour: number, roughness: number, metalness: number, opacity: number,
  transparent = opacity < 1, depthTest = true, order = 0): MeshStandardMaterial {
  const key = `${colour}:${roughness}:${metalness}:${opacity}:${transparent}:${depthTest}:${order}`;
  let mat = sharedMaterials.get(key);
  if (!mat) {
    mat = new MeshStandardMaterial({ color: colour, roughness, metalness, transparent, opacity });
    mat.depthTest = depthTest;
    mat.userData['order'] = order;
    sharedMaterials.set(key, mat);
  }
  return mat;
}

/**
 * Public transport on screen (`world/transit.ts`, `sim/transit/transit.ts`):
 * the train's tracks on their ballast with sleepers and two rails; its
 * stations, a platform beside the track under a canopy; the metro's
 * entrances (its tracks and trains run under the ground and are not drawn);
 * bus stops, a shelter and a sign in the colour of the first line that calls
 * there, a terminal's longer; and the trains, their cars in their line's
 * colour, moved every frame.
 *
 * Every piece is a unit box, instanced, as the walls and fences are
 * (`barriers.ts`).
 */
export interface TransitMeshes {
  readonly group: Group;
  readonly triangles: number;
  /**
   * The metro under the ground, seen as a cut (the transit tool): its tunnels
   * with their tracks and its stations' platforms, drawn through the ground.
   */
  setXray(on: boolean): void;
  /** The trains where the simulation has them now. */
  update(trains: readonly TrainView[], groundAt: (x: number, y: number) => number): void;
  dispose(): void;
}

interface Box { x: number; y: number; z: number; yaw: number; length: number; width: number; height: number; colour?: string }

const SLEEPER_STEP = m(0.7);
/** Length of the pieces a track is laid in, each on what is under it. */
const PIECE = m(4);
const GAUGE = m(1.435);
/** Most trains' cars drawn at once. */
const MAX_CARS = 256;
const CAR = { length: m(17.5), width: m(2.9), height: m(3.6) };
/** The metro's rails below the ground; its tunnel's inside width and height. */
export const METRO_DEPTH = m(12);
const TUNNEL = { width: m(9), height: m(6) };

/**
 * A run of track as boxes: ballast, sleepers and two rails, in pieces each on
 * what is under it - over open ground on its ballast; across a street (a
 * level crossing) the rails alone, flush with the paving. The metro's lies at
 * `METRO_DEPTH` under the ground in its tunnel: a floor, two walls and a roof
 * slab, so the cut shows the bore.
 */
export function trackBoxes(points: readonly { x: number; y: number }[], mode: 'train' | 'metro',
  groundAt: (x: number, y: number) => number, pavedAt: (x: number, y: number) => number = () => NaN): Record<'ballast' | 'sleepers' | 'rails' | 'tunnel' | 'roof', Box[]> {
  const out = { ballast: [] as Box[], sleepers: [] as Box[], rails: [] as Box[], tunnel: [] as Box[], roof: [] as Box[] };
  for (let i = 1; i < points.length; i++) {
    // On the stretch's first point's chart, the second carried there (`world/transit.ts`).
    const a = points[i - 1]!, b = onChartOf(points[i]!, a);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-3) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len, yaw = Math.atan2(b.y - a.y, b.x - a.x);
    const pieces = Math.max(1, Math.ceil(len / PIECE));
    const piece = len / pieces;
    for (let k = 0; k < pieces; k++) {
      const d0 = k * piece, cx = a.x + ux * (d0 + piece / 2), cy = a.y + uy * (d0 + piece / 2);
      const paved = mode === 'train' ? pavedAt(cx, cy) : NaN;
      const crossing = Number.isFinite(paved);
      const z = crossing ? paved : groundAt(cx, cy) - (mode === 'metro' ? METRO_DEPTH : 0);
      if (mode === 'metro') {
        const nx = -uy, ny = ux;
        out.tunnel.push({ x: cx, y: cy, z: z - m(0.6), yaw, length: piece + m(0.05), width: TUNNEL.width, height: m(0.4) });
        for (const side of [-1, 1]) {
          out.tunnel.push({ x: cx + nx * side * (TUNNEL.width / 2 + m(0.2)), y: cy + ny * side * (TUNNEL.width / 2 + m(0.2)), z: z - m(0.6),
            yaw, length: piece + m(0.05), width: m(0.4), height: TUNNEL.height });
        }
        out.roof.push({ x: cx, y: cy, z: z - m(0.6) + TUNNEL.height, yaw, length: piece + m(0.05), width: TUNNEL.width + m(0.8), height: m(0.4) });
      }
      if (!crossing) {
        out.ballast.push({ x: cx, y: cy, z: z - m(0.05), yaw, length: piece + m(0.05), width: m(3.4), height: m(0.3) });
        for (let d = d0 + SLEEPER_STEP / 2; d < d0 + piece; d += SLEEPER_STEP) {
          out.sleepers.push({ x: a.x + ux * d, y: a.y + uy * d, z: z + m(0.25), yaw: yaw + Math.PI / 2, length: m(2.6), width: m(0.24), height: m(0.15) });
        }
      }
      for (const side of [-1, 1]) {
        out.rails.push({ x: cx - uy * side * GAUGE / 2, y: cy + ux * side * GAUGE / 2, z: z + (crossing ? m(0.01) : m(0.4)), yaw,
          length: piece + m(0.02), width: m(0.08), height: crossing ? m(0.04) : m(0.15) });
      }
    }
  }
  return out;
}

export function buildTransit(doc: RoadDoc, groundAt: (x: number, y: number) => number,
  pavedAt: (x: number, y: number) => number = () => NaN,
  onRoad: (p: { x: number; y: number }) => boolean = () => false): TransitMeshes {
  const group = new Group();
  group.name = 'transit';
  const t = doc.transit;
  const ballast: Box[] = [], sleepers: Box[] = [], rails: Box[] = [], platforms: Box[] = [], roofs: Box[] = [],
    posts: Box[] = [], signs: Box[] = [], glass: Box[] = [];
  // The metro's, seen as a cut through the ground (`setXray`).
  const xTunnel: Box[] = [], xRoof: Box[] = [], xBallast: Box[] = [], xSleepers: Box[] = [], xRails: Box[] = [], xPlatforms: Box[] = [];
  for (const track of t.tracks) {
    const laid = trackBoxes(track.points, track.mode, groundAt, pavedAt);
    if (track.mode === 'train') { ballast.push(...laid.ballast); sleepers.push(...laid.sleepers); rails.push(...laid.rails); }
    else { xTunnel.push(...laid.tunnel); xRoof.push(...laid.roof); xBallast.push(...laid.ballast); xSleepers.push(...laid.sleepers); xRails.push(...laid.rails); }
  }
  const halls: Box[] = [];
  const colourAt = (stop: number): string => t.lines.find((l) => l.stops.includes(stop))?.colour ?? '#2f7de1';
  for (let s of t.stops) {
    const z = groundAt(s.x, s.y);
    const colour = colourAt(s.id);
    if (s.mode === 'train') {
      // Along the track there: the platform beside it, under its canopy.
      const track = t.tracks.find((k) => k.id === s.track);
      let yaw = 0;
      if (track) {
        let best = Infinity;
        for (let i = 1; i < track.points.length; i++) {
          const a = track.points[i - 1]!, b = onChartOf(track.points[i]!, a), at = onChartOf(s, a);
          const d = Math.hypot((a.x + b.x) / 2 - at.x, (a.y + b.y) / 2 - at.y);
          if (d < best) { best = d; yaw = Math.atan2(b.y - a.y, b.x - a.x); }
        }
      }
      const nx = -Math.sin(yaw), ny = Math.cos(yaw);
      const off = m(3.6);
      const px = s.x + nx * off, py = s.y + ny * off;
      platforms.push({ x: px, y: py, z, yaw, length: m(60), width: m(4), height: m(1.0) });
      for (const k of [-24, -12, 0, 12, 24]) {
        posts.push({ x: px + Math.cos(yaw) * m(k), y: py + Math.sin(yaw) * m(k), z: z + m(1), yaw, length: m(0.2), width: m(0.2), height: m(3) });
      }
      roofs.push({ x: px, y: py, z: z + m(4), yaw, length: m(56), width: m(4.4), height: m(0.25) });
      signs.push({ x: px + nx * m(1.8), y: py + ny * m(1.8), z: z + m(2.6), yaw, length: m(2.4), width: m(0.1), height: m(0.7), colour });
      // The station building behind the platform: a hall with a glazed front
      // to the forecourt, its roof, and the line's sign over the door.
      const hx = px + nx * m(8), hy = py + ny * m(8);
      halls.push({ x: hx, y: hy, z, yaw, length: m(22), width: m(10), height: m(6.5) });
      roofs.push({ x: hx, y: hy, z: z + m(6.5), yaw, length: m(24), width: m(12), height: m(0.4) });
      glass.push({ x: hx + nx * m(5.05), y: hy + ny * m(5.05), z: z + m(0.2), yaw, length: m(14), width: m(0.1), height: m(4.6) });
      signs.push({ x: hx + nx * m(5.3), y: hy + ny * m(5.3), z: z + m(5), yaw, length: m(6), width: m(0.15), height: m(1), colour });
      // A passage from the hall onto the platform.
      platforms.push({ x: px + nx * m(3.2), y: py + ny * m(3.2), z, yaw, length: m(6), width: m(2.4), height: m(1.0) });
      continue;
    }
    if (s.mode === 'metro') {
      // The way down: a glazed entrance with the sign of the line - off the
      // carriageway (a station clicked on a street opens onto the nearest
      // ground beside it, clear of the kerb).
      const at = s.entrance ? { x: s.entrance.x, y: s.entrance.y, yaw: Math.atan2(s.entrance.y - s.y, s.entrance.x - s.x) + Math.PI / 2 } : entranceSpot(s.x, s.y, onRoad);
      const ez = groundAt(at.x, at.y);
      const ex = at.x, ey = at.y, yaw = at.yaw;
      const ux = Math.cos(yaw), uy = Math.sin(yaw);
      glass.push({ x: ex, y: ey, z: ez, yaw, length: m(4), width: m(2.6), height: m(2.6) });
      // The station below: an island platform between the two tracks... or,
      // on one track, platforms either side, and its hall, all in the cut.
      {
        const track = t.tracks.find((k) => k.id === s.track);
        let tyaw = 0;
        if (track) {
          let best = Infinity;
          for (let i = 1; i < track.points.length; i++) {
            const a = track.points[i - 1]!, b = onChartOf(track.points[i]!, a), at = onChartOf(s, a);
            const d = Math.hypot((a.x + b.x) / 2 - at.x, (a.y + b.y) / 2 - at.y);
            if (d < best) { best = d; tyaw = Math.atan2(b.y - a.y, b.x - a.x); }
          }
        }
        const deep = groundAt(s.x, s.y) - METRO_DEPTH;
        const nx = -Math.sin(tyaw), ny = Math.cos(tyaw);
        for (const side of [-1, 1]) {
          xPlatforms.push({ x: s.x + nx * side * m(3.4), y: s.y + ny * side * m(3.4), z: deep, yaw: tyaw, length: m(80), width: m(3.6), height: m(1.0) });
        }
        // The hall's box round the platforms, wider than the bore.
        xTunnel.push({ x: s.x, y: s.y, z: deep - m(0.6), yaw: tyaw, length: m(90), width: m(16), height: m(0.4) });
        for (const side of [-1, 1]) {
          xTunnel.push({ x: s.x + nx * side * m(8.2), y: s.y + ny * side * m(8.2), z: deep - m(0.6), yaw: tyaw, length: m(90), width: m(0.4), height: m(7) });
        }
        // The stairs' shaft from the entrance down to the hall.
        xTunnel.push({ x: ex, y: ey, z: deep, yaw, length: m(3.2), width: m(2.4), height: ez - deep });
        // ...and the passage from the foot of the stairs to the platforms.
        {
          const plen = Math.hypot(s.x - ex, s.y - ey);
          xTunnel.push({ x: (ex + s.x) / 2, y: (ey + s.y) / 2, z: deep, yaw: Math.atan2(s.y - ey, s.x - ex), length: plen, width: m(3), height: m(0.3) });
        }
      }
      roofs.push({ x: ex, y: ey, z: ez + m(2.6), yaw, length: m(4.4), width: m(3), height: m(0.2) });
      posts.push({ x: ex + ux * m(2.6), y: ey + uy * m(2.6), z: ez, yaw, length: m(0.12), width: m(0.12), height: m(3.4) });
      signs.push({ x: ex + ux * m(2.6), y: ey + uy * m(2.6), z: ez + m(3.4), yaw, length: m(0.9), width: m(0.9), height: m(0.9), colour });
      continue;
    }
    // A bus stop: a shelter on two posts along the street, its glass at the
    // back (away from the road), a pole with the sign at its end.
    const seg = s.segment !== undefined ? doc.segments.get(s.segment) : undefined;
    const na = seg ? doc.nodes.get(seg.a) : undefined, nb = seg ? doc.nodes.get(seg.b) : undefined;
    let yaw = 0, bx = 0, by = 1;
    if (na && nb) {
      yaw = Math.atan2(nb.y - na.y, nb.x - na.x);
      const ux = Math.cos(yaw), uy = Math.sin(yaw);
      const u = (s.x - na.x) * ux + (s.y - na.y) * uy;
      const cx = na.x + ux * u, cy = na.y + uy * u, d = Math.hypot(s.x - cx, s.y - cy) || 1;
      bx = (s.x - cx) / d; by = (s.y - cy) / d;
    }
    const long = s.terminal ? m(9) : m(3.2);
    const ux = Math.cos(yaw), uy = Math.sin(yaw);
    // At the kerb, as a shelter stands, clear of the shop awnings over the
    // footway: from the stop (the middle of the footway) towards the road.
    const kx = s.x - bx * m(0.9), ky = s.y - by * m(0.9);
    s = { ...s, x: kx, y: ky };
    for (const k of [-1, 1]) {
      posts.push({ x: s.x + ux * k * (long / 2 - m(0.2)) + bx * m(0.5), y: s.y + uy * k * (long / 2 - m(0.2)) + by * m(0.5),
        z: z + m(0.15), yaw, length: m(0.1), width: m(0.1), height: m(2.4) });
    }
    roofs.push({ x: s.x + bx * m(0.2), y: s.y + by * m(0.2), z: z + m(2.55), yaw, length: long, width: m(1.6), height: m(0.12) });
    glass.push({ x: s.x + bx * m(0.75), y: s.y + by * m(0.75), z: z + m(0.15), yaw, length: long, width: m(0.06), height: m(2.1) });
    posts.push({ x: s.x + ux * (long / 2 + m(0.6)), y: s.y + uy * (long / 2 + m(0.6)), z: z + m(0.15), yaw, length: m(0.08), width: m(0.08), height: m(2.8) });
    signs.push({ x: s.x + ux * (long / 2 + m(0.6)), y: s.y + uy * (long / 2 + m(0.6)), z: z + m(2.6), yaw, length: m(0.6), width: m(0.05), height: m(0.6), colour });
  }

  const unit = new BoxGeometry(1, 1, 1);
  const material = (colour: number, roughness: number, metalness = 0, opacity = 1): MeshStandardMaterial =>
    sharedMaterial(colour, roughness, metalness, opacity);
  const o = new Object3D();
  const place = (b: Box): void => {
    o.position.set(b.x, b.z + b.height / 2, -b.y);
    o.rotation.set(0, b.yaw, 0);
    o.scale.set(b.length, b.height, b.width);
    o.updateMatrix();
  };
  let triangles = 0;
  const add = (name: string, boxes: readonly Box[], mat: MeshStandardMaterial, coloured = false): void => {
    if (boxes.length === 0) return;
    const mesh = new InstancedMesh(unit, mat, boxes.length);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const c = new Color();
    boxes.forEach((b, i) => {
      place(b);
      mesh.setMatrixAt(i, o.matrix);
      if (coloured) mesh.setColorAt(i, c.set(b.colour ?? '#ffffff'));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    group.add(mesh);
    triangles += boxes.length * 12;
  };
  add('transit-ballast', ballast, material(0x7d776e, 0.95));
  add('transit-sleepers', sleepers, material(0x5b4636, 0.9));
  add('transit-rails', rails, material(0x9aa0a6, 0.35, 0.8));
  add('transit-platforms', platforms, material(0xbdb6aa, 0.9));
  add('transit-roofs', roofs, material(0x3f4a52, 0.6, 0.2));
  add('transit-posts', posts, material(0x2e3438, 0.5, 0.6));
  add('transit-glass', glass, material(0xa9c7d6, 0.1, 0.1, 0.45));
  add('transit-signs', signs, material(0xffffff, 0.5), true);
  add('transit-halls', halls, material(0xc9b79a, 0.85));

  // The metro in its cut: drawn through the ground (no depth test against it)
  // in its own order, the bore's concrete a little see-through so the tracks
  // read inside; shown only while the transit tool is on.
  const xray = new Group();
  xray.name = 'transit-xray';
  xray.visible = false;
  const through = (colour: number, opacity: number, order: number): MeshStandardMaterial =>
    sharedMaterial(colour, 0.8, 0, opacity, true, false, order);
  const addThrough = (name: string, boxes: readonly Box[], mat: MeshStandardMaterial): void => {
    if (!boxes.length) return;
    const mesh = new InstancedMesh(unit, mat, boxes.length);
    mesh.name = name;
    mesh.renderOrder = 20 + (mat.userData['order'] as number);
    boxes.forEach((b, i) => { place(b); mesh.setMatrixAt(i, o.matrix); });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    xray.add(mesh);
  };
  addThrough('metro-bore', xTunnel, through(0x8d8a84, 0.55, 0));
  addThrough('metro-ballast', xBallast, through(0x6d675e, 0.95, 1));
  addThrough('metro-platforms', xPlatforms, through(0xd6cfc2, 0.95, 1));
  addThrough('metro-sleepers', xSleepers, through(0x5b4636, 1, 2));
  addThrough('metro-rails', xRails, through(0xb8bec4, 1, 3));
  addThrough('metro-roof', xRoof, through(0x8d8a84, 0.18, 4));
  group.add(xray);

  // The trains: one box per car, moved each frame, in their line's colour.
  const cars = new InstancedMesh(unit, material(0xffffff, 0.45, 0.3), MAX_CARS);
  cars.name = 'transit-trains';
  cars.castShadow = true;
  // Its instances move all over the map: the bounds of the one unit box at the
  // origin would cull them all whenever the camera is elsewhere.
  cars.frustumCulled = false;
  cars.count = 0;
  group.add(cars);
  const tint = new Color();
  return {
    group,
    setXray(on) { xray.visible = on; },
    triangles,
    update(trains, ground) {
      let n = 0;
      for (const train of trains) {
        if (train.metro) continue;
        tint.set(train.colour);
        for (const car of train.cars) {
          if (n >= MAX_CARS) break;
          place({ x: car.x, y: car.y, z: ground(car.x, car.y) + m(0.55), yaw: car.heading, length: CAR.length, width: CAR.width, height: CAR.height });
          cars.setMatrixAt(n, o.matrix);
          cars.setColorAt(n, tint);
          n++;
        }
      }
      // The cars there are, uploaded and drawn: with no train running the mesh
      // went through both render lists every frame and its whole buffer
      // (16 KiB) was uploaded again.
      cars.count = n;
      cars.visible = n > 0;
      if (!n) return;
      cars.instanceMatrix.clearUpdateRanges();
      cars.instanceMatrix.addUpdateRange(0, n * 16);
      cars.instanceMatrix.needsUpdate = true;
      if (cars.instanceColor) {
        cars.instanceColor.clearUpdateRanges();
        cars.instanceColor.addUpdateRange(0, n * 3);
        cars.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      unit.dispose();
    },
  };
}

/**
 * Where a metro entrance stands for a station at (x, y): the point itself when
 * it is off the roads, else the nearest point off the carriageway (searched
 * in rings), a metre and a half further on so it clears the kerb; turned
 * along the kerb.
 */
function entranceSpot(x: number, y: number, onRoad: (p: { x: number; y: number }) => boolean): { x: number; y: number; yaw: number } {
  if (!onRoad({ x, y })) return { x, y, yaw: 0 };
  for (let r = m(1); r <= m(30); r += m(1)) {
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * Math.PI * 2;
      const p = { x: x + Math.cos(a) * r, y: y + Math.sin(a) * r };
      if (onRoad(p)) continue;
      const q = { x: x + Math.cos(a) * (r + m(2.5)), y: y + Math.sin(a) * (r + m(2.5)) };
      if (onRoad(q)) continue;
      return { x: x + Math.cos(a) * (r + m(2.5)), y: y + Math.sin(a) * (r + m(2.5)), yaw: a + Math.PI / 2 };
    }
  }
  return { x, y, yaw: 0 };
}


/**
 * The run of track being laid (the transit tool's preview): the real track,
 * as it will be built - the train's on its ballast, the metro's in its bore
 * under the ground, seen through it - not a line. Built again as it changes.
 */
export function buildTrackPreview(points: readonly { x: number; y: number }[], mode: 'train' | 'metro',
  groundAt: (x: number, y: number) => number, pavedAt: (x: number, y: number) => number = () => NaN): { group: Group; dispose(): void } {
  const group = new Group();
  group.name = 'transit-preview';
  const laid = trackBoxes(points, mode, groundAt, pavedAt);
  const unit = new BoxGeometry(1, 1, 1);
  const o = new Object3D();
  const add = (boxes: readonly Box[], colour: number, opacity: number, order: number, roughness = 0.8, metalness = 0): void => {
    if (!boxes.length) return;
    const mat = sharedMaterial(colour, roughness, metalness, opacity, true, mode !== 'metro');
    const mesh = new InstancedMesh(unit, mat, boxes.length);
    mesh.renderOrder = 30 + order;
    mesh.frustumCulled = false;
    boxes.forEach((b, i) => {
      o.position.set(b.x, b.z + b.height / 2, -b.y); o.rotation.set(0, b.yaw, 0); o.scale.set(b.length, b.height, b.width); o.updateMatrix();
      mesh.setMatrixAt(i, o.matrix);
    });
    group.add(mesh);
  };
  add(laid.tunnel, 0x8d8a84, 0.55, 0);
  add(laid.ballast, 0x7d776e, 0.9, 1);
  add(laid.sleepers, 0x5b4636, 0.95, 2);
  add(laid.rails, 0x9aa0a6, 1, 3, 0.35, 0.8);
  add(laid.roof, 0x8d8a84, 0.18, 4);
  return { group, dispose() { unit.dispose(); } };
}
