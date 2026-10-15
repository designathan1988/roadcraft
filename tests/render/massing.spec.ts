import { describe, expect, it } from 'vitest';
import { emitChunk } from '@render/buildings/buildingMesh';
import { emitMassing } from '@render/buildings/massing';
import { drawsSignature } from '@render/buildings/signature';
import { m } from '@world/units';
import { growCity } from '../world/cityAudit';

/** A BUILDING FROM AFAR KEEPS ITS SHAPE. */
const FAR_ERROR = m(1.5);
/** How far apart the samples of each level are: the far level is a few faces, sampled finer. */
const STEP = m(0.75);
const FINE = m(0.25);
/** The farthest a point of a face lies from the nearest sample of it on a lattice of `FINE` (half its diagonal). */
const SLACK = FINE * Math.SQRT1_2;
/** The share of a level's samples that may lie farther than the error from the other. */
const MOST_OFF = 0.03;

/** Points on a mesh's surface, about `STEP` apart */
function samples(position: Float32Array, index: Uint32Array, out: number[], step = STEP): void {
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = index[t]! * 3, b = index[t + 1]! * 3, c = index[t + 2]! * 3;
    const ux = position[b]! - position[a]!, uy = position[b + 1]! - position[a + 1]!, uz = position[b + 2]! - position[a + 2]!;
    const vx = position[c]! - position[a]!, vy = position[c + 1]! - position[a + 1]!, vz = position[c + 2]! - position[a + 2]!;
    const area = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
    const n = Math.max(1, Math.ceil(Math.max(Math.hypot(ux, uy, uz), Math.hypot(vx, vy, vz)) / step));
    const each = area / (((n + 1) * (n + 2)) / 2);
    for (let i = 0; i <= n; i++) {
      for (let j = 0; i + j <= n; j++) {
        const u = i / n, v = j / n, w = 1 - u - v;
        for (let k = 0; k < 3; k++) out.push(position[a + k]! * w + position[b + k]! * u + position[c + k]! * v);
        out.push(each);
      }
    }
  }
}

/** A cell of `FAR_ERROR` as one number (a town is well inside 2^20 cells a side). */
const cellKey = (i: number, j: number, k: number): number => ((i + 524288) * 1048576 + (j + 524288)) * 4096 + (k + 2048);

/** The samples filed by cell of `FAR_ERROR`, for the nearest within the error. */
function bucket(points: readonly number[]): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let p = 0; p < points.length; p += 4) {
    const key = cellKey(Math.floor(points[p]! / FAR_ERROR), Math.floor(points[p + 1]! / FAR_ERROR), Math.floor(points[p + 2]! / FAR_ERROR));
    const list = out.get(key);
    if (list) list.push(points[p]!, points[p + 1]!, points[p + 2]!); else out.set(key, [points[p]!, points[p + 1]!, points[p + 2]!]);
  }
  return out;
}

/** The share of `points`' area farther than `reach` from every point of `other`. */
function strays(points: readonly number[], other: Map<number, number[]>, reach: number): number {
  let off = 0, all = 0;
  const r2 = reach * reach;
  for (let p = 0; p < points.length; p += 4) {
    all += points[p + 3]!;
    const x = points[p]!, y = points[p + 1]!, z = points[p + 2]!;
    const i = Math.floor(x / FAR_ERROR), j = Math.floor(y / FAR_ERROR), k = Math.floor(z / FAR_ERROR);
    let near = false;
    for (let di = -1; di <= 1 && !near; di++) {
      for (let dj = -1; dj <= 1 && !near; dj++) {
        for (let dk = -1; dk <= 1 && !near; dk++) {
          const list = other.get(cellKey(i + di, j + dj, k + dk));
          if (!list) continue;
          for (let q = 0; q < list.length; q += 3) {
            const dx = list[q]! - x, dy = list[q + 1]! - y, dz = list[q + 2]! - z;
            if (dx * dx + dy * dy + dz * dz <= r2) { near = true; break; }
          }
        }
      }
    }
    if (!near) off += points[p + 3]!;
  }
  return off / Math.max(1e-9, all);
}

describe('the far level of a building', () => {
  it('stands where the detailed building does, within the error it is drawn at', () => {
    const city = growCity({ size: 'small', seed: 1 });
    const off: string[] = [];
    let checked = 0;
    // A sample of the town's buildings, of every kind it grows.
    for (const whole of [...city.doc.buildings.all()].filter((_, i) => i % 10 === 0)) {
      // Its blocks: its lots and their parts left out
      if (drawsSignature(whole)) continue;
      const b = { ...whole, volumes: whole.volumes.filter((v) => !v.open), elements: [] };
      const mass = emitMassing(b, () => 0);
      if (!mass) continue;
      const far: number[] = [], fineFar: number[] = [], near: number[] = [];
      samples(mass.position, mass.index, far);
      samples(mass.position, mass.index, fineFar, FINE);
      for (const shell of Object.values(emitChunk(b, () => 0).shells)) if (shell) samples(shell.position, shell.index, near);
      // The detailed shells are many small faces, their samples dense; the far level is sampled finer to measure against.
      const farOff = strays(far, bucket(near), FAR_ERROR + SLACK), nearOff = strays(near, bucket(fineFar), FAR_ERROR + SLACK);
      checked++;
      if (farOff > MOST_OFF || nearOff > MOST_OFF) off.push(`${b.id}: longe ${(100 * farOff).toFixed(1)} %, detalhe ${(100 * nearOff).toFixed(1)} %`);
    }
    expect(checked).toBeGreaterThan(30);
    expect(off).toEqual([]);
  });
});
