import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Float32BufferAttribute, InstancedMesh, MeshBasicMaterial, type Camera, type Group, type Scene, type WebGLRenderer } from 'three';
import { createClassBodies } from '@render/people/crowdBodies';
import { dropFaceShapesOnceDrawn } from '@render/riggedCitizens';

/** The people's memory on the page: one copy of a class's shape basis, and a cooked body's face shapes let go once three holds its own */

describe("the people's memory", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps one copy of a class's shape basis: the one shared with the workers", () => {
    vi.stubGlobal('crossOriginIsolated', true);
    const basis = new Float32Array(2 * 2 * 4).fill(1);
    const bodies = createClassBodies(basis, 2, 2, new Float32Array(6), 1);
    expect(bodies.basis).not.toBe(basis);
    expect(bodies.basis.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...bodies.basis]).toEqual([...basis]);
    bodies.dispose();
  });

  it("lets a cooked body's face shapes go after its first draw, keeping whatever ran after a draw", () => {
    const geometry = new BoxGeometry();
    const count = geometry.getAttribute('position').count;
    geometry.morphAttributes['position'] = [new Float32BufferAttribute(new Float32Array(count * 3), 3), new Float32BufferAttribute(new Float32Array(count * 3), 3)];
    const mesh = new InstancedMesh(geometry, new MeshBasicMaterial(), 1);
    let after = 0;
    mesh.onAfterRender = () => { after++; };
    dropFaceShapesOnceDrawn(mesh);
    expect(geometry.morphAttributes['position']!.every((a) => a.array.length === count * 3)).toBe(true);
    const draw = (): void => mesh.onAfterRender({} as WebGLRenderer, {} as Scene, {} as Camera, geometry, mesh.material, {} as Group);
    draw();
    expect(geometry.morphAttributes['position']!.every((a) => a.array.length === 0)).toBe(true);
    // The shapes' number, which three's morph texture is kept by, the same.
    expect(geometry.morphAttributes['position']!.length).toBe(2);
    draw();
    expect(after).toBe(2);
  });
});
