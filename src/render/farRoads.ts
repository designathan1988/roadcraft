import { Box3, BufferAttribute, BufferGeometry, FrontSide, Group, Mesh, MeshStandardMaterial, Sphere, Vector3 } from 'three';
import { canQueueJobs, focusDistance, jobWorkers, submitJob } from '../jobs/jobPool';
import { forgetOtherDerived } from './derivedCache';
import { pullTowardEye } from './depthConvention';
import { type FarRoadJob, type FarRoadMesh, type FarRoadReply, derivedRoadCache, farLevelError, runFarRoadJob, tileRoads } from './farRoadTiles';
import { type FarKind, type FarLanded, FarTree, type FarTreeJob, type FarTreeRun } from './farTree';
import { nodeSide } from './buildings/farTiles';
import { TIER_SPAN } from './buildings/cellPool';
import { gpuOnly } from './mesh/gpuOnly';
import type { SharedGroundData } from './sharedGround';

/** THE ROADS OF THE TILES NOT IN THE PAGE'S DOCUMENT (CLAUDE.md "Streaming world"): baked per tile in workers from the tile store (`farRoadTiles.ts`), chosen as a quadtree (`farTree.ts`), drawn with one material */

declare const __FAR_ROADS_HASH__: string | undefined;
/** The fingerprint of the code the far roads are baked by (`cook-plugin.ts`): bakes are kept under it; none (tests): nothing kept. */
const FAR_HASH = typeof __FAR_ROADS_HASH__ !== 'undefined' && __FAR_ROADS_HASH__ ? __FAR_ROADS_HASH__ : null;
const FAR_PREFIX = FAR_HASH ? `farRoads:${FAR_HASH}:` : null;
/** The far roads' band in the queue: with the buildings' far levels (`farLevels.ts` `FAR_TIER`). */
const FAR_TIER = 2.9;

/** The linear colour of an sRGB byte colour, in the vertex shader (IEC 61966-2-1). */
const LINEAR_GLSL = /* glsl */ `
vec3 farLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}`;

/** THE ONE MATERIAL OF THE FAR ROADS: lit as the near streets (rough, no metal), the colours their vertices', the vertices compact (`FarRoadMesh`) */
function createFarRoadMaterial(): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0, envMapIntensity: 0.55, side: FrontSide });
  material.name = 'far-roads';
  // Over the land they lie on, whichever way the depth runs (`depthConvention.ts`).
  pullTowardEye(material, 1, 2);
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 farXZ;\nattribute float farHeight;\n${LINEAR_GLSL}`)
      // The plan is scaled by the mesh (x and z by 1/q, `farRoadMesh`): the normal is given in the world's axes and taken back into the mesh's here.
      .replace('#include <beginnormal_vertex>', 'float farScale = length(modelMatrix[0].xyz);\nvec3 objectNormal = vec3(normal.x * farScale, normal.y, normal.z * farScale);')
      .replace('#include <begin_vertex>', 'vec3 transformed = vec3(farXZ.x, farHeight, -farXZ.y);')
      .replace('#include <color_vertex>', '#include <color_vertex>\nvColor.rgb = farLinear(vColor.rgb);');
  };
  material.customProgramCacheKey = () => 'far-roads';
  return material;
}

/** A far road mesh's geometry: plan int16 (`farXZ`), height float, normal and colour bytes; no `position` (what reads one, a pass with its own material, draws nothing of it). */
function farGeometry(data: Pick<FarRoadMesh, 'xz' | 'height' | 'normal' | 'color' | 'index'>): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('farXZ', new BufferAttribute(data.xz, 2));
  g.setAttribute('farHeight', new BufferAttribute(data.height, 1));
  g.setAttribute('normal', new BufferAttribute(data.normal, 4, true));
  g.setAttribute('color', new BufferAttribute(data.color, 4, true));
  g.setIndex(new BufferAttribute(data.index, 1));
  return g;
}

/** A node's mesh: placed at its origin, its plan scaled by 1/q; its bounds set by hand (three would read them off `position`). */
function farRoadMesh(data: FarRoadMesh, material: MeshStandardMaterial): FarLanded {
  const g = farGeometry(data);
  const [x0, y0, x1, y1, h0, h1] = data.bounds as unknown as [number, number, number, number, number, number];
  const q = data.q;
  // In the mesh's own axes (plan times q, height as is).
  g.boundingBox = new Box3(new Vector3((x0 - data.ox) * q, h0, -(y1 - data.oy) * q), new Vector3((x1 - data.ox) * q, h1, -(y0 - data.oy) * q));
  // DO NOT take the sphere's radius in the mesh's axes: three scales it by the largest scale of the mesh (1 while q >= 1), so it is given in metres over that.
  const radius = Math.hypot(x1 - x0, y1 - y0, h1 - h0) / 2;
  g.boundingSphere = new Sphere(new Vector3(((x0 + x1) / 2 - data.ox) * q, (h0 + h1) / 2, -((y0 + y1) / 2 - data.oy) * q), radius / Math.max(1, 1 / q));
  const mesh = new Mesh(g, material);
  mesh.name = 'roads-far';
  mesh.position.set(data.ox, 0, -data.oy);
  mesh.scale.set(1 / q, 1, 1 / q);
  mesh.matrixAutoUpdate = false;
  mesh.updateMatrix();
  // Flat on the ground: it casts nothing, it takes the buildings' shadows as the near streets do.
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  gpuOnly(mesh, () => ({}));
  return { mesh, x0, y0, x1, y1, top: h1, error: data.error };
}

/** A tree's job as the far roads' job: the tile the page read (the desktop's store) cut to its roads (`tileRoads`), its buildings never posted; the store's map kept for the worker to read the tile itself. */
export function farRoadJob(tree: FarTreeJob): FarRoadJob {
  // The plan goes with it: a node no tile was made under is baked from it (`farRoadTiles.ts` bakePlanRoads).
  const { records, ...job } = tree;
  return records ? { ...job, records: tileRoads(records) } : job;
}

/** DO NOT bake on the page: the far jobs go to the job system's queue (`farRoads` service), the page only when no worker can run (tests) */
function farRoadsRunner(ground: () => SharedGroundData | null): FarTreeRun<FarRoadMesh> {
  return (tree, done) => {
    const job = farRoadJob(tree);
    if (!canQueueJobs()) {
      let live = true;
      void runFarRoadJob({ ...job, ground: ground() }, derivedRoadCache).then(
        (reply) => { if (live) done(reply); },
        (error: unknown) => { if (live) done({ kind: 'farError', node: job.node, sig: job.sig, message: String(error) }); },
      );
      return () => { live = false; };
    }
    const side = nodeSide(job.k);
    const ticket = submitJob({
      service: 'farRoads',
      key: `farRoads:${job.node}`,
      priority: FAR_TIER * TIER_SPAN + focusDistance((job.i + 0.5) * side, (job.j + 0.5) * side),
      write: () => ({ data: { ...job, ground: ground() }, transfer: [] }),
      done: (answer) => done(answer as FarRoadReply),
      failed: (message) => done({ kind: 'farError', node: job.node, sig: job.sig, message }),
    });
    return () => ticket.cancel();
  };
}

/** THE FAR ROADS: the tree of their levels, with the material its meshes share */
export class FarRoads extends FarTree<FarRoadMesh> {
  private readonly material: MeshStandardMaterial;
  private readonly standIn: Mesh;

  /** `ground`: the ground shared with the workers (null: flat at 0); `run`, `prefix`: where the jobs go and the bakes are kept (tests give their own). */
  constructor(ground: () => SharedGroundData | null, run?: FarTreeRun<FarRoadMesh>, prefix: string | null = FAR_PREFIX) {
    const material = createFarRoadMaterial();
    // Drawn from the plan where no tile was made, down to a tile (`farRoadTiles.ts` bakePlanRoads): the roads go on past the tiles made, as the buildings do (`farPlan.ts`).
    const kind: FarKind<FarRoadMesh> = { name: 'roads', land: (data) => farRoadMesh(data, material), levelError: farLevelError, planFrom: 0 };
    super(kind, run ?? farRoadsRunner(ground), prefix, canQueueJobs() ? jobWorkers() : 1);
    this.material = material;
    // The bakes of an older build of this code: let go.
    if (prefix !== null && prefix === FAR_PREFIX && FAR_HASH) forgetOtherDerived('farRoads', FAR_HASH);
    // Its program among the world's, compiled before the town is shown (`shaderCatalogue.ts` walks the scene, the hidden too): a stand-in never drawn.
    const standIn = new Group();
    standIn.name = 'roads-far-program';
    standIn.visible = false;
    const one = new Mesh(farGeometry({
      xz: new Int16Array(6), height: new Float32Array(3), normal: new Int8Array([0, 127, 0, 0, 0, 127, 0, 0, 0, 127, 0, 0]),
      color: new Uint8Array(12).fill(255), index: new Uint16Array([0, 1, 2]),
    }), material);
    one.receiveShadow = true;
    one.frustumCulled = false;
    standIn.add(one);
    this.group.add(standIn);
    this.standIn = one;
  }

  override dispose(): void {
    super.dispose();
    this.standIn.geometry.dispose();
    this.material.dispose();
  }
}
