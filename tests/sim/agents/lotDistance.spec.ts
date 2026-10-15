import { describe, expect, it } from 'vitest';
import type { Building } from '@world/buildings/types';
import { buildLotGrid } from '@sim/agents/lotNav';

/**
 * The lot's distance field is a true shortest distance to the nearest exit:
 * the same as a plain Dijkstra that scans for the nearest open cell (no heap),
 * over the same free cells and the same no-corner-cutting rule.
 */
function reference(nx: number, ny: number, cell: number, blocked: Uint8Array, sources: number[]): Float64Array {
  const dist = new Float64Array(nx * ny).fill(Infinity);
  const done = new Uint8Array(nx * ny);
  for (const s of sources) dist[s] = 0;
  for (;;) {
    let best = -1;
    for (let k = 0; k < nx * ny; k++) if (!done[k] && dist[k]! < Infinity && (best < 0 || dist[k]! < dist[best]!)) best = k;
    if (best < 0) return dist;
    done[best] = 1;
    const i = best % nx, j = (best - i) / nx;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const a = i + di, c = j + dj;
        if (a < 0 || a >= nx || c < 0 || c >= ny) continue;
        const n = c * nx + a;
        if (blocked[n] || done[n]) continue;
        if (di && dj && (blocked[j * nx + a] || blocked[c * nx + i])) continue;
        dist[n] = Math.min(dist[n]!, dist[best]! + (di && dj ? Math.SQRT2 : 1) * cell);
      }
    }
  }
}

describe('the lot distance field', () => {
  it('is the shortest distance to an exit in every free cell, round walls', () => {
    const building = { elements: [] } as unknown as Building;
    const lot = { x: 0, y: 0, w: 40, d: 30 };
    // Two walls with gaps, so ways round them race each other.
    const walls = [
      [{ x: 8, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 22 }, { x: 8, y: 22 }],
      [{ x: 20, y: 8 }, { x: 22, y: 8 }, { x: 22, y: 30 }, { x: 20, y: 30 }],
      [{ x: 28, y: 4 }, { x: 36, y: 4 }, { x: 36, y: 6 }, { x: 28, y: 6 }],
    ];
    const exits = [
      { inner: { x: 2, y: 28 }, edge: { x: 2, y: 29.9 } },
      { inner: { x: 38, y: 2 }, edge: { x: 39.9, y: 2 } },
    ];
    const g = buildLotGrid(building, lot, walls, exits);
    // The exits the grid opened (a way out only through a gate it sees).
    const sources: number[] = [];
    for (let k = 0; k < g.nx * g.ny; k++) if (g.dist[k] === 0) sources.push(k);
    expect(sources.length).toBe(2);
    const want = reference(g.nx, g.ny, g.cell, g.blocked, sources);
    let compared = 0;
    for (let k = 0; k < g.nx * g.ny; k++) {
      if (g.blocked[k]) continue;
      if (want[k] === Infinity) { expect(g.dist[k]).toBe(Infinity); continue; }
      expect(g.dist[k]).toBeCloseTo(want[k]!, 3);
      compared++;
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
