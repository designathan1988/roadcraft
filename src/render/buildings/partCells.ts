import { Box3, type BufferGeometry, Group, InstancedInterleavedBuffer, InstancedMesh, InterleavedBufferAttribute, type InstancedBufferAttribute, type Mesh, Sphere, Vector3 } from 'three';
import { gpuOnlyAttributes } from '../mesh/gpuOnly';
import { gateUntilBuilt } from '../uploads';
import { FINISH_ATTRIBUTE } from './cellArrays';
import { GROUND_ATTRIBUTE, LOOK_FLOATS, SHELL_PARTS, shellPartError } from './shellParts';
import type { Axes, BuildingKit, PartKind, PartScreen } from './kit';
import { partLook } from './fade';
import { POSE_FLOATS, letGoPosed, partPoseDepth, posedCopy } from './partPose';
import { DRAW_TRIANGLES, LEAVES, type PartFiling } from './partFiling';

/** THE PARTS OF ONE CELL OF BUILDINGS, EACH KIND DRAWN AT THE LEVEL ITS ERROR ON THE SCREEN ALLOWS */
// One buffer a kind for the cell, its sub-cells in Morton order: sub-cells side by side in that order are one run of it, drawn
// by one mesh bound at the run's offset (three binds an interleaved attribute at its `offset`, `WebGLBindingStates`).
// Each sub-cell takes its level; neighbours at one level are one draw. Choosing a level swaps a mesh's geometry or hides it:
// nothing is emitted again, and the choice reads sub-cells, never instances.
// DO NOT give a kind one buffer whatever its instances' shapes: a frame is also a gourmet balcony's post (1 m deep), and the
// largest scale over a sub-cell held every window at full detail; instances are banded by their error, each band its own buffer.
// A shell's part (`whole`, a lot's box, rail or slab) has one level: drawn at it, or not at all once its instances are under a pixel across (the player's call, plan 9.9 item 4: lot parts under a pixel out of the drawing).

/** A level is left for a coarser one once that one's error is under this share of a pixel (a shadow under this share of a texel), and taken back at a whole one. */
const COARSEN = 0.85;
/** Pixels a coarser level's error may span before a finer one is drawn. 1.5, not 1: the parts were 47 % of the district's triangles
 *  (9.3 M of 20 M, `npm run diagnose`, 2026-10-22), and the full-resolution occlusion of the top tier is paid from them. Whether a part
 *  is drawn at all is still judged by a pixel (`levelAt`). */
export const PART_ERROR_PX = 1.5;
/** A sub-cell not drawn: every instance in it under a pixel. */
const NONE = 127;
/** A part made of bars (a frame's rails and stiles, a railing's, a brise's blades: its `pieces`) leaves the drawing once its bars span under this many pixels: what it covers is its bars, not its box. DO NOT keep it until its whole diagonal is under a pixel: 300 thousand window frames of 6 cm bars were drawn to 1-2 km as lines a fifth of a pixel wide, 6 M triangles of shimmer (2026-10-20). */
export const BAR_PIXELS = 0.5;
/** A shell's part is drawn with the far program (`kit.farShell`) once a metre spans under this many pixels where its run stands nearest (a finish's texture holds features of some 15 cm: under a pixel past it), the near one back at `LIGHT_BACK`. */
const LIGHT_PIXELS = 6;
const LIGHT_BACK = 7;
/** The choices a run's mesh is kept after it leaves the drawing, before its buffers go: a run that comes back within a camera's pause keeps its mesh; one left behind by a turn does not hold its copies for the rest of the cell's life (the lab's +53 geometries a minute, 2026-10-20). */
const EVICT_AFTER = 240;

/** Where the eye is (map x/y, height), the pixels a metre spans at a metre's distance (or everywhere, `orthoPx`) and a shadow texel's side, m (Infinity: no shadows). */
export interface PartView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly pxAtMetre: number;
  readonly orthoPx: number | null;
  readonly shadowTexel: number;
}


/** One band of a kind's instances in the cell, by sub-cell. */
interface Band {
  readonly kind: PartKind;
  readonly screen: PartScreen;
  /** Each sub-cell's first instance; the last entry is the band's count. */
  readonly start: Uint32Array;
  /** Each sub-cell's box in three's world (min x, y, z, max x, y, z). */
  readonly box: Float64Array;
  /** Each sub-cell's largest scale of an instance along each of the model's axes, then the cell's. */
  readonly scale: Float32Array;
  /** Its instances' poses (`partPose.ts`): the GPU makes their matrices. */
  readonly poses: InstancedInterleavedBuffer;
  readonly colours: InstancedInterleavedBuffer | null;
  /** The shell's parts: each one's finish, wear and ground (`shellParts.ts`), read by its run's own copy of the model. */
  readonly looks: InstancedInterleavedBuffer | null;
  /** A mesh for each run of sub-cells it was ever drawn by (first * LEAVES + last), and the level each is drawn at now. */
  readonly meshes: Map<number, InstancedMesh>;
  readonly drawn: Map<number, number>;
  /** When each run was last drawn, by run key (`PartCell.tick`): a run out of the drawing for long enough gives its mesh back (`PartCell.evictStale`). */
  readonly unseen: Map<number, number>;
  /** The level each sub-cell was last chosen at (hysteresis). */
  readonly held: Uint8Array;
  casts: boolean;
  /** Its widest piece as drawn now, m (`choose`): what a cascade's texel is measured against (`castInto`). */
  width: number;
  /** Its widest piece, NaN until first read (`choose`): its pieces and scales never change, so worked out once (PRD-30). */
  widest: number;
  /** What the band casts: every instance of it, at the level each cascade's texel asks (`castInto`), drawn into the cascades alone; null until
   *  first asked. */
  caster: InstancedMesh | null;
  /** The level each cascade's texel asks of the band (`shadowLevel`), by texel. */
  readonly castLevels: Map<number, number>;
}

/** The largest of three lengths scaled. */
const largest = (a: Axes, s: Float32Array, o: number): number => Math.max(a[0] * s[o]!, a[1] * s[o + 1]!, a[2] * s[o + 2]!);
/** The widest of a part's bars across (`PartScreen.pieces`, the middle side of each), at a sub-cell's scale. */
function barsAcross(band: { readonly screen: { readonly pieces: readonly Axes[] }; readonly scale: Float32Array }, m: number): number {
  let widest = 0;
  for (const piece of band.screen.pieces) widest = Math.max(widest, middle(piece, band.scale, m * 3));
  return widest;
}
/** A band's widest bar over all its sub-cells (`barsAcross`), metres: what the facade level's batch judges a kind of bars by (`farParts.ts`). */
export function widestBar(pieces: readonly Axes[], scale: Float32Array): number {
  let widest = 0;
  for (let o = 0; o + 2 < scale.length; o += 3) for (const piece of pieces) widest = Math.max(widest, middle(piece, scale, o));
  return widest;
}
/** The diagonal of a box scaled. */
const diagonal = (a: Axes, s: Float32Array, o: number): number => Math.hypot(a[0] * s[o]!, a[1] * s[o + 1]!, a[2] * s[o + 2]!);
/** The middle of three lengths scaled: a piece's shadow is this wide from some side of the sun. */
function middle(a: Axes, s: Float32Array, o: number): number {
  const x = a[0] * s[o]!, y = a[1] * s[o + 1]!, z = a[2] * s[o + 2]!;
  return Math.max(Math.min(x, y), Math.min(Math.max(x, y), z));
}

export class PartCell {
  readonly group = new Group();
  private readonly bands: Band[] = [];
  private faded = false;
  /** The view the levels were last chosen for: the same view chooses the same levels. */
  private readonly chosenFor = { x: NaN, y: NaN, z: NaN, pxAtMetre: NaN, orthoPx: null as number | null, shadowTexel: NaN };
  /** The choices made so far: what a run's mesh kept out of the drawing is measured against (`EVICT_AFTER`). */
  private tick = 0;
  /** Scratch for one band's runs this frame: each run's first and last sub-cell, its level and its instances. */
  private readonly runFirst = new Uint8Array(LEAVES);
  private readonly runLast = new Uint8Array(LEAVES);
  private readonly runLevel = new Uint8Array(LEAVES);
  private readonly runCount = new Uint32Array(LEAVES);

  /** The cell's whole filing, as its job filed it: the far parts' batch draws the kinds this cell's bands leave out (`farParts.ts`). */
  readonly filing: PartFiling;

  /** `filing`: the cell's parts by band and sub-cell, as its job filed them (`partFiling.ts`): DO NOT read an instance here, the page only wraps the buffers handed over. `full`: the whole filing when `filing` leaves the far batch's kinds out (a facade cell's shell parts alone). */
  constructor(key: string, filing: PartFiling, private readonly kit: BuildingKit, full: PartFiling = filing) {
    this.filing = full;
    this.group.name = 'building-parts';
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    void key;
    const own: Record<string, InstancedInterleavedBuffer> = {};
    for (const f of filing.bands) {
      const band: Band = {
        kind: f.kind, screen: kit.screen[f.kind], start: f.start, box: f.box, scale: f.scale,
        // Tints in half floats: HALF_FLOAT where the buffer says so (r186 `WebGLAttributes.createBuffer`, an interleaved attribute by its buffer).
        poses: new InstancedInterleavedBuffer(f.poses, POSE_FLOATS), colours: f.colours ? Object.assign(new InstancedInterleavedBuffer(f.colours, 3), { isFloat16BufferAttribute: true }) : null,
        looks: f.looks ? new InstancedInterleavedBuffer(f.looks, LOOK_FLOATS) : null,
        meshes: new Map(), drawn: new Map(), unseen: new Map(), held: new Uint8Array(LEAVES), casts: false, width: 0, widest: Number.NaN,
        caster: null, castLevels: new Map(),
      };
      own[`${f.kind}-${this.bands.length}-poses`] = band.poses;
      if (band.colours) own[`${f.kind}-${this.bands.length}-colours`] = band.colours;
      if (band.looks) own[`${f.kind}-${this.bands.length}-looks`] = band.looks;
      this.bands.push(band);
    }
    // On the GPU only: a lost context asks the cell of the workers again (`layer.ts` `refill`).
    gpuOnlyAttributes(this.group, own, () => ({}));
  }

  /** Each sub-cell of each band at the coarsest level whose error is under a pixel, none where an instance is; shadows cast where a piece spans a texel. */
  choose(view: PartView): void {
    const was = this.chosenFor;
    if (was.x === view.x && was.y === view.y && was.z === view.z && was.pxAtMetre === view.pxAtMetre && was.orthoPx === view.orthoPx && was.shadowTexel === view.shadowTexel) return;
    Object.assign(was, view);
    this.tick++;
    for (const band of this.bands) {
      const runs = this.runsOf(band, view);
      if (Number.isNaN(band.widest)) {
        let widest = 0;
        for (const piece of band.screen.pieces) widest = Math.max(widest, middle(piece, band.scale, LEAVES * 3));
        band.widest = widest;
      }
      const width = band.widest;
      // A shell's part too, by its widest piece: out of a cascade whose texel is wider than it (its colour drawn whatever its size, `levelAt`).
      band.width = width;
      const casts = this.kit.castsShadow.has(band.kind) && Number.isFinite(view.shadowTexel) && width >= view.shadowTexel * (band.casts ? COARSEN : 1);
      const recast = casts !== band.casts;
      band.casts = casts;
      // Out: the runs drawn before and not now. Its mesh is kept a while (a camera pause brings the run back), then given back (`evictStale`).
      for (const [key] of band.drawn) {
        let kept = false;
        for (let r = 0; r < runs && !kept; r++) kept = this.runFirst[r]! * LEAVES + this.runLast[r]! === key;
        if (kept) continue;
        band.meshes.get(key)!.visible = false;
        band.drawn.delete(key);
        band.unseen.set(key, this.tick);
      }
      // In: each run now, at its level.
      const visible = partLook(this.kit, band.kind, this.faded).visible;
      const shell = SHELL_PARTS.has(band.kind) && !this.faded;
      for (let r = 0; r < runs; r++) {
        const key = this.runFirst[r]! * LEAVES + this.runLast[r]!, level = this.runLevel[r]!;
        band.unseen.delete(key);
        let mesh = band.meshes.get(key);
        // A shell's part: the far program where its finish's texture is under a pixel (`LIGHT_PIXELS`), the near one where it is not.
        const far = shell && this.runPixels(band, r, view) < (mesh?.userData['far'] === true ? LIGHT_BACK : LIGHT_PIXELS);
        if (mesh && shell && mesh.userData['far'] !== far) this.drawFar(band, mesh, far);
        if (band.drawn.get(key) === level && !recast) continue;
        if (!mesh) {
          band.meshes.set(key, mesh = this.make(band, this.runFirst[r]!, this.runLast[r]!));
          if (shell) this.drawFar(band, mesh, far);
        }
        // A run's posed copy of its level: a shell's part too, now that it has a coarse level (`kit.ts`).
        mesh.geometry = this.posedLevel(band, mesh, level);
        // The runs cast nothing: the band's caster does (`castInto`), at the cascade's level, whatever the camera chose here.
        mesh.castShadow = false;
        mesh.visible = visible;
        band.drawn.set(key, level);
      }
    }
    // A band drawn casts by a caster of its own (`castInto`), made here, outside the shadow passes. DO NOT make it with the cell: every cell's
    // casters went through the door with it, the district's frames p95 13 -> 93 ms (`npm run diagnose`, 2026-10-22); nor in a cascade's pass.
    for (const band of this.bands) if (!band.caster && band.drawn.size > 0 && this.kit.castsShadow.has(band.kind)) this.makeCaster(band);
    if (this.tick % 60 === 0) this.evictStale();
  }

  /** The run meshes out of the drawing longer than `EVICT_AFTER` given back: their posed copies freed and the mesh taken out of the cell (a run wanted again is made anew). */
  private evictStale(): void {
    for (const band of this.bands) {
      for (const [key, seen] of band.unseen) {
        if (this.tick - seen < EVICT_AFTER) continue;
        band.unseen.delete(key);
        const mesh = band.meshes.get(key);
        if (!mesh || band.drawn.has(key)) continue;
        band.meshes.delete(key);
        // DO NOT free the band's buffers with one run: its poses, looks and colours are shared by every run of the band, their arrays let go once
        // uploaded (`gpuOnlyAttributes`), and the runs still drawn found no buffer and three made one of a null array - every frame, the game frozen
        // (the player, 2026-10-22: "navego um pouco e trava"). Every attribute of a copy is the model's or the band's: all taken off, nothing freed.
        for (const copy of (mesh.userData['posed'] as Map<number, BufferGeometry>).values()) {
          for (const name of Object.keys(copy.attributes)) copy.deleteAttribute(name);
          copy.setIndex(null);
          copy.dispose();
        }
        mesh.instanceColor = null;
        mesh.dispose();
        this.group.remove(mesh);
      }
    }
  }
  private runsOf(band: Band, view: PartView): number {
    const { runFirst, runLast, runLevel, runCount } = this;
    const triangles = (k: number): number => band.screen.levels[k]!.triangles;
    let runs = 0;
    for (let m = 0; m < LEAVES; m++) {
      const count = band.start[m + 1]! - band.start[m]!;
      if (count === 0) continue;
      const level = this.levelAt(band, m, this.perMetre(band, m, view), band.held[m]!);
      band.held[m] = level;
      const last = runs - 1;
      // A run's sub-cells are side by side in the buffer: those between with no instance of the band add none.
      if (runs > 0 && runLevel[last] === level) {
        runLast[last] = m;
        runCount[last] = runCount[last]! + count;
      } else {
        runFirst[runs] = m; runLast[runs] = m; runLevel[runs] = level; runCount[runs] = count;
        runs++;
      }
      // Two drawn runs with a run under a pixel between are one draw at the finer level when drawing the gap's instances and the coarser one finer costs less than a draw.
      if (runs >= 3 && runLevel[runs - 1] !== NONE && runLevel[runs - 2] === NONE && runLevel[runs - 3] !== NONE) {
        const a = runs - 3, gap = runs - 2, b = runs - 1;
        const fine = Math.min(runLevel[a]!, runLevel[b]!), coarse = Math.max(runLevel[a]!, runLevel[b]!);
        const coarseCount = runLevel[a] === coarse ? runCount[a]! : runCount[b]!;
        if (runCount[gap]! * triangles(fine) + coarseCount * (triangles(fine) - triangles(coarse)) <= DRAW_TRIANGLES) {
          runLast[a] = runLast[b]!; runCount[a] = runCount[a]! + runCount[gap]! + runCount[b]!; runLevel[a] = fine;
          runs -= 2;
        }
      }
      // Two drawn runs side by side are one draw at the finer level when drawing the coarser one finer costs less than a draw.
      while (runs >= 2 && runLevel[runs - 1] !== NONE && runLevel[runs - 2] !== NONE) {
        const a = runs - 2, b = runs - 1;
        const fine = Math.min(runLevel[a]!, runLevel[b]!), coarse = Math.max(runLevel[a]!, runLevel[b]!);
        const coarseCount = runLevel[a] === coarse ? runCount[a]! : runCount[b]!;
        if (coarseCount * (triangles(fine) - triangles(coarse)) > DRAW_TRIANGLES) break;
        runLast[a] = runLast[b]!; runCount[a] = runCount[a]! + runCount[b]!; runLevel[a] = fine;
        runs--;
      }
    }
    // The runs not drawn are not runs.
    let kept = 0;
    for (let r = 0; r < runs; r++) {
      if (runLevel[r] === NONE) continue;
      runFirst[kept] = runFirst[r]!; runLast[kept] = runLast[r]!; runLevel[kept] = runLevel[r]!; runCount[kept] = runCount[r]!;
      kept++;
    }
    return kept;
  }

  /** Before a sun cascade is drawn: each band casts into it where its widest piece spans the cascade's texel, every instance of it at the
   *  level that texel asks (`shadowLevel`), by its caster drawn into the cascades alone; `null`, the passes over: the casters hidden, as
   *  they stand between the passes. DO NOT cast the runs the camera chose: their levels and their runs change as the camera moves, and each
   *  change was a change of the near cascade's store, drawn whole again at nearly every frame of a flight (`tooBigNear` 295 of 501 passes,
   *  `npm run diagnose`, 2026-10-22). What the band casts follows the cascade's texel alone. */
  castInto(texel: number | null): void {
    for (const band of this.bands) {
      if (!this.kit.castsShadow.has(band.kind) || band.start[LEAVES] === 0) continue;
      // None yet: the band was never drawn (`choose` makes it then), nothing of it casts.
      const caster = band.caster;
      if (!caster) continue;
      if (texel === null) {
        // Between the passes: hidden from the colour pass, at its first level, casting (what the casters' signature reads, `renderer.ts`).
        caster.visible = false;
        caster.geometry = this.posedLevel(band, caster, 0);
        caster.castShadow = true;
        continue;
      }
      if (Number.isNaN(band.widest)) band.widest = widestBar(band.screen.pieces, band.scale);
      const level = band.widest >= texel ? this.shadowLevel(band, texel) : NONE;
      // A card casts nothing: its face would cast whole (`kit.ts` cards).
      const casts = level !== NONE && !band.screen.levels[level]!.card && partLook(this.kit, band.kind, this.faded).visible;
      caster.visible = casts;
      caster.castShadow = casts;
      if (casts) caster.geometry = this.posedLevel(band, caster, level);
    }
  }

  /** The level a cascade of `texel` draws the band at: the finest any of its sub-cells asks there, as a sub-cell's level is chosen for a
   *  pixel (`levelAt`, a texel standing for the pixel); NONE when each is under its texel. Worked out once a texel. */
  private shadowLevel(band: Band, texel: number): number {
    let level = band.castLevels.get(texel);
    if (level !== undefined) return level;
    level = NONE;
    for (let m = 0; m < LEAVES; m++) {
      if (band.start[m + 1] === band.start[m]) continue;
      level = Math.min(level, this.levelAt(band, m, 1 / texel, band.screen.levels.length));
    }
    // A card's face would cast whole (`kit.ts` cards): the coarsest level of bars before it casts for it.
    while (level !== NONE && level > 0 && band.screen.levels[level]!.card) level--;
    if (band.castLevels.size > 8) band.castLevels.clear();
    band.castLevels.set(texel, level);
    return level;
  }

  /** The band's caster: every instance of it, its own bounds, its depth material, drawn into the cascades alone (`castInto`). */
  private makeCaster(band: Band): InstancedMesh {
    const look = partLook(this.kit, band.kind, this.faded);
    const geometry = posedCopy(band.screen.levels[0]!.geometry, band.poses, 0);
    if (band.looks) {
      geometry.setAttribute(FINISH_ATTRIBUTE, new InterleavedBufferAttribute(band.looks, 1, 0));
      geometry.setAttribute('aDecay', new InterleavedBufferAttribute(band.looks, 1, 1));
      geometry.setAttribute(GROUND_ATTRIBUTE, new InterleavedBufferAttribute(band.looks, 1, 2));
    }
    const mesh = new InstancedMesh(geometry, look.material, 0);
    mesh.userData['posed'] = new Map<number, BufferGeometry>([[0, geometry]]);
    mesh.userData['first'] = 0;
    // Drawn in the cascades alone: the casters' signature reads it hidden (`renderer.ts` casterChanges), its changes told where it casts.
    mesh.userData['shadowOnly'] = true;
    if (Number.isNaN(band.widest)) band.widest = widestBar(band.screen.pieces, band.scale);
    mesh.userData['castReach'] = band.widest;
    mesh.customDepthMaterial = partPoseDepth(look.material);
    mesh.count = band.start[LEAVES]!;
    const box = new Box3();
    for (let m = 0; m < LEAVES; m++) {
      if (band.start[m + 1] === band.start[m]) continue;
      const o = m * 6, b = band.box;
      box.union(new Box3(new Vector3(b[o], b[o + 1], b[o + 2]), new Vector3(b[o + 3], b[o + 4], b[o + 5])));
    }
    mesh.boundingBox = box;
    mesh.boundingSphere = box.getBoundingSphere(new Sphere());
    mesh.name = `building-${band.kind}-caster`;
    mesh.receiveShadow = false;
    mesh.castShadow = true;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    // Drawn into no cascade before its programs are built (`uploads.ts`): made after the cell went through the door, it goes through its own.
    gateUntilBuilt(mesh);
    band.caster = mesh;
    return mesh;
  }

  /** Every kind drawn faded ("Ocultar outros") or not. */
  setFaded(faded: boolean): void {
    if (faded === this.faded) return;
    this.faded = faded;
    for (const band of this.bands) {
      const look = partLook(this.kit, band.kind, faded);
      for (const [key, mesh] of band.meshes) {
        // A shell's part drawn from afar keeps its far program once shown again (`drawFar`).
        mesh.material = !faded && mesh.userData['far'] === true ? this.kit.farShell : look.material;
        if (faded) mesh.userData['far'] = false;
        mesh.customDepthMaterial = partPoseDepth(look.material);
        mesh.renderOrder = look.renderOrder;
        mesh.visible = band.drawn.has(key) && look.visible;
      }
    }
  }

  private box: Box3 | null = null;
  /** Every piece the cell may draw, in three's world: its bands' sub-cell boxes that hold any instance (what the occlusion tests, `layer.ts` hideOccluded). */
  get bounds(): Box3 {
    if (this.box) return this.box;
    const box = new Box3();
    for (const band of this.bands) {
      for (let m = 0; m < LEAVES; m++) {
        if (band.start[m + 1] === band.start[m]) continue;
        const o = m * 6, b = band.box;
        box.expandByPoint(new Vector3(b[o], b[o + 1], b[o + 2]));
        box.expandByPoint(new Vector3(b[o + 3], b[o + 4], b[o + 5]));
      }
    }
    return (this.box = box);
  }

  /** What the cell draws now. */
  get triangles(): number {
    let sum = 0;
    for (const band of this.bands) for (const [key, level] of band.drawn) sum += band.meshes.get(key)!.count * band.screen.levels[level]!.triangles;
    return sum;
  }

  /** A mesh a band over the whole cell, made now to send its instances to the GPU ahead (`uploads.ts`): every run shares its buffers. */
  warmMeshes(): Mesh[] {
    return this.bands.filter((band) => !SHELL_PARTS.has(band.kind)).map((band) => {
      const key = LEAVES - 1;
      let mesh = band.meshes.get(key);
      if (!mesh) band.meshes.set(key, mesh = this.make(band, 0, LEAVES - 1));
      return mesh;
    });
  }

  dispose(): void {
    // A band's runs go at once: the first mesh disposed takes their shared buffer off the GPU (`WebGLObjects`).
    for (const band of this.bands) {
      for (const mesh of band.caster ? [...band.meshes.values(), band.caster] : band.meshes.values()) {
        // Its posed copies of the kit's levels: their own buffers freed, the kit's kept (`partPose.ts`).
        for (const [level, copy] of mesh.userData['posed'] as Map<number, BufferGeometry>) letGoPosed(copy, band.screen.levels[level]!.geometry);
        mesh.dispose();
      }
    }
    this.group.clear();
  }

  /** A sub-cell's level for the pixels a metre spans there: the coarsest whose error is under a pixel, NONE when an instance is. */
  private levelAt(band: Band, m: number, perMetre: number, held: number): number {
    const { levels, extent } = band.screen;
    // A shell's part: the sides its top-only level leaves out are as tall as its height or as wide as its thinnest plan
    // (a post's width, not its metre of height), so that face's smaller side is its error (`shellPartError`).
    const shell = SHELL_PARTS.has(band.kind);
    let k = 0;
    for (; k < levels.length; k++) {
      const next = k + 1;
      const bars = next === levels.length && band.screen.pieces[0] !== extent;
      const metres = next < levels.length
        ? (shell ? shellPartError(band.scale, m * 3) : largest(levels[next]!.error, band.scale, m * 3))
        : bars ? barsAcross(band, m) : diagonal(extent, band.scale, m * 3);
      if (metres * perMetre >= (next < levels.length ? PART_ERROR_PX : bars ? BAR_PIXELS : 1) * (next <= held ? 1 : COARSEN)) break;
    }
    // Under a pixel across its diagonal: not drawn, a shell's part too; nor a level of no triangles (a top-less part from afar, `kit.ts`).
    return k === levels.length || levels[k]!.triangles === 0 ? NONE : k;
  }

  /** The most pixels a metre spans over a run's sub-cells (its nearest). */
  private runPixels(band: Band, r: number, view: PartView): number {
    let most = 0;
    for (let m = this.runFirst[r]!; m <= this.runLast[r]!; m++) if (band.start[m + 1]! > band.start[m]!) most = Math.max(most, this.perMetre(band, m, view));
    return most;
  }

  /** A shell's part run drawn with the far program or the near one. */
  private drawFar(band: Band, mesh: InstancedMesh, far: boolean): void {
    mesh.userData['far'] = far;
    mesh.material = far ? this.kit.farShell : partLook(this.kit, band.kind, this.faded).material;
  }

  /** The pixels a metre spans at a sub-cell's nearest point to the eye. */
  private perMetre(band: Band, m: number, view: PartView): number {
    if (view.orthoPx !== null) return view.orthoPx;
    const b = band.box, o = m * 6;
    // Three's world: x, up, z; the map's y is -z.
    const dx = Math.max(b[o]! - view.x, 0, view.x - b[o + 3]!);
    const dy = Math.max(-b[o + 5]! - view.y, 0, view.y + b[o + 2]!);
    const dh = Math.max(b[o + 1]! - view.z, 0, view.z - b[o + 4]!);
    return view.pxAtMetre / Math.max(Math.hypot(dx, dy, dh), 1);
  }

  /** A run's posed copy of a level of its kind's model, bound at the run's first instance (`partPose.ts`), made once a level. */
  private posedLevel(band: Band, mesh: InstancedMesh, level: number): BufferGeometry {
    const copies = mesh.userData['posed'] as Map<number, BufferGeometry>;
    let copy = copies.get(level);
    if (!copy) {
      const at = mesh.userData['first'] as number;
      copy = posedCopy(band.screen.levels[level]!.geometry, band.poses, at);
      // A shell's part carries its finish, wear and ground per instance; the coarse level needs them too (`make`).
      if (band.looks) {
        copy.setAttribute(FINISH_ATTRIBUTE, new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS));
        copy.setAttribute('aDecay', new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS + 1));
        copy.setAttribute(GROUND_ATTRIBUTE, new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS + 2));
      }
      copies.set(level, copy);
    }
    return copy;
  }

  /** A run's mesh: the band's buffers bound at its first instance, its own bounds (three would read the matrices for them). */
  private make(band: Band, first: number, last: number): InstancedMesh {
    const look = partLook(this.kit, band.kind, this.faded);
    const at = band.start[first]!;
    // The kit's model with the band's poses bound at the run's first; a shell's part also its finish, wear and ground per instance (`shellParts.ts`).
    const geometry = posedCopy(band.screen.levels[0]!.geometry, band.poses, at);
    if (band.looks) {
      geometry.setAttribute(FINISH_ATTRIBUTE, new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS));
      geometry.setAttribute('aDecay', new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS + 1));
      geometry.setAttribute(GROUND_ATTRIBUTE, new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS + 2));
    }
    // No matrix of three's (`posePart`): the poses are the instances.
    const mesh = new InstancedMesh(geometry, look.material, 0);
    mesh.userData['posed'] = new Map<number, BufferGeometry>([[0, geometry]]);
    mesh.userData['first'] = at;
    mesh.customDepthMaterial = partPoseDepth(look.material);
    if (band.colours) mesh.instanceColor = new InterleavedBufferAttribute(band.colours, 3, at * 3) as unknown as InstancedBufferAttribute;
    mesh.count = band.start[last + 1]! - at;
    const box = new Box3();
    for (let m = first; m <= last; m++) {
      if (band.start[m + 1] === band.start[m]) continue;
      const o = m * 6, b = band.box;
      box.union(new Box3(new Vector3(b[o], b[o + 1], b[o + 2]), new Vector3(b[o + 3], b[o + 4], b[o + 5])));
    }
    mesh.boundingBox = box;
    mesh.boundingSphere = box.getBoundingSphere(new Sphere());
    mesh.name = `building-${band.kind}`;
    mesh.renderOrder = look.renderOrder;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);
    return mesh;
  }
}

/** A cell's parts out of `parts` and `root`, let go. */
export function dropParts(parts: Map<string, PartCell>, key: string, root: Group | null): void {
  const known = parts.get(key);
  if (!known) return;
  root?.remove(known.group);
  known.dispose();
  parts.delete(key);
}
