import { describe, expect, it } from 'vitest';
import type { Vec2 } from '@core/vec2';
import { dist } from '@core/vec2';
import { normaliseAngle } from '@editor/buildings';
import { type FootprintSize, type PlacementSnap, footprintSize, snapPlacement } from '@editor/buildingSnap';
import { type Anchor, findAnchor } from '@editor/snap';
import { blueprintByKey, instantiate } from '@world/buildings/blueprints';
import { GRID, buildingBounds, footprintRects } from '@world/buildings/geometry';
import type { Building, BuildingId } from '@world/buildings/types';
import { ROAD_CLEARANCE } from '@world/buildings/validate';
import { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import { Network } from '@world/network';
import { Level, ROAD_TYPES, casingHalf, halfWidth, roadProfile } from '@world/roadTypes';
import { roadStructure } from '@world/structures';
import { m } from '@world/units';

/**
 * The pointer's snap reads the places near it, not the map (class C2,
 * docs/PLANO-ESPINHA-2026-10-14.md): `findAnchor` (`editor/snap.ts`) and
 * `snapPlacement` (`editor/buildingSnap.ts`) ask the network's cells and the
 * buildings' grid. The answers must be the ones the walk over the whole map
 * gave - copied below as it stood - and the work must not grow with the map.
 */

const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const SPACING = m(80);
const KINDS = ['local', 'urban', 'avenue'].map((id) => ROAD_TYPES.findIndex((t) => t.id === id));
const BLUEPRINTS = ['house', 'rowhouse', 'shop', 'apartments', 'office'];

/** A grid town of `k` by `k` blocks: roads of three classes, some bent, three buildings a block. */
function town(k: number): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const ids: NodeId[][] = [];
  for (let i = 0; i <= k; i++) {
    ids.push([]);
    for (let j = 0; j <= k; j++) ids[i]!.push(doc.addNode({ x: i * SPACING, y: j * SPACING }).id);
  }
  for (let i = 0; i <= k; i++) {
    for (let j = 0; j <= k; j++) {
      const kind = KINDS[(i * 7 + j * 3) % KINDS.length]!;
      const bent = (i + 2 * j) % 5 === 0 ? { t: 0.5, h: m(6) } : null;
      if (i < k) doc.addSegment(ids[i]![j]!, ids[i + 1]![j]!, kind, bent);
      if (j < k) doc.addSegment(ids[i]![j]!, ids[i]![j + 1]!, kind, null);
    }
  }
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      // The same buildings in a block whatever the size of the town.
      const rnd = mulberry32(i * 1000 + j + 1);
      for (let b = 0; b < 3; b++) {
        const body = blueprintByKey(BLUEPRINTS[Math.floor(rnd() * BLUEPRINTS.length)]!)!.body;
        const at = { x: i * SPACING + m(18) + rnd() * m(44), y: j * SPACING + m(18) + rnd() * m(44) };
        const rotation = rnd() < 0.5 ? Math.floor(rnd() * 4) * (Math.PI / 2) : rnd() * Math.PI * 2;
        doc.buildings.add(instantiate(body, at, rotation));
      }
    }
  }
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

// ------------------------------------------------- the walks, as they stood

function oldFindAnchor(doc: RoadDoc, net: Network, p: Vec2, zoom: number, exclude?: ReadonlySet<NodeId>, targetHeightOffset?: number): Anchor {
  const nodeRadius = 30 / zoom;
  let best: Anchor = { kind: 'free', at: p };
  let bestScore = Infinity;
  for (const node of doc.nodes.values()) {
    if (exclude?.has(node.id)) continue;
    if (targetHeightOffset !== undefined && Math.abs(node.heightOffset - targetHeightOffset) > m(0.3)) continue;
    const d = dist(p, node);
    if (d > nodeRadius) continue;
    if (d < bestScore) {
      bestScore = d;
      best = { kind: 'node', at: { x: node.x, y: node.y }, node: node.id };
    }
  }
  if (best.kind === 'node') return best;
  for (const [id, seg] of doc.segments) {
    const segRadius = Math.max(26 / zoom, casingHalf(roadProfile(seg.type, seg.lanes, seg.direction, seg.section, seg.parking)));
    const pl = net.polylines.get(doc, id);
    const bb = pl.bbox;
    if (p.x < bb.minX - segRadius || p.x > bb.maxX + segRadius || p.y < bb.minY - segRadius || p.y > bb.maxY + segRadius) continue;
    const hit = pl.closestPoint(p);
    if (hit.distance > segRadius) continue;
    if (targetHeightOffset !== undefined) {
      const fraction = hit.s / Math.max(1e-6, pl.length);
      const a = doc.node(seg.a)?.heightOffset ?? 0;
      const b = doc.node(seg.b)?.heightOffset ?? 0;
      const height = a + (b - a) * fraction + roadStructure(seg.structure).clearance;
      if (Math.abs(height - targetHeightOffset) > m(0.3)) continue;
    }
    if (hit.distance < bestScore) {
      bestScore = hit.distance;
      best = { kind: 'segment', at: hit.point, segment: id, s: hit.s };
    }
  }
  return best;
}

const ROAD_REACH = m(9.6);
const EDGE_SNAP = m(0.32);
const BUILDING_REACH = m(12);

function oldSnapPlacement(doc: RoadDoc, net: Network | null, size: FootprintSize, cursor: Vec2, rotation: number, ignore?: BuildingId): PlacementSnap {
  const road = net ? oldSnapToRoad(net, size, cursor) : null;
  if (road) return oldFlush(doc, road, size, false, ignore);
  const near = oldNearestBuilding(doc, cursor, ignore);
  if (near) {
    const quarter = Math.PI / 2;
    const bearing = near.rotation;
    const k = Math.round(normaliseAngle(rotation - bearing) / quarter);
    const aligned: PlacementSnap = { anchor: frontAnchor(cursor, size, bearing + k * quarter), rotation: normaliseAngle(bearing + k * quarter), kind: 'building' };
    return oldFlush(doc, aligned, size, true, ignore);
  }
  const snapped = { x: Math.round(cursor.x / GRID) * GRID, y: Math.round(cursor.y / GRID) * GRID };
  return { anchor: frontAnchor(snapped, size, rotation), rotation: normaliseAngle(rotation), kind: 'grid' };
}

function frontAnchor(centre: Vec2, size: FootprintSize, rotation: number): Vec2 {
  const vx = -Math.sin(rotation);
  const vy = Math.cos(rotation);
  return { x: centre.x - vx * (size.depth / 2), y: centre.y - vy * (size.depth / 2) };
}

function oldSnapToRoad(net: Network, size: FootprintSize, at: Vec2): PlacementSnap | null {
  let best: { distance: number; anchor: Vec2; rotation: number; ribbon: number } | null = null;
  for (const ribbon of net.ribbons.values()) {
    const segment = net.doc.segment(ribbon.id);
    if (!segment || segment.structure === 'tunnel') continue;
    const half = halfWidth(ribbon.road, Level.Sidewalk) + ROAD_CLEARANCE;
    const hit = ribbon.full.closestPoint(at);
    if (hit.distance > half + size.depth + ROAD_REACH) continue;
    if (best && hit.distance >= best.distance) continue;
    const frame = ribbon.full.sampleAt(hit.s);
    const side = (at.x - frame.p.x) * frame.n.x + (at.y - frame.p.y) * frame.n.y >= 0 ? 1 : -1;
    const s = Math.round(hit.s / GRID) * GRID;
    const along = ribbon.full.sampleAt(Math.max(0, Math.min(ribbon.full.length, s)));
    const ox = frame.n.x * side;
    const oy = frame.n.y * side;
    const rotation = Math.atan2(-ox, oy);
    best = { distance: hit.distance, anchor: { x: along.p.x + ox * half, y: along.p.y + oy * half }, rotation, ribbon: ribbon.id };
  }
  if (!best) return null;
  return { anchor: oldCornerFlush(net, best.anchor, best.rotation, size, best.ribbon, at), rotation: normaliseAngle(best.rotation), kind: 'road' };
}

function oldCornerFlush(net: Network, anchor: Vec2, rotation: number, size: FootprintSize, snapped: number, cursor: Vec2): Vec2 {
  const ux = Math.cos(rotation), uy = Math.sin(rotation);
  const vx = -Math.sin(rotation), vy = Math.cos(rotation);
  let shift = 0;
  let bestNeed = Infinity;
  for (const ribbon of net.ribbons.values()) {
    if (ribbon.id === snapped) continue;
    const segment = net.doc.segment(ribbon.id);
    if (!segment || segment.structure === 'tunnel') continue;
    const back = halfWidth(ribbon.road, Level.Sidewalk) + ROAD_CLEARANCE;
    for (const side of [-1, 1]) {
      const px = anchor.x + ux * side * size.width / 2 + vx * size.depth / 2;
      const py = anchor.y + uy * side * size.width / 2 + vy * size.depth / 2;
      const hit = ribbon.full.closestPoint({ x: px, y: py });
      if (hit.distance > back + size.width + size.module) continue;
      const frame = ribbon.full.sampleAt(hit.s);
      if (Math.abs(frame.t.x * vx + frame.t.y * vy) < 0.9) continue;
      const beyond = ((frame.p.x - px) * ux + (frame.p.y - py) * uy) * side;
      if (beyond <= 0) continue;
      const need = beyond - back;
      const candidateX = anchor.x + ux * need * side;
      const candidateY = anchor.y + uy * need * side;
      const along = (cursor.x - candidateX) * ux + (cursor.y - candidateY) * uy;
      const behind = (cursor.x - candidateX) * vx + (cursor.y - candidateY) * vy;
      const outsideAlong = Math.max(0, Math.abs(along) - size.width / 2);
      const outsideDepth = Math.max(0, -behind, behind - size.depth);
      if (Math.hypot(outsideAlong, outsideDepth) > size.module) continue;
      if (Math.abs(need) < Math.abs(bestNeed)) { bestNeed = need; shift = need * side; }
    }
  }
  return { x: anchor.x + ux * shift, y: anchor.y + uy * shift };
}

function oldNearestBuilding(doc: RoadDoc, at: Vec2, ignore?: BuildingId): Building | null {
  let best: Building | null = null;
  let bestDistance = BUILDING_REACH;
  for (const b of doc.buildings.all()) {
    if (b.id === ignore) continue;
    const box = buildingBounds(b);
    const dx = Math.max(box.minX - at.x, 0, at.x - box.maxX);
    const dy = Math.max(box.minY - at.y, 0, at.y - box.maxY);
    const d = Math.hypot(dx, dy);
    if (d < bestDistance) { bestDistance = d; best = b; }
  }
  return best;
}

function oldFlush(doc: RoadDoc, snap: PlacementSnap, size: FootprintSize, both: boolean, ignore?: BuildingId): PlacementSnap {
  const ux = Math.cos(snap.rotation), uy = Math.sin(snap.rotation);
  const vx = -uy, vy = ux;
  let shiftU = 0, shiftV = 0;
  let bestU = EDGE_SNAP * size.module, bestV = EDGE_SNAP * size.module;
  const reach = Math.max(size.width, size.depth) * 2 + m(8);
  for (const b of doc.buildings.all()) {
    if (b.id === ignore) continue;
    const turn = Math.abs(normaliseAngle((b.rotation - snap.rotation) * 4)) / 4;
    if (turn > 0.02) continue;
    const box = buildingBounds(b);
    const near = snap.anchor;
    if (box.minX > near.x + reach || box.maxX < near.x - reach || box.minY > near.y + reach || box.maxY < near.y - reach) continue;
    for (const rect of footprintRects(b)) {
      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      for (const p of rect) {
        const du = (p.x - snap.anchor.x) * ux + (p.y - snap.anchor.y) * uy;
        const dv = (p.x - snap.anchor.x) * vx + (p.y - snap.anchor.y) * vy;
        minU = Math.min(minU, du); maxU = Math.max(maxU, du);
        minV = Math.min(minV, dv); maxV = Math.max(maxV, dv);
      }
      const half = size.width / 2;
      if (maxV > m(-0.2) && minV < size.depth + m(0.2)) {
        for (const shift of [maxU + half, minU - half, minU + half, maxU - half]) {
          if (Math.abs(shift) < bestU) { bestU = Math.abs(shift); shiftU = shift; }
        }
      }
      if (both && maxU > -half - 0.5 && minU < half + 0.5) {
        for (const shift of [maxV, minV - size.depth, minV, maxV - size.depth]) {
          if (Math.abs(shift) < bestV) { bestV = Math.abs(shift); shiftV = shift; }
        }
      }
    }
  }
  return { anchor: { x: snap.anchor.x + ux * shiftU + vx * shiftV, y: snap.anchor.y + uy * shiftU + vy * shiftV }, rotation: snap.rotation, kind: snap.kind };
}

// ------------------------------------------------------------- the counting

/** Counts every item a snap looks at: what a walk over the map yields, and what the indexes hand back. */
function counted(doc: RoadDoc, net: Network): { n: number } {
  const c = { n: 0 };
  const yields = (target: object, key: PropertyKey): void => {
    const t = target as Record<PropertyKey, (...a: unknown[]) => Iterable<unknown>>;
    const original = t[key]!.bind(target);
    t[key] = function* (...a: unknown[]) { for (const x of original(...a)) { c.n++; yield x; } };
  };
  yields(doc.nodes, 'values');
  yields(doc.segments, Symbol.iterator);
  yields(net.ribbons, 'values');
  yields(doc.buildings, 'all');
  const meeting = net.segmentCells.idsMeeting.bind(net.segmentCells);
  net.segmentCells.idsMeeting = (rect) => { const out = meeting(rect); c.n += out.length; return out; };
  const near = doc.buildings.near.bind(doc.buildings);
  doc.buildings.near = (...a) => { const out = near(...a); c.n += out.length; return out; };
  return c;
}

const SIZES = BLUEPRINTS.map((key) => footprintSize(blueprintByKey(key)!.body));

describe('the snap under the pointer reads the places near it', () => {
  it('findAnchor gives the same anchor as the walk over every node and road', () => {
    const { doc, net } = town(8);
    const rnd = mulberry32(42);
    const nodes = [...doc.nodes.values()];
    const zooms = [0.25, 0.5, 1, 2, 6];
    const kinds = { node: 0, segment: 0, free: 0 };
    for (let i = 0; i < 3000; i++) {
      const base = rnd() < 0.5
        ? nodes[Math.floor(rnd() * nodes.length)]!
        : { x: rnd() * 8 * SPACING, y: rnd() * 8 * SPACING };
      const p = { x: base.x + (rnd() - 0.5) * m(60), y: base.y + (rnd() - 0.5) * m(60) };
      const zoom = zooms[Math.floor(rnd() * zooms.length)]!;
      const exclude = rnd() < 0.2 ? new Set([nodes[Math.floor(rnd() * nodes.length)]!.id]) : undefined;
      const height = [undefined, 0, m(5)][Math.floor(rnd() * 3)];
      const want = oldFindAnchor(doc, net, p, zoom, exclude, height);
      expect(findAnchor(doc, net, p, zoom, exclude, height)).toEqual(want);
      kinds[want.kind]++;
    }
    // The points reach all three answers.
    expect(kinds.node).toBeGreaterThan(200);
    expect(kinds.segment).toBeGreaterThan(200);
    expect(kinds.free).toBeGreaterThan(200);
  });

  it('snapPlacement gives the same placement as the walk over every road and building', () => {
    const { doc, net } = town(8);
    const rnd = mulberry32(7);
    const ids = [...doc.buildings.all()].map((b) => b.id);
    const kinds = { road: 0, building: 0, grid: 0 };
    for (let i = 0; i < 2000; i++) {
      const p = { x: rnd() * 8 * SPACING, y: rnd() * 8 * SPACING };
      const size = SIZES[Math.floor(rnd() * SIZES.length)]!;
      const rotation = rnd() * Math.PI * 2;
      const ignore = rnd() < 0.2 ? ids[Math.floor(rnd() * ids.length)] : undefined;
      // Without the network the road snap is skipped: the buildings answer.
      const roads = rnd() < 0.5 ? net : null;
      const want = oldSnapPlacement(doc, roads, size, p, rotation, ignore);
      expect(snapPlacement(doc, roads, size, p, rotation, ignore)).toEqual(want);
      kinds[want.kind]++;
    }
    expect(kinds.road).toBeGreaterThan(200);
    expect(kinds.building).toBeGreaterThan(100);
    expect(kinds.grid).toBeGreaterThan(50);
  });

  it('looks at as many things in a town four times the area', () => {
    // Points well inside the small town (a network cell is 256 m): the same
    // places round them in both towns.
    const points: Vec2[] = [];
    const rnd = mulberry32(3);
    for (let i = 0; i < 40; i++) points.push({ x: m(290) + rnd() * m(60), y: m(290) + rnd() * m(60) });
    const work = (t: { doc: RoadDoc; net: Network }, anchor: typeof findAnchor, place: typeof snapPlacement): number => {
      const c = counted(t.doc, t.net);
      for (const p of points) {
        anchor(t.doc, t.net, p, 1);
        place(t.doc, t.net, SIZES[0]!, p, 0.3);
        place(t.doc, null, SIZES[1]!, p, 0.3);
      }
      return c.n;
    };
    const small = town(8), large = town(16);
    const now = [work(small, findAnchor, snapPlacement), work(large, findAnchor, snapPlacement)];
    expect(now[0]).toBeGreaterThan(0);
    expect(now[1]).toBe(now[0]);
    // The count sees a walk over the map: the old snap's grows with it.
    const before = [work(town(8), oldFindAnchor, oldSnapPlacement), work(town(16), oldFindAnchor, oldSnapPlacement)];
    expect(before[1]).toBeGreaterThan(before[0]! * 3);
  });
});
