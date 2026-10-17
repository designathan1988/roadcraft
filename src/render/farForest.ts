import {
  Box3,
  BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshStandardMaterial,
  Sphere,
  Vector3,
  Vector4,
  type WebGLRenderer,
} from 'three';
import type { NatureSettings } from '@world/ecology';
import type { ReliefVersion } from '@world/terrain';
import { takeWaitingPictures } from './plantImpostors';
import { natureTreePictures } from './natureTrees';
import { FAR_WOODS_BUDGET, woodsScale, type FarWoods, type FarWoodsAsk, type FarWoodsGrid } from './farWoods';
import { IMPOSTOR_FRAGMENT_MAP, IMPOSTOR_FRAGMENT_NORMAL, IMPOSTOR_VERTEX, IMPOSTOR_VERTEX_PARS, IMPOSTOR_FRAGMENT_PARS } from './impostorShaders';
import { gpuOnlyAttributes } from './mesh/gpuOnly';
import { programsOf, programsWaited } from './programsFirst';

/** DO NOT go back to one mesh of the map: its 102,400 instances */

/** Most trees a plate draws: its budget at the map's scale with room (`farWoods.ts` HEADROOM). */
const SLOT = 4_096;
/** How long after a plate's own trees could grow its far ones start to go, and how long they take, seconds. */
const NEAR_GROWS = 0.7;
const DISSOLVE = 0.6;
/** Under this share of the screen's height a tree's wood thins (about 6 px at 1080) */
const THIN_SHARE = 0.006;
const THIN_LEAST = 0.3;

export interface FarForestStats {
  /** Plates whose woods were asked of the worker, and how many times (each land and ecosystem once). */
  readonly asks: number;
  /** Plates whose woods are in, and the trees in them. */
  readonly ready: number;
  readonly trees: number;
  /** Plates drawing their far trees now (fade above 0). */
  readonly drawn: number;
}

/** Asks the worker for a plate's woods (`ecologyPool.ts` readFarWoods): injected, so a spec counts the asks. */
export type FarWoodsReader = (key: number, ask: FarWoodsAsk, done: (woods: FarWoods) => void, failed: () => void) => void;

interface PlateState {
  /** The plate's key (`world/bounds.ts`) and its slot among the far plates (its fade's place in the shader). */
  readonly key: number;
  readonly slot: number;
  readonly cx: number;
  readonly cy: number;
  /** What its woods were asked for (land and ecosystem); empty when not asked. */
  asked: string;
  woods: FarWoods | null;
  /** Its woods' scale (`woodsScale` of its own density and the quality's budget), fixed when they came: another plate coming changes none of it. */
  scale: number;
  /** Drawn in full, and since when its own trees could grow (its ecosystem is in), seconds; NaN while not. */
  full: boolean;
  nearSince: number;
  fade: number;
}

/** The far woods' bookkeeping, no `three`: which plates' woods to ask, which are in, each plate's fade */
export class FarWoodsBook {
  /** The far plates there are now, by key (`add`, `drop`): those round the view, never a list of the world's. */
  readonly plates = new Map<number, PlateState>();
  private landKey = '';
  private asks = 0;
  private land: { relief: ReliefVersion; nature: NatureSettings | null } | null = null;
  /** The keys of the plates whose woods came in (or went with the land): the instances to write. */
  arrived: number[] = [];
  /** The keys of the plates let go: their meshes to drop. */
  gone: number[] = [];
  /** The trees per 1920 m square the quality tier allows (`setVegetation`). */
  private budget = FAR_WOODS_BUDGET;

  constructor(private readonly grid: FarWoodsGrid, private readonly read: FarWoodsReader) {}

  /** A far plate come into the view's ring, in `slot`: its woods asked once the land is known. */
  add(key: number, slot: number, cx: number, cy: number): void {
    if (this.plates.has(key)) return;
    const p: PlateState = { key, slot, cx, cy, asked: '', woods: null, scale: 1, full: false, nearSince: NaN, fade: 1 };
    this.plates.set(key, p);
    this.ask(p);
  }

  /** A far plate gone out of the ring: its woods let go (asked again if it comes back). */
  drop(key: number): void {
    const p = this.plates.get(key);
    if (!p) return;
    // An answer still on its way finds the plate gone.
    p.asked = '';
    this.plates.delete(key);
    this.arrived = this.arrived.filter((k) => k !== key);
    this.gone.push(key);
  }

  /** The land and the ecosystem: when either changed, every far plate's woods asked again (in the background, the nearest first). */
  sync(relief: ReliefVersion, nature: NatureSettings | null, focusX: number, focusY: number): void {
    const key = nature ? `${relief}:${nature.region}:${nature.seed}` : '';
    if (key === this.landKey) return;
    this.landKey = key;
    this.land = { relief, nature };
    for (const p of this.plates.values()) { p.woods = null; p.asked = ''; }
    this.arrived = [...this.plates.keys()];
    const order = [...this.plates.values()].sort((a, b) => Math.hypot(a.cx - focusX, a.cy - focusY) - Math.hypot(b.cx - focusX, b.cy - focusY));
    for (const p of order) this.ask(p);
  }

  /** Asks plate `p`'s woods of the worker for the land known, once. */
  private ask(p: PlateState): void {
    const land = this.land;
    if (!land?.nature || p.asked === this.landKey) return;
    const key = this.landKey;
    p.asked = key;
    this.asks++;
    this.read(p.key, { relief: land.relief, nature: land.nature, cx: p.cx, cy: p.cy, grid: this.grid }, (woods) => {
      if (p.asked !== key || this.plates.get(p.key) !== p) return;
      p.woods = woods;
      p.scale = this.scaleOf(woods);
      this.arrived.push(p.key);
    }, () => {
      console.warn('[nature] the far woods of a plate could not be worked out; it stands bare from afar', p.key);
    });
  }

  /** A plate's woods' scale: the budget over its own density. DO NOT take it over the plates present: a plate coming in moved every plate's (the density seen changed as the camera went). */
  private scaleOf(woods: FarWoods): number {
    return this.budget === 0 ? 0 : woodsScale(woods.planned, this.grid.half, this.budget);
  }

  /** The vegetation the quality tier allows, as the near sweep reads it */
  setVegetation(amount: number): void {
    const budget = FAR_WOODS_BUDGET * Math.min(1, Math.max(0, amount) / 2_600);
    if (budget === this.budget) return;
    this.budget = budget;
    // Every plate's scale again, its instances written again (`arrived`).
    for (const p of this.plates.values()) {
      if (!p.woods) continue;
      p.scale = this.scaleOf(p.woods);
      if (!this.arrived.includes(p.key)) this.arrived.push(p.key);
    }
  }

  /** Whether plate `key` is drawn in full, and whether its own ecosystem is in (its near trees can grow); a plate not in the ring has no far woods to fade. */
  setFull(key: number, full: boolean, nearReady: boolean, now: number): void {
    const p = this.plates.get(key);
    if (!p) return;
    p.full = full;
    if (!full || !nearReady) p.nearSince = NaN;
    else if (Number.isNaN(p.nearSince)) p.nearSince = now;
  }

  /** Moves the fades to `now`, seconds; true when any changed. */
  step(now: number): boolean {
    let moved = false;
    for (const p of this.plates.values()) {
      const next = !p.full || Number.isNaN(p.nearSince) ? 1 : 1 - Math.min(1, Math.max(0, (now - p.nearSince - NEAR_GROWS) / DISSOLVE));
      if (next !== p.fade) { p.fade = next; moved = true; }
    }
    return moved;
  }

  get stats(): FarForestStats {
    let ready = 0, trees = 0, drawn = 0;
    for (const p of this.plates.values()) {
      if (p.woods) { ready++; trees += Math.min(SLOT, p.woods.count); }
      if (p.woods && p.fade > 0) drawn++;
    }
    return { asks: this.asks, ready, trees, drawn };
  }

  get landOf(): { relief: ReliefVersion; nature: NatureSettings | null } | null {
    return this.land;
  }
}

export interface FarForest {
  /** The far woods' mesh, added to the atlas' group. */
  readonly object: Group;
  readonly book: FarWoodsBook;
  /** Each frame: the pictures taken once, the instances of plates come in written, the fades moved. */
  update(renderer: WebGLRenderer, now: number): void;
  dispose(): void;
}

/** `slots`: the most far plates there are at once (`flatAtlas.ts` the far ring), each fading by its slot. */
export function createFarForest(slots: number, grid: FarWoodsGrid, read: FarWoodsReader): FarForest {
  const book = new FarWoodsBook(grid, read);
  // The near trees' pictures (`natureTrees.ts`): the same models, one atlas; taken between draws (`takeWaitingPictures`).
  const pictures = natureTreePictures();
  const models = pictures.set.spheres;
  const blocksX = pictures.set.blocks.x, blocksY = pictures.set.blocks.y;

  const fades = Math.ceil(slots / 4);
  /** How far a tree's picture reaches from its foot, over its height: the model's sphere */
  let reachPerSize = 0;
  for (const v of models) reachPerSize = Math.max(reachPerSize, v.centre.length() + 2 * Math.SQRT2 * v.radius);
  reachPerSize /= Math.sqrt(THIN_LEAST);
  const uniforms = {
    uAlbedo: { value: pictures.set.albedo },
    uNormals: { value: pictures.set.normals },
    uFade: { value: new Float32Array(fades * 4).fill(1) },
    // Each plate's own scale is in its trees' picks (`arraysOf`): the shader's is 1.
    uScale: { value: 1 },
    uThin: { value: new Vector4(THIN_SHARE, THIN_LEAST, blocksX, blocksY) },
    uCentre: { value: models.map((v) => v.centre) },
    uRadius: { value: new Float32Array(models.map((v) => v.radius)) },
  };
  const material = new MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.35, alphaToCoverage: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.defines = { ...shader.defines, FAR_FADES: fades, FAR_MODELS: models.length };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${IMPOSTOR_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', IMPOSTOR_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${IMPOSTOR_FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', IMPOSTOR_FRAGMENT_MAP)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${IMPOSTOR_FRAGMENT_NORMAL}`);
  };
  material.customProgramCacheKey = () => 'far-forest-impostor';
  const object = new Group();
  object.name = 'far-forest-group';
  /** Each far plate's mesh of its trees, by key, while it has trees. */
  const meshes = new Map<number, Mesh<InstancedBufferGeometry>>();
  /** A quad drawn once a tree: the instances' corners. */
  const quadOf = (spot: InstancedBufferAttribute, look: InstancedBufferAttribute): InstancedBufferGeometry => {
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('aSpot', spot);
    geometry.setAttribute('aLook', look);
    geometry.instanceCount = spot.count;
    return geometry;
  };
  // One empty tree (a pick of 2 is never under the scale: no triangle) always in the group
  const program = new Mesh(quadOf(new InstancedBufferAttribute(new Float32Array(4), 4), new InstancedBufferAttribute(Float32Array.of(0, 2, 0, 1), 4)), material);
  program.name = 'far-forest-program';
  program.frustumCulled = false;
  program.castShadow = false;
  program.receiveShadow = false;
  object.add(program);
  /** The woods' programs built (`programsFirst.ts`): no plate's woods shown before (made where nothing builds ahead, at once). */
  let built = !programsWaited();
  if (!built) {
    program.visible = false;
    void programsOf([program]).then(() => { built = true; program.visible = true; });
  }

  /** A plate's trees as its instances: x, height, three's z, size; the model and the plate's slot, the pick, the yaw, the tint. */
  const arraysOf = (key: number): { aSpot: Float32Array; aLook: Float32Array } | null => {
    const plate = book.plates.get(key);
    const woods = plate?.woods;
    if (!plate || !woods || woods.count === 0 || models.length === 0) return null;
    // More than a plate draws: the lowest picks, the trees that stand first.
    let order: number[] | null = null;
    if (woods.count > SLOT) order = Array.from({ length: woods.count }, (_, i) => i).sort((a, b) => woods.pick[a]! - woods.pick[b]!).slice(0, SLOT);
    const count = Math.min(SLOT, woods.count);
    const s = new Float32Array(count * 4), l = new Float32Array(count * 4);
    for (let n = 0; n < count; n++) {
      const i = order ? order[n]! : n;
      const o = n * 4;
      s[o] = woods.x[i]!; s[o + 1] = woods.z[i]!; s[o + 2] = -woods.y[i]!; s[o + 3] = woods.size[i]!;
      const seed = woods.seed[i]!;
      // Its pick over the plate's scale: the shader's test against a scale of 1 is the test against the plate's (`impostorShaders.ts`: want - pick, both over the scale); none stands at a scale of 0.
      const pick = plate.scale > 0 ? woods.pick[i]! / plate.scale : 2;
      const variety = Math.min(models.length - 1, Math.floor(seed * models.length));
      // The near trees' own tint (`natureTrees.ts`): a little lighter or darker per tree.
      l[o] = plate.slot * 8 + variety; l[o + 1] = pick; l[o + 2] = woods.yaw[i]!; l[o + 3] = 0.9 + ((seed * 3.77) % 1) * 0.2;
    }
    return { aSpot: s, aLook: l };
  };

  /** Plate `key`'s mesh let go. */
  const unwrite = (key: number): void => {
    const was = meshes.get(key);
    if (!was) return;
    object.remove(was);
    was.geometry.dispose();
    meshes.delete(key);
  };
  /** Plate `key`'s mesh made again from its woods (or let go). */
  const write = (key: number): void => {
    unwrite(key);
    const arrays = arraysOf(key);
    if (!arrays) return;
    const count = arrays.aSpot.length / 4;
    const spot = new InstancedBufferAttribute(arrays.aSpot, 4), look = new InstancedBufferAttribute(arrays.aLook, 4);
    const geometry = quadOf(spot, look);
    // The woods' bounds: every foot, grown by the farthest a picture reaches (`reachPerSize`).
    const box = new Box3();
    const foot = new Vector3();
    let tallest = 0;
    for (let n = 0; n < count; n++) {
      box.expandByPoint(foot.fromArray(arrays.aSpot, n * 4));
      tallest = Math.max(tallest, arrays.aSpot[n * 4 + 3]!);
    }
    box.expandByScalar(tallest * reachPerSize);
    geometry.boundingBox = box;
    geometry.boundingSphere = box.getBoundingSphere(new Sphere());
    const mesh = new Mesh(geometry, material);
    mesh.name = 'far-forest';
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.visible = built && (book.plates.get(key)?.fade ?? 0) > 0;
    // The instances live on the GPU only, made again from the plate's woods (`mesh/gpuOnly.ts`).
    gpuOnlyAttributes(mesh, { aSpot: spot, aLook: look }, () => arraysOf(key) ?? {});
    meshes.set(key, mesh);
    object.add(mesh);
  };

  return {
    object,
    book,
    update(renderer, now) {
      // The trees' pictures (theirs and the near plants'), between draws (`plantImpostors.ts`).
      takeWaitingPictures(renderer);
      if (book.gone.length) {
        for (const key of book.gone) unwrite(key);
        book.gone = [];
      }
      if (book.arrived.length) {
        for (const key of book.arrived) write(key);
        book.arrived = [];
      }
      book.step(now);
      // Every far plate's fade into its slot each frame (a few dozen numbers): a slot handed on starts from its new plate's.
      const fade = uniforms.uFade.value;
      for (const p of book.plates.values()) {
        fade[p.slot] = p.fade;
        // Faded out (drawn in full, its own trees grown): not drawn at all.
        const mesh = meshes.get(p.key);
        if (mesh) mesh.visible = built && p.fade > 0;
      }
    },
    dispose() {
      for (const mesh of meshes.values()) mesh.geometry.dispose();
      program.geometry.dispose();
      object.clear();
      material.dispose();
      pictures.release();
    },
  };
}
