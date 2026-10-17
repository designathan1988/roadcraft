import { describe, expect, it } from 'vitest';
import { type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { createFarForest } from '@render/farForest';
import { natureTreePictures } from '@render/natureTrees';

/** ONE ATLAS OF THE TREES' PICTURES (`natureTrees.ts` natureTreePictures): the near trees' far level and the far woods draw the same pictures */

const grid = { side: 5, cell: 6.4, half: 12.8, base: 0, farQuads: 4 };

describe('the trees\' pictures', () => {
  it('are one atlas for the far woods and the near trees, held until the last lets go', () => {
    const near = natureTreePictures();
    const far = createFarForest(4, grid, () => {});
    const material = far.material;
    const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <begin_vertex>', fragmentShader: '#include <common>\n#include <map_fragment>\n#include <normal_fragment_begin>', defines: {} };
    material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as WebGLRenderer);
    const uniforms = shader.uniforms as Record<string, { value: unknown }>;
    expect(uniforms['uAlbedo']!.value).toBe(near.set.albedo);
    expect(uniforms['uNormals']!.value).toBe(near.set.normals);
    // Its models' spheres and the atlas's blocks, the near set's.
    expect((uniforms['uRadius']!.value as Float32Array).length).toBe(near.set.spheres.length);
    expect((uniforms['uThin']!.value as { z: number; w: number }).z).toBe(near.set.blocks.x);
    // The far woods let go: the near trees keep the pictures; a new holder gets the same.
    far.dispose();
    const again = natureTreePictures();
    expect(again.set).toBe(near.set);
    again.release();
    near.release();
    // The last one gone: the next holder takes them anew.
    const fresh = natureTreePictures();
    expect(fresh.set).not.toBe(near.set);
    fresh.release();
  });
});
