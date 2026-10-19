import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial } from 'three';
import { poseDepthOf, type SlotFormat } from '@render/cellInstances';
import { windDepthMaterial } from '@render/wind';

/** THE VEGETATION'S SHADOW MATERIALS WRITE NO COLOUR (VEG-10, 2026-10-19): the cascades compare their depth texture, their colour nothing reads. */
describe('the vegetation\'s depth materials', () => {
  it('write depth only', () => {
    expect(windDepthMaterial({ sway: 0.02, flutter: 0.01 }, 'tree').colorWrite).toBe(false);
    const format: SlotFormat = { stride: 7, key: 'test', glsl: 'return mat4(1.0);', matrixInto: () => {} };
    expect(poseDepthOf(new MeshStandardMaterial(), format).colorWrite).toBe(false);
  });
});
