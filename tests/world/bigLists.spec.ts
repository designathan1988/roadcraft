import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';

/** EDT-14: a map's long lists copied without spreading them into `push` (past ~100 000 arguments the engine threw RangeError). */
describe("a map's long lists", () => {
  it('copy whole in a clone and in a replace, 300 000 of them', () => {
    const doc = new RoadDoc();
    const n = 300_000;
    for (let i = 0; i < n; i++) (doc.terrainPaint as unknown[]).push({ x: i, y: 0, r: 1, layer: 0, strength: 1 });
    const copy = doc.clone();
    expect(copy.terrainPaint.length).toBe(n);
    const other = new RoadDoc();
    other.replaceWith(copy);
    expect(other.terrainPaint.length).toBe(n);
  });
});
