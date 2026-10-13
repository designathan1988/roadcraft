import {
  BufferAttribute,
  Color,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  Scene,
  Vector3,
  Vector4,
  WebGLRenderTarget,
  type BufferGeometry,
  type WebGLRenderer,
} from 'three';
import type { NatureSettings } from '@world/ecology';
import type { ReliefVersion } from '@world/terrain';
import { lowPolyTreeParts } from './lowPolyTrees';
import { TREE_MODELS } from './natureTrees';
import { FAR_WOODS_BUDGET, woodsScale, type FarWoods, type FarWoodsAsk, type FarWoodsGrid } from './farWoods';
import { bakeMaterials, IMPOSTOR_FRAGMENT_MAP, IMPOSTOR_FRAGMENT_NORMAL, IMPOSTOR_VERTEX, IMPOSTOR_VERTEX_PARS, IMPOSTOR_FRAGMENT_PARS, FRAMES, hemiOctaDirection, frameBasis } from './impostorShaders';

/**
 * THE WOODS OF THE WHOLE MAP FROM AFAR: on every plate not drawn in full
 * (`flatAtlas.ts`), the trees its ecosystem grows (`farWoods.ts`, worked out
 * in the ecology's worker once per land and ecosystem) drawn as OCTAHEDRAL
 * IMPOSTORS - each tree a single quad facing the eye, painted from a picture
 * of the same low-poly model (`lowPolyTrees.ts`) taken from the nearest of 64
 * directions over the upper hemisphere and blended between the three nearest
 * (Ryan Brucks' octahedral impostors for Fortnite, shaderbits.com; the
 * hemi-octahedral mapping and the three-frame blend as
 * github.com/agargaro/octahedral-impostor and
 * github.com/SIsilicon/Godot-Octahedral-Impostors write them). The pictures
 * hold the model's colours and its normals, so the far trees are lit by the
 * scene's own sun as the near ones are, the same greens.
 *
 * One mesh for the map, instanced: a fixed slot of `SLOT` trees per plate,
 * so a plate's woods coming in write only their own slot (`addUpdateRange`)
 * and nothing is drawn twice. Per plate a fade: a plate brought in full keeps
 * its far trees until its own (the near ones, the same trees at the same
 * places) have had time to grow, then dissolves them (alpha to coverage, no
 * pop); a plate let go shows them again at once. The woods thin with the
 * distance by the same number that picks them (`pick`), each survivor grown
 * to keep the cover (the area kept constant) and each tree at the margin
 * shrinking away rather than vanishing: a wood reads as a wood to the
 * horizon. They cast no shadow (beyond the cascades' reach) and are never
 * drawn under a plate in full.
 *
 * The pictures are taken once, on the first frame (`update`), with
 * materials made with the rest at load; nothing is made or compiled in play.
 */

/** Trees a plate's slot holds: its budget at the map's scale with room (`farWoods.ts` HEADROOM). */
const SLOT = 4_096;
/** How long after a plate's own trees could grow its far ones start to go, and how long they take, seconds. */
const NEAR_GROWS = 0.7;
const DISSOLVE = 0.6;
/**
 * Under this share of the screen's height a tree's wood thins (about 6 px at
 * 1080): at most to `THIN_LEAST` of it, each survivor larger.
 */
const THIN_SHARE = 0.006;
const THIN_LEAST = 0.3;
/** Pixels of one picture of the atlas. */
const FRAME_PX = 64;

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
  readonly index: number;
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

/**
 * The far woods' bookkeeping, no `three`: which plates' woods to ask, which
 * are in, each plate's fade. `sync` asks only what changed; `step` moves the
 * fades and says whether any moved.
 */
export class FarWoodsBook {
  readonly plates: PlateState[];
  private landKey = '';
  private asks = 0;
  private land: { relief: ReliefVersion; nature: NatureSettings | null } | null = null;
  /** Bumped when a plate's woods come in: the instances to write. */
  arrived: number[] = [];
  scale = 1;
  /** The trees per 1920 m square the quality tier allows (`setVegetation`). */
  private budget = FAR_WOODS_BUDGET;

  constructor(regions: readonly { readonly cx: number; readonly cy: number }[], private readonly grid: FarWoodsGrid, private readonly read: FarWoodsReader) {
    this.plates = regions.map((r, index) => ({ index, cx: r.cx, cy: r.cy, asked: '', woods: null, full: false, nearSince: NaN, fade: 1 }));
  }

  /** The land and the ecosystem: when either changed, every plate's woods asked again (in the background, the nearest first). */
  sync(relief: ReliefVersion, nature: NatureSettings | null, focusX: number, focusY: number): void {
    const key = nature ? `${relief}:${nature.region}:${nature.seed}` : '';
    if (key === this.landKey) return;
    this.landKey = key;
    this.land = { relief, nature };
    for (const p of this.plates) { p.woods = null; p.asked = ''; }
    this.arrived = this.plates.map((p) => p.index);
    if (!nature) return;
    const order = [...this.plates].sort((a, b) => Math.hypot(a.cx - focusX, a.cy - focusY) - Math.hypot(b.cx - focusX, b.cy - focusY));
    for (const p of order) {
      p.asked = key;
      this.asks++;
      this.read(p.index, { relief, nature, cx: p.cx, cy: p.cy, grid: this.grid }, (woods) => {
        if (p.asked !== this.landKey) return;
        p.woods = woods;
        this.arrived.push(p.index);
        this.rescale();
      }, () => {
        console.warn('[nature] the far woods of a plate could not be worked out; it stands bare from afar', p.index);
      });
    }
  }

  /** The woods' scale, as the near sweep's: the budget over the plates' average density. */
  private rescale(): void {
    let sum = 0, n = 0;
    for (const p of this.plates) if (p.woods) { sum += p.woods.planned; n++; }
    this.scale = n ? woodsScale(sum / n, this.grid.half, this.budget) : 1;
  }

  /**
   * The vegetation the quality tier allows, as the near sweep reads it
   * (`renderer.ts` natureSweep: its budget scaled by `vegetation / 2600`,
   * none at 0): the far woods as thick as the near ones.
   */
  setVegetation(amount: number): void {
    const budget = FAR_WOODS_BUDGET * Math.min(1, Math.max(0, amount) / 2_600);
    if (budget === this.budget) return;
    this.budget = budget;
    this.rescale();
    if (budget === 0) this.scale = 0;
  }

  /** Whether plate `index` is drawn in full, and whether its own ecosystem is in (its near trees can grow). */
  setFull(index: number, full: boolean, nearReady: boolean, now: number): void {
    const p = this.plates[index]!;
    p.full = full;
    if (!full || !nearReady) p.nearSince = NaN;
    else if (Number.isNaN(p.nearSince)) p.nearSince = now;
  }

  /**
   * Moves the fades to `now`, seconds; true when any changed. In full, a
   * plate's far trees dissolve over `DISSOLVE` once its own have had
   * `NEAR_GROWS` to grow; let go, they are back at once (its near trees go
   * as it does).
   */
  step(now: number): boolean {
    let moved = false;
    for (const p of this.plates) {
      const next = !p.full || Number.isNaN(p.nearSince) ? 1 : 1 - Math.min(1, Math.max(0, (now - p.nearSince - NEAR_GROWS) / DISSOLVE));
      if (next !== p.fade) { p.fade = next; moved = true; }
    }
    return moved;
  }

  get stats(): FarForestStats {
    let ready = 0, trees = 0, drawn = 0;
    for (const p of this.plates) {
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

export function createFarForest(regions: readonly { readonly cx: number; readonly cy: number }[], grid: FarWoodsGrid, read: FarWoodsReader): FarForest {
  const book = new FarWoodsBook(regions, grid, read);
  const models = variants();
  const blocksX = 3, blocksY = Math.ceil(models.length / blocksX);
  const block = FRAMES * FRAME_PX;
  // Two pictures per view: the colour (premultiplied, gamma-encoded, so the
  // dark greens keep their steps in 8 bits) and the normal in the model's
  // frame with the coverage. Mipmapped once all are taken.
  const atlas = new WebGLRenderTarget(blocksX * block, blocksY * block, { count: 2, depthBuffer: true, generateMipmaps: true });
  for (const t of atlas.textures) { t.minFilter = LinearMipmapLinearFilter; t.magFilter = LinearFilter; }
  const bake = bakeMaterials();

  const plates = regions.length;
  const capacity = plates * SLOT;
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  // x, height, three's z, size; the model and the plate, the pick, the yaw, the tint.
  const spot = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  const look = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
  spot.setUsage(DynamicDrawUsage);
  look.setUsage(DynamicDrawUsage);
  // Every slot empty to begin with: a pick of 2 is never under the scale.
  for (let i = 0; i < capacity; i++) { look.array[i * 4] = Math.floor(i / SLOT) * 8; look.array[i * 4 + 1] = 2; }
  geometry.setAttribute('aSpot', spot);
  geometry.setAttribute('aLook', look);
  geometry.instanceCount = capacity;

  const uniforms = {
    uAlbedo: { value: atlas.textures[0]! },
    uNormals: { value: atlas.textures[1]! },
    uFade: { value: new Float32Array(plates).fill(1) },
    uScale: { value: 1 },
    uThin: { value: new Vector4(THIN_SHARE, THIN_LEAST, blocksX, blocksY) },
    uCentre: { value: models.map((v) => v.centre) },
    uRadius: { value: new Float32Array(models.map((v) => v.radius)) },
  };
  const material = new MeshStandardMaterial({ roughness: 0.85, metalness: 0, envMapIntensity: 0.35, alphaToCoverage: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.defines = { ...shader.defines, FAR_PLATES: plates, FAR_MODELS: models.length };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${IMPOSTOR_VERTEX_PARS}`)
      .replace('#include <begin_vertex>', IMPOSTOR_VERTEX);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${IMPOSTOR_FRAGMENT_PARS}`)
      .replace('#include <map_fragment>', IMPOSTOR_FRAGMENT_MAP)
      .replace('#include <normal_fragment_begin>', `#include <normal_fragment_begin>\n${IMPOSTOR_FRAGMENT_NORMAL}`);
  };
  material.customProgramCacheKey = () => 'far-forest-impostor';
  const mesh = new Mesh(geometry, material);
  mesh.name = 'far-forest';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const object = new Group();
  object.name = 'far-forest-group';
  object.add(mesh);

  let baked = false;
  const takePictures = (renderer: WebGLRenderer): void => {
    baked = true;
    const camera = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10);
    const scene = new Scene();
    // Each picture's square set on the atlas itself: a target's own viewport
    // and scissor are in its pixels (three's setViewport would scale them by
    // the screen's pixel ratio).
    const was = {
      target: renderer.getRenderTarget(), autoClear: renderer.autoClear, alpha: renderer.getClearAlpha(),
      shadows: renderer.shadowMap.autoUpdate, colour: renderer.getClearColor(new Color()),
    };
    atlas.scissorTest = false;
    atlas.viewport.set(0, 0, atlas.width, atlas.height);
    renderer.setRenderTarget(atlas);
    renderer.setClearColor(0x000000, 0);
    renderer.clear(true, true, true);
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    atlas.scissorTest = true;
    const direction = new Vector3(), tangent = new Vector3(), bitangent = new Vector3();
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
          renderer.render(scene, camera);
        }
      }
    });
    scene.clear();
    // (Three makes the atlas' mipmaps after each picture drawn into it: the last one holds them all.)
    renderer.setRenderTarget(was.target);
    renderer.setClearColor(was.colour, was.alpha);
    renderer.autoClear = was.autoClear;
    renderer.shadowMap.autoUpdate = was.shadows;
    for (const v of models) { v.body.dispose(); v.cards?.dispose(); }
  };

  /** Writes plate `index`'s woods into its slot (or empties it). */
  const write = (index: number): void => {
    const woods = book.plates[index]!.woods;
    const s = spot.array as Float32Array, l = look.array as Float32Array;
    const start = index * SLOT;
    let n = 0;
    if (woods) {
      // More than a slot holds: the lowest picks, the trees that stand first.
      let order: number[] | null = null;
      if (woods.count > SLOT) order = Array.from({ length: woods.count }, (_, i) => i).sort((a, b) => woods.pick[a]! - woods.pick[b]!).slice(0, SLOT);
      const count = Math.min(SLOT, woods.count);
      for (; n < count; n++) {
        const i = order ? order[n]! : n;
        const o = (start + n) * 4;
        s[o] = woods.x[i]!; s[o + 1] = woods.z[i]!; s[o + 2] = -woods.y[i]!; s[o + 3] = woods.size[i]!;
        const seed = woods.seed[i]!;
        const variety = Math.min(models.length - 1, Math.floor(seed * models.length));
        // The near trees' own tint (`natureTrees.ts`): a little lighter or darker per tree.
        l[o] = index * 8 + variety; l[o + 1] = woods.pick[i]!; l[o + 2] = woods.yaw[i]!; l[o + 3] = 0.9 + ((seed * 3.77) % 1) * 0.2;
      }
    }
    for (let k = n; k < SLOT; k++) { const o = (start + k) * 4; l[o] = index * 8; l[o + 1] = 2; }
    spot.addUpdateRange(start * 4, SLOT * 4);
    look.addUpdateRange(start * 4, SLOT * 4);
    spot.needsUpdate = true;
    look.needsUpdate = true;
  };

  return {
    object,
    book,
    update(renderer, now) {
      if (!baked) takePictures(renderer);
      if (book.arrived.length) {
        spot.clearUpdateRanges();
        look.clearUpdateRanges();
        for (const index of book.arrived) write(index);
        book.arrived = [];
      }
      uniforms.uScale.value = book.scale;
      if (book.step(now)) for (const p of book.plates) uniforms.uFade.value[p.index] = p.fade;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      atlas.dispose();
      bake.body.dispose();
      bake.cards.dispose();
      for (const v of models) { v.body.dispose(); v.cards?.dispose(); }
    },
  };
}
