import { BoxGeometry, Color, DynamicDrawUsage, type Frustum, Group, InstancedMesh, type Matrix4, MeshStandardMaterial, Object3D } from 'three';
import type { Change, ChangeJournal, ChangeKind, ChangeRect } from '@world/changes';
import { CellFiling } from '@world/cells';
import { Derived, type DerivedSpec } from '@world/derived';
import { createInstanceRuns, RunBuilder, sameRun, type Run, type RunStore } from './instanceRuns';
export type { Box as TransitBox };

import type { RoadDoc } from '@world/doc';
import { m } from '@world/units';
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
    const a = points[i - 1]!, b = points[i]!;
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

/** Every kind of box the transport draws, by the store it is drawn in. */
const VISIBLE = ['ballast', 'sleepers', 'rails', 'platforms', 'roofs', 'posts', 'glass', 'signs', 'halls'] as const;
const XRAY = ['xTunnel', 'xBallast', 'xPlatforms', 'xSleepers', 'xRails', 'xRoof'] as const;
type TransitParts = Record<(typeof VISIBLE)[number] | (typeof XRAY)[number], Box[]>;
const emptyParts = (): TransitParts => Object.fromEntries([...VISIBLE, ...XRAY].map((k) => [k, []])) as unknown as TransitParts;
type TransitStop = RoadDoc['transit']['stops'][number];
type TransitTrack = RoadDoc['transit']['tracks'][number];

/** A track's boxes: the train's on the ground, the metro's in its cut. */
function trackParts(track: TransitTrack, groundAt: (x: number, y: number) => number, pavedAt: (x: number, y: number) => number, out: TransitParts): void {
  const laid = trackBoxes(track.points, track.mode, groundAt, pavedAt);
  if (track.mode === 'train') { out.ballast.push(...laid.ballast); out.sleepers.push(...laid.sleepers); out.rails.push(...laid.rails); }
  else { out.xTunnel.push(...laid.tunnel); out.xRoof.push(...laid.roof); out.xBallast.push(...laid.ballast); out.xSleepers.push(...laid.sleepers); out.xRails.push(...laid.rails); }
}

/** One stop's boxes (a station, a metro entrance with its hall below, a bus stop), into `out`. */
function stopParts(doc: RoadDoc, stop: TransitStop, groundAt: (x: number, y: number) => number,
  onRoad: (p: { x: number; y: number }) => boolean, out: TransitParts): void {
  const t = doc.transit;
  const { platforms, roofs, posts, signs, glass, halls, xTunnel, xPlatforms } = out;
  let s = stop;
  const colourAt = (id: number): string => t.lines.find((l) => l.stops.includes(id))?.colour ?? '#2f7de1';

    const z = groundAt(s.x, s.y);
    const colour = colourAt(s.id);
    if (s.mode === 'train') {
      // Along the track there: the platform beside it, under its canopy.
      const track = t.tracks.find((k) => k.id === s.track);
      let yaw = 0;
      if (track) {
        let best = Infinity;
        for (let i = 1; i < track.points.length; i++) {
          const a = track.points[i - 1]!, b = track.points[i]!;
          const d = Math.hypot((a.x + b.x) / 2 - s.x, (a.y + b.y) / 2 - s.y);
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
      return;
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
            const a = track.points[i - 1]!, b = track.points[i]!;
            const d = Math.hypot((a.x + b.x) / 2 - s.x, (a.y + b.y) / 2 - s.y);
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
      return;
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

interface TransitSource {
  readonly changes: ChangeJournal;
  readonly doc: RoadDoc;
  readonly groundAt: (x: number, y: number) => number;
  readonly pavedAt: (x: number, y: number) => number;
  readonly onRoad: (p: { x: number; y: number }) => boolean;
}
/** A track's or a stop's runs (the visible ones, the cut's) and the box it reads. */
interface TransitPlace { readonly visible: Run; readonly xray: Run; readonly box: ChangeRect; readonly boxes: number }

/** How far round a stop its boxes and what they read reach (a station's 60 m platform and hall, an entrance's search). */
const STOP_READS = m(100);
/** How far round a track's points it reads the ground and the paving. */
const TRACK_READS = m(6);
const trackKey = (id: number): number => id * 2;
const stopKey = (id: number): number => id * 2 + 1;

/** The transport as a product of the diary, item by item: a track (`trackKey`), a stop (`stopKey`). */
class TransitProduct implements DerivedSpec<TransitSource, number, TransitPlace> {
  readonly name = 'transit';
  readonly kinds: readonly ChangeKind[] = ['transit', 'terrain', 'elevation', 'ground', 'roads', 'buildings'];
  readonly byId = false;
  private readonly filing = new CellFiling<number, TransitPlace>();

  constructor(private readonly visible: readonly RunStore[], private readonly xray: readonly RunStore[]) {}

  /** @rebuild Every track and stop: read only when everything changed (a load, the diary forgotten). */
  allKeys(source: TransitSource): Iterable<number> {
    const out: number[] = [];
    for (const track of source.doc.transit.tracks) out.push(trackKey(track.id));
    for (const stop of source.doc.transit.stops) out.push(stopKey(stop.id));
    for (const id of this.filing.ids()) out.push(id);
    return out;
  }

  dirty(change: Change, out: Set<number>, source: TransitSource): void {
    if (change.rects === null) {
      for (const key of this.allKeys(source)) out.add(key);
      return;
    }
    for (const key of this.filing.idsMeetingAny(change.rects)) out.add(key);
    // A change of the transport itself may make a new track or stop: the transport's own items in its rectangles
    // (a handful on a map; the other kinds reach only what stands, through the filing).
    if (change.kind !== 'transit') return;
    const meets = (x0: number, y0: number, x1: number, y1: number): boolean => change.rects!.some((r) => r[0] <= x1 && r[2] >= x0 && r[1] <= y1 && r[3] >= y0);
    for (const track of source.doc.transit.tracks) {
      const box = pointsBox(track.points, TRACK_READS);
      if (box && meets(box[0], box[1], box[2], box[3])) out.add(trackKey(track.id));
    }
    for (const stop of source.doc.transit.stops) if (meets(stop.x - STOP_READS, stop.y - STOP_READS, stop.x + STOP_READS, stop.y + STOP_READS)) out.add(stopKey(stop.id));
  }

  compute(key: number, source: TransitSource): TransitPlace | undefined {
    const id = Math.floor(key / 2);
    const parts = emptyParts();
    let box: ChangeRect | null;
    if (key % 2 === 0) {
      const track = source.doc.transit.tracks.find((k) => k.id === id);
      if (!track) return undefined;
      trackParts(track, source.groundAt, source.pavedAt, parts);
      box = pointsBox(track.points, TRACK_READS);
    } else {
      const stop = source.doc.transit.stops.find((k) => k.id === id);
      if (!stop) return undefined;
      stopParts(source.doc, stop, source.groundAt, source.onRoad, parts);
      box = [stop.x - STOP_READS, stop.y - STOP_READS, stop.x + STOP_READS, stop.y + STOP_READS];
    }
    if (!box) return undefined;
    const o = new Object3D();
    const c = new Color();
    const runOf = (kinds: readonly (keyof TransitParts)[], stores: readonly RunStore[]): { run: Run; boxes: number } => {
      const builder = new RunBuilder(stores);
      let boxes = 0;
      kinds.forEach((kind, store) => {
        for (const b of parts[kind]) {
          o.position.set(b.x, b.z + b.height / 2, -b.y);
          o.rotation.set(0, b.yaw, 0);
          o.scale.set(b.length, b.height, b.width);
          o.updateMatrix();
          builder.add(store, o.matrix.elements, Math.max(b.length, b.height, b.width), stores[store]!.tinted ? c.set(b.colour ?? '#ffffff') : undefined);
          boxes++;
        }
      });
      return { run: builder.build(), boxes };
    };
    const shown = runOf(VISIBLE, this.visible), cut = runOf(XRAY, this.xray);
    return { visible: shown.run, xray: cut.run, box, boxes: shown.boxes };
  }

  equals(a: TransitPlace, b: TransitPlace): boolean {
    return a.box.every((v, i) => v === b.box[i]) && sameRun(a.visible, b.visible) && sameRun(a.xray, b.xray);
  }

  changed(key: number, _before: TransitPlace | undefined, after: TransitPlace | undefined): void {
    if (after === undefined) this.filing.remove(key);
    else this.filing.file(key, after, after.box);
  }
}

/** The box round some points, grown by `pad`; null for none. */
function pointsBox(points: readonly { readonly x: number; readonly y: number }[], pad: number): ChangeRect | null {
  if (!points.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of points) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/**
 * The transport kept item by item from the diary (`TransitProduct`): a track or a stop made again only
 * when it changed or what it stands on did, each a run of the layer's instanced stores. DO NOT build the
 * whole transport again on its revision or a change of the ground under any piece of it.
 */
export function createTransit(): TransitMeshes & {
  /** Brings the tracks and stops up to the diary; the items made again. */
  sync(doc: RoadDoc, groundAt: (x: number, y: number) => number, pavedAt: (x: number, y: number) => number, onRoad: (p: { x: number; y: number }) => boolean): number;
  /** The parts the camera can see, every frame. */
  cull(frustum: Frustum, view: Matrix4): void;
} {
  const group = new Group();
  group.name = 'transit';
  const unit = new BoxGeometry(1, 1, 1);
  const material = (colour: number, roughness: number, metalness = 0, opacity = 1): MeshStandardMaterial =>
    sharedMaterial(colour, roughness, metalness, opacity);
  const shown = (name: string, mat: MeshStandardMaterial, tinted = false): RunStore =>
    ({ name, geometry: unit, material: mat, castShadow: true, receiveShadow: true, tinted, cards: false });
  const visibleStores: RunStore[] = [
    shown('transit-ballast', material(0x7d776e, 0.95)),
    shown('transit-sleepers', material(0x5b4636, 0.9)),
    shown('transit-rails', material(0x9aa0a6, 0.35, 0.8)),
    shown('transit-platforms', material(0xbdb6aa, 0.9)),
    shown('transit-roofs', material(0x3f4a52, 0.6, 0.2)),
    shown('transit-posts', material(0x2e3438, 0.5, 0.6)),
    shown('transit-glass', material(0xa9c7d6, 0.1, 0.1, 0.45)),
    shown('transit-signs', material(0xffffff, 0.5), true),
    shown('transit-halls', material(0xc9b79a, 0.85)),
  ];
  // The metro in its cut: drawn through the ground (no depth test against it)
  // in its own order, the bore's concrete a little see-through so the tracks
  // read inside; shown only while the transit tool is on.
  const through = (name: string, colour: number, opacity: number, order: number): RunStore => {
    const mat = sharedMaterial(colour, 0.8, 0, opacity, true, false, order);
    return { name, geometry: unit, material: mat, castShadow: false, receiveShadow: false, tinted: false, cards: false, renderOrder: 20 + order };
  };
  const xrayStores: RunStore[] = [
    through('metro-bore', 0x8d8a84, 0.55, 0),
    through('metro-ballast', 0x6d675e, 0.95, 1),
    through('metro-platforms', 0xd6cfc2, 0.95, 1),
    through('metro-sleepers', 0x5b4636, 1, 2),
    through('metro-rails', 0xb8bec4, 1, 3),
    through('metro-roof', 0x8d8a84, 0.18, 4),
  ];
  const visible = createInstanceRuns('transit-pieces', visibleStores, m(8));
  const xray = createInstanceRuns('transit-xray', xrayStores, 0);
  xray.group.visible = false;
  group.add(visible.group, xray.group);
  const product = new Derived(new TransitProduct(visibleStores, xrayStores));
  const drawn = new Map<number, TransitPlace>();
  let boxes = 0;

  // The trains: one box per car, moved each frame, in their line's colour.
  const o = new Object3D();
  const place = (b: Box): void => {
    o.position.set(b.x, b.z + b.height / 2, -b.y);
    o.rotation.set(0, b.yaw, 0);
    o.scale.set(b.length, b.height, b.width);
    o.updateMatrix();
  };
  const cars = new InstancedMesh(unit, material(0xffffff, 0.45, 0.3), MAX_CARS);
  cars.name = 'transit-trains';
  cars.castShadow = true;
  // Its instances move all over the map: the bounds of the one unit box at the
  // origin would cull them all whenever the camera is elsewhere.
  cars.frustumCulled = false;
  cars.count = 0;
  group.add(cars);
  const tint = new Color();
  /** Each line's colour as three holds it, parsed once (`Color.set` of a CSS string parses it on every call). */
  const lineColours = new Map<string, Color>();
  return {
    group,
    get triangles() { return boxes * 12; },
    setXray(on) { xray.group.visible = on; },
    sync(doc, groundAt, pavedAt, onRoad) {
      const source: TransitSource = { changes: doc.changes, doc, groundAt, pavedAt, onRoad };
      const goneShown: Run[] = [], cameShown: Run[] = [], goneCut: Run[] = [], cameCut: Run[] = [];
      for (const key of product.refresh(source)) {
        const was = drawn.get(key);
        if (was) { goneShown.push(was.visible); goneCut.push(was.xray); boxes -= was.boxes; drawn.delete(key); }
        const now = product.get(key);
        if (now) { cameShown.push(now.visible); cameCut.push(now.xray); boxes += now.boxes; drawn.set(key, now); }
      }
      if (goneShown.length || cameShown.length) {
        visible.update({ removed: goneShown, added: cameShown });
        xray.update({ removed: goneCut, added: cameCut });
      }
      return product.work.last;
    },
    cull(frustum, view) {
      visible.cull(frustum, view);
      if (xray.group.visible) xray.cull(frustum, view);
    },
    update(trains, ground) {
      let n = 0;
      for (const train of trains) {
        if (train.metro) continue;
        let colour = lineColours.get(train.colour);
        if (!colour) lineColours.set(train.colour, colour = new Color(train.colour));
        tint.copy(colour);
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
      visible.dispose();
      xray.dispose();
      cars.dispose();
      unit.dispose();
      drawn.clear();
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


/** The run of track being laid, kept and written again as it changes (`createTrackPreview`). */
export interface TrackPreview {
  readonly group: Group;
  /** The track along `points` as it will be built; fewer than two points shows nothing. */
  set(points: readonly { x: number; y: number }[], mode: 'train' | 'metro',
    groundAt: (x: number, y: number) => number, pavedAt?: (x: number, y: number) => number): void;
  dispose(): void;
}

/** Each layer of the preview: its boxes in `trackBoxes`, colour, opacity, draw order and finish. */
const PREVIEW_LAYERS = [
  { boxes: 'tunnel', colour: 0x8d8a84, opacity: 0.55, order: 0, roughness: 0.8, metalness: 0 },
  { boxes: 'ballast', colour: 0x7d776e, opacity: 0.9, order: 1, roughness: 0.8, metalness: 0 },
  { boxes: 'sleepers', colour: 0x5b4636, opacity: 0.95, order: 2, roughness: 0.8, metalness: 0 },
  { boxes: 'rails', colour: 0x9aa0a6, opacity: 1, order: 3, roughness: 0.35, metalness: 0.8 },
  { boxes: 'roof', colour: 0x8d8a84, opacity: 0.18, order: 4, roughness: 0.8, metalness: 0 },
] as const;

/**
 * The run of track being laid (the transit tool's preview): the real track,
 * as it will be built - the train's on its ballast, the metro's in its bore
 * under the ground, seen through it - not a line. ONE set of instanced meshes
 * for the tool's life, written again as the track changes, growing by
 * doubling when it needs more room: the preview follows the pointer, and a new
 * geometry and new instanced meshes per move were new GPU buffers per move,
 * and the instance buffers were never freed (`dispose` freed the box only).
 * DO NOT build the preview again per move.
 */
export function createTrackPreview(): TrackPreview {
  const group = new Group();
  group.name = 'transit-preview';
  const unit = new BoxGeometry(1, 1, 1);
  const o = new Object3D();
  const meshes = PREVIEW_LAYERS.map((layer) => {
    const mesh = new InstancedMesh(unit, sharedMaterial(layer.colour, layer.roughness, layer.metalness, layer.opacity, true, true), 16);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.renderOrder = 30 + layer.order;
    mesh.frustumCulled = false;
    mesh.count = 0;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  });
  return {
    group,
    set(points, mode, groundAt, pavedAt = () => NaN) {
      const laid = points.length >= 2 ? trackBoxes(points, mode, groundAt, pavedAt) : null;
      PREVIEW_LAYERS.forEach((layer, k) => {
        let mesh = meshes[k]!;
        const boxes = laid ? laid[layer.boxes] : [];
        if (boxes.length > mesh.instanceMatrix.count) {
          // three cannot resize a buffer attribute: a new mesh, twice as long, the old one's buffers freed.
          let capacity = mesh.instanceMatrix.count;
          while (capacity < boxes.length) capacity *= 2;
          const grown = new InstancedMesh(unit, mesh.material, capacity);
          grown.instanceMatrix.setUsage(DynamicDrawUsage);
          grown.renderOrder = mesh.renderOrder;
          grown.frustumCulled = false;
          group.remove(mesh);
          mesh.dispose();
          group.add(grown);
          meshes[k] = mesh = grown;
        }
        // The metro's is seen through the ground; the train's is not.
        mesh.material = sharedMaterial(layer.colour, layer.roughness, layer.metalness, layer.opacity, true, mode !== 'metro');
        boxes.forEach((b, i) => {
          o.position.set(b.x, b.z + b.height / 2, -b.y); o.rotation.set(0, b.yaw, 0); o.scale.set(b.length, b.height, b.width); o.updateMatrix();
          mesh.setMatrixAt(i, o.matrix);
        });
        mesh.count = boxes.length;
        mesh.visible = boxes.length > 0;
        mesh.instanceMatrix.clearUpdateRanges();
        if (boxes.length) {
          mesh.instanceMatrix.addUpdateRange(0, boxes.length * 16);
          mesh.instanceMatrix.needsUpdate = true;
        }
      });
    },
    dispose() {
      for (const mesh of meshes) mesh.dispose();
      unit.dispose();
    },
  };
}

/** The run of track `points` built once as a preview (the shader warm-up, `renderer.ts`). */
export function buildTrackPreview(points: readonly { x: number; y: number }[], mode: 'train' | 'metro',
  groundAt: (x: number, y: number) => number, pavedAt: (x: number, y: number) => number = () => NaN): TrackPreview {
  const preview = createTrackPreview();
  preview.set(points, mode, groundAt, pavedAt);
  return preview;
}
