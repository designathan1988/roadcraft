import {
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Object3D,
  Sphere,
  Vector3,
  Group,
  type BufferGeometry,
  type Color,
  type Frustum,
  type Material,
  type MeshDepthMaterial,
} from 'three';
import { Rng } from '@core/rng';
import { m } from '@world/units';
import { BUSH_KINDS, TREE_SPECIES, trianglesOf, type BushKind, type TreeSpecies } from './propGeometry';
import { SHADOW_REACH, foliageTint, type Scenery, type SceneryKit } from './scenery';

/**
 * THE BUILDINGS' GARDENS, KEPT BUILDING BY BUILDING: the trees, shrubs,
 * hedges and flowers of every building's garden, drawn with the scenery's
 * own plants (instanced, swaying, culled to the view).
 *
 * Each plant kind is one store of instances - one mesh, one draw - in which
 * every building's garden holds a run of slots. A building grown appends its
 * run; one changed or gone leaves its run dead (never drawn) until half the
 * store is dead and it is packed again. The whole town's gardens were built
 * again from every building's plants at each building grown: 36 s of the 64
 * a city of 2 560 m spent growing from 10 000 buildings on (2026-10-14),
 * and the city slowed to four buildings a second. Fixed capacity and a live
 * count, a new mesh only to grow (threejs.org InstancedMesh; three's GPU
 * buffer is made at the array's size, `WebGLAttributes.createBuffer`).
 * NÃO voltar a reconstruir os jardins da cidade inteira a cada prédio.
 */

/** A plant of a building's garden, in the world: a tree, a shrub, a run of hedge or a flower bed. */
export interface GardenPlant {
  readonly kind: 'tree' | 'shrub' | 'hedge' | 'flowers';
  readonly x: number;
  readonly y: number;
  /** Ground height under it. */
  readonly z: number;
  /** Size, world units: along (w), across (d) and height (h); `yaw` the way `w` runs. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly yaw: number;
  readonly seed: number;
  /** A tree's species, when it is not a garden's mix (a painted forest's). */
  readonly species?: TreeSpecies;
  /** A shrub that never flowers (a wood's understorey). */
  readonly plain?: boolean;
}

interface Placement { x: number; y: number; z: number; yaw: number; sx: number; sy: number; sz: number; tint?: Color }

/** A garden tree's species: mostly broadleaf, some conifers, now and then a flowering ipê. */
function gardenSpecies(roll: number): TreeSpecies {
  if (roll < 0.42) return 'broadleaf';
  if (roll < 0.62) return 'broadleafTall';
  if (roll < 0.8) return 'conifer';
  return roll < 0.9 ? 'ipeYellow' : 'ipePink';
}

/** One building's garden placed, per plant kind: its instances' matrices, tints and largest scale. */
interface GardenPack {
  readonly matrices: Float32Array;
  /** Tints, white where a plant has none; null when none has one. */
  readonly colours: Float32Array | null;
  readonly scales: Float32Array;
  readonly count: number;
}

/** One garden's plants placed, by plant kind (`tree:<species>`, `bush:<kind>`). */
function gardenPack(list: readonly GardenPlant[]): ReadonlyMap<string, GardenPack> {
  const trees = new Map<TreeSpecies, Placement[]>(TREE_SPECIES.map((s) => [s, []]));
  const bushes = new Map<BushKind, Placement[]>(BUSH_KINDS.map((k) => [k, []]));
  for (const p of list) {
    const rng = new Rng(Math.floor(p.seed * 0xffffff) ^ 0x5eed);
    switch (p.kind) {
      case 'tree': {
        const spread = 0.82 + rng.float() * 0.3;
        const roll = rng.float();
        (trees.get(p.species ?? gardenSpecies(roll)) as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: p.h * spread, sy: p.h, sz: p.h * spread * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'shrub': {
        // The geometry is about 1.5 across for 1 tall, kept in the bush's own
        // proportions: it fills the slot's width and stands no taller than a
        // bush that wide, a little under the slot (the leaf cards reach past
        // the crown, and a bush by a wall must not show through it).
        const across = (Math.min(p.w, p.d) / 1.5) * 0.8;
        const tall = Math.min(p.h, across * 1.3);
        const wide = Math.max(across, tall / 1.3);
        (bushes.get(!p.plain && rng.float() < 0.25 ? 'bushFlowering' : 'bush') as Placement[]).push({
          x: p.x, y: p.y, z: p.z - m(0.05), yaw: rng.float() * Math.PI * 2,
          sx: wide, sy: tall, sz: wide * (0.9 + rng.float() * 0.2), tint: foliageTint(rng),
        });
        break;
      }
      case 'hedge': {
        // Clipped pieces along its run, overlapping so it reads as one.
        const n = Math.max(1, Math.round(p.w / Math.max(m(2.2), p.h * 1.5)));
        const step = p.w / n;
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        const tint = foliageTint(rng);
        for (let i = 0; i < n; i++) {
          const t = (i + 0.5) * step - p.w / 2;
          (bushes.get('hedge') as Placement[]).push({
            x: p.x + cx * t, y: p.y + cy * t, z: p.z - m(0.05), yaw: p.yaw,
            sx: (step / 1.9) * 1.25, sy: p.h, sz: p.d / 0.9, tint,
          });
        }
        break;
      }
      case 'flowers': {
        // A bed of low flowering clumps.
        const n = Math.max(2, Math.round((p.w * p.d) / (m(0.7) * m(0.7))));
        const cx = Math.cos(p.yaw), cy = Math.sin(p.yaw);
        for (let i = 0; i < Math.min(n, 24); i++) {
          const u = (rng.float() - 0.5) * p.w * 0.85, v = (rng.float() - 0.5) * p.d * 0.85;
          const h = m(0.35) + rng.float() * m(0.25);
          (bushes.get('bushFlowering') as Placement[]).push({
            x: p.x + cx * u - cy * v, y: p.y + cy * u + cx * v, z: p.z + m(0.12), yaw: rng.float() * Math.PI * 2,
            sx: h * 1.1, sy: h, sz: h * 1.1,
          });
        }
        break;
      }
    }
  }
  const out = new Map<string, GardenPack>();
  const object = new Object3D();
  const pack = (key: string, placed: readonly Placement[]): void => {
    if (!placed.length) return;
    const matrices = new Float32Array(placed.length * 16);
    const scales = new Float32Array(placed.length);
    let colours: Float32Array | null = null;
    placed.forEach((placement, index) => {
      object.position.set(placement.x, placement.z, -placement.y);
      object.rotation.set(0, placement.yaw, 0);
      object.scale.set(placement.sx, placement.sy, placement.sz);
      object.updateMatrix();
      object.matrix.toArray(matrices, index * 16);
      scales[index] = Math.max(placement.sx, placement.sy, placement.sz);
      if (placement.tint) {
        colours ??= new Float32Array(placed.length * 3).fill(1);
        placement.tint.toArray(colours, index * 3);
      }
    });
    out.set(key, { matrices, colours, scales, count: placed.length });
  };
  for (const [species, placed] of trees) pack(`tree:${species}`, placed);
  for (const [kind, placed] of bushes) pack(`bush:${kind}`, placed);
  return out;
}

type Bounds = { x: number; y: number; z: number; r: number };

/** The smallest sphere round two spheres. */
function enclose(a: Bounds | null, b: Bounds): Bounds {
  if (!a || a.r < 0) return b;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, d = Math.hypot(dx, dy, dz);
  if (d + b.r <= a.r) return a;
  if (d + a.r <= b.r) return b;
  const r = (d + a.r + b.r) / 2, k = d > 0 ? (r - a.r) / d : 0;
  return { x: a.x + dx * k, y: a.y + dy * k, z: a.z + dz * k, r };
}

/** One plant kind's instances: every garden's run of slots, the dead ones with a radius of -Infinity. */
interface Store {
  readonly key: string;
  readonly name: string;
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly depth: MeshDepthMaterial | undefined;
  /** The foliage cards: they throw no shadow (`plantMeshes`). */
  readonly cards: boolean;
  readonly centre: Vector3;
  readonly reach: number;
  mesh: InstancedMesh | null;
  capacity: number;
  used: number;
  dead: number;
  matrices: Float32Array;
  colours: Float32Array;
  /** Per slot: centre x, y, z and radius, in the scene's frame. */
  spheres: Float32Array;
  bounds: Bounds | null;
  runs: Map<readonly GardenPlant[], { start: number; count: number }>;
}

/** The smallest store worth a mesh. */
const MIN_CAPACITY = 64;

export interface Gardens extends Scenery {
  /**
   * The gardens of the buildings' lists, in the town's order: a list the same
   * object as before keeps its slots; the meshes taken out of the scene and
   * put in (a store grown past its room is a new mesh).
   */
  update(groups: readonly (readonly GardenPlant[])[]): { readonly removed: readonly InstancedMesh[]; readonly added: readonly InstancedMesh[] };
}

export function createGardens(kit: SceneryKit): Gardens {
  const packs = new WeakMap<readonly GardenPlant[], ReadonlyMap<string, GardenPack>>();
  const packOf = (list: readonly GardenPlant[]): ReadonlyMap<string, GardenPack> => {
    let known = packs.get(list);
    if (!known) packs.set(list, known = gardenPack(list));
    return known;
  };
  const stores: Store[] = [];
  const store = (key: string, name: string, geometry: BufferGeometry, material: Material, depth: MeshDepthMaterial | undefined, cards: boolean): void => {
    // The kit's models have their spheres (`createSceneryKit`).
    const sphere = geometry.boundingSphere;
    stores.push({
      key, name, geometry, material, depth, cards,
      centre: sphere?.center.clone() ?? new Vector3(), reach: sphere?.radius ?? 1,
      mesh: null, capacity: 0, used: 0, dead: 0,
      matrices: new Float32Array(0), colours: new Float32Array(0), spheres: new Float32Array(0), bounds: null, runs: new Map(),
    });
  };
  // The same meshes, in the same order, as the scenery's plants (`plantMeshes`).
  for (const species of TREE_SPECIES) {
    store(`tree:${species}`, `garden-trees-${species}`, kit.trees[species], kit.foliage, kit.foliageDepth, false);
    const cards = kit.cards[species];
    if (cards) store(`tree:${species}`, `garden-trees-${species}-cards`, cards, kit.treeCards, kit.treeCardsDepth, true);
  }
  for (const kind of BUSH_KINDS) {
    store(`bush:${kind}`, `garden-bushes-${kind}`, kit.bushes[kind], kit.shrubs, kit.shrubsDepth, false);
    const cards = kit.cards[kind];
    if (cards) store(`bush:${kind}`, `garden-bushes-${kind}-cards`, cards, kit.shrubCards, kit.shrubCardsDepth, true);
  }

  const newMesh = (s: Store): InstancedMesh => {
    const mesh = new InstancedMesh(s.geometry, s.material, s.capacity);
    mesh.name = s.name;
    mesh.castShadow = !s.cards;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    if (s.depth) mesh.customDepthMaterial = s.depth;
    // Every store tinted, white where a plant has none: one program variant for the shared materials.
    mesh.instanceColor = new InstancedBufferAttribute(new Float32Array(s.capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    return mesh;
  };
  /** The store's arrays sized for `capacity`, its live slots in `order` from slot 0. */
  const repack = (s: Store, capacity: number, order: readonly (readonly GardenPlant[])[] | null): void => {
    const matrices = new Float32Array(capacity * 16), colours = new Float32Array(capacity * 3).fill(1), spheres = new Float32Array(capacity * 4);
    if (order) {
      const runs = new Map<readonly GardenPlant[], { start: number; count: number }>();
      let at = 0;
      for (const list of order) {
        const run = s.runs.get(list);
        if (!run) continue;
        matrices.set(s.matrices.subarray(run.start * 16, (run.start + run.count) * 16), at * 16);
        colours.set(s.colours.subarray(run.start * 3, (run.start + run.count) * 3), at * 3);
        spheres.set(s.spheres.subarray(run.start * 4, (run.start + run.count) * 4), at * 4);
        runs.set(list, { start: at, count: run.count });
        at += run.count;
      }
      s.runs = runs;
      s.used = at;
      s.dead = 0;
      s.bounds = null;
      for (let i = 0; i < at; i++) s.bounds = enclose(s.bounds, { x: spheres[i * 4]!, y: spheres[i * 4 + 1]!, z: spheres[i * 4 + 2]!, r: spheres[i * 4 + 3]! });
    } else {
      matrices.set(s.matrices.subarray(0, s.used * 16));
      colours.set(s.colours.subarray(0, s.used * 3));
      spheres.set(s.spheres.subarray(0, s.used * 4));
    }
    s.matrices = matrices; s.colours = colours; s.spheres = spheres; s.capacity = capacity;
  };
  const point = new Vector3(), matrix = new Matrix4();
  const append = (s: Store, list: readonly GardenPlant[], one: GardenPack): void => {
    const start = s.used;
    s.matrices.set(one.matrices, start * 16);
    if (one.colours) s.colours.set(one.colours, start * 3);
    else s.colours.fill(1, start * 3, (start + one.count) * 3);
    let bounds: Bounds | null = null;
    for (let i = 0; i < one.count; i++) {
      matrix.fromArray(one.matrices, i * 16);
      point.copy(s.centre).applyMatrix4(matrix);
      const at = (start + i) * 4, r = s.reach * one.scales[i]!;
      s.spheres[at] = point.x; s.spheres[at + 1] = point.y; s.spheres[at + 2] = point.z; s.spheres[at + 3] = r;
      bounds = enclose(bounds, { x: point.x, y: point.y, z: point.z, r });
    }
    if (bounds) s.bounds = enclose(s.bounds, bounds);
    s.runs.set(list, { start, count: one.count });
    s.used += one.count;
  };

  /** The gardens placed, as the last `update` had them. */
  let placed = new Set<readonly GardenPlant[]>();
  let culledFor: Matrix4 | null = null;
  const probe = new Sphere();
  const live = (): InstancedMesh[] => stores.flatMap((s) => (s.mesh ? [s.mesh] : []));
  return {
    get meshes() { return live(); },
    grass: new Group(),
    get triangles() {
      let n = 0;
      for (const s of stores) if (s.mesh) n += trianglesOf(s.geometry) * (s.used - s.dead);
      return n;
    },
    update(groups) {
      const removed: InstancedMesh[] = [], added: InstancedMesh[] = [];
      const now = new Set(groups);
      // Only the gardens that came and went are read: the town's list is walked once.
      const gone = [...placed].filter((list) => !now.has(list));
      const fresh = groups.filter((list) => !placed.has(list));
      placed = now;
      for (const s of stores) {
        // A garden changed or gone: its run is never drawn again.
        for (const list of gone) {
          const run = s.runs.get(list);
          if (!run) continue;
          for (let i = run.start; i < run.start + run.count; i++) s.spheres[i * 4 + 3] = -Infinity;
          s.dead += run.count;
          s.runs.delete(list);
        }
        let coming = 0;
        for (const list of fresh) coming += packOf(list).get(s.key)?.count ?? 0;
        const was = s.mesh;
        if (s.dead > 0 && s.dead * 2 >= s.used + coming) {
          // Half the store dead: packed again in the town's order, the new ones after.
          repack(s, Math.max(s.capacity, MIN_CAPACITY), groups);
        }
        if (s.used + coming > s.capacity) {
          repack(s, Math.max(MIN_CAPACITY, (s.used + coming) * 2), null);
          s.mesh = null;
        }
        for (const list of fresh) {
          const one = packOf(list).get(s.key);
          if (one) append(s, list, one);
        }
        if (!s.mesh && s.capacity > 0) s.mesh = newMesh(s);
        if (s.mesh && s.bounds) s.mesh.boundingSphere = new Sphere(new Vector3(s.bounds.x, s.bounds.y, s.bounds.z), s.bounds.r);
        if (was !== s.mesh) {
          if (was) { removed.push(was); was.dispose(); }
          if (s.mesh) added.push(s.mesh);
        }
      }
      culledFor = null;
      return { removed, added };
    },
    // A garden plant has one model at every zoom.
    setNear() {},
    setMap() { culledFor = null; },
    cull(frustum: Frustum, view: Matrix4) {
      if (culledFor && culledFor.equals(view)) return;
      culledFor = (culledFor ?? new Matrix4()).copy(view);
      for (const s of stores) {
        const mesh = s.mesh;
        if (!mesh) continue;
        const target = mesh.instanceMatrix.array as Float32Array;
        const tints = mesh.instanceColor!.array as Float32Array;
        let n = 0;
        // The whole store, before its plants one by one (`scenery.ts` `cullInstances`).
        const whole = s.bounds;
        if (whole) {
          probe.center.set(whole.x, whole.y, whole.z);
          probe.radius = whole.r + SHADOW_REACH;
        }
        if (whole && frustum.intersectsSphere(probe)) {
          const sp = s.spheres;
          for (let i = 0; i < s.used; i++) {
            const r = sp[i * 4 + 3]!;
            if (r === -Infinity) continue;
            probe.center.set(sp[i * 4]!, sp[i * 4 + 1]!, sp[i * 4 + 2]!);
            probe.radius = r + SHADOW_REACH;
            if (!frustum.intersectsSphere(probe)) continue;
            for (let j = 0; j < 16; j++) target[n * 16 + j] = s.matrices[i * 16 + j]!;
            tints[n * 3] = s.colours[i * 3]!; tints[n * 3 + 1] = s.colours[i * 3 + 1]!; tints[n * 3 + 2] = s.colours[i * 3 + 2]!;
            n++;
          }
        }
        if (n === 0 && mesh.count === 0) continue;
        mesh.count = n;
        mesh.instanceMatrix.clearUpdateRanges();
        if (n > 0) mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor!.clearUpdateRanges();
        if (n > 0) mesh.instanceColor!.addUpdateRange(0, n * 3);
        mesh.instanceColor!.needsUpdate = true;
      }
    },
    exclude() { /* a garden's plants are the building's own */ },
    dispose() {
      for (const s of stores) s.mesh?.dispose();
    },
  };
}

/** The gardens of these lists, made at once (`createGardens` and one `update`). */
export function buildGardens(groups: readonly (readonly GardenPlant[])[], kit: SceneryKit): Gardens {
  const gardens = createGardens(kit);
  gardens.update(groups);
  return gardens;
}
