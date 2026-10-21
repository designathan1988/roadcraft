import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, InstancedMesh, MeshBasicMaterial, OrthographicCamera, type WebGLRenderer } from 'three';
import { castCoarse } from '@render/riggedCitizens';

/** A RIGGED CITIZEN'S SHADOW BY THE COARSEST LEVEL A CASCADE'S TEXEL HIDES (`riggedCitizens.ts` castCoarse): the coarse index and its garments' ranges for the draw alone */

/** A body's finest level (two garments and a face) and a coarse one (the two garments, fewer triangles), sharing their vertices. */
function levels(): { fine: BufferGeometry; coarse: BufferGeometry } {
  const position = new BufferAttribute(new Float32Array(30), 3);
  const fine = new BufferGeometry();
  fine.setAttribute('position', position);
  fine.setIndex(new BufferAttribute(new Uint16Array(36), 1));
  fine.addGroup(0, 18, 0);
  fine.addGroup(18, 12, 1);
  fine.addGroup(30, 6, 2);
  const coarse = new BufferGeometry();
  coarse.setAttribute('position', position);
  coarse.setIndex(new BufferAttribute(new Uint16Array(9), 1));
  coarse.addGroup(0, 6, 0);
  coarse.addGroup(6, 3, 1);
  return { fine, coarse };
}

/** A renderer drawing into a cascade map `width` texels wide. */
const renderer = (width: number): WebGLRenderer => ({ getRenderTarget: () => ({ width }) }) as unknown as WebGLRenderer;
/** A cascade `side` units across. */
const cascade = (side: number): OrthographicCamera => new OrthographicCamera(-side / 2, side / 2, side / 2, -side / 2);

describe('a rigged citizen cast into the shadows', () => {
  it('casts each garment by the coarse level\'s range and puts the fine level back after the draw', () => {
    const { fine, coarse } = levels();
    const mesh = new InstancedMesh(fine, [new MeshBasicMaterial(), new MeshBasicMaterial(), new MeshBasicMaterial()], 4);
    let asked = 0;
    castCoarse(mesh, (texel) => { asked = texel; return coarse; });
    const fineIndex = fine.index;
    const camera = cascade(2048);
    for (const [k, group] of fine.groups.entries()) {
      const before = { ...group };
      mesh.onBeforeShadow(renderer(1024), mesh as never, camera, camera, fine, new MeshBasicMaterial(), group as never);
      expect(asked).toBeCloseTo(2);
      expect(fine.index).toBe(coarse.index);
      if (k < 2) expect([group.start, group.count]).toEqual([coarse.groups[k]!.start, coarse.groups[k]!.count]);
      // The face the coarse level has not: not cast.
      else expect(group.count).toBe(0);
      mesh.onAfterShadow(renderer(1024), mesh as never, camera, camera, fine, new MeshBasicMaterial(), group as never);
      expect(fine.index).toBe(fineIndex);
      expect(group).toEqual(before);
    }
  });

  it('leaves a level alone where no coarser one is hidden by the texel', () => {
    const { fine } = levels();
    const mesh = new InstancedMesh(fine, new MeshBasicMaterial(), 4);
    castCoarse(mesh, () => null);
    const index = fine.index;
    const camera = cascade(64);
    mesh.onBeforeShadow(renderer(2048), mesh as never, camera, camera, fine, new MeshBasicMaterial(), null as never);
    expect(fine.index).toBe(index);
    mesh.onAfterShadow(renderer(2048), mesh as never, camera, camera, fine, new MeshBasicMaterial(), null as never);
    expect(fine.index).toBe(index);
  });
});
