import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { fogAt } from '@world/fogPaint';

describe('painted fog', () => {
  it('is kept in the map: saved, loaded and restored with its brush settings', () => {
    const doc = new RoadDoc();
    doc.addFogDab({ x: 10, y: 20, radius: 50, strength: 0.6, height: 40, speed: 12 });
    doc.addFogDab({ x: 30, y: 20, radius: 50, strength: 0.5, height: 40, speed: 12, erase: true });
    doc.setFogSettings({ density: 1.4 });
    const loaded = RoadDoc.fromJSON(doc.toJSON());
    expect(loaded.fogDabs).toEqual(doc.fogDabs);
    expect(loaded.fogSettings.density).toBeCloseTo(1.4);
    expect(loaded.fogRevision).toBeGreaterThan(0);
  });

  it('lays fog, and the eraser takes it away', () => {
    const lay = { x: 0, y: 0, radius: 100, strength: 0.8, height: 40, speed: 10 };
    const laid = fogAt([lay], 0, 0).density;
    expect(laid).toBeCloseTo(0.8);
    const erased = fogAt([lay, { ...lay, erase: true }], 0, 0).density;
    expect(erased).toBeLessThan(laid * 0.3);
    expect(fogAt([lay], 150, 0).density).toBe(0);
  });

  it('keeps each bank its own height and speed, the latest stroke winning where they meet', () => {
    const low = { x: 0, y: 0, radius: 100, strength: 1, height: 20, speed: 2 };
    const tall = { x: 300, y: 0, radius: 100, strength: 1, height: 200, speed: 40 };
    expect(fogAt([low, tall], 0, 0)).toMatchObject({ height: 20, speed: 2 });
    expect(fogAt([low, tall], 300, 0)).toMatchObject({ height: 200, speed: 40 });
    const repainted = fogAt([low, { ...tall, x: 0 }], 0, 0);
    expect(repainted.height).toBeCloseTo(200);
  });
});
