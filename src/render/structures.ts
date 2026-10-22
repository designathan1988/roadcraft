import {
  BoxGeometry,
  BufferGeometry,
  BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Mesh,
  Object3D,
  type Material,
} from 'three';

import { angleOf } from '@core/vec2';
import type { Frame, Polyline } from '@core/polyline';
import type { Network, SegmentRibbon } from '@world/network';
import type { SegmentId } from '@world/ids';
import { CUT_WALL_REACH, type RoadElevation } from '@world/elevation';
import { buildModeAt } from '@world/roads/buildMode';
import { TERRAIN_UV } from './roadSurfaceReads';
import { ROAD_TUNING } from '@world/roads/tuning';
import { Level, casingHalf, roadProfile, sidewalkHalf } from '@world/roadTypes';
import {
  RAISED_LIFT,
  TUNNELS_DRAWN,
  TUNNEL_ARCH,
  TUNNEL_BORE,
  TUNNEL_HEADROOM,
  TUNNEL_PORTAL_COVER,
  isRaised,
  roadStructure,
  type RoadStructure,
} from '@world/structures';
import type { SceneMaterials } from './materials';
import { m } from '@world/units';
import { cylinderWith } from './mesh/cylinder';

/** The parts of a raised structure that are not its deck */

export interface StructureDetails {
  readonly group: Group;
  readonly triangles: number;
  /** Where the structures built stand */
  readonly spans: readonly (readonly [number, number, number, number])[];
  dispose(): void;
}

/** Room round a structure's road that its details read (abutments, casings met, portals). */
export const SPAN_REACH = m(24);

/** DO NOT walk every ribbon of the map for a box. */
function structureRibbons(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  within?: readonly (readonly [number, number, number, number])[],
  candidates?: readonly SegmentRibbon[],
): { raised: SegmentRibbon[]; tunnels: SegmentRibbon[]; walled: SegmentRibbon[] } {
  const samples = (ribbon: SegmentRibbon,
    predicate: (cover: number) => boolean): boolean => {
    for (let s = 0; s <= ribbon.full.length; s += Math.max(m(1.6), ribbon.full.length / 32)) {
      const p = ribbon.full.sampleAt(s).p;
      const cover = elevation.onSegment(ribbon.id, p.x, p.y) - terrainAt(p.x, p.y);
      if (predicate(cover)) return true;
    }
    return false;
  };
  const near = (): SegmentRibbon[] => {
    const ids = new Set<SegmentId>();
    for (const r of within!) for (const id of net.segmentCells.idsMeeting([r[0] - SPAN_REACH, r[1] - SPAN_REACH, r[2] + SPAN_REACH, r[3] + SPAN_REACH])) ids.add(id);
    return [...ids].sort((a, b) => a - b).map((id) => net.ribbons.get(id)).filter((r): r is SegmentRibbon => r !== undefined);
  };
  /** @rebuild Every ribbon only for the whole map's details (the first world, a map opened). */
  const asked = candidates ?? (within === undefined ? [...net.ribbons.values()] : near());
  const raised = asked.filter((ribbon) =>
    isRaised(net.doc.segment(ribbon.id)?.structure ?? 'ground') || samples(ribbon, (lift) => lift > RAISED_LIFT),
  );
  const tunnels = TUNNELS_DRAWN
    ? asked.filter((ribbon) =>
      ribbon.full.length > 0 &&
      (net.doc.segment(ribbon.id)?.structure === 'tunnel' || samples(ribbon, (lift) => lift < -TUNNEL_BORE)))
    : [];
  // Roads whose cutting is held by retaining walls.
  const walled = asked.filter((ribbon) => net.doc.segment(ribbon.id)?.cutWalls === true && ribbon.full.length > 0);
  return { raised, tunnels, walled };
}

/** A retaining wall's thickness, its coping over the ground it holds, its footing under the road. */
const WALL_THICK = m(0.32);
const WALL_COPING = m(0.18);
const WALL_FOOT = m(0.24);
/** Spacing of a wall's sections along the road. */
const WALL_STEP = m(0.8);

/** THE RETAINING WALLS of a cutting (`RoadSegment.cutWalls`) */
function retainingWalls(
  net: Network, walled: readonly SegmentRibbon[], elevation: RoadElevation, terrainAt: (x: number, y: number) => number,
  faces: Extrusion, lids: Extrusion, faceTile: number, lidTile: number,
): void {
  for (const ribbon of walled) {
    const structure = net.doc.requireSegment(ribbon.id).structure;
    const centre = ribbon.centre[Level.Casing] ?? ribbon.full;
    const edge = casingHalf(ribbon.road);
    const length = centre.length;
    const steps = Math.max(1, Math.ceil(length / WALL_STEP));
    for (const side of [1, -1] as const) {
      type Section = { x: number; y: number; ox: number; oy: number; deck: number; top: number; s: number };
      let prev: Section | null = null;
      for (let i = 0; i <= steps; i++) {
        const s = (i / steps) * length;
        const f = centre.sampleAt(s);
        const ox = f.n.x * side, oy = f.n.y * side;
        const deck = elevation.onSegment(ribbon.id, f.p.x, f.p.y);
        // The ground where the backfill ends: past the shaper's reach, the natural ground.
        const out = edge + CUT_WALL_REACH - m(0.2);
        const top = terrainAt(f.p.x + ox * out, f.p.y + oy * out);
        // Only where the road is in an open cutting (`world/roads/buildMode.ts`): not at grade, not where it has gone into a bore.
        const here: Section | null = buildModeAt(structure, deck - top) === 'cutting'
          ? { x: f.p.x + ox * edge, y: f.p.y + oy * edge, ox, oy, deck, top, s }
          : null;
        // The end of a run of wall: the backfill closed down to the road.
        const end = here && !prev ? here : prev && !here ? prev : null;
        if (end) {
          const tx = f.t.x, ty = f.t.y, sign = here ? -1 : 1;
          const at = (out: number, h: number): [number, number, number] => [end.x + end.ox * out, end.y + end.oy * out, h];
          faces.quad(at(0, end.deck - WALL_FOOT), at(CUT_WALL_REACH - m(0.2), end.deck - WALL_FOOT), at(CUT_WALL_REACH - m(0.2), end.top + m(0.016)), at(0, end.top + WALL_COPING),
            [tx * sign, ty * sign, 0], [0, (end.deck - WALL_FOOT) / faceTile, CUT_WALL_REACH / faceTile, (end.top + WALL_COPING) / faceTile]);
        }
        if (prev && here) {
          const a = prev, b = here;
          const at = (q: Section, out: number, h: number): [number, number, number] => [q.x + q.ox * out, q.y + q.oy * out, h];
          const u0 = a.s / faceTile, u1 = b.s / faceTile;
          // The face towards the road.
          faces.quad(at(a, 0, a.deck - WALL_FOOT), at(b, 0, b.deck - WALL_FOOT), at(b, 0, b.top + WALL_COPING), at(a, 0, a.top + WALL_COPING),
            [-(a.ox + b.ox) / 2, -(a.oy + b.oy) / 2, 0], [u0, (a.deck - WALL_FOOT) / faceTile, u1, (a.top + WALL_COPING) / faceTile]);
          // The coping.
          faces.quad(at(a, 0, a.top + WALL_COPING), at(b, 0, b.top + WALL_COPING), at(b, WALL_THICK, b.top + WALL_COPING), at(a, WALL_THICK, a.top + WALL_COPING),
            [0, 0, 1], [u0, 0, u1, WALL_THICK / faceTile]);
          // The back of the coping, down to the backfill.
          faces.quad(at(a, WALL_THICK, a.top + WALL_COPING), at(b, WALL_THICK, b.top + WALL_COPING), at(b, WALL_THICK, b.top), at(a, WALL_THICK, a.top),
            [(a.ox + b.ox) / 2, (a.oy + b.oy) / 2, 0], [u0, 0, u1, WALL_COPING / faceTile]);
          // The backfill over the band the cutting was dug back.
          const back = CUT_WALL_REACH - m(0.2);
          // Flat from the coping to where it meets the ground.
          const pa = at(a, WALL_THICK, a.top + m(0.016)), pb = at(b, WALL_THICK, b.top + m(0.016));
          const qa = at(a, back, a.top + m(0.016)), qb = at(b, back, b.top + m(0.016));
          lids.quadWorld(pa, pb, qb, qa, [0, 0, 1], lidTile);
        }
        prev = here;
      }
    }
  }
}

/** Bearing inset: the deck rests ON the pier, so its top stops just under it. */
const BEARING = m(0.08);
/** How slender a column is allowed to be: height divided by width. */
const PIER_SLENDERNESS = 8;
/** Nothing gets fatter than this, however tall the deck. */
const PIER_MAX_WIDTH_FACTOR = 1.8;
/** Shortest pier worth building. Below this the deck is on the ground. */
const MIN_SUPPORT = m(0.36);
/** Where a bent's columns stand, as a fraction of the deck's half-width. */
const BENT_SPREAD = 0.55;
/** Depth of the crossbeam along the road, as a multiple of a column's radius. */
const CAP_DEPTH = 2.2;
/** Depth of the crossbeam the columns carry. */
const CAP_HEIGHT = m(0.72);
/** How far the crossbeam reaches past the outermost column. */
const CAP_OVERHANG = m(0.64);
/** The parapet: a solid concrete barrier along each edge of a deck. */
const PARAPET_HEIGHT = m(0.88);
/** Width of the barrier at its foot and at its top: the traffic face leans back. */
const PARAPET_FOOT = m(0.36);
const PARAPET_TOP = m(0.2);
/** Spacing of the extrusion's cross-sections along the edge. */
const PARAPET_STEP = m(1.2);
/** Height of the deck over the ground between which the parapet grows from nothing to its full height. */
const PARAPET_FROM = m(0.64);
const PARAPET_FULL = m(1.28);
/** Height of the deck over the ground at which a ramp leaves its solid approach for the first span on piers */
const ABUTMENT_LIFT = m(0.48);
/** Depth of an abutment along the road. */
const ABUTMENT_DEPTH = m(1.6);
/** How far a pier must stand from an abutment: less than this and it is one wall. */
const PIER_ABUTMENT_GAP = m(10.4);
/** How far a tunnel portal's face reaches past the road, to close the cutting. */
const PORTAL_WING = m(5.6);
/** Depth of the portal face along the road. Thick enough to cover a grid cell. */
const PORTAL_THICKNESS = m(1.6);
/** Width of each slice of a portal's wing walls, which step down with the ground beside it. */
const PORTAL_SLICE = m(1.2);
/** How far a portal's wing wall stands over the ground at its own place. */
export const PORTAL_COPING = m(0.24);

interface Placement {
  readonly x: number;
  readonly y: number;
  readonly yaw: number;
  readonly sx: number;
  readonly sy: number;
  readonly sz: number;
  readonly cy: number;
}

/** A column's foot over its width: `CylinderGeometry(1, 1.08, ...)` scaled by the width (`buildStructureDetails`). */
const PIER_FOOT_FLARE = 1.08;

/** A column's shape: open at its foot, half a metre under the ground (`placeBent`); its top kept, a wide column's disc reaching past the crossbeam's ends. */
export const pierShape = (): BufferGeometry => cylinderWith(1, PIER_FOOT_FLARE, 1, 16, { top: true, bottom: false });

/** DO NOT file a road by the cells round its vertices again */
export function onAnotherCasing(net: Network, self: SegmentId, x: number, y: number, clearance = 0): boolean {
  for (const id of net.segmentCells.idsMeeting([x - clearance, y - clearance, x + clearance, y + clearance])) {
    if (id === self) continue;
    const segment = net.doc.segment(id);
    if (!segment) continue;
    const reach = casingHalf(roadProfile(segment.type, segment.lanes, segment.direction, segment.section, segment.parking));
    if (net.polylines.get(net.doc, id).distanceTo({ x, y }) < reach + clearance) return true;
  }
  return false;
}

/** The instances' matrices of placements (16 floats each), as three's `Object3D` composes them (r186 `Object3D.updateMatrix`): what a bake hands the page. */
function matricesOf(placements: readonly Placement[]): Float32Array<ArrayBuffer> {
  const out = new Float32Array(placements.length * 16);
  const object = new Object3D();
  placements.forEach((placement, index) => {
    object.position.set(placement.x, placement.cy, -placement.y);
    object.rotation.set(0, placement.yaw, 0);
    object.scale.set(placement.sx, placement.sy, placement.sz);
    object.updateMatrix();
    object.matrix.toArray(out, index * 16);
  });
  return out;
}

/** A kind's instances drawn from their matrices, taken as they came (none: no mesh). */
function instanced(name: string, geometry: BufferGeometry, material: Material, matrices: Float32Array<ArrayBuffer>): InstancedMesh | null {
  const count = matrices.length / 16;
  if (count === 0) return null;
  const mesh = new InstancedMesh(geometry, material, 0);
  mesh.instanceMatrix = new InstancedBufferAttribute(matrices, 16);
  mesh.count = count;
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.computeBoundingSphere();
  return mesh;
}

/** A box placement whose LENGTH runs along the road and whose WIDTH runs across it, in world units. */
function boxAlong(frame: Frame, along: number, across: number, height: number, centreY: number, offset = 0): Placement {
  return {
    x: frame.p.x + frame.n.x * offset,
    y: frame.p.y + frame.n.y * offset,
    yaw: angleOf(frame.t),
    sx: along,
    sy: height,
    sz: across,
    cy: centreY,
  };
}

/** Flat-shaded quads, indexed, built in world coordinates and mapped into three's frame once. */
class Extrusion {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly uvs: number[] = [];
  readonly indices: number[] = [];

  /** One quad `a b c d` (counter-clockwise seen from `normal`), in world `(x, y, height)`. */
  quad(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    normal: readonly [number, number, number],
    uv: readonly [number, number, number, number],
  ): void {
    const to3 = (p: readonly [number, number, number]): [number, number, number] => [p[0], p[2], -p[1]];
    const n3: [number, number, number] = [normal[0], normal[2], -normal[1]];
    const pa = to3(a);
    const pc = to3(c);
    let pb = to3(b);
    let pd = to3(d);
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    const facing = (uy * vz - uz * vy) * n3[0] + (uz * vx - ux * vz) * n3[1] + (ux * vy - uy * vx) * n3[2];
    const [u0, v0, u1, v1] = uv;
    const uvA = [u0, v0];
    const uvC = [u1, v1];
    let uvB = [u1, v0];
    let uvD = [u0, v1];
    if (facing < 0) {
      [pb, pd] = [pd, pb];
      [uvB, uvD] = [uvD, uvB];
    }
    this.push(pa, pb, pc, pd, uvA, uvB, uvC, uvD, n3);
  }

  /** A quad textured by world position (`uv = (x, y) / scale` at each corner), as the terrain's own material reads it */
  quadWorld(
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    normal: readonly [number, number, number],
    scale: number,
  ): void {
    const to3 = (p: readonly [number, number, number]): [number, number, number] => [p[0], p[2], -p[1]];
    const n3: [number, number, number] = [normal[0], normal[2], -normal[1]];
    const uv = (p: readonly [number, number, number]): number[] => [p[0] / scale, p[1] / scale];
    const pa = to3(a), pc = to3(c);
    let pb = to3(b), pd = to3(d);
    let ub = uv(b), ud = uv(d);
    const ux = pb[0] - pa[0], uy = pb[1] - pa[1], uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0], vy = pc[1] - pa[1], vz = pc[2] - pa[2];
    if ((uy * vz - uz * vy) * n3[0] + (uz * vx - ux * vz) * n3[1] + (ux * vy - uy * vx) * n3[2] < 0) {
      [pb, pd] = [pd, pb];
      [ub, ud] = [ud, ub];
    }
    this.push(pa, pb, pc, pd, uv(a), ub, uv(c), ud, n3);
  }

  /** A quad's four corners, shared by its two triangles (one normal a quad: it stays flat). */
  private push(pa: readonly number[], pb: readonly number[], pc: readonly number[], pd: readonly number[],
    uvA: readonly number[], uvB: readonly number[], uvC: readonly number[], uvD: readonly number[], n3: readonly number[]): void {
    const first = this.positions.length / 3;
    for (const [p, t] of [[pa, uvA], [pb, uvB], [pc, uvC], [pd, uvD]] as const) {
      this.positions.push(p[0] as number, p[1] as number, p[2] as number);
      this.normals.push(n3[0] as number, n3[1] as number, n3[2] as number);
      this.uvs.push(t[0] as number, t[1] as number);
    }
    this.indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }

  /** Its quads' arrays (none: no quad); the index 16-bit while the corners fit, as three's `setIndex` of an array makes it. */
  sheet(): StructureSheet | null {
    if (this.positions.length === 0) return null;
    const vertices = this.positions.length / 3;
    return {
      positions: Float32Array.from(this.positions), normals: Float32Array.from(this.normals), uvs: Float32Array.from(this.uvs),
      index: vertices >= 0x10000 ? Uint32Array.from(this.indices) : Uint16Array.from(this.indices),
    };
  }
}

/** A sheet's mesh. */
function sheetMesh(sheet: StructureSheet | null, name: string, material: Material): Mesh | null {
  if (!sheet) return null;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(sheet.positions, 3));
  geometry.setAttribute('normal', new BufferAttribute(sheet.normals, 3));
  geometry.setAttribute('uv', new BufferAttribute(sheet.uvs, 2));
  geometry.setIndex(new BufferAttribute(sheet.index, 1));
  geometry.computeBoundingSphere();
  const mesh = new Mesh(geometry, material);
  mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** 0 below `a`, 1 above `b`, smooth in between. */
function smoothstep(a: number, b: number, value: number): number {
  const u = Math.min(1, Math.max(0, (value - a) / Math.max(1e-6, b - a)));
  return u * u * (3 - 2 * u);
}

/** The barrier along one edge of a raised deck, as a continuous extrusion. */
function parapetRun(
  out: Extrusion,
  centre: Polyline,
  side: 1 | -1,
  edge: number,
  deckAt: (x: number, y: number) => number,
  terrainAt: (x: number, y: number) => number,
  tile: number,
): void {
  const length = centre.length;
  if (length <= 0) return;
  const count = Math.max(1, Math.ceil(length / PARAPET_STEP));
  interface Section { x: number; y: number; ox: number; oy: number; bottom: number; top: number; s: number; tx: number; ty: number; grow: number }
  const sections: Section[] = [];
  for (let k = 0; k <= count; k++) {
    const s = (length * k) / count;
    const f = centre.sampleAt(s);
    const ox = f.n.x * side;
    const oy = f.n.y * side;
    const x = f.p.x + ox * edge;
    const y = f.p.y + oy * edge;
    const deck = deckAt(x, y);
    const grow = smoothstep(PARAPET_FROM, PARAPET_FULL, deck - terrainAt(x, y));
    sections.push({ x, y, ox, oy, bottom: deck - m(0.12), top: deck + m(0.144) + PARAPET_HEIGHT * grow, s, tx: f.t.x, ty: f.t.y, grow });
  }
  type P = [number, number, number];
  const outerFoot = (q: Section): P => [q.x, q.y, q.bottom];
  const outerTop = (q: Section): P => [q.x, q.y, q.top];
  const innerTop = (q: Section): P => [q.x - q.ox * PARAPET_TOP, q.y - q.oy * PARAPET_TOP, q.top];
  const innerFoot = (q: Section): P => [q.x - q.ox * PARAPET_FOOT, q.y - q.oy * PARAPET_FOOT, q.bottom];
  const cap = (q: Section, sign: number): void => {
    out.quad(outerFoot(q), innerFoot(q), innerTop(q), outerTop(q), [q.tx * sign, q.ty * sign, 0],
      [0, q.bottom / tile, PARAPET_FOOT / tile, q.top / tile]);
  };
  let open = false;
  for (let k = 0; k + 1 < sections.length; k++) {
    const a = sections[k] as Section;
    const b = sections[k + 1] as Section;
    if (a.grow <= 0.001 && b.grow <= 0.001) {
      open = false;
      continue;
    }
    if (!open && a.grow > 0.001) cap(a, -1);
    open = true;
    const u0 = a.s / tile;
    const u1 = b.s / tile;
    const ox = (a.ox + b.ox) / 2;
    const oy = (a.oy + b.oy) / 2;
    // Outer face, top, and the traffic face leaning back towards the road.
    out.quad(outerFoot(a), outerFoot(b), outerTop(b), outerTop(a), [ox, oy, 0], [u0, a.bottom / tile, u1, a.top / tile]);
    out.quad(outerTop(a), outerTop(b), innerTop(b), innerTop(a), [0, 0, 1], [u0, 0, u1, PARAPET_TOP / tile]);
    const lean = (PARAPET_FOOT - PARAPET_TOP) / Math.max(m(0.04), a.top - a.bottom);
    const nl = Math.hypot(1, lean);
    out.quad(innerTop(a), innerTop(b), innerFoot(b), innerFoot(a), [-ox / nl, -oy / nl, lean / nl],
      [u0, a.top / tile, u1, a.bottom / tile]);
    if (k + 2 === sections.length && b.grow > 0.001) cap(b, 1);
  }
}

/** A sheet of a structure's quads (parapets, retaining walls, their backfill), as arrays. */
export interface StructureSheet {
  readonly positions: Float32Array<ArrayBuffer>;
  readonly normals: Float32Array<ArrayBuffer>;
  readonly uvs: Float32Array<ArrayBuffer>;
  readonly index: Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>;
}

/** THE STRUCTURES OF SOME ROADS MADE, WITH NO MATERIAL (`buildStructureDetails`): each kind's instances' matrices, the sheets of quads, where they stand */
export interface StructureParts {
  readonly piers: Float32Array<ArrayBuffer>;
  readonly caps: Float32Array<ArrayBuffer>;
  readonly abutments: Float32Array<ArrayBuffer>;
  readonly jambs: Float32Array<ArrayBuffer>;
  readonly lintels: Float32Array<ArrayBuffer>;
  readonly headwalls: Float32Array<ArrayBuffer>;
  readonly parapets: StructureSheet | null;
  readonly walls: StructureSheet | null;
  readonly backfill: StructureSheet | null;
  readonly spans: readonly (readonly [number, number, number, number])[];
}

export function buildStructureDetails(
  net: Network,
  elevation: RoadElevation,
  terrainAt: (x: number, y: number) => number,
  materials: SceneMaterials,
  /** The terrain's own material, for a retaining wall's backfill */
  groundMaterial?: Material,
  /** Only these roads' structures (a cell of the structure layer, `structureCells.ts`); all of the map without. */
  only?: readonly SegmentRibbon[],
  /** The shapes the instances are drawn with, kept by the caller across builds; made here (and let go with these) without. */
  shapes?: { readonly pier: BufferGeometry; readonly box: BufferGeometry },
): StructureDetails {
  return structureMeshes(structureParts(net, elevation, terrainAt, materials.scale.deck, only), materials, groundMaterial, shapes);
}

/** The roads' structures made (`only`: these roads'; all of the map without); `deckTile`, the deck's texture scale (`SceneMaterials.scale.deck`). */
export function structureParts(net: Network, elevation: RoadElevation, terrainAt: (x: number, y: number) => number, deckTile: number, only?: readonly SegmentRibbon[]): StructureParts {
  const { raised, tunnels, walled } = structureRibbons(net, elevation, terrainAt, undefined, only);
  const spans = [...raised, ...tunnels, ...walled].map((ribbon) => {
    const bb = ribbon.full.bbox;
    return [bb.minX - SPAN_REACH, bb.minY - SPAN_REACH, bb.maxX + SPAN_REACH, bb.maxY + SPAN_REACH] as const;
  });

  const piers: Placement[] = [];
  const caps: Placement[] = [];
  const abutments: Placement[] = [];
  const parapets = new Extrusion();

  for (const ribbon of raised) {
    const segment = net.doc.requireSegment(ribbon.id);
    const structure = segment.structure as RoadStructure;
    const deckAt = (x: number, y: number): number => elevation.onSegment(segment.id, x, y);
    const spec = roadStructure(isRaised(structure) ? structure : 'elevated');
    const spacing = structure === 'bridge' ? ROAD_TUNING.piers.spacingBridge : ROAD_TUNING.piers.spacingElevated;
    const radius = structure === 'bridge' ? m(1.28) : m(1.04);
    const length = ribbon.full.length;
    const casing = casingHalf(ribbon.road);

    // ------------------------------------------------------------ abutments Where a ramp leaves the ground
    const liftAt = (s: number): number => {
      const f = ribbon.full.sampleAt(s);
      return deckAt(f.p.x, f.p.y) - spec.deck - m(0.144) - terrainAt(f.p.x, f.p.y);
    };
    const abutmentAt: number[] = [];
    const scan = 2;
    let before = liftAt(0);
    for (let s = scan; s <= length; s += scan) {
      const here = liftAt(s);
      if ((before < ABUTMENT_LIFT) !== (here < ABUTMENT_LIFT)) {
        const at = s - scan / 2;
        const f = ribbon.full.sampleAt(at);
        const soffit = deckAt(f.p.x, f.p.y) - spec.deck - m(0.144);
        const foot = Math.min(terrainAt(f.p.x, f.p.y), soffit) - 1;
        abutments.push(boxAlong(f, ABUTMENT_DEPTH, casing * 2, soffit - foot, (soffit + foot) / 2));
        abutmentAt.push(at);
      }
      before = here;
    }

    // ---------------------------------------------------------------- piers Columns stand out at the deck edges rather than
    const halfDeck = sidewalkHalf(ribbon.road);
    const spread = Math.max(0, Math.min(halfDeck * BENT_SPREAD, halfDeck - radius - 1));
    const sides: readonly number[] = spread > 0 ? [-1, 1] : [0];

    /** One bent: a crossbeam under the soffit, on a column at each deck edge. */
    const placeBent = (frame: Frame): void => {
      const soffit = deckAt(frame.p.x, frame.p.y) - spec.deck - m(0.144) - BEARING;
      const beam = soffit - CAP_HEIGHT;

      const standing: { readonly x: number; readonly y: number; readonly ground: number }[] = [];
      for (const side of sides) {
        const x = frame.p.x + frame.n.x * spread * side;
        const y = frame.p.y + frame.n.y * spread * side;
        const ground = terrainAt(x, y);
        if (beam - ground < MIN_SUPPORT) continue;
        standing.push({ x, y, ground });
      }
      if (standing.length === 0) return;

      // One width for the whole bent, from the TALLEST of its feet
      const tallest = standing.reduce((mx, foot) => Math.max(mx, beam - foot.ground), 0);
      const width = Math.min(radius * PIER_MAX_WIDTH_FACTOR, Math.max(radius, tallest / PIER_SLENDERNESS));
      // Not on another road: the column's whole foot clear of its casing, not only its axis.
      const feet = standing.filter((foot) => !onAnotherCasing(net, segment.id, foot.x, foot.y, width * PIER_FOOT_FLARE));
      if (feet.length === 0) return;

      for (const foot of feet) {
        const height = beam - foot.ground + 0.5;
        piers.push({ x: foot.x, y: foot.y, yaw: angleOf(frame.t), sx: width, sy: height, sz: width, cy: foot.ground - 0.5 + height / 2 });
      }
      // The crossbeam follows the columns it rests on, or a tall bent grows a beam narrower than the legs under it.
      caps.push(boxAlong(frame, width * CAP_DEPTH, spread * 2 + width + CAP_OVERHANG * 2, CAP_HEIGHT, beam + CAP_HEIGHT / 2));
    };

    let placed = 0;
    for (let s = spacing * 0.5; s < length - spacing * 0.35; s += spacing) {
      if (abutmentAt.some((at) => Math.abs(at - s) < PIER_ABUTMENT_GAP)) continue;
      placeBent(ribbon.full.sampleAt(s));
      placed++;
    }
    if (placed === 0 && length > 0) {
      const mid = length / 2;
      if (!abutmentAt.some((at) => Math.abs(at - mid) < PIER_ABUTMENT_GAP)) placeBent(ribbon.full.sampleAt(mid));
    }

    // ------------------------------------------------------------- parapets Along the casing's own centreline
    const centre = ribbon.centre[Level.Casing] ?? ribbon.full;
    const edge = casing - m(0.02);
    for (const side of [1, -1] as const) {
      parapetRun(parapets, centre, side, edge, deckAt, terrainAt, deckTile);
    }
  }

  // ------------------------------------------------------- retaining walls
  let walls: StructureSheet | null = null, backfill: StructureSheet | null = null;
  if (walled.length > 0) {
    const faces = new Extrusion();
    const lids = new Extrusion();
    retainingWalls(net, walled, elevation, terrainAt, faces, lids, deckTile, TERRAIN_UV);
    walls = faces.sheet();
    backfill = lids.sheet();
  }

  const jambs: Placement[] = [];
  const lintels: Placement[] = [];
  const headwalls: Placement[] = [];

  // ---------------------------------------------------------------- portals A portal is NOT at the end of a tunnel segment.
  if (TUNNELS_DRAWN && tunnels.length > 0) {
    for (const ribbon of tunnels) {
      const segment = net.doc.requireSegment(ribbon.id);
      const length = ribbon.full.length;
      const step = Math.min(m(2.4), Math.max(m(0.8), length / 200));
      const half = sidewalkHalf(ribbon.road);
      const jambWidth = m(0.88);

      const coverAt = (s: number): number => {
        const frame = ribbon.full.sampleAt(s);
        return terrainAt(frame.p.x, frame.p.y) - elevation.onSegment(segment.id, frame.p.x, frame.p.y);
      };

      let previous = coverAt(0);
      const buriedJoin = (nodeId: typeof segment.a): boolean => {
        const node = net.doc.node(nodeId);
        return !!node && node.incident.length > 1 && node.heightOffset < -TUNNEL_HEADROOM;
      };
      for (let s = step; s <= length; s += step) {
        const cover = coverAt(s);
        const crossed =
          (previous < TUNNEL_PORTAL_COVER && cover >= TUNNEL_PORTAL_COVER) ||
          (previous >= TUNNEL_PORTAL_COVER && cover < TUNNEL_PORTAL_COVER);
        previous = cover;
        if (!crossed) continue;
        // A portal belongs to the alignment that actually reaches daylight.
        if ((s < m(16) && buriedJoin(segment.a)) ||
          (length - s < m(16) && buriedJoin(segment.b))) continue;

        // Linear interpolation is enough: the cover changes by at most a few tenths of a unit over one step.
        const frame = ribbon.full.sampleAt(s - step / 2);
        const road = elevation.onSegment(segment.id, frame.p.x, frame.p.y);
        const yaw = angleOf(frame.t);
        const opening = TUNNEL_HEADROOM;
        const crown = road + opening + TUNNEL_ARCH;
        // The face has to be at least as wide as the band of ground the cutting held down
        const faceHalf = half + jambWidth + PORTAL_WING;
        // Tall enough to carry the arch and stand proud of the ground at the foot of the cutting
        const top = Math.max(crown + m(0.6), terrainAt(frame.p.x, frame.p.y) + m(0.8));

        // Either side of the opening, the face as WING WALLS stepping down with the hillside
        for (const side of [-1, 1] as const) {
          const inner = half;
          const width = faceHalf - inner;
          const slices = Math.max(2, Math.ceil(width / PORTAL_SLICE));
          const w = width / slices;
          for (let k = 0; k < slices; k++) {
            const centre = inner + w * (k + 0.5);
            const x = frame.p.x + frame.n.x * centre * side;
            const y = frame.p.y + frame.n.y * centre * side;
            // The higher ground either side of the face
            const reach = PORTAL_THICKNESS / 2 + 2;
            const ground = Math.max(terrainAt(x, y), terrainAt(x + frame.t.x * reach, y + frame.t.y * reach), terrainAt(x - frame.t.x * reach, y - frame.t.y * reach));
            const low = Math.min(terrainAt(x + frame.t.x * reach, y + frame.t.y * reach), terrainAt(x - frame.t.x * reach, y - frame.t.y * reach));
            const jamb = centre - inner < jambWidth;
            // A wing over ground lower than the road holds nothing back: none there.
            if (!jamb && ground < road + 1) continue;
            const sliceTop = jamb ? Math.max(crown + m(0.6), Math.min(top, ground + PORTAL_COPING)) : Math.min(top, ground + PORTAL_COPING);
            const foot = Math.min(road, low) - 1;
            if (sliceTop - foot < 0.5) continue;
            jambs.push({ x, y, yaw, sx: PORTAL_THICKNESS, sy: sliceTop - foot, sz: w + m(0.008), cy: foot + (sliceTop - foot) / 2 });
          }
        }
        lintels.push({
          x: frame.p.x,
          y: frame.p.y,
          yaw,
          sx: PORTAL_THICKNESS,
          sy: Math.max(m(0.32), top - crown),
          sz: (half + jambWidth) * 2,
          cy: crown + Math.max(m(0.32), top - crown) / 2,
        });
        // A coping course along the top of the opening
        headwalls.push({
          x: frame.p.x,
          y: frame.p.y,
          yaw,
          sx: PORTAL_THICKNESS + m(0.64),
          sy: m(0.36),
          sz: (half + jambWidth) * 2 + m(0.64),
          cy: top + m(0.18),
        });
      }
    }

  }

  return {
    piers: matricesOf(piers), caps: matricesOf(caps), abutments: matricesOf(abutments),
    jambs: matricesOf(jambs), lintels: matricesOf(lintels), headwalls: matricesOf(headwalls),
    parapets: parapets.sheet(), walls, backfill, spans,
  };
}

/** THE STRUCTURES' MESHES from their parts (`structureParts`): the instances and sheets taken as they came; `groundMaterial`, the backfill's (none: no backfill drawn) */
export function structureMeshes(parts: StructureParts, materials: SceneMaterials, groundMaterial?: Material,
  shapes?: { readonly pier: BufferGeometry; readonly box: BufferGeometry }): StructureDetails {
  const group = new Group();
  group.matrixAutoUpdate = false;
  group.name = 'road-structure-details';
  let triangles = 0;
  const attach = (mesh: InstancedMesh | Mesh | null): void => {
    if (!mesh) return;
    group.add(mesh);
    const count = mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count;
    triangles += (count / 3) * (mesh instanceof InstancedMesh ? mesh.count : 1);
  };
  const pierGeometry = shapes?.pier ?? pierShape();
  const boxGeometry = shapes?.box ?? new BoxGeometry(1, 1, 1);
  attach(instanced('structure-piers', pierGeometry, materials.concrete, parts.piers));
  attach(instanced('structure-pier-caps', boxGeometry, materials.concrete, parts.caps));
  attach(instanced('structure-abutments', boxGeometry, materials.concrete, parts.abutments));
  const owned: BufferGeometry[] = shapes ? [] : [pierGeometry, boxGeometry];
  const parapetMesh = sheetMesh(parts.parapets, 'structure-parapets', materials.parapet);
  attach(parapetMesh);
  const faceMesh = sheetMesh(parts.walls, 'retaining-walls', materials.parapet);
  const lidMesh = groundMaterial ? sheetMesh(parts.backfill, 'retaining-wall-backfill', groundMaterial) : null;
  if (lidMesh) lidMesh.castShadow = false;
  attach(faceMesh);
  attach(lidMesh);
  for (const mesh of [parapetMesh, faceMesh, lidMesh]) if (mesh) owned.push(mesh.geometry);
  attach(instanced('tunnel-jambs', boxGeometry, materials.concrete, parts.jambs));
  attach(instanced('tunnel-lintels', boxGeometry, materials.concrete, parts.lintels));
  attach(instanced('tunnel-headwalls', boxGeometry, materials.concrete, parts.headwalls));
  return {
    group,
    triangles,
    spans: parts.spans,
    dispose() {
      for (const geometry of owned) geometry.dispose();
      // The instance buffers are let go only by the mesh's own dispose (three r186 WebGLObjects, 'dispose').
      for (const o of group.children) if ((o as InstancedMesh).isInstancedMesh) (o as InstancedMesh).dispose();
      group.clear();
    },
  };
}
