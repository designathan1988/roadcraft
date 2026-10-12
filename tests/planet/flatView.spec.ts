import { describe, expect, it } from 'vitest';
import { MAX_HALF_HEIGHT, isFlatView, isoZoomBounds, maxHalfHeight, setFlatView } from '@render/isoViewport';

/**
 * ONE WORLD, TWO VIEWS (the player, 2026-10-11): on the planet the flat view
 * is the same world drawn flat, switched in place (`setFlatView`), its view
 * held under the top of the air until the whole world has a far projection
 * of its own (docs/pesquisa/fase-2-mapa-do-codigo.md).
 */
describe('the flat view of the one world', () => {
  it('turns on and off in place, and holds the view under the air', () => {
    expect(isFlatView()).toBe(false);
    expect(maxHalfHeight()).toBe(MAX_HALF_HEIGHT);
    setFlatView(true);
    expect(isFlatView()).toBe(true);
    expect(maxHalfHeight()).toBe(450);
    expect(isoZoomBounds(900).min).toBeCloseTo(900 / (2 * maxHalfHeight()), 9);
    setFlatView(false);
    expect(isFlatView()).toBe(false);
    expect(isoZoomBounds(900).min).toBeCloseTo(900 / (2 * MAX_HALF_HEIGHT), 9);
  });
});
