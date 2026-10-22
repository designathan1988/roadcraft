import { describe, expect, it } from 'vitest';
import { LineSegments, Scene } from 'three';

import { createTracers, TRACER_SLOTS } from '../../src/render/playEffects';

/** THE TRACERS ARE ONE DRAW AND NOTHING MADE A SHOT (`render/playEffects.ts`, F5 "efeitos ... otimizados") */
describe('the tracers', () => {
  it('draw every shot from one set of line segments, made once', () => {
    const scene = new Scene();
    const tracers = createTracers(scene);
    const before = scene.children.length;
    const lines = scene.getObjectByName('tracers') as LineSegments;
    const geometry = lines.geometry;
    const position = geometry.getAttribute('position');
    for (let i = 0; i < TRACER_SLOTS + 8; i++) tracers.shot([i, 0, 1.5], [i, 30, 1.2]);
    expect(scene.children.length).toBe(before);
    expect(lines.geometry).toBe(geometry);
    expect(geometry.getAttribute('position')).toBe(position);
    expect(lines.visible).toBe(true);
    // The oldest slot taken again by the newest shot: shot 32 wrote slot 0.
    expect(position.getX(0)).toBe(TRACER_SLOTS);
    // Lit for a tenth of a second, then gone.
    expect(tracers.update(0.06)).toBe(TRACER_SLOTS);
    expect(tracers.update(0.07)).toBe(0);
    expect(lines.visible).toBe(false);
    tracers.dispose();
    expect(scene.getObjectByName('tracers')).toBeUndefined();
  });
});
