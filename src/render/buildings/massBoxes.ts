import {
  Box3, BufferAttribute, BufferGeometry, InstancedBufferGeometry, InstancedInterleavedBuffer, InterleavedBufferAttribute, type Material, Mesh, Sphere, Vector3,
} from 'three';
import { gpuOnlyAttributes } from '../mesh/gpuOnly';
import { BOX_INSTANCE, type BoxMass } from './cellArrays';

/** What a box level reads of the kit (`kit.ts`): its unit box, the boxes' material and their depth. DO NOT import the kit for it: the kit makes the unit box here. */
interface BoxKit { readonly massBox: BufferGeometry; readonly massingBoxes: Material; readonly massBoxDepth: Material }

/** THE BOX LEVELS' BUILDINGS AS INSTANCES OF ONE BOX (`farTiles.ts` levels 2 and up): the box's 20 vertices once for the kit, each building's box `BOX_INSTANCE` numbers, laid by the masses' shader (`massingMaterial.ts` `boxes`) */

/** The unit box: four walls (corner, up, face, end of the wall) and a roof, its triangles as the boxes' mesh of masses laid them (counter-clockwise seen from outside). */
export function unitBox(): BufferGeometry {
  const vertex: number[] = [];
  for (let side = 0; side < 4; side++) {
    const p = side, q = (side + 1) % 4;
    vertex.push(p, 0, side, 0, q, 0, side, 1, q, 1, side, 1, p, 1, side, 0);
  }
  for (let corner = 0; corner < 4; corner++) vertex.push(corner, 1, 4, 0);
  const index: number[] = [];
  for (let quad = 0; quad < 5; quad++) { const f = quad * 4; index.push(f, f + 1, f + 2, f, f + 2, f + 3); }
  const g = new BufferGeometry();
  // Its place is the instance's: the position only names the vertices (three draws by the index).
  g.setAttribute('position', new BufferAttribute(new Float32Array(20 * 3), 3));
  g.setAttribute('boxVertex', new BufferAttribute(Float32Array.from(vertex), 4));
  g.setIndex(index);
  return g;
}

/** A box level's mesh: the kit's unit box drawn once a box, each from its instance. */
export function boxesMesh(mass: BoxMass, kit: BoxKit, name = 'building-massing-far'): Mesh {
  const g = new InstancedBufferGeometry();
  const unit = kit.massBox;
  g.index = unit.index;
  g.setAttribute('position', unit.getAttribute('position'));
  g.setAttribute('boxVertex', unit.getAttribute('boxVertex'));
  const boxes = new InstancedInterleavedBuffer(mass.boxes, BOX_INSTANCE);
  g.setAttribute('boxA', new InterleavedBufferAttribute(boxes, 4, 0));
  g.setAttribute('boxB', new InterleavedBufferAttribute(boxes, 4, 4));
  g.setAttribute('boxC', new InterleavedBufferAttribute(boxes, 4, 8));
  g.setAttribute('boxD', new InterleavedBufferAttribute(boxes, 4, 12));
  g.setAttribute('boxE', new InterleavedBufferAttribute(boxes, 2, 16));
  g.instanceCount = mass.boxes.length / BOX_INSTANCE;
  const b = mass.bounds;
  g.boundingBox = new Box3(new Vector3(b[0], b[1], b[2]), new Vector3(b[3], b[4], b[5]));
  g.boundingSphere = new Sphere(new Vector3(b[6], b[7], b[8]), b[9]);
  const mesh = new Mesh(g, kit.massingBoxes);
  // DO NOT let go of the kit's unit box: every box level draws it; only the boxes are the mesh's own.
  gpuOnlyAttributes(mesh, { boxes }, () => ({}));
  mesh.customDepthMaterial = kit.massBoxDepth;
  mesh.name = name;
  mesh.matrixAutoUpdate = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}
