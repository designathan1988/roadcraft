import { describe, expect, it } from 'vitest';
import type { BufferGeometry } from 'three';
import { emitChunk } from '@render/buildings/buildingMesh';
import { PART_KINDS, createBuildingKit } from '@render/buildings/kit';
import { m } from '@world/units';
import type { Building } from '@world/buildings/types';
import { growCity } from '../world/cityAudit';

/**
 * NO TWO SURFACES OF A BUILDING IN ONE PLANE. Two faces drawn in the same
 * plane over each other - a balcony's floor on the roof slab under it, a band
 * on its wall, a wall standing on a lot's kerb - fight for the depth buffer
 * pixel by pixel and flicker as the camera moves (z-fighting; the player,
 * 2026-10-12 and 2026-10-13: "objetos se sobrepondo e piscando"). Every face
 * of a sample of a generated town's buildings - the shells of each finish and
 * every instanced part, in the world - is filed by its plane (normal and
 * distance, to 1 mm); faces of different looks in one plane, facing the same
 * way, that overlap are summed by area. A part on the shell wins by its
 * polygon offset (`kit.ts`), so shell is measured against shell and part
 * against part. The sum only shrinks: some 5,000 m² over 150 buildings before
 * the layers of `buildingMesh.ts` (kerbs, pavings, plinth ledges, pinwheel
 * aprons and bands, boundary walls), some 5 m² after.
 */
type V3 = [number, number, number];
type P2 = [number, number];
interface Face { kind: string; look: string; rgb: V3; n: V3; d: number; pts: V3[] }

const PLANE_EPS = m(0.001);
/** Two colours of one finish this far apart in a channel are told apart: the shells' tone noise is within +-3 %. */
const COLOUR_APART = 0.07;
/** Overlaps smaller than this are rounding, not a surface. */
const MIN_OVERLAP = m(0.02) * m(0.02);
/** The buildings measured: the first of the town, with their lots, walls, gates and pavings. */
const SAMPLE = 100;
/** The overlapping area over the sample, m² (3.59 on 2026-10-13, 0.38 after the fences, gates, walls, bands, canopies and machine rooms were parted); it only shrinks. */
const BUDGET = 0.39;

function face(a: V3, b: V3, c: V3, kind: string, look: string, rgb: V3, out: Face[]): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz);
  if (l < 1e-9) return;
  nx /= l; ny /= l; nz /= l;
  out.push({ kind, look, rgb, n: [nx, ny, nz], d: nx * a[0] + ny * a[1] + nz * a[2], pts: [a, b, c] });
}

function area(poly: readonly P2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return s / 2;
}

/** The triangle in the plane's own 2-D frame, counter-clockwise. */
function flat(f: Face): P2[] {
  const [nx, ny, nz] = f.n;
  const ax = Math.abs(nx) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const ux0 = ny * ax[2]! - nz * ax[1]!, uy0 = nz * ax[0]! - nx * ax[2]!, uz0 = nx * ax[1]! - ny * ax[0]!;
  const ul = Math.hypot(ux0, uy0, uz0);
  const ux = ux0 / ul, uy = uy0 / ul, uz = uz0 / ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const t = f.pts.map((q): P2 => [q[0] * ux + q[1] * uy + q[2] * uz, q[0] * vx + q[1] * vy + q[2] * vz]);
  return area(t) < 0 ? t.reverse() : t;
}

/** The area two convex counter-clockwise polygons share (Sutherland-Hodgman). */
function overlap(a: readonly P2[], b: readonly P2[]): number {
  let out = a.slice();
  for (let i = 0; i < b.length && out.length > 0; i++) {
    const p = b[i]!, q = b[(i + 1) % b.length]!;
    const side = (r: P2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const input = out;
    out = [];
    for (let k = 0; k < input.length; k++) {
      const c = input[k]!, d = input[(k + 1) % input.length]!;
      const sc = side(c), sd = side(d);
      if (sc >= 0) out.push(c);
      if ((sc >= 0) !== (sd >= 0)) {
        const t = sc / (sc - sd);
        out.push([c[0] + (d[0] - c[0]) * t, c[1] + (d[1] - c[1]) * t]);
      }
    }
  }
  return out.length < 3 ? 0 : Math.abs(area(out));
}

/** Overlapping area of faces of different looks in one plane, facing the same way, by pair of looks. */
function coplanarOverlaps(faces: readonly Face[], into: Map<string, number>): void {
  const planes = new Map<string, Face[]>();
  for (const f of faces) {
    const key = `${Math.round(f.n[0] * 200)},${Math.round(f.n[1] * 200)},${Math.round(f.n[2] * 200)},${Math.round(f.d / PLANE_EPS)}`;
    let list = planes.get(key);
    if (!list) planes.set(key, list = []);
    list.push(f);
  }
  for (const list of planes.values()) {
    if (list.length < 2) continue;
    const flats = list.map(flat);
    const boxes = flats.map((t) => [Math.min(t[0]![0], t[1]![0], t[2]![0]), Math.min(t[0]![1], t[1]![1], t[2]![1]), Math.max(t[0]![0], t[1]![0], t[2]![0]), Math.max(t[0]![1], t[1]![1], t[2]![1])] as const);
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i]!, b = list[j]!;
        if (a.kind !== b.kind) continue;
        // One paint in one plane is one picture whichever face wins; two read apart.
        if (a.look === b.look && Math.max(Math.abs(a.rgb[0] - b.rgb[0]), Math.abs(a.rgb[1] - b.rgb[1]), Math.abs(a.rgb[2] - b.rgb[2])) < COLOUR_APART) continue;
        const ba = boxes[i]!, bb = boxes[j]!;
        if (ba[0] >= bb[2] || bb[0] >= ba[2] || ba[1] >= bb[3] || bb[1] >= ba[3]) continue;
        const shared = overlap(flats[i]!, flats[j]!);
        if (shared < MIN_OVERLAP) continue;
        const k = `${a.kind}: ${[a.look, b.look].sort().join(' x ')}`;
        into.set(k, (into.get(k) ?? 0) + shared);
      }
    }
  }
}

function facesOfGeometry(g: BufferGeometry, look: string, e: Float32Array, out: Face[]): void {
  const p = g.getAttribute('position');
  const idx = g.getIndex();
  const n = idx ? idx.count : p.count;
  const at = (i: number): V3 => {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    return [e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!];
  };
  for (let t = 0; t + 2 < n; t += 3) face(at(idx ? idx.getX(t) : t), at(idx ? idx.getX(t + 1) : t + 1), at(idx ? idx.getX(t + 2) : t + 2), 'peça', look, [0, 0, 0], out);
}

/** Every face of one building, in the world: its shells by finish and colour, its parts by kind. */
function facesOf(b: Building, kit: ReturnType<typeof createBuildingKit>): Face[] {
  const faces: Face[] = [];
  const chunk = emitChunk(b, () => 0);
  for (const [finish, shell] of Object.entries(chunk.shells)) {
    if (!shell) continue;
    const pos = shell.position, index = shell.index, colour = shell.colour;
    const v = (i: number): V3 => [pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!];
    for (let t = 0; t + 2 < index.length; t += 3) {
      const i0 = index[t]!, i1 = index[t + 1]!, i2 = index[t + 2]!;
      const rgb: V3 = [0, 1, 2].map((k) => (colour[i0 * 3 + k]! + colour[i1 * 3 + k]! + colour[i2 * 3 + k]!) / 3) as V3;
      face(v(i0), v(i1), v(i2), 'casca', finish, rgb, faces);
    }
  }
  for (const kind of PART_KINDS) {
    const batch = chunk.parts[kind];
    if (!batch || batch.count === 0) continue;
    for (let k = 0; k < batch.count; k++) facesOfGeometry(kit.geometry[kind], kind, batch.matrices.subarray(k * 16, k * 16 + 16), faces);
  }
  return faces;
}

describe('building surfaces', () => {
  it('draws every instanced part over the shell it is set on', () => {
    // The parts (frames, shutters, balcony slabs) lie on the shell's faces by
    // design; a polygon offset towards the camera makes them win the depth
    // test there (glPolygonOffset: negative factor and units).
    const kit = createBuildingKit();
    const loose = PART_KINDS.filter((kind) => {
      const material = kit.material[kind];
      return !material.polygonOffset || material.polygonOffsetFactor >= 0 || material.polygonOffsetUnits >= 0;
    });
    expect(loose).toEqual([]);
  });

  it('draws no two surfaces of a generated town in one plane over each other', () => {
    const city = growCity({ size: 'small', seed: 1 });
    const kit = createBuildingKit();
    const pairs = new Map<string, number>();
    for (const b of [...city.doc.buildings.all()].slice(0, SAMPLE)) coplanarOverlaps(facesOf(b, kit), pairs);
    const unit = m(1) * m(1);
    const total = [...pairs.values()].reduce((s, a) => s + a, 0) / unit;
    const report = [...pairs.entries()].sort((a, b) => b[1] - a[1]).map(([k, a]) => `${k}: ${(a / unit).toFixed(2)} m²`);
    expect(total, report.join('\n')).toBeLessThanOrEqual(BUDGET);
  });
});
