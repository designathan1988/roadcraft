import { describe, expect, it } from 'vitest';
import { drawBuilderGrid } from '@ui/overlay/builderGrid';

/** THE BUILDER'S GRID IN TWO STROKES A FRAME, THE SAME LINES (`ui/overlay/builderGrid.ts`, plan K5) */
describe('the builder grid', () => {
  it('draws every line in two strokes, the major ones over the minor', () => {
    let strokes = 0, lines = 0;
    const styles: string[] = [];
    const ctx = {
      save() {}, restore() {}, beginPath() {}, lineCap: '', lineWidth: 0, strokeStyle: '',
      moveTo() { lines++; }, lineTo() {}, stroke() { strokes++; styles.push(ctx.strokeStyle); },
    };
    drawBuilderGrid(ctx as unknown as CanvasRenderingContext2D, (x, y) => ({ x, y }), { x: 0, y: 0 }, 0);
    expect(strokes).toBe(2);
    expect(styles[1]).toContain('0.22');
    expect(lines).toBeGreaterThan(20);
  });
});
