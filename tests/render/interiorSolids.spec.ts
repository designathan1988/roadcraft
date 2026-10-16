import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Box3, Ray, Triangle, Vector3 } from 'three';

import { ARCHETYPES } from '@sim/vehicles/archetypes';
import { buildBusModel, buildTruckModel, type SeatModel, type VehicleModel } from '@render/vehicleModels';
import { occupantScale } from './support/occupantScale';
import { buildCarModel, carStylesFor } from '@render/carBody';
import type { InteriorSolid, InteriorSolidKind } from '@render/interiorSolids';
import { seatBaseClip } from '@render/occupants';
import { m } from '@world/units';

/** THE INTERIOR'S SOLIDS HAVE NAMES (`render/interiorSolids.ts`) */
const models = (): [string, VehicleModel][] => {
  const out: [string, VehicleModel][] = [];
  for (const a of ARCHETYPES) {
    // Every body the class is drawn as (`agents.ts`).
    if (a.shape === 'car') for (const style of carStylesFor(a)) out.push([`${a.id}/${style}`, buildCarModel(a, style)]);
    else if (a.shape === 'bus') out.push([a.id, buildBusModel(a)]);
    else if (a.shape === 'truck') out.push([a.id, buildTruckModel(a)]);
  }
  return out;
};

// ---------------------------------------------------------------- the bodies

interface Cells { readonly cell: number; readonly kinds: Record<string, number[]> }
const CELLS = JSON.parse(readFileSync('tests/fixtures/seated-body-cells.json', 'utf8')) as Cells;
const CELL = CELLS.cell;
/** A body cell: where (the body's frame: x its left, y up, z ahead; metres from the pelvis) and how deep in the body, metres. */
interface BodyCell { readonly at: Vector3; readonly depth: number }

/** The skin's cells filled: the cells no path of empty cells joins to the outside are inside the body */
function fill(runs: readonly number[]): BodyCell[] {
  const skin: number[] = [];
  for (let i = 0; i < runs.length; i += 2) for (let k = 0; k < runs[i + 1]!; k++) skin.push(runs[i]! + k);
  const ax = (p: number, s: number): number => (p >> s) & 255;
  const lo = [255, 255, 255], hi = [0, 0, 0];
  for (const p of skin) [16, 8, 0].forEach((s, a) => { lo[a] = Math.min(lo[a]!, ax(p, s) - 1); hi[a] = Math.max(hi[a]!, ax(p, s) + 1); });
  const [nx, ny, nz] = [hi[0]! - lo[0]! + 1, hi[1]! - lo[1]! + 1, hi[2]! - lo[2]! + 1];
  const id = (x: number, y: number, z: number): number => (x * ny + y) * nz + z;
  // -1: outside; 0: not reached yet; d > 0: body, d - 1 cells deep.
  const grid = new Int16Array(nx * ny * nz);
  const isSkin = new Uint8Array(nx * ny * nz);
  for (const p of skin) isSkin[id(ax(p, 16) - lo[0]!, ax(p, 8) - lo[1]!, ax(p, 0) - lo[2]!)] = 1;
  // The outside: from the box's border through every cell that is not skin.
  let queue: number[] = [];
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    if (x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) { grid[id(x, y, z)] = -1; queue.push(id(x, y, z)); }
  }
  const steps = [ny * nz, -ny * nz, nz, -nz, 1, -1];
  const inBox = (c: number, s: number): boolean => {
    const x = Math.floor(c / (ny * nz)), y = Math.floor(c / nz) % ny, z = c % nz;
    return !((s === ny * nz && x === nx - 1) || (s === -ny * nz && x === 0) || (s === nz && y === ny - 1) || (s === -nz && y === 0) || (s === 1 && z === nz - 1) || (s === -1 && z === 0));
  };
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    for (const s of steps) {
      if (!inBox(c, s)) continue;
      const n = c + s;
      if (grid[n] === 0 && !isSkin[n]) { grid[n] = -1; queue.push(n); }
    }
  }
  // The depths: layer by layer in from the outside.
  queue = [];
  for (let c = 0; c < grid.length; c++) {
    if (grid[c] !== 0) continue;
    if (steps.some((s) => inBox(c, s) && grid[c + s] === -1)) { grid[c] = 1; queue.push(c); }
  }
  for (let h = 0; h < queue.length; h++) {
    const c = queue[h]!;
    for (const s of steps) {
      if (!inBox(c, s)) continue;
      const n = c + s;
      if (grid[n] === 0) { grid[n] = grid[c]! + 1; queue.push(n); }
    }
  }
  const out: BodyCell[] = [];
  for (let c = 0; c < grid.length; c++) {
    if (grid[c]! <= 0) continue;
    const x = Math.floor(c / (ny * nz)), y = Math.floor(c / nz) % ny, z = c % nz;
    const at = (i: number, a: number): number => (i + lo[a]! - 128 + 0.5) * CELL;
    out.push({ at: new Vector3(at(x, 0), at(y, 1), at(z, 2)), depth: (grid[c]! - 1) * CELL });
  }
  return out;
}
const BODIES = new Map(Object.entries(CELLS.kinds).map(([kind, runs]) => [kind, fill(runs)]));
const kindOf = (seat: SeatModel): string => /^(carDrive|carRide|carRear|cabDrive|cabRide|chair)/.exec(seatBaseClip(seat))![1]!;

/** A seated body in the vehicle's frame (x ahead, y up, z right), at the size it is drawn at. */
function occupant(seat: SeatModel): { p: Vector3; depth: number }[] {
  const s = occupantScale(seat);
  const u = s * m(1);
  return BODIES.get(kindOf(seat))!.map((c) => ({ p: new Vector3(seat.x + c.at.z * u, seat.hipY + c.at.y * u, seat.z - c.at.x * u), depth: c.depth * s }));
}

// ---------------------------------------------------------------- the pieces

interface Piece { readonly solid: InteriorSolid; readonly box: Box3; readonly tris: Triangle[]; readonly edges: [Vector3, Vector3][] | null }

/** Each named piece: its bounds, its triangles, and for a sheet (not closed) its rim. */
function pieces(model: VehicleModel): Piece[] {
  const pos = model.interior.getAttribute('position');
  const index = model.interior.index;
  const corner = (i: number): Vector3 => new Vector3().fromBufferAttribute(pos, index ? index.getX(i) : i);
  return model.solids.map((solid) => {
    const tris: Triangle[] = [];
    const box = new Box3();
    for (let v = solid.start; v < solid.start + solid.count; v += 3) {
      const t = new Triangle(corner(v), corner(v + 1), corner(v + 2));
      box.expandByPoint(t.a).expandByPoint(t.b).expandByPoint(t.c);
      tris.push(t);
    }
    // A door's lining is the door's skin moved in (`carBody.ts`)
    if (solid.kind !== 'card') return { solid, box, tris, edges: null };
    const key = (v: Vector3): string => `${Math.round(v.x * 1e4 / m(1))},${Math.round(v.y * 1e4 / m(1))},${Math.round(v.z * 1e4 / m(1))}`;
    const count = new Map<string, { n: number; a: Vector3; b: Vector3 }>();
    for (const t of tris) {
      for (const [a, b] of [[t.a, t.b], [t.b, t.c], [t.c, t.a]] as const) {
        const ka = key(a), kb = key(b);
        if (ka === kb) continue;
        const k = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        const e = count.get(k) ?? { n: 0, a, b };
        e.n++;
        count.set(k, e);
      }
    }
    const rim = [...count.values()].filter((e) => e.n === 1).map((e) => [e.a, e.b] as [Vector3, Vector3]);
    return { solid, box, tris, edges: rim.length ? rim : null };
  });
}

// Off every axis, so a ray never runs along a box's face or edge.
const DIRECTION = new Vector3(0.5773, 0.6123, 0.5401).normalize();
const ray = new Ray();
const hit = new Vector3();
/** Inside a closed piece: an odd number of its faces crossed on the way out. */
function inside(p: Vector3, tris: readonly Triangle[]): boolean {
  ray.set(p, DIRECTION);
  let n = 0;
  for (const t of tris) if (ray.intersectTriangle(t.a, t.b, t.c, false, hit)) n++;
  return (n & 1) === 1;
}
const near = new Vector3(), normal = new Vector3(), onRim = new Vector3();
/** Behind a sheet facing the cabin: how far, metres, where the nearest point of it is not on its rim; 0 in front. */
function behind(p: Vector3, piece: Piece): number {
  let best = Infinity, side = 0;
  let nearest: Vector3 | null = null;
  for (const t of piece.tris) {
    const q = t.closestPointToPoint(p, near);
    const d = q.distanceTo(p);
    if (d < best) { best = d; side = p.clone().sub(q).dot(t.getNormal(normal)); nearest = q.clone(); }
  }
  if (!nearest || side >= 0) return 0;
  for (const [a, b] of piece.edges!) {
    const ab = b.clone().sub(a);
    const k = Math.max(0, Math.min(1, nearest.clone().sub(a).dot(ab) / ab.lengthSq()));
    if (onRim.copy(a).addScaledVector(ab, k).distanceTo(nearest) < 1e-3 * m(1)) return 0;
  }
  return best / m(1);
}

interface Contact { readonly seat: number; readonly label: string; readonly kind: InteriorSolidKind; readonly own: boolean; readonly cells: number; readonly deep: number; readonly grain: number }

/** Per seat, per class of piece touched: how many body cells, and how deep (metres; see the top). */
function contacts(model: VehicleModel): Contact[] {
  const all = pieces(model);
  const out: Contact[] = [];
  model.seats.forEach((seat, i) => {
    const body = occupant(seat);
    const bounds = new Box3();
    for (const c of body) bounds.expandByPoint(c.p);
    const found = new Map<string, Contact>();
    const note = (piece: Piece, deep: number): void => {
      const own = piece.solid.seats.length === 0 || piece.solid.seats.includes(i);
      const label = `${piece.solid.kind}${own ? '' : ' (another seat\'s)'}`;
      const f = found.get(label);
      found.set(label, { seat: i, label, kind: piece.solid.kind, own, cells: (f?.cells ?? 0) + 1, deep: Math.max(f?.deep ?? 0, deep), grain: CELL * occupantScale(seat) });
    };
    for (const piece of all) {
      if (!piece.box.intersectsBox(bounds)) continue;
      // What the feet stand on: the floor, or the podium the seat stands on.
      const ground = piece.solid.kind === 'floor' || (piece.solid.kind === 'podium' && Math.abs(piece.box.max.y - seat.floor) < m(0.01));
      for (const c of body) {
        const p = c.p;
        if (ground) {
          if (p.x < piece.box.min.x || p.x > piece.box.max.x || p.z < piece.box.min.z || p.z > piece.box.max.z || p.y >= piece.box.max.y) continue;
          note(piece, (piece.box.max.y - p.y) / m(1));
        } else if (piece.edges) {
          if (!piece.box.clone().expandByScalar(m(0.3)).containsPoint(p)) continue;
          const d = behind(p, piece);
          if (d > 0) note(piece, d);
        } else if (piece.box.containsPoint(p) && inside(p, piece.tris)) note(piece, c.depth);
      }
    }
    out.push(...found.values());
  });
  return out;
}

/** How deep a seated body may be in a piece: up to a cell, at the size the body is drawn at, is a contact */

describe('the interior\'s solids', () => {
  it('name every vertex of every cabin, in pieces, and every seat its own shell', () => {
    for (const [id, model] of models()) {
      const count = model.interior.index?.count ?? model.interior.getAttribute('position').count;
      let next = 0;
      for (const s of model.solids) {
        expect(s.start, id).toBe(next);
        expect(s.count % 3, id).toBe(0);
        next += s.count;
      }
      expect(next, id).toBe(count);
      const kinds = new Set(model.solids.map((s) => s.kind));
      for (const kind of ['floor', 'dash', 'seat', 'headrest', 'column'] as InteriorSolidKind[]) expect(kinds.has(kind), `${id} ${kind}`).toBe(true);
      model.seats.forEach((_, i) => {
        expect(model.solids.some((s) => s.kind === 'seat' && s.seats.includes(i)), `${id} seat ${i}`).toBe(true);
      });
      const driver = model.seats.findIndex((s) => s.driver);
      expect(model.solids.some((s) => s.kind === 'column' && s.seats.includes(driver)), `${id} column`).toBe(true);
    }
  });

  it('has the seated bodies of the roster, filled, for every kind of seat', () => {
    for (const kind of ['carDrive', 'carRide', 'carRear', 'cabDrive', 'cabRide', 'chair']) {
      const body = BODIES.get(kind) ?? [];
      // Filled: more inside the skin than on it, and a trunk some 15 cm deep.
      expect(body.filter((c) => c.depth > 0).length, kind).toBeGreaterThan(body.filter((c) => c.depth === 0).length);
      expect(Math.max(...body.map((c) => c.depth)), kind).toBeGreaterThan(0.1);
    }
  });

  it('seats every body against its cabin, never in it: no knee through a dashboard, no legs through a podium', () => {
    const wrong: string[] = [];
    const table: string[] = [];
    for (const [id, model] of models()) {
      for (const c of contacts(model)) {
        const line = `${id} seat ${c.seat}: ${c.label} ${c.cells} cells, ${(c.deep * 100).toFixed(1)} cm deep`;
        table.push(line);
        if (c.deep > c.grain + 1e-6) wrong.push(line);
      }
    }
    if (process.env['CABIN_TABLE']) console.log(table.join('\n'));
    expect(wrong).toEqual([]);
  });
});
