import { describe, expect, it } from 'vitest';
import { ShaderChunk, ShaderLib, type InstancedMesh, type Material, type Object3D, type WebGLProgramParametersWithUniforms, type WebGLRenderer } from 'three';
import { personProgramStandIns } from '@render/people/proceduralCrowd';

/** A procedural person's place is read from their row (`procPerson`), written once a frame: no piece's program reads its own instance matrix */

/** The vertex shader a material's `onBeforeCompile` makes of three's, its includes spelled out. */
function vertexOf(material: Material, lib: 'physical' | 'depth'): string {
  const shader = { vertexShader: ShaderLib[lib].vertexShader, fragmentShader: ShaderLib[lib].fragmentShader, uniforms: {} };
  material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as WebGLRenderer);
  const resolve = (src: string): string => src.replace(/#include <(\w+)>/g, (_, name: string) => resolve((ShaderChunk as unknown as Record<string, string>)[name] ?? ''));
  return resolve(shader.vertexShader);
}

describe("a procedural person's place", () => {
  it('is their row in every program they are drawn and cast with, never the instance matrix', () => {
    const { lit, shadow } = personProgramStandIns();
    const meshes: Object3D[] = [...lit.children, ...shadow.children];
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of lit.children as InstancedMesh[]) {
      const vs = vertexOf(mesh.material as Material, 'physical');
      expect(vs).toContain('procPlace = mat4(texelFetch(procPerson');
      expect(vs).not.toContain('instanceMatrix');
      expect(vs).toContain('mvPosition = procPlace * mvPosition');
    }
    for (const mesh of shadow.children as InstancedMesh[]) {
      const depth = (mesh as InstancedMesh).customDepthMaterial ?? (mesh as InstancedMesh).material as Material;
      const vs = vertexOf(depth, 'depth');
      expect(vs).not.toContain('instanceMatrix');
      expect(vs).toContain('mvPosition = procPlace * mvPosition');
      // Cast with the next level's program: never the face's expressions (`depthMaterial`).
      expect(vs).not.toContain('The expression of the moment');
    }
  });
});
