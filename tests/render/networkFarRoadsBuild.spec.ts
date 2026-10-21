import { describe, expect, it } from 'vitest';
import { buildFarRoadCells, type FarRoadCell, type FarRoadInput } from '@render/networkFarRoadsBuild';

/** Outlines as the page hands them over: each a list of (x, y) corners at height `z`, its layer and colour. */
function input(outlines: { ring: [number, number][]; layer: number; colour: [number, number, number]; z?: number }[], cell = 100,
  exclude: [number, number, number, number] | null = null): FarRoadInput {
  const points: number[] = [], counts: number[] = [], layers: number[] = [], colors: number[] = [];
  for (const o of outlines) {
    for (const [x, y] of o.ring) points.push(x, y, o.z ?? 0);
    counts.push(o.ring.length);
    layers.push(o.layer);
    colors.push(...o.colour);
  }
  return { cell, origin: 0, exclude, points: new Float64Array(points), counts: new Uint32Array(counts), layers: new Uint8Array(layers), colors: new Float32Array(colors) };
}

const rect = (x0: number, y0: number, x1: number, y1: number): [number, number][] => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/** The plan area a cell's triangles cover (positions are x, height, -y). */
function area(cells: readonly FarRoadCell[], layer: number, key?: string): number {
  let sum = 0;
  for (const c of cells) {
    if (c.layer !== layer || (key !== undefined && c.key !== key)) continue;
    const p = c.positions;
    for (let t = 0; t < c.indices.length; t += 3) {
      const a = c.indices[t]! * 3, b = c.indices[t + 1]! * 3, d = c.indices[t + 2]! * 3;
      sum += Math.abs((p[b]! - p[a]!) * (p[d + 2]! - p[a + 2]!) - (p[d]! - p[a]!) * (p[b + 2]! - p[a + 2]!)) / 2;
    }
  }
  return sum;
}

const CASING: [number, number, number] = [0.2, 0.2, 0.2];
const ASPHALT: [number, number, number] = [0.04, 0.04, 0.04];
const ARTERIAL: [number, number, number] = [0.05, 0.04, 0.04];

describe('the network far roads', () => {
  it('cuts the carriageways out of the casing: the two layers never overlap', () => {
    const cells = buildFarRoadCells(input([
      { ring: rect(0, 0, 40, 10), layer: 0, colour: CASING },
      { ring: rect(0, 3, 40, 7), layer: 1, colour: ASPHALT },
      // A junction's carriageway reaching into the road's casing, of another class.
      { ring: rect(30, 0, 50, 10), layer: 1, colour: ARTERIAL },
    ]));
    const asphalt = area(cells, 1), casing = area(cells, 0);
    // The carriageways merged: 40x4 and 20x10 sharing 10x4.
    expect(asphalt).toBeCloseTo(160 + 200 - 40, 3);
    // The casing: 40x10 less the carriageways over it (30x4 and 10x10).
    expect(casing).toBeCloseTo(400 - 120 - 100, 3);
  });

  it('clips each outline to the cells it crosses, and leaves the excluded area out', () => {
    const cells = buildFarRoadCells(input([{ ring: rect(80, 0, 130, 10), layer: 1, colour: ASPHALT, z: 2 }]));
    expect(area(cells, 1, '0,0')).toBeCloseTo(200, 3);
    expect(area(cells, 1, '1,0')).toBeCloseTo(300, 3);
    for (const c of cells) for (let i = 1; i < c.positions.length; i += 3) expect(c.positions[i]).toBeCloseTo(2, 5);
    const cut = buildFarRoadCells(input([{ ring: rect(80, 0, 130, 10), layer: 1, colour: ASPHALT }], 100, [100, -50, 200, 50]));
    expect(area(cut, 1)).toBeCloseTo(200, 3);
  });
});
