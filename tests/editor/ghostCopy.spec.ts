import { describe, expect, it, vi } from 'vitest';
import { blueprintByKey, instantiate, placeBody } from '@world/buildings/blueprints';

/** The ghost under the pointer is placed, not copied (`placeBody`) */
describe('the ghost of a blueprint', () => {
  it('is placed as instantiate places it, without a JSON copy', () => {
    const body = blueprintByKey('house')!.body;
    const at = { x: 120, y: -40 };
    const stringify = vi.spyOn(JSON, 'stringify');
    const ghost = placeBody(body, at, 0.7, 'house');
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    expect(ghost).toEqual(instantiate(body, at, 0.7, 'house'));
    // It shares the body: only read.
    expect(ghost.volumes).toBe(body.volumes);
  });
});
