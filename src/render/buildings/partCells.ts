import { Box3, type BufferGeometry, Group, InstancedInterleavedBuffer, InstancedMesh, InterleavedBufferAttribute, type InstancedBufferAttribute, type Mesh, Sphere, Vector3 } from 'three';
import { gpuOnlyAttributes } from '../mesh/gpuOnly';
import { FINISH_ATTRIBUTE } from './cellArrays';
import { GROUND_ATTRIBUTE, LOOK_FLOATS } from './shellParts';
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
/** A sub-cell not drawn: every instance in it under a pixel. */
const NONE = 127;

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
  /** The level each sub-cell was last chosen at (hysteresis). */
  readonly held: Uint8Array;
  casts: boolean;
  /** Its widest piece as drawn now, m (`choose`): what a cascade's texel is measured against (`castInto`). */
  width: number;
  /** Its widest piece, NaN until first read (`choose`): its pieces and scales never change, so worked out once (PRD-30). */
  widest: number;
}

/** The largest of three lengths scaled. */
const largest = (a: Axes, s: Float32Array, o: number): number => Math.max(a[0] * s[o]!, a[1] * s[o + 1]!, a[2] * s[o + 2]!);
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
  /** Scratch for one band's runs this frame: each run's first and last sub-cell, its level and its instances. */
  private readonly runFirst = new Uint8Array(LEAVES);
  private readonly runLast = new Uint8Array(LEAVES);
  private readonly runLevel = new Uint8Array(LEAVES);
  private readonly runCount = new Uint32Array(LEAVES);

  /** `filing`: the cell's parts by band and sub-cell, as its job filed them (`partFiling.ts`): DO NOT read an instance here, the page only wraps the buffers handed over. */
  constructor(key: string, filing: PartFiling, private readonly kit: BuildingKit) {
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
        meshes: new Map(), drawn: new Map(), held: new Uint8Array(LEAVES), casts: false, width: 0, widest: Number.NaN,
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
      // Out: the runs drawn before and not now.
      for (const [key] of band.drawn) {
        let kept = false;
        for (let r = 0; r < runs && !kept; r++) kept = this.runFirst[r]! * LEAVES + this.runLast[r]! === key;
        if (kept) continue;
        band.meshes.get(key)!.visible = false;
        band.drawn.delete(key);
      }
      // In: each run now, at its level.
      const visible = partLook(this.kit, band.kind, this.faded).visible;
      for (let r = 0; r < runs; r++) {
        const key = this.runFirst[r]! * LEAVES + this.runLast[r]!, level = this.runLevel[r]!;
        if (band.drawn.get(key) === level && !recast) continue;
        let mesh = band.meshes.get(key);
        if (!mesh) band.meshes.set(key, mesh = this.make(band, this.runFirst[r]!, this.runLast[r]!));
        // A shell's part keeps its run's own copy of its one level (`make`); another kind its run's posed copy of the level.
        if (!band.looks) mesh.geometry = this.posedLevel(band, mesh, level);
        mesh.castShadow = casts;
        mesh.visible = visible;
        band.drawn.set(key, level);
      }
    }
  }

  /** A band's runs this frame (in the scratch arrays, their count returned): neighbours at one level, or joined at the finer where that costs less than a draw. */
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

  /** Before a sun cascade is drawn: each band drawn casts into it only where its widest piece spans the cascade's texel. */
  castInto(texel: number): void {
    for (const band of this.bands) {
      const casts = this.kit.castsShadow.has(band.kind) && band.width >= texel;
      for (const key of band.drawn.keys()) band.meshes.get(key)!.castShadow = casts;
    }
  }

  /** Every kind drawn faded ("Ocultar outros") or not. */
  setFaded(faded: boolean): void {
    if (faded === this.faded) return;
    this.faded = faded;
    for (const band of this.bands) {
      const look = partLook(this.kit, band.kind, faded);
      for (const [key, mesh] of band.meshes) {
        mesh.material = look.material;
        mesh.customDepthMaterial = partPoseDepth(look.material);
        mesh.renderOrder = look.renderOrder;
        mesh.visible = band.drawn.has(key) && look.visible;
      }
    }
  }

  /** What the cell draws now. */
  get triangles(): number {
    let sum = 0;
    for (const band of this.bands) for (const [key, level] of band.drawn) sum += band.meshes.get(key)!.count * band.screen.levels[level]!.triangles;
    return sum;
  }

  /** A mesh a band over the whole cell, made now to send its instances to the GPU ahead (`uploads.ts`): every run shares its buffers. */
  warmMeshes(): Mesh[] {
    return this.bands.map((band) => {
      const key = LEAVES - 1;
      let mesh = band.meshes.get(key);
      if (!mesh) band.meshes.set(key, mesh = this.make(band, 0, LEAVES - 1));
      return mesh;
    });
  }

  dispose(): void {
    // A band's runs go at once: the first mesh disposed takes their shared buffer off the GPU (`WebGLObjects`).
    for (const band of this.bands) {
      for (const mesh of band.meshes.values()) {
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
    let k = 0;
    for (; k < levels.length; k++) {
      const next = k + 1;
      const metres = next < levels.length ? largest(levels[next]!.error, band.scale, m * 3) : diagonal(extent, band.scale, m * 3);
      if (metres * perMetre >= (next <= held ? 1 : COARSEN)) break;
    }
    // Under a pixel across its diagonal: not drawn, a shell's part too.
    return k === levels.length ? NONE : k;
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
    if (!copy) copies.set(level, copy = posedCopy(band.screen.levels[level]!.geometry, band.poses, mesh.userData['first'] as number));
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
