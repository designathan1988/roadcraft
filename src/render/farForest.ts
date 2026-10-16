import {
  Box3,
  BufferAttribute,
  Color,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  Sphere,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type BufferGeometry,
  type WebGLRenderer,
} from 'three';
import type { NatureSettings } from '@world/ecology';
import type { ReliefVersion } from '@world/terrain';
import { lowPolyTreeParts } from './lowPolyTrees';
import { takeWaitingPictures } from './plantImpostors';
import { TREE_MODELS } from './natureTrees';
import { FAR_WOODS_BUDGET, woodsScale, type FarWoods, type FarWoodsAsk, type FarWoodsGrid } from './farWoods';
import { bakeMaterials, IMPOSTOR_FRAGMENT_MAP, IMPOSTOR_FRAGMENT_NORMAL, IMPOSTOR_VERTEX, IMPOSTOR_VERTEX_PARS, IMPOSTOR_FRAGMENT_PARS, FRAMES, FRAME_PX, hemiOctaDirection, frameBasis } from './impostorShaders';
import { gpuOnlyAttributes } from './mesh/gpuOnly';

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
  scale = 1;
  /** The trees per 1920 m square the quality tier allows (`setVegetation`). */
  private budget = FAR_WOODS_BUDGET;

  constructor(private readonly grid: FarWoodsGrid, private readonly read: FarWoodsReader) {}

  /** A far plate come into the view's ring, in `slot`: its woods asked once the land is known. */
  add(key: number, slot: number, cx: number, cy: number): void {
    if (this.plates.has(key)) return;
    const p: PlateState = { key, slot, cx, cy, asked: '', woods: null, full: false, nearSince: NaN, fade: 1 };
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
    if (p.woods) this.rescale();
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
      this.arrived.push(p.key);
      this.rescale();
    }, () => {
      console.warn('[nature] the far woods of a plate could not be worked out; it stands bare from afar', p.key);
    });
  }

  /** The woods' scale, as the near sweep's: the budget over the plates' average density. */
  private rescale(): void {
    let sum = 0, n = 0;
    for (const p of this.plates.values()) if (p.woods) { sum += p.woods.planned; n++; }
    this.scale = n ? woodsScale(sum / n, this.grid.half, this.budget) : 1;
  }

  /** The vegetation the quality tier allows, as the near sweep reads it */
  setVegetation(amount: number): void {
    const budget = FAR_WOODS_BUDGET * Math.min(1, Math.max(0, amount) / 2_600);
    if (budget === this.budget) return;
    this.budget = budget;
    this.rescale();
    if (budget === 0) this.scale = 0;
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

interface Variant { readonly body: BufferGeometry; readonly cards: BufferGeometry | null; readonly centre: Vector3; readonly radius: number }

/** The models, one unit tall (`natureTrees.ts` loadNatureTrees: the same seeds, the same trees), and the sphere round each. */
function variants(): Variant[] {
  return TREE_MODELS.map((kind, i) => {
    const { body, cards } = lowPolyTreeParts(kind, 0x7ee5 + i * 7919);
    const min = new Vector3(Infinity, Infinity, Infinity), max = new Vector3(-Infinity, -Infinity, -Infinity);
    const grow = (g: BufferGeometry, reach: number): void => {
      const p = g.getAttribute('position');
      for (let v = 0; v < p.count; v++) {
        min.set(Math.min(min.x, p.getX(v) - reach), Math.min(min.y, p.getY(v) - reach), Math.min(min.z, p.getZ(v) - reach));
        max.set(Math.max(max.x, p.getX(v) + reach), Math.max(max.y, p.getY(v) + reach), Math.max(max.z, p.getZ(v) + reach));
      }
    };
    grow(body, 0);
    let corner = 0;
    if (cards) {
      const c = cards.getAttribute('aCorner');
      for (let v = 0; v < c.count; v++) corner = Math.max(corner, Math.hypot(c.getX(v), c.getY(v)));
      grow(cards, corner);
    }
    const centre = min.clone().add(max).multiplyScalar(0.5);
    // The sphere round the box: every view of the model fits its picture.
    const radius = max.clone().sub(min).length() / 2;
    return { body, cards, centre, radius };
  });
}

/** `slots`: the most far plates there are at once (`flatAtlas.ts` the far ring), each fading by its slot. */
export function createFarForest(slots: number, grid: FarWoodsGrid, read: FarWoodsReader): FarForest {
  const book = new FarWoodsBook(grid, read);
  const models = variants();
  const blocksX = 3, blocksY = Math.ceil(models.length / blocksX);
  const block = FRAMES * FRAME_PX;
  // Two pictures per view: the colour
  const atlas = new WebGLRenderTarget(blocksX * block, blocksY * block, { count: 2, depthBuffer: true, generateMipmaps: true });
  for (const t of atlas.textures) { t.minFilter = LinearMipmapLinearFilter; t.magFilter = LinearFilter; }
  const bake = bakeMaterials();

  const fades = Math.ceil(slots / 4);
  /** How far a tree's picture reaches from its foot, over its height: the model's sphere */
  let reachPerSize = 0;
  for (const v of models) reachPerSize = Math.max(reachPerSize, v.centre.length() + 2 * Math.SQRT2 * v.radius);
  reachPerSize /= Math.sqrt(THIN_LEAST);
  const uniforms = {
    uAlbedo: { value: atlas.textures[0]! },
    uNormals: { value: atlas.textures[1]! },
    uFade: { value: new Float32Array(fades * 4).fill(1) },
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

  let baked = false;
  const takePictures = (renderer: WebGLRenderer): void => {
    baked = true;
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    const scene = new Scene();
    // Each picture's square set on the atlas itself: a target's own viewport and scissor are in its pixels
    const was = {
      target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
      shadows: renderer.shadowMap.autoUpdate, colour: renderer.getClearColor(new Color()),
    };
    atlas.scissorTest = false;
    atlas.viewport.set(0, 0, atlas.width, atlas.height);
    // Made with every mip level (three allocates them by `generateMipmaps` when the target is first set)
    renderer.setRenderTarget(atlas);
    for (const t of atlas.textures) t.generateMipmaps = false;
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    atlas.scissorTest = true;
    const direction = new Vector3(), tangent = new Vector3(), bitangent = new Vector3();
    const last = models.length * FRAMES * FRAMES - 1;
    let taken = 0;
    models.forEach((v, k) => {
      scene.clear();
      scene.add(new Mesh(v.body, bake.body));
      if (v.cards) scene.add(new Mesh(v.cards, bake.cards));
      const r = v.radius;
      camera.left = -r; camera.right = r; camera.top = r; camera.bottom = -r;
      camera.near = 0.01 * r; camera.far = 4 * r;
      camera.updateProjectionMatrix();
      const bx = (k % blocksX) * block, by = Math.floor(k / blocksX) * block;
      for (let row = 0; row < FRAMES; row++) {
        for (let col = 0; col < FRAMES; col++) {
          hemiOctaDirection(col / (FRAMES - 1), row / (FRAMES - 1), direction);
          frameBasis(direction, tangent, bitangent);
          camera.position.copy(v.centre).addScaledVector(direction, 2 * r);
          camera.up.copy(bitangent);
          camera.lookAt(v.centre);
          camera.updateMatrixWorld();
          const x = bx + col * FRAME_PX, y = by + row * FRAME_PX;
          atlas.viewport.set(x, y, FRAME_PX, FRAME_PX);
          atlas.scissor.set(x, y, FRAME_PX, FRAME_PX);
          renderer.setRenderTarget(atlas);
          if (taken++ === last) for (const t of atlas.textures) t.generateMipmaps = true;
          renderer.render(scene, camera);
        }
      }
    });
    scene.clear();
    renderer.setRenderTarget(was.target);
    renderer.setClearColor(was.colour, was.alpha);
    renderer.autoClear = was.autoClear;
    renderer.shadowMap.autoUpdate = was.shadows;
    for (const v of models) { v.body.dispose(); v.cards?.dispose(); }
  };

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
      const variety = Math.min(models.length - 1, Math.floor(seed * models.length));
      // The near trees' own tint (`natureTrees.ts`): a little lighter or darker per tree.
      l[o] = plate.slot * 8 + variety; l[o + 1] = woods.pick[i]!; l[o + 2] = woods.yaw[i]!; l[o + 3] = 0.9 + ((seed * 3.77) % 1) * 0.2;
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
    mesh.visible = (book.plates.get(key)?.fade ?? 0) > 0;
    // The instances live on the GPU only, made again from the plate's woods (`mesh/gpuOnly.ts`).
    gpuOnlyAttributes(mesh, { aSpot: spot, aLook: look }, () => arraysOf(key) ?? {});
    meshes.set(key, mesh);
    object.add(mesh);
  };

  return {
    object,
    book,
    update(renderer, now) {
      if (!baked) takePictures(renderer);
      // The near plants' pictures too, the same way: between draws (`plantImpostors.ts`).
      takeWaitingPictures(renderer);
      if (book.gone.length) {
        for (const key of book.gone) unwrite(key);
        book.gone = [];
      }
      if (book.arrived.length) {
        for (const key of book.arrived) write(key);
        book.arrived = [];
      }
      uniforms.uScale.value = book.scale;
      book.step(now);
      // Every far plate's fade into its slot each frame (a few dozen numbers): a slot handed on starts from its new plate's.
      const fade = uniforms.uFade.value;
      for (const p of book.plates.values()) {
        fade[p.slot] = p.fade;
        // Faded out (drawn in full, its own trees grown): not drawn at all.
        const mesh = meshes.get(p.key);
        if (mesh) mesh.visible = p.fade > 0;
      }
    },
    dispose() {
      for (const mesh of meshes.values()) mesh.geometry.dispose();
      program.geometry.dispose();
      object.clear();
      material.dispose();
      atlas.dispose();
      bake.body.dispose();
      bake.cards.dispose();
      for (const v of models) { v.body.dispose(); v.cards?.dispose(); }
    },
  };
}
