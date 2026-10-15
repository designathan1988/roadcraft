import type { Vec2 } from '@core/vec2';
import { Rng as RngStream } from '@core/rng';
import type { RoadDoc } from '@world/doc';
import type { NodeId } from '@world/ids';
import type { RoadStructure } from '@world/structures';
import { Level, ROAD_TYPES, halfWidth, roadProfile } from '@world/roadTypes';
import type { SegmentParking } from '@world/parking';
import type { TerrainMode, TerrainStamp } from '@world/terrain';
import { type BlueprintBody } from '@world/buildings/blueprints';
import { Model, mat } from '@world/buildings/cityBuildings';
import type { Building, BuildingFunction, LotSurface } from '@world/buildings/types';
import { buildingBounds } from '@world/buildings/geometry';
import { type Box, type Edge, facingBody, inside, overlaps } from './sampleTown';
import { courtyard, houses, park, perimeter, varied, type Placer } from './town';
import { m } from '@world/units';

/** THE TOWN THE GAME OPENS ON. */

// ---------------------------------------------------------------- the plan

/** The town was laid out in steps of 0.4 m (the world unit until 2026-10-10) */
const PLAN_STEP = m(0.4);
const plan = (steps: number): number => steps * PLAN_STEP;

/** Node lines of the street grid 300 steps is a 120 m block, which is a town block; 210 steps is 84 m of depth, two rows */
const XS: readonly number[] = [-1200, -900, -600, -300, 0, 300, 600].map(plan);
const YS: readonly number[] = [-420, -210, 0, 210, 420].map(plan);
/** The avenue's own line, and where it runs out at each end. */
const AVENUE = 0;
const WEST_END = plan(-1560);
const EAST_END = plan(900);
/** The works: their own lines, east of the last street of the grid. */
const WORKS = { west: plan(900), east: plan(1440), south: plan(-420), north: plan(210) } as const;
/** The stream, running north-south along the east of the town, in plan steps. */
const STREAM_X = 1960;

/** The town generators draw from a plain stream, as the ones in town.ts do. */
type Rng = () => number;

const LOCAL = ROAD_TYPES.findIndex((t) => t.id === 'local');
const AVENUE_CLASS = ROAD_TYPES.findIndex((t) => t.id === 'avenue');
/** The residential streets are laid with parallel parking along both kerbs, as real ones are */
const STREET_PARKING: SegmentParking = { left: 'parallel', right: 'parallel' };
const parkingOf = (type: number): SegmentParking | undefined => (type === LOCAL ? STREET_PARKING : undefined);
/** The local streets running east-west trade the parking on one side for a cycle lane */
const CYCLE_STREET: SegmentParking = { left: 'parallel', right: 'cycle' };
const parkingAlong = (type: number, from: Vec2, to: Vec2): SegmentParking | undefined =>
  type === LOCAL && Math.abs(to.x - from.x) > Math.abs(to.y - from.y) ? CYCLE_STREET : parkingOf(type);

/** The ground the town stands on, before the hills: plan steps above datum. */
const TOWN_LEVEL = 14;

// ---------------------------------------------------------------- landform

/** A dab of the landform, every figure in plan steps. */
const stamp = (
  x: number, y: number, radius: number, strength: number, mode: TerrainMode, level?: number,
): Omit<TerrainStamp, 'id'> =>
  ({ x: plan(x), y: plan(y), radius: plan(radius), strength: plan(strength), mode, ...(level === undefined ? {} : { level: plan(level) }) });

/** A mass of high ground along a line, the way a hill is really shaped. */
function ridge(
  doc: RoadDoc,
  from: Vec2,
  to: Vec2,
  radius: number,
  peak: number,
  stations = 7,
  passes = 2,
): void {
  const length = Math.hypot(to.x - from.x, to.y - from.y);
  // What one dab must add for the line to add up to `peak`
  const spacing = Math.max(1, length / Math.max(1, stations - 1));
  const each = (peak * spacing) / (2 * radius) / passes;
  for (let pass = 0; pass < passes; pass++) {
    for (let i = 0; i < stations; i++) {
      const t = stations === 1 ? 0.5 : i / (stations - 1);
      // A bell across the line, so the ends are shoulders and not cliffs.
      const bell = 0.5 + 0.5 * Math.sin(Math.PI * t);
      doc.addTerrainStamp(stamp(
        from.x + (to.x - from.x) * t,
        from.y + (to.y - from.y) * t,
        radius, each * bell, 'raise',
      ));
    }
  }
}

/** The land the town was built in. */
function layLandform(doc: RoadDoc): void {
  // The town's own ground: high in the west, falling east towards the works and the water.
  doc.addTerrainStamp(stamp(-1_500, -100, 1_400, 34, 'raise'));
  doc.addTerrainStamp(stamp(-2_000, -400, 1_000, 22, 'raise'));
  doc.addTerrainStamp(stamp(900, -60, 1_200, 26, 'lower'));
  doc.addTerrainStamp(stamp(1_900, 40, 900, 20, 'lower'));

  // And the relief INSIDE the town, which is what a town on real ground has and a poured slab does not
  doc.addTerrainStamp(stamp(-430, -470, 260, 28, 'raise'));
  doc.addTerrainStamp(stamp(-1_020, 300, 250, 26, 'raise'));
  doc.addTerrainStamp(stamp(760, 320, 230, 24, 'raise'));
  doc.addTerrainStamp(stamp(180, -330, 220, 18, 'raise'));
  doc.addTerrainStamp(stamp(-1_150, -720, 300, 24, 'raise'));
  doc.addTerrainStamp(stamp(430, 560, 300, 20, 'lower'));

  // The hill that closes the avenue's western view, and the rise behind the town's last street of houses.
  ridge(doc, { x: -1_950, y: -350 }, { x: -1_520, y: -950 }, 400, 260, 5, 2);
  ridge(doc, { x: -2_100, y: 250 }, { x: -1_300, y: 250 }, 400, 200, 3, 2);
  // The hill the avenue runs towards: its western end is against this, which is what closes the town's longest view.
  doc.addTerrainStamp(stamp(-2_450, 60, 560, 40, 'raise'));
  doc.addTerrainStamp(stamp(-2_150, -260, 380, 30, 'raise'));

  // The ridge behind the town, close enough to be the town's backdrop and far enough that the northern street is not on it
  ridge(doc, { x: -2_100, y: 980 }, { x: 1_900, y: 900 }, 420, 250, 12, 2);

  // The south side: a hillside the southern houses step down, rising to the mountains at the map's far edge.
  ridge(doc, { x: -1_900, y: -1_180 }, { x: 900, y: -1_400 }, 420, 210, 11, 2);

  // The stream's valley, along the east: shallow and wide, so the water is the bottom of the view and not a wall in it.
  for (let i = 0; i < 9; i++) {
    doc.addTerrainStamp(stamp(STREAM_X + 60, -1_800 + i * 460, 420, 12, 'lower'));
  }
  // The channel itself, with the water in it.
  const streamAt = (t: number): Vec2 => ({
    x: STREAM_X + Math.sin(t * Math.PI * 2.4) * 95 + Math.sin(t * 7.1) * 22,
    y: 1_420 - t * 2_620,
  });
  // A 26-unit (10 m) channel with a 64-unit brush
  const CHANNEL_STEP = 26;
  for (let d = 0; d * CHANNEL_STEP < 2_620; d++) {
    const t = (d * CHANNEL_STEP) / 2_620;
    const at = streamAt(t);
    doc.addTerrainStamp(stamp(at.x, at.y, 64, 9, 'river'));
  }
  // The mill pond at the foot of the stream: wider, shallower, and the reason the works are where they are.
  for (let i = 0; i < 6; i++) {
    doc.addTerrainStamp(stamp(1_850 + (i % 3) * 55, -1_250 - Math.floor(i / 3) * 60, 110, 6, 'river'));
  }
  // The works' flat, on the low ground between the town and the water.
  for (let i = 0; i < 2; i++) doc.addTerrainStamp(stamp(1_150, -100, 560, 6, 'flatten', TOWN_LEVEL - 16));

  // The far east, past the stream: the bank rises again, so the town has a horizon on that side too.
  ridge(doc, { x: 2_250, y: 1_600 }, { x: 2_150, y: -1_700 }, 380, 150, 7, 2);

  // Mountains proper, on the map's far side: the horizon is landscape.
  ridge(doc, { x: -2_050, y: 1_950 }, { x: 1_600, y: 1_900 }, 500, 520, 11, 2);
  ridge(doc, { x: -1_950, y: -1_950 }, { x: 300, y: -2_000 }, 500, 470, 8, 2);
  ridge(doc, { x: 1_300, y: -2_050 }, { x: 2_150, y: -1_150 }, 440, 340, 5, 2);
}

// ---------------------------------------------------------------- streets

/** Nodes by coordinate, so a street run can name its ends. */
class Nodes {
  private readonly byKey = new Map<string, NodeId>();
  constructor(private readonly doc: RoadDoc) {}
  at(x: number, y: number): NodeId {
    const key = `${Math.round(x)},${Math.round(y)}`;
    const found = this.byKey.get(key);
    if (found !== undefined) return found;
    const id = this.doc.addNode({ x, y }).id;
    this.byKey.set(key, id);
    return id;
  }
  /** A road from one point to another, through `bends` if it has any. */
  run(a: Vec2, b: Vec2, type: number, bends: readonly Vec2[] = [], structure: RoadStructure = 'ground'): void {
    const points = [a, ...bends, b];
    for (let i = 0; i + 1 < points.length; i++) {
      const from = points[i] as Vec2;
      const to = points[i + 1] as Vec2;
      this.doc.addSegment(this.at(from.x, from.y), this.at(to.x, to.y), type, null, 0, 'both', null, structure,
        undefined, parkingAlong(type, from, to));
    }
  }
}

/** The streets. */
function layStreets(doc: RoadDoc): Nodes {
  const nodes = new Nodes(doc);
  const point = (x: number, y: number): Vec2 => ({ x, y });

  // The avenue, west to east: in from the hill, through the town, out to the works.
  nodes.run(point(plan(-2_200), AVENUE + plan(130)), point(XS[0] as number, AVENUE), AVENUE_CLASS, [
    point(plan(-1_800), AVENUE + plan(70)),
    point(WEST_END, AVENUE + plan(34)),
    point(plan(-1_360), AVENUE + plan(14)),
  ]);
  for (let i = 0; i + 1 < XS.length; i++) {
    nodes.run(point(XS[i] as number, AVENUE), point(XS[i + 1] as number, AVENUE), AVENUE_CLASS);
  }
  // East of the last street the avenue is a street again, and the works' own road takes over at its end
  nodes.run(point(XS[6] as number, AVENUE), point(EAST_END, AVENUE), LOCAL);

  // The cross streets, north-south: one segment per band between the avenue's neighbours
  for (const x of XS) {
    for (let j = 0; j + 1 < YS.length; j++) {
      nodes.run(point(x, YS[j] as number), point(x, YS[j + 1] as number), LOCAL);
    }
  }

  // The cross streets, east-west: the town's own grid runs from -1200 to 600
  for (const y of [YS[1] as number, YS[3] as number]) {
    for (let i = 0; i + 1 < XS.length; i++) {
      nodes.run(point(XS[i] as number, y), point(XS[i + 1] as number, y), LOCAL);
    }
    nodes.run(point(XS[6] as number, y), point(WORKS.west, y), LOCAL);
  }
  for (const y of [YS[0] as number, YS[4] as number]) {
    for (let i = 0; i + 1 < XS.length; i++) {
      nodes.run(point(XS[i] as number, y), point(XS[i + 1] as number, y), LOCAL);
    }
    nodes.run(point(XS[6] as number, y), point(WORKS.west, y), LOCAL);
  }

  // The works: a service road down the district's western edge, one along its northern side, one along the water
  nodes.run(point(WORKS.west, YS[4] as number), point(WORKS.west, YS[3] as number), LOCAL);
  nodes.run(point(WORKS.west, YS[3] as number), point(WORKS.west, AVENUE), LOCAL);
  nodes.run(point(WORKS.west, AVENUE), point(WORKS.west, YS[1] as number), LOCAL);
  nodes.run(point(WORKS.west, YS[1] as number), point(WORKS.west, WORKS.south), LOCAL);
  nodes.run(point(WORKS.west, WORKS.north), point(WORKS.east, WORKS.north), LOCAL);
  nodes.run(point(WORKS.west, WORKS.south), point(WORKS.east, WORKS.south), LOCAL);
  nodes.run(point(WORKS.east, WORKS.north), point(WORKS.east, WORKS.south), LOCAL);

  // Out to the stream and over it: the lane along the works, the town's bridge
  nodes.run(point(EAST_END, WORKS.south), point(plan(1_760), WORKS.south), LOCAL, [point(plan(1_180), WORKS.south - plan(10))]);
  nodes.run(point(plan(1_760), WORKS.south), point(plan(1_980), WORKS.south), LOCAL, [], 'bridge');
  // And off the map on the east bank: the road out, which is why the bridge is there at all.
  nodes.run(point(plan(1_980), WORKS.south), point(plan(2_320), WORKS.south + plan(120)), LOCAL, [
    point(plan(2_140), WORKS.south + plan(20)),
    point(plan(2_260), WORKS.south + plan(60)),
  ]);

  return nodes;
}

// ---------------------------------------------------------------- occupancy

/** A lot begins at the back of the actual footway, where a frontage can stand. */
const sidewalkOf = (type: number): number => halfWidth(roadProfile(type, null, 'both', undefined, parkingOf(type)), Level.Sidewalk);
const LOCAL_LOT_OFF = sidewalkOf(LOCAL);
const AVENUE_LOT_OFF = sidewalkOf(AVENUE_CLASS);

/** The lot of the block between two street lines: the rectangle the paving leaves. */
function lotOf(i: number, j: number): Box {
  // A block is inset by whatever street bounds it, and the avenue is nearly twice as wide as a street
  const side = (line: number): number => (line === AVENUE ? AVENUE_LOT_OFF : LOCAL_LOT_OFF);
  const x0 = (XS[i] as number) + LOCAL_LOT_OFF;
  const x1 = (XS[i + 1] as number) - LOCAL_LOT_OFF;
  const y0 = (YS[j] as number) + side(YS[j] as number);
  const y1 = (YS[j + 1] as number) - side(YS[j + 1] as number);
  return { x0, y0, x1, y1 };
}

/** The blocks between the grid's last street and the works' road, south to north. */
const BAND_YS = [YS[0], YS[1], AVENUE, YS[3], YS[4]] as const;
function bandLot(j: number): Box {
  return {
    x0: (XS[XS.length - 1] as number) + LOCAL_LOT_OFF,
    x1: WORKS.west - LOCAL_LOT_OFF,
    // The avenue's side as wide as the avenue
    y0: (BAND_YS[j] as number) + (BAND_YS[j] === AVENUE ? AVENUE_LOT_OFF : LOCAL_LOT_OFF),
    y1: (BAND_YS[j + 1] as number) - (BAND_YS[j + 1] === AVENUE ? AVENUE_LOT_OFF : LOCAL_LOT_OFF),
  };
}

/** What fronts the street round each block of the avenue's north side. */
const NORTH_FRONT: readonly (readonly BuildingFunction[])[] = [
  ['bank', 'shop', 'townhouse', 'bakery', 'shop'],
  ['shop', 'townhouse', 'restaurant', 'shop', 'pharmacy'],
  ['hotel', 'shop', 'bar', 'shop', 'townhouse'],
  ['cinema', 'restaurant', 'shop', 'townhouse', 'shop'],
  ['postOffice', 'shop', 'council', 'apartments', 'shop'],
];
/** South of the avenue: the shops that face the square, and the works' gate. */
const SOUTH_FRONT: readonly (readonly BuildingFunction[])[] = [
  ['shop', 'shop', 'bakery', 'townhouse', 'shop'],
  ['restaurant', 'bar', 'shop', 'snackBar', 'townhouse'],
  ['pharmacy', 'shop', 'townhouse', 'shop', 'apartments'],
  ['shop', 'townhouse', 'restaurant', 'clinic', 'shop'],
  ['police', 'shop', 'townhouse', 'apartments', 'bank'],
];
/** The northern band of terraces, school and library. */
const TERRACE_FRONT: readonly (readonly BuildingFunction[])[] = [
  ['townhouse', 'townhouse', 'bakery', 'townhouse', 'apartments', 'townhouse'],
  ['clinic', 'townhouse', 'townhouse', 'shop', 'townhouse', 'townhouse'],
  ['library', 'townhouse', 'apartments', 'townhouse', 'bakery', 'townhouse'],
];
const FILL_SHOP: readonly BuildingFunction[] = ['shop', 'townhouse'];
const FILL_TERRACE: readonly BuildingFunction[] = ['townhouse', 'shop'];

/** A lot of open ground, as the model's own blocks. */
function paved(model: Model, x: number, y: number, w: number, d: number, surface: LotSurface, piece = 50): void {
  const nx = Math.max(1, Math.ceil(w / piece));
  const ny = Math.max(1, Math.ceil(d / piece));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      model.lot(x + (i * w) / nx, y + (j * d) / ny, w / nx, d / ny, surface);
    }
  }
}

/** A straight run of paving or of parking bays, laid in PIECES. */
function runOf(
  model: Model,
  kind: 'pavement' | 'parking',
  x: number,
  y: number,
  length: number,
  across: number,
  facing: 0 | 1,
  piece = 24,
): void {
  const count = Math.max(1, Math.ceil(length / piece));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) * (length / count);
    // 0.12 m: the thinnest a part may be
    model.el(kind, facing === 0 ? x + t : x, facing === 0 ? y : y + t, facing,
      { w: length / count, d: across, h: kind === 'pavement' ? 0.12 : 0.12 });
  }
}

/** The market square: paving from edge to edge, a fountain where the ways cross, rows of trees, benches */
function plaza(rng: Rng, Wm: number, Dm: number): BlueprintBody {
  const model = new Model('square', 'commercial', 3);
  const w = Wm;
  const d = Dm;
  paved(model, 0, 0, w, d, 'paving');
  // The fountain: a stone basin with water in it, at the middle of the square.
  const fx = w / 2;
  const fy = d / 2;
  model.lot(fx - 3, fy - 3, 6, 6, 'water');
  model.el('pillar', fx, fy, 0, { w: 0.8, d: 0.8, h: 2.4, material: mat('stone', 0xc9c0ae) });
  model.el('rocks', fx - 2.4, fy - 1.6, 0, { w: 1.2, d: 0.9, h: 0.5, material: mat('stone', 0xb3aa98) });
  model.el('rocks', fx + 2.2, fy + 1.8, 0, { w: 1, d: 0.8, h: 0.4, material: mat('stone', 0xb3aa98) });
  // Two walks across, meeting at the fountain.
  runOf(model, 'pavement', 2, d / 2, w - 4, 3, 0);
  runOf(model, 'pavement', w / 2, 2, d - 4, 3, 1);
  void rng;
  // Rows of trees down the sides, with benches between them, and flower beds.
  for (const side of [0, 1]) {
    const y = side === 0 ? 4.2 : d - 4.2;
    model.row('tree', 7, y, w - 7, y, Math.max(3, Math.min(8, Math.round(w / 18))));
    model.row('bench', 8, side === 0 ? y + 2.6 : y - 2.6, w - 8, side === 0 ? y + 2.6 : y - 2.6, 4, side === 0 ? 2 : 0);
  }
  model.row('flowers', 10, d * 0.22, w - 10, d * 0.22, 3);
  model.row('flowers', 10, d * 0.78, w - 10, d * 0.78, 3);
  // The market: canopies along the square's length, a stall under each.
  const stalls = Math.max(3, Math.min(6, Math.round(w / 26)));
  for (let k = 0; k < stalls; k++) {
    const x = 12 + (k * (w - 24)) / Math.max(1, stalls - 1);
    model.el('canopy', x, fy - 8, 0, { w: 6, d: 4, h: 0.2, z: 2.6 });
    model.el('slab', x, fy - 8, 0, { w: 3.4, d: 1.4, h: 0.9, material: mat('wood', 0x8c6b4c) });
  }
  return model.build();
}

/** A car park: hard standing, marked bays, and a row of trees along each aisle */
function parkingBody(Wm: number, Dm: number, surface: LotSurface): BlueprintBody {
  const model = new Model('square', 'commercial', 1);
  paved(model, 0, 0, Wm, Dm, surface, 60);
  const rows = Math.max(1, Math.min(4, Math.round(Dm / 14)));
  for (let k = 0; k < rows; k++) {
    const y = ((k + 0.5) * Dm) / rows;
    runOf(model, 'parking', 3, y, Math.max(2, Wm - 6), 5, 0, 30);
  }
  // A row of trees along the two long sides, which is what breaks a forecourt up
  const trees = Math.max(2, Math.min(9, Math.round(Wm / 22)));
  model.row('tree', 4, 3.4, Wm - 4, 3.4, trees);
  model.row('tree', 4, Dm - 3.4, Wm - 4, Dm - 3.4, trees);
  // A part may not be one of a handful: 64 elements is a whole building's budget
  return model.build();
}

/** A garden on a strip too narrow for a court: lawn, a line of trees down its length, shrubs between them. */
function garden(rng: Rng, Wm: number, Dm: number): BlueprintBody {
  const model = new Model('square', 'commercial', 1);
  paved(model, 0, 0, Wm, Dm, 'grass', 60);
  const long = Wm >= Dm;
  const length = long ? Wm : Dm;
  const trees = Math.max(1, Math.min(14, Math.floor(length / 9)));
  for (let k = 0; k < trees; k++) {
    const t = ((k + 0.5) * length) / trees + (rng() - 0.5) * 3;
    // A crown never wider than the strip, so no tree hangs over the street.
    const short = long ? Dm : Wm;
    const h = Math.min(5 + rng() * 5, (short - 1) / 0.6);
    // The line wanders across the strip, as planted trees do.
    const across = short / 2 + (rng() - 0.5) * Math.max(0, short - h * 0.6 - 1);
    model.el('tree', long ? t : across, long ? across : t, 0, { w: h * 0.6, d: h * 0.6, h });
  }
  const shrubs = Math.min(12, Math.floor(length / 7));
  for (let k = 0; k < shrubs; k++) {
    const s = 1 + rng() * 0.8;
    const t = 2 + rng() * (length - 4);
    const across = 1.2 + rng() * Math.max(0.1, (long ? Dm : Wm) - 2.4);
    model.el('shrub', long ? t : across, long ? across : t, 0, { w: s, d: s, h: s * 0.8, material: mat('wood', 0x48693a) });
  }
  return model.build();
}

/** The biggest empty rectangle left in `lot`, clear of every box in `placed` */
function emptiest(lot: Box, placed: readonly Box[], min: number): Box | null {
  const cell = m(2);
  const nx = Math.floor((lot.x1 - lot.x0) / cell);
  const ny = Math.floor((lot.y1 - lot.y0) / cell);
  if (nx <= 0 || ny <= 0) return null;
  const free = new Uint8Array(nx * ny).fill(1);
  for (const o of placed) {
    if (o.x1 <= lot.x0 || o.x0 >= lot.x1 || o.y1 <= lot.y0 || o.y0 >= lot.y1) continue;
    const i0 = Math.max(0, Math.floor((o.x0 - lot.x0) / cell));
    const i1 = Math.min(nx, Math.ceil((o.x1 - lot.x0) / cell));
    const j0 = Math.max(0, Math.floor((o.y0 - lot.y0) / cell));
    const j1 = Math.min(ny, Math.ceil((o.y1 - lot.y0) / cell));
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) free[j * nx + i] = 0;
  }
  const minCells = Math.ceil(min / cell);
  const height = new Int32Array(nx);
  let best: { area: number; i0: number; i1: number; j0: number; j1: number } | null = null;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) height[i] = free[j * nx + i] ? (height[i] as number) + 1 : 0;
    const stack: number[] = [];
    for (let i = 0; i <= nx; i++) {
      const h = i < nx ? (height[i] as number) : 0;
      while (stack.length && (height[stack[stack.length - 1] as number] as number) >= h) {
        const top = stack.pop() as number;
        const hh = height[top] as number;
        const left = stack.length ? (stack[stack.length - 1] as number) + 1 : 0;
        const w = i - left;
        if (w >= minCells && hh >= minCells && (!best || w * hh > best.area)) {
          best = { area: w * hh, i0: left, i1: i, j0: j - hh + 1, j1: j + 1 };
        }
      }
      stack.push(i);
    }
  }
  if (!best) return null;
  return {
    x0: lot.x0 + best.i0 * cell,
    x1: lot.x0 + best.i1 * cell,
    y0: lot.y0 + best.j0 * cell,
    y1: lot.y0 + best.j1 * cell,
  };
}

/** The works: yards, warehouses and the factory, with their aprons fenced off the street. */
function yard(rng: Rng, Wm: number, Dm: number, kind: 'factory' | 'warehouse' | 'store'): BlueprintBody {
  const model = new Model(kind === 'store' ? 'warehouse' : kind, 'industrial', 7);
  const w = Wm;
  const d = Dm;
  // The boundary is a FENCE, not a wall all the way round
  const boundary = (): void => {
    model.row('fence', 2, d - 1, w - 2, d - 1, Math.max(3, Math.round(w / 6)));
    model.row('fence', 1, 2, 1, d * 0.6, Math.max(2, Math.round(d / 12)));
  };
  if (kind === 'store') {
    // A yard of hard standing: gravel, containers as slabs, a hut.
    paved(model, 0, 0, w, d, 'gravel');
    for (let k = 0; k < 6; k++) {
      const x = 5 + (k % 3) * 11;
      const y = 6 + Math.floor(k / 3) * 9;
      model.el('slab', x, y, 0, { w: 7, d: 2.6, h: 2.6, material: mat('metal', 0x5d6b70) });
    }
    model.block({ x: w - 14, y: d - 12, w: 9, d: 7, storeys: 1, roof: 'shed', door: 'middle' });
    boundary();
  } else if (kind === 'factory') {
    paved(model, 0, 0, w, d, 'paving');
    model.block({ x: 12, y: 10, w: 36, d: 24, storeys: 1, roof: 'sawtooth', fill: 'ribbon', ground: 'loadingDoor' });
    model.block({ x: 52, y: 12, w: 3, d: 3, storeys: 8, fill: 'wall' });   // the chimney
    model.block({ x: 12, y: 40, w: 10, d: 9, storeys: 2, door: 'middle' }); // the office
    runOf(model, 'parking', 30, d - 8, 30, 5, 0);
    model.row('tree', 58, 8, 58, d - 12, 3);
    boundary();
  } else {
    paved(model, 0, 0, w, d, 'paving');
    model.block({ x: 6, y: 14, w: 30, d: 24, storeys: 1, roof: 'shed', fill: 'wall', ground: 'loadingDoor' });
    // The turning apron and the bays are in FRONT of the shed
    runOf(model, 'parking', 6, 6, Math.max(20, w - 14), 5, 0);
    model.row('tree', 46, 18, 46, d - 8, 3);
    boundary();
  }
  void rng;
  return model.build();
}

/** Everything that stands on the blocks, district by district. */
function occupy(doc: RoadDoc, stream: RngStream): number {
  const rng = (): number => stream.float();
  const placed: Box[] = [];
  let count = 0;
  const into: Placer = {
    placed,
    put(body, box) {
      doc.buildings.add(body);
      // The whole of what it puts on the ground - its volumes AND its parts (the trees of a front garden, an awning, a fence)
      const all = buildingBounds(body as Building);
      placed.push({ x0: Math.min(box.x0, all.minX), y0: Math.min(box.y0, all.minY), x1: Math.max(box.x1, all.maxX), y1: Math.max(box.y1, all.maxY) });
      count++;
    },
  };
  /** An open block (a square, a park, a yard) laid on its lot, no front gap. */
  const putOpen = (body: BlueprintBody, fn: BuildingFunction, lot: Box, inset = 0): boolean => {
    const x0 = lot.x0 + inset;
    const y0 = lot.y0 + inset;
    const edge: Edge = { start: { x: x0, y: y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 - inset * 2 };
    const f = facingBody(body, fn, edge, 0, 0);
    if (!inside(f.box, lot)) return false;
    into.put({ ...f.body, function: fn }, f.box);
    return true;
  };
  /** What is left of a block once its frontage is built */
  const fillGaps = (lot: Box, kind: 'homes' | 'shops' | 'works'): void => {
    const refused: Box[] = [];
    for (let k = 0; k < 24; k++) {
      const gap = emptiest(lot, [...placed, ...refused], m(10));
      if (!gap) return;
      // Half a metre clear of the neighbours, so no two lots share an edge.
      const box: Box = { x0: gap.x0 + m(0.5), y0: gap.y0 + m(0.5), x1: gap.x1 - m(0.5), y1: gap.y1 - m(0.5) };
      const Wm = (box.x1 - box.x0) / m(1);
      const Dm = (box.y1 - box.y0) / m(1);
      const short = Math.min(Wm, Dm);
      // In the works a gap big enough for a shed is a shed and its apron
      const shed = kind === 'works' && Wm >= 52 && Dm >= 46;
      const park = kind === 'shops' && short >= 14 && (short < 22 || k % 2 === 0);
      const body = shed ? yard(rng, Wm, Dm, 'warehouse')
        : kind === 'works' ? garden(rng, Wm, Dm)
          : park ? parkingBody(Wm, Dm, 'paving')
            : short >= 22 ? courtyard(rng, Wm, Dm)
              : garden(rng, Wm, Dm);
      if (!putOpen(body, shed ? 'warehouse' : 'square', box)) refused.push(gap);
    }
  };
  /** The biggest room left in a block's middle, for a court or a garden. */
  const middle = (lot: Box, fn: (w: number, d: number) => BlueprintBody, fnName: BuildingFunction): void => {
    for (let inset = m(12); inset < Math.min(lot.x1 - lot.x0, lot.y1 - lot.y0) / 2 - m(8); inset += m(2)) {
      const box: Box = { x0: lot.x0 + inset, y0: lot.y0 + inset, x1: lot.x1 - inset, y1: lot.y1 - inset };
      if (placed.some((o) => overlaps(box, o, m(1)))) continue;
      putOpen(fn((box.x1 - box.x0) / m(1), (box.y1 - box.y0) / m(1)), fnName, box);
      return;
    }
  };

  // ---- the avenue's north side: the shops, with the flats above them
  for (let i = 0; i < 5; i++) {
    const lot = lotOf(i, 2);
    perimeter(rng, lot, [...(NORTH_FRONT[i] as readonly BuildingFunction[])], FILL_SHOP, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
    fillGaps(lot, 'shops');
  }
  // The north-east block is the supermarket and its car park: a big shed is not something to line up with the shops.
  {
    const lot = lotOf(5, 2);
    const body = varied(rng, 'supermarket') as BlueprintBody;
    const edge: Edge = { start: { x: lot.x0 + m(3.2), y: lot.y0 + m(0.8) }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 - m(6.4) };
    const f = facingBody(body, 'supermarket', edge, 0, m(0.4));
    into.put({ ...f.body, function: 'supermarket' }, f.box);
    // Its car park beside it, on the avenue
    const park = { x0: f.box.x1 + m(2), y0: lot.y0, x1: lot.x1, y1: lot.y1 };
    putOpen(parkingBody((park.x1 - park.x0) / m(1), (park.y1 - park.y0) / m(1), 'paving'), 'square', park);
    fillGaps(lot, 'shops');
  }

  // ---- the avenue's south side, with the market square in the middle
  for (const i of [0, 1, 2, 4]) {
    const lot = lotOf(i, 1);
    perimeter(rng, lot, [...(SOUTH_FRONT[i] as readonly BuildingFunction[])], FILL_SHOP, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
    fillGaps(lot, 'shops');
  }
  {
    // The square: the block between the avenue and the street behind it, from x = -300 to 0, opening on the avenue.
    const lot: Box = lotOf(3, 1);
    let west = lot.x0;
    let east = lot.x1;
    for (const [fn, atWest] of [['cityHall', true], ['church', false]] as const) {
      const body = varied(rng, fn);
      if (!body) continue;
      // Facing the plaza: the model's front is set against `inward`
      const inward: Vec2 = { x: atWest ? -1 : 1, y: 0 };
      const probe = facingBody(body, fn, { start: { x: 0, y: 0 }, along: { x: 0, y: 1 }, inward, length: 1 }, 0, 0);
      const width = probe.box.y1 - probe.box.y0;
      const depth = probe.box.x1 - probe.box.x0;
      const start: Vec2 = {
        x: atWest ? lot.x0 + depth + m(1) : lot.x1 - depth - m(1),
        y: lot.y0 + (lot.y1 - lot.y0 - width) / 2,
      };
      const edge: Edge = { start, along: { x: 0, y: 1 }, inward, length: width };
      const f = facingBody(body, fn, edge, 0, m(1));
      if (!inside(f.box, lot)) continue;
      into.put({ ...f.body, function: fn }, f.box);
      if (atWest) west = Math.max(west, f.box.x1 + m(3));
      else east = Math.min(east, f.box.x0 - m(3));
    }
    if (east - west > m(20)) {
      putOpen(plaza(rng, (east - west) / m(1), (lot.y1 - lot.y0) / m(1)), 'square',
        { x0: west, y0: lot.y0, x1: east, y1: lot.y1 });
    }
    // The church's yard and the city hall's garden: the ground either side of them, up to the streets.
    fillGaps(lot, 'homes');
  }
  {
    const lot = lotOf(5, 1);
    perimeter(rng, lot, ['gym', 'shop', 'townhouse', 'apartments', 'police'], FILL_SHOP, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
    fillGaps(lot, 'shops');
  }

  // ---- the northern band: terraces, the school, the park, the library
  for (const i of [0, 1, 3, 5]) {
    const lot = lotOf(i, 3);
    perimeter(rng, lot, [...(TERRACE_FRONT[(i + 1) % TERRACE_FRONT.length] as readonly BuildingFunction[])], FILL_TERRACE, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
    fillGaps(lot, 'homes');
  }
  {
    // The school: its own campus against the avenue's back street.
    const lot = lotOf(2, 3);
    const edge: Edge = { start: { x: lot.x0 + m(0.8), y: lot.y0 + m(1.6) }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: lot.x1 - lot.x0 - m(1.6) };
    const f = facingBody(varied(rng, 'school') as BlueprintBody, 'school', edge, 0, m(0.4));
    if (inside(f.box, lot)) into.put({ ...f.body, function: 'school' }, f.box);
    // The rest of the block is the street's terraces round the school's playing field
    perimeter(rng, lot, ['townhouse', 'apartments', 'townhouse', 'bakery', 'townhouse'], FILL_TERRACE, into);
    const field = emptiest(lot, placed, m(30));
    if (field) {
      const box: Box = { x0: field.x0 + m(1), y0: field.y0 + m(1), x1: field.x1 - m(1), y1: field.y1 - m(1) };
      putOpen(courtyard(rng, (box.x1 - box.x0) / m(1), (box.y1 - box.y0) / m(1)), 'square', box);
    }
    fillGaps(lot, 'homes');
  }
  {
    // The park: on the block behind the shops, with the pond and its walks.
    const lot = lotOf(4, 3);
    putOpen(park(rng, (lot.x1 - lot.x0) / m(1), (lot.y1 - lot.y0) / m(1)), 'park', lot);
  }

  // ---- the southern band: the residential blocks, each a pair of rows of houses back to back, every house its own
  for (let i = 0; i < 6; i++) {
    const lot = lotOf(i, 0);
    houses(rng, lot, into);
    // The middle of the block: a garden, a court, a playground.
    if (i % 2 === 0) middle(lot, (w, d) => courtyard(rng, w, d), 'square');
    fillGaps(lot, 'homes');
  }

  // ---- the blocks between the grid and the works, south to north
  const BAND: readonly { front: BuildingFunction[]; fill: readonly BuildingFunction[]; kind: 'homes' | 'shops' | 'works' }[] = [
    { front: ['warehouse', 'office', 'shop', 'warehouse'], fill: ['office', 'shop'], kind: 'works' },
    { front: ['office', 'gym', 'shop', 'restaurant', 'apartments'], fill: FILL_SHOP, kind: 'shops' },
    { front: ['hotel', 'shop', 'bar', 'apartments', 'shop'], fill: FILL_SHOP, kind: 'shops' },
    { front: ['apartments', 'townhouse', 'townhouse', 'clinic', 'townhouse'], fill: FILL_TERRACE, kind: 'homes' },
  ];
  BAND.forEach((band, j) => {
    const lot = bandLot(j);
    perimeter(rng, lot, [...band.front], band.fill, into);
    middle(lot, (w, d) => courtyard(rng, w, d), 'square');
    fillGaps(lot, band.kind);
  });

  // ---- the works, east of the last street Two columns of yards with the lane between them
  {
    const west = WORKS.west + LOCAL_LOT_OFF;
    const east = WORKS.east - LOCAL_LOT_OFF;
    const north = WORKS.north - LOCAL_LOT_OFF;
    const south = WORKS.south + LOCAL_LOT_OFF;
    const westEast = west + m(88);
    const eastWest = east - m(88);
    // The western column, from the northern lane down.
    putOpen(yard(rng, 88, 70, 'factory'), 'factory', { x0: west, y0: north - m(72), x1: westEast, y1: north });
    putOpen(yard(rng, 66, 60, 'warehouse'), 'warehouse', { x0: west, y0: north - m(134), x1: west + m(68), y1: north - m(74) });
    putOpen(yard(rng, 74, 54, 'store'), 'warehouse', { x0: west, y0: north - m(190), x1: west + m(76), y1: north - m(136) });
    // The eastern column.
    putOpen(yard(rng, 88, 74, 'warehouse'), 'warehouse', { x0: eastWest, y0: north - m(76), x1: east, y1: north });
    putOpen(yard(rng, 88, 70, 'store'), 'warehouse', { x0: eastWest, y0: north - m(148), x1: east, y1: north - m(78) });
    // The garage, its forecourt, and the way in from the avenue.
    const forecourt: Box = { x0: west + m(74), y0: south + m(2), x1: east, y1: south + m(46) };
    putOpen(parkingBody((forecourt.x1 - forecourt.x0) / m(1), (forecourt.y1 - forecourt.y0) / m(1), 'paving'), 'square', forecourt);
    const station = varied(rng, 'gasStation');
    if (station) {
      const near: Box = { x0: west + m(76), y0: south + m(48), x1: west + m(128), y1: south + m(82) };
      const edge: Edge = { start: { x: near.x0, y: near.y0 }, along: { x: 1, y: 0 }, inward: { x: 0, y: 1 }, length: near.x1 - near.x0 };
      const f = facingBody(station, 'gasStation', edge, 0, 0);
      if (inside(f.box, near)) into.put({ ...f.body, function: 'gasStation' }, f.box);
    }
    fillGaps({ x0: west, y0: south, x1: east, y1: north }, 'works');
  }

  return count;
}

// ---------------------------------------------------------------- the dressing

/** The town's own fittings: the hedges that hold the built town off the fields it was cut out of. */
function dress(doc: RoadDoc): void {
  // No poles: wires, street lights and every other fitting of a street are the player's to place (2026-10-05).

  // The hedgerows along the two edges of the built town, on the far side of the outer streets
  const hedgeAlong = (from: Vec2, to: Vec2, step = plan(30)): void => {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    const count = Math.max(2, Math.round(length / step));
    const points: Vec2[] = [];
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      // A hedge is planted, not surveyed: it wanders by a unit or two.
      const wobble = Math.sin(i * 1.7) * plan(3);
      points.push({
        x: from.x + (to.x - from.x) * t + wobble,
        y: from.y + (to.y - from.y) * t - wobble,
      });
    }
    doc.addBarrier('hedge', points);
  };
  hedgeAlong({ x: plan(-1_250), y: YS[0] as number - plan(34) }, { x: plan(640), y: (YS[0] as number) - plan(40) });
  hedgeAlong({ x: plan(-1_250), y: (YS[4] as number) + plan(34) }, { x: plan(640), y: (YS[4] as number) + plan(40) });
  hedgeAlong({ x: (XS[0] as number) - plan(34), y: plan(-400) }, { x: (XS[0] as number) - plan(40), y: plan(420) });
  // And a wall round the park, which is the one plot in the town that is not somebody's front garden.
  const park = lotOf(4, 3);
  doc.addBarrier('wall', [
    { x: park.x0 - m(0.8), y: park.y0 - m(0.8) },
    { x: park.x1 + m(0.8), y: park.y0 - m(0.8) },
    { x: park.x1 + m(0.8), y: park.y1 + m(0.8) },
    { x: park.x0 - m(0.8), y: park.y1 + m(0.8) },
    { x: park.x0 - m(0.8), y: park.y0 - m(0.8) },
  ]);
}

/** Every block the streets enclose, named: the grid's blocks, the band between the grid and the works, and the works. */
export function townBlocks(): { name: string; box: Box }[] {
  const out: { name: string; box: Box }[] = [];
  for (let j = 0; j + 1 < YS.length; j++) {
    for (let i = 0; i + 1 < XS.length; i++) out.push({ name: `block ${i},${j}`, box: lotOf(i, j) });
  }
  for (let j = 0; j + 1 < BAND_YS.length; j++) out.push({ name: `band ${j}`, box: bandLot(j) });
  out.push({ name: 'works', box: { x0: WORKS.west + LOCAL_LOT_OFF, y0: WORKS.south + LOCAL_LOT_OFF, x1: WORKS.east - LOCAL_LOT_OFF, y1: WORKS.north - LOCAL_LOT_OFF } });
  return out;
}

/** Builds the town on `doc`, which should be empty. Returns how many buildings it put up. */
export function buildDefaultTown(doc: RoadDoc): number {
  const stream = new RngStream(0x70a1_2026);
  layLandform(doc);
  layStreets(doc);
  const count = occupy(doc, stream);
  dress(doc);
  return count;
}
