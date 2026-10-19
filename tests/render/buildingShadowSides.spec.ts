import { describe, expect, it } from 'vitest';
import { DoubleSide, FrontSide, type Material } from 'three';
import { createBuildingKit } from '@render/buildings/kit';

/** WHICH FACES OF A BUILDING'S PARTS DRAW INTO THE SUN'S SHADOW (`kit.ts`) */

describe('building shadow sides', () => {
  it('casts a window pane from its front only, the sun-facing side', () => {
    const kit = createBuildingKit();
    for (const kind of ['glass', 'glassDark'] as const) {
      const material = kit.material[kind] as Material;
      // Drawn from the front, seen from outside...
      expect(material.side).toBe(FrontSide);
      // ...and cast from the front: no pane whose back faces the sun drawn in each cascade.
      expect(material.shadowSide).toBe(FrontSide);
    }
    // Leaves stay two-sided: seen and cast from both sides.
    expect((kit.material.foliage as Material).shadowSide).toBe(DoubleSide);
  });
});
