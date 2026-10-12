import { describe, expect, it } from 'vitest';

import { highestGroundUnder } from '@render/buildings/lawnGround';
import { Rng } from '@core/rng';

/**
 * NOTHING ON A LAWN SINKS INTO THE DRAWN GROUND (Etapa 5a). A part is seated
 * at the highest the drawn ground rises under it (`buildingMesh.ts`
 * `emitLots`). The drawn ground is triangles on a grid, each cell split along
 * one diagonal or the other (`render/terrain.ts` `sampleGrid`); here a rough
 * one, every corner at random and every cell's diagonal at random, and the
 * highest point read for footprints of every size and turn, against the
 * ground swept on a fine grid. Four corners and the centre missed ridges by
 * centimetres to decimetres.
 */
const CELL = 16, HALF = 160, SEG = 20, GRID = SEG + 1;

function roughGround(seed: number): (x: number, y: number) => number {
  const rng = new Rng(seed + 1);
  const rand = (): number => rng.float();
  const corners = Float64Array.from({ length: GRID * GRID }, () => rand() * 6);
  const flip = Uint8Array.from({ length: SEG * SEG }, () => (rand() < 0.5 ? 1 : 0));
  return (x, y) => {
    const gx = (x + HALF) / CELL, gy = (HALF - y) / CELL;
    const ix = Math.min(SEG - 1, Math.floor(gx)), iy = Math.min(SEG - 1, Math.floor(gy));
    const u = gx - ix, v = gy - iy;
    const a = corners[ix + iy * GRID]!, b = corners[ix + (iy + 1) * GRID]!;
    const c = corners[ix + 1 + (iy + 1) * GRID]!, d = corners[ix + 1 + iy * GRID]!;
    if (flip[ix + iy * SEG]) return u >= v ? a * (1 - u) + d * (u - v) + c * v : a * (1 - v) + b * (v - u) + c * u;
    return u + v <= 1 ? a * (1 - u - v) + d * u + b * v : b * (1 - u) + c * (u + v - 1) + d * (1 - v);
  };
}

describe('the highest the drawn ground rises under a part', () => {
  it('is exact for footprints of every size and turn over a rough grid', () => {
    const rng = new Rng(0x1a77);
    const rand = (): number => rng.float();
    let worstShort = 0, beyond = 0, ridges = 0;
    for (let k = 0; k < 400; k++) {
      const ground = roughGround(k);
      const cx = -100 + rand() * 200, cy = -100 + rand() * 200;
      const w = 1 + rand() * 30, d = 1 + rand() * 30, a = rand() * Math.PI;
      const ux = Math.cos(a), uy = Math.sin(a);
      const at = (s: number, t: number): [number, number] => [cx + ux * s - uy * t, cy + uy * s + ux * t];
      const corners = [at(-w / 2, -d / 2), at(w / 2, -d / 2), at(w / 2, d / 2), at(-w / 2, d / 2)];
      // Every point it reads is recorded: each must be under the part.
      const asked: [number, number][] = [];
      const read = highestGroundUnder(corners, (x, y) => { asked.push([x, y]); return ground(x, y); }, { cell: CELL, half: HALF });
      for (const [x, y] of asked) {
        const s = (x - cx) * ux + (y - cy) * uy, t = -(x - cx) * uy + (y - cy) * ux;
        if (Math.abs(s) > w / 2 + 1e-6 || Math.abs(t) > d / 2 + 1e-6) beyond++;
      }
      // The ground swept inside on a fine grid and along the edges finer still (the highest is often where an edge crosses a ridge).
      let swept = -Infinity;
      for (let i = 0; i <= 120; i++) for (let j = 0; j <= 120; j++) swept = Math.max(swept, ground(...at(-w / 2 + (w * i) / 120, -d / 2 + (d * j) / 120)));
      for (let e = 0; e < 4; e++) {
        const [ax, ay] = corners[e]!, [bx, by] = corners[(e + 1) % 4]!;
        for (let i = 0; i <= 20000; i++) swept = Math.max(swept, ground(ax + ((bx - ax) * i) / 20000, ay + ((by - ay) * i) / 20000));
      }
      const cornersOnly = Math.max(...corners.map(([x, y]) => ground(x, y)), ground(cx, cy));
      if (swept > cornersOnly + 0.05) ridges++;
      worstShort = Math.max(worstShort, swept - read);
    }
    // Ridges the corners and centre missed were met, or nothing was tested.
    expect(ridges).toBeGreaterThan(50);
    expect(worstShort).toBeLessThan(1e-9);
    expect(beyond).toBe(0);
  });
});
