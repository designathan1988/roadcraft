import { describe, expect, it } from 'vitest';
import { resolveBlocks } from '@world/buildings/blocks';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building, Volume } from '@world/buildings/types';

/** PRD-11: a block cut by a void keeps its own per-side materials; a stored record's are frozen. */
describe('a block cut by a void', () => {
  it('leaves the block it was cut from as it was, its frozen per-side materials too', () => {
    const body = JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)) as Omit<Building, 'id'>;
    const solid = body.volumes[0]!;
    const sides = Object.freeze({ north: Object.freeze({ finish: 'brick' }) }) as unknown as NonNullable<Volume['materials']>['sides'];
    const materials = Object.freeze({ sides });
    const block: Volume = { ...solid, materials: materials as NonNullable<Volume['materials']> };
    const { materials: _none, ...plain } = solid;
    const hole: Volume = { ...plain, id: solid.id + 50, mode: 'void', x: solid.x + solid.w * 0.25, y: solid.y + solid.d * 0.25, w: solid.w * 0.5, d: solid.d * 0.5 };
    const b = { ...body, id: 1, x: 0, y: 0, rotation: 0, volumes: [block, hole] } as unknown as Building;
    let out: Building | undefined;
    expect(() => { out = resolveBlocks(b); }).not.toThrow();
    expect(block.materials).toBe(materials);
    expect(materials.sides).toBe(sides);
    // The pieces cut from it carry no per-side materials (they belong to the block's own sides).
    for (const v of out!.volumes) if (v.id !== block.id) expect(v.materials?.sides).toBeUndefined();
  });
});
