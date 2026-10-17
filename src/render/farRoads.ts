import { Box3, BufferAttribute, BufferGeometry, FrontSide, Group, type Material, Mesh, MeshStandardMaterial, Sphere, Vector3 } from 'three';
import type { Building } from '@world/buildings/types';
import { gatesOf } from '@world/parkingLayout';
import { canQueueJobs, focusDistance, jobWorkers, submitJob } from '../jobs/jobPool';
import { forgetOtherDerived } from './derivedCache';
import { pullTowardEye } from './depthConvention';
import { type FarRoadJob, type FarRoadMesh, type FarRoadReply, derivedRoadCache, farLevelError, runFarRoadJob, tileRoads } from './farRoadTiles';
import { type FarKind, type FarLanded, type FarNearLanded, FarTree, type FarTreeJob, type FarTreeRun } from './farTree';
import { nodeSide } from './buildings/farTiles';
import { FAR_TIER, NEAR_TIER, TIER_SPAN } from './buildings/cellPool';
import { FAR_ERROR } from './buildings/massCells';
import { geometryCost } from './gpuLedger';
import { gpuOnly } from './mesh/gpuOnly';
import { readsRoadSection } from './mesh/roadEdges';
import { finish } from './mesh/surfaceMesh';
import type { NearRoadMesh, NearTileRoads } from './nearRoadTiles';
import type { PassLook } from './roadSurfacePass';
import type { TileSource } from './roadTileShape';
import type { SharedGroundData } from './sharedGround';

/** What a node of the roads' tree carries: a far level's mesh, or a tile's near level (`nearRoadTiles.ts`). */
export type RoadPayload = FarRoadMesh | NearRoadMesh;

/** THE ROADS OF THE TILES NOT IN THE PAGE'S DOCUMENT (CLAUDE.md "Streaming world"): baked per tile in workers from the tile store (`farRoadTiles.ts`), chosen as a quadtree (`farTree.ts`), drawn with one material */

declare const __FAR_ROADS_HASH__: string | undefined;
/** The fingerprint of the code the far roads are baked by (`cook-plugin.ts`): bakes are kept under it; none (tests): nothing kept. */
const FAR_HASH = typeof __FAR_ROADS_HASH__ !== 'undefined' && __FAR_ROADS_HASH__ ? __FAR_ROADS_HASH__ : null;
const FAR_PREFIX = FAR_HASH ? `farRoads:${FAR_HASH}:` : null;

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

/** What the roads' near level reads of the page (`renderer.ts`): the roads' look and paint as the region draws them, each surface's material, the ground's flag. */
export interface NearRoadKit {
  look(): PassLook;
  markingStyle(): string;
  naturalIsGround(): boolean;
  /** A surface's material, shadow and order (`roadSurfaces.ts` surfaceLook). */
  dress(source: TileSource, raised: boolean): { readonly material: Material; readonly castShadow?: boolean; readonly renderOrder?: number };
}

/** A tile the page read, as a near bake reads it: its roads, and its buildings' gates (worked out here for one written before they were kept). */
const nearRoadsOf = (records: FarTreeJob['records'] & object): NearTileRoads => ({
  ...tileRoads(records), gates: records.gates ?? gatesOf(records.buildings as readonly Building[]),
});

/** A tree's job as the far roads' job: the tile the page read (the desktop's store) cut to its roads (`tileRoads`), its buildings never posted; the store's map kept for the worker to read the tile itself; a near level's with the page's look of the roads and the ground (`kit`). */
export function farRoadJob(tree: FarTreeJob, kit?: NearRoadKit | null, ground: SharedGroundData | null = null): FarRoadJob {
  const { records, near, ...job } = tree;
  if (near) {
    if (!kit) throw new Error('a near level asked of roads with no near kit');
    return {
      ...job,
      near: {
        look: kit.look(), markingStyle: kit.markingStyle(), ground, naturalIsGround: kit.naturalIsGround(), tiles: near.tiles,
        ...(near.records ? { records: near.records.map(nearRoadsOf) } : {}),
      },
    };
  }
  return records ? { ...job, records: tileRoads(records) } : job;
}

/** DO NOT bake on the page: the far jobs go to the job system's queue (`farRoads` service), the page only when no worker can run (tests) */
function farRoadsRunner(ground: () => SharedGroundData | null, kit: NearRoadKit | null): FarTreeRun<RoadPayload> {
  return (tree, done) => {
    const answered = (reply: FarRoadReply): void => done(reply);
    if (!canQueueJobs()) {
      const job = farRoadJob(tree, kit, ground());
      let live = true;
      void runFarRoadJob({ ...job, ground: ground() }, derivedRoadCache).then(
        (reply) => { if (live) answered(reply); },
        (error: unknown) => { if (live) done({ kind: 'farError', node: job.node, sig: job.sig, message: String(error) }); },
      );
      return () => { live = false; };
    }
    const side = nodeSide(Math.max(0, tree.k));
    const near = tree.near !== undefined;
    const ticket = submitJob({
      service: 'farRoads',
      key: `farRoads:${tree.node}`,
      // A near level with the cells' detail, after every far level (`cellPool.ts` NEAR_TIER).
      priority: (near ? NEAR_TIER : FAR_TIER) * TIER_SPAN + focusDistance((tree.i + 0.5) * side, (tree.j + 0.5) * side),
      write: () => ({ data: { ...farRoadJob(tree, kit, ground()), ground: ground() }, transfer: [] }),
      done: (answer) => answered(answer as FarRoadReply),
      failed: (message) => done({ kind: 'farError', node: tree.node, sig: tree.sig, message }),
    });
    return () => ticket.cancel();
  };
}

/** Each vertex's place in no road's section (`tileMesh.ts`: a surface without one). */
function noSection(vertices: number): Float32Array {
  const out = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) out[v * 3 + 1] = -1;
  return out;
}

/** A TILE'S NEAR ROADS AS THE PAGE DRAWS THEM: a mesh per surface, with the material, shadow and order the region gives it (`kit.dress`), the attributes its material reads alone (`surfaceTiles.ts` readsOf), bounded by its box; its arrays let go once on the GPU */
function nearRoadGroup(data: NearRoadMesh, kit: NearRoadKit): FarNearLanded {
  const group = new Group();
  group.name = 'roads-near';
  group.matrixAutoUpdate = false;
  const meshes: Mesh[] = [];
  let bytes = 0;
  for (const s of data.surfaces) {
    const look = kit.dress(s.source, s.raised);
    const vertices = s.position.length / 3;
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(s.position, 3));
    g.setAttribute('normal', new BufferAttribute(s.normal, 3));
    g.setAttribute('uv', new BufferAttribute(s.uv, 2));
    if (look.material.vertexColors) g.setAttribute('color', new BufferAttribute(s.color ?? new Float32Array(vertices * 3).fill(1), 3));
    if (readsRoadSection(look.material)) g.setAttribute('roadSection', new BufferAttribute(s.section ?? noSection(vertices), 3));
    g.setIndex(new BufferAttribute(s.index, 1));
    g.boundingBox = new Box3(new Vector3(s.box[0], s.box[1], s.box[2]), new Vector3(s.box[3], s.box[4], s.box[5]));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new Sphere());
    const mesh = finish(g, { name: s.name, material: look.material, castShadow: look.castShadow ?? false, receiveShadow: true });
    if (look.renderOrder !== undefined) mesh.renderOrder = look.renderOrder;
    bytes += geometryCost(g).bytes;
    // Made again from the store when a lost context asks (the tree's `refill`).
    gpuOnly(mesh, () => ({}));
    group.add(mesh);
    meshes.push(mesh);
  }
  return {
    group, meshes, bytes, triangles: data.triangles, top: data.bounds[5]!,
    dispose() { for (const mesh of meshes) mesh.geometry.dispose(); },
  };
}

/** THE FAR ROADS: the tree of their levels, with the material its meshes share */
export class FarRoads extends FarTree<RoadPayload> {
  private readonly material: MeshStandardMaterial;
  private readonly standIn: Mesh;

  /** `ground`: the ground shared with the workers (null: flat at 0); `run`, `prefix`: where the jobs go and the bakes are kept (tests give their own); `near`: the page's look of the roads, for each tile's near level where the view wants its detail (none: the far levels alone). */
  constructor(ground: () => SharedGroundData | null, run?: FarTreeRun<RoadPayload>, prefix: string | null = FAR_PREFIX, near: NearRoadKit | null = null) {
    const material = createFarRoadMaterial();
    const kind: FarKind<RoadPayload> = {
      name: 'roads', land: (data) => farRoadMesh(data as FarRoadMesh, material), levelError: farLevelError,
      // Where the buildings' cells come near (`massCells.ts` FAR_ERROR): the roads under them with their own detail.
      ...(near ? { near: { error: FAR_ERROR, land: (data: RoadPayload) => nearRoadGroup(data as NearRoadMesh, near), version: () => near.markingStyle() } } : {}),
    };
    super(kind, run ?? farRoadsRunner(ground, near), prefix, canQueueJobs() ? jobWorkers() : 1);
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
