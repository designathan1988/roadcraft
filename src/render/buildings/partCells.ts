import { Box3, Group, InstancedInterleavedBuffer, type InstancedBufferAttribute, InstancedMesh, InterleavedBufferAttribute, type Mesh, Sphere, Vector3 } from 'three';
import { gpuOnlyAttributes } from '../mesh/gpuOnly';
import { type CellArrays, FINISH_ATTRIBUTE } from './cellArrays';
import { GROUND_ATTRIBUTE, LOOK_FLOATS } from './shellParts';
import { type Axes, type BuildingKit, PART_KINDS, type PartKind, type PartScreen } from './kit';
import { partLook } from './fade';
import { BATCH_CELL, DETAIL_CELL } from './layerCells';

/** THE PARTS OF ONE CELL OF BUILDINGS, EACH KIND DRAWN AT THE LEVEL ITS ERROR ON THE SCREEN ALLOWS */
// One buffer a kind for the cell, its sub-cells in Morton order: sub-cells side by side in that order are one run of it, drawn
// by one mesh bound at the run's offset (three binds an interleaved attribute at its `offset`, `WebGLBindingStates`).
// Each sub-cell takes its level; neighbours at one level are one draw. Choosing a level swaps a mesh's geometry or hides it:
// nothing is emitted again, and the choice reads sub-cells, never instances.
// DO NOT give a kind one buffer whatever its instances' shapes: a frame is also a gourmet balcony's post (1 m deep), and the
// largest scale over a sub-cell held every window at full detail; instances are banded by their error, each band its own buffer.

/** Sub-cells a side of a cell: four, as `morton` is made for. */
const SIDE = Math.round(BATCH_CELL / DETAIL_CELL);
if (SIDE !== 4) throw new Error(`[buildings] a cell's parts are filed four sub-cells a side, not ${SIDE}`);
const LEAVES = SIDE * SIDE;
/** A level is left for a coarser one once that one's error is under this share of a pixel (a shadow under this share of a texel), and taken back at a whole one. */
const COARSEN = 0.85;
/** What a draw is taken to cost in triangles: two runs side by side are drawn as one at the finer level when that costs less, and a band is kept apart only if it draws as much. */
const DRAW_TRIANGLES = 4096;
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

/** A sub-cell's index in Morton order from its column and row in the cell. */
const morton = (u: number, v: number): number => (u & 1) | ((v & 1) << 1) | ((u & 2) << 1) | ((v & 2) << 2);

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
  readonly matrices: InstancedInterleavedBuffer;
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
}

/** The error a band's instances are grouped by starts at this, m, each band four times the last's. */
const BAND_BASE = 0.01;
/** The band of an instance whose kind's first coarser level leaves out `metres` of it (its size, for a kind of one level). */
function bandOf(metres: number): number {
  let band = 0;
  for (let edge = BAND_BASE; band < 15 && metres > edge; edge *= 4) band++;
  return band;
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

  /** `details`: the cell's sub-cells (`DETAIL_CELL`) as the workers made them (`cellWork.ts`), by key "column,row". */
  constructor(key: string, details: readonly (readonly [string, CellArrays])[], private readonly kit: BuildingKit) {
    this.group.name = 'building-parts';
    this.group.matrixAutoUpdate = false;
    this.group.updateMatrix();
    const comma = key.indexOf(',');
    const ci = Number(key.slice(0, comma)), cj = Number(key.slice(comma + 1));
    const slots: (CellArrays | undefined)[] = [];
    for (const [sub, arrays] of details) {
      const at = sub.indexOf(',');
      const u = Number(sub.slice(0, at)) - ci * SIDE, v = Number(sub.slice(at + 1)) - cj * SIDE;
      if (u < 0 || v < 0 || u >= SIDE || v >= SIDE) throw new Error(`[buildings] sub-cell ${sub} is not in cell ${key}`);
      slots[morton(u, v)] = arrays;
    }
    const own: Record<string, InstancedInterleavedBuffer> = {};
    for (const kind of PART_KINDS) {
      for (const band of this.file(kind, slots)) {
        own[`${kind}-${this.bands.length}-matrices`] = band.matrices;
        if (band.colours) own[`${kind}-${this.bands.length}-colours`] = band.colours;
        if (band.looks) own[`${kind}-${this.bands.length}-looks`] = band.looks;
        this.bands.push(band);
      }
    }
    // On the GPU only: a lost context asks the cell of the workers again (`layer.ts` `refill`).
    gpuOnlyAttributes(this.group, own, () => ({}));
  }

  /** One kind's instances by band, each laid out by sub-cell in Morton order, with each sub-cell's box and largest scales */
  // Once a cell lands, on the page: one pass reads each instance's scales and band, the other copies; a sub-cell all of one band is copied whole.
  private file(kind: PartKind, slots: readonly (CellArrays | undefined)[]): Band[] {
    const screen = this.kit.screen[kind];
    const first = screen.levels.length > 1 ? screen.levels[1]!.error : null;
    // Each instance's band; each band's count and largest scales by sub-cell; the band each sub-cell is all of (-1: mixed).
    const bandsOf: (Uint8Array | undefined)[] = [];
    const perBand = new Map<number, { counts: Uint32Array; scale: Float32Array }>();
    const whole = new Int8Array(LEAVES).fill(-1);
    let coloured = false, looked = false;
    for (let m = 0; m < LEAVES; m++) {
      const p = slots[m]?.parts[kind];
      if (!p) continue;
      coloured ||= p.instanceColor !== undefined;
      looked ||= p.looks !== undefined;
      const bands = new Uint8Array(p.count), e = p.instanceMatrix;
      let only = -2, lastBand = -1;
      let into: { counts: Uint32Array; scale: Float32Array } | undefined;
      for (let i = 0; i < p.count; i++) {
        const o = i * 16;
        // The model's axes as the instance scales them: the columns of its matrix.
        const sx = Math.sqrt(e[o]! * e[o]! + e[o + 1]! * e[o + 1]! + e[o + 2]! * e[o + 2]!);
        const sy = Math.sqrt(e[o + 4]! * e[o + 4]! + e[o + 5]! * e[o + 5]! + e[o + 6]! * e[o + 6]!);
        const sz = Math.sqrt(e[o + 8]! * e[o + 8]! + e[o + 9]! * e[o + 9]! + e[o + 10]! * e[o + 10]!);
        const metres = first ? Math.max(first[0] * sx, first[1] * sy, first[2] * sz) : Math.sqrt((screen.extent[0] * sx) ** 2 + (screen.extent[1] * sy) ** 2 + (screen.extent[2] * sz) ** 2);
        const b = bandOf(metres);
        bands[i] = b;
        only = only === -2 || only === b ? b : -1;
        if (b !== lastBand || !into) {
          into = perBand.get(b);
          if (!into) perBand.set(b, into = { counts: new Uint32Array(LEAVES), scale: new Float32Array(LEAVES * 3) });
          lastBand = b;
        }
        into.counts[m] = into.counts[m]! + 1;
        const at = m * 3, scale = into.scale;
        if (sx > scale[at]!) scale[at] = sx;
        if (sy > scale[at + 1]!) scale[at + 1] = sy;
        if (sz > scale[at + 2]!) scale[at + 2] = sz;
      }
      bandsOf[m] = bands;
      whole[m] = only;
    }
    // A band drawing less than a draw's worth joins the next coarser one (or the last the one before): its error only grows.
    const order = [...perBand.keys()].sort((a, b) => a - b);
    const into = new Uint8Array(16);
    let open: number[] = [];
    for (const band of order) {
      open.push(band);
      let total = 0;
      for (const b of open) for (const c of perBand.get(b)!.counts) total += c;
      if (total * screen.levels[0]!.triangles < DRAW_TRIANGLES && band !== order.at(-1)) continue;
      for (const b of open) into[b] = band;
      open = [];
    }
    const merged = new Map<number, { counts: Uint32Array; scale: Float32Array }>();
    for (const [b, { counts, scale }] of perBand) {
      const to = into[b]!;
      let sum = merged.get(to);
      if (!sum) merged.set(to, sum = { counts: new Uint32Array(LEAVES), scale: new Float32Array((LEAVES + 1) * 3) });
      for (let m = 0; m < LEAVES; m++) {
        sum.counts[m] = sum.counts[m]! + counts[m]!;
        for (let k = 0; k < 3; k++) {
          sum.scale[m * 3 + k] = Math.max(sum.scale[m * 3 + k]!, scale[m * 3 + k]!);
          sum.scale[LEAVES * 3 + k] = Math.max(sum.scale[LEAVES * 3 + k]!, scale[m * 3 + k]!);
        }
      }
    }
    const out: Band[] = [];
    for (const [band, { counts, scale }] of [...merged].sort((a, b) => a[0] - b[0])) {
      let total = 0;
      for (const c of counts) total += c;
      const matrices = new Float32Array(total * 16), colours = coloured ? new Float32Array(total * 3) : null;
      const looks = looked ? new Float32Array(total * LOOK_FLOATS) : null;
      const start = new Uint32Array(LEAVES + 1);
      const box = new Float64Array(LEAVES * 6);
      let at = 0;
      for (let m = 0; m < LEAVES; m++) {
        start[m] = at;
        const p = slots[m]?.parts[kind];
        if (!p || counts[m] === 0) continue;
        // The sub-cell's box for the kind: a band's own is inside it.
        for (let k = 0; k < 6; k++) box[m * 6 + k] = p.bounds[k]!;
        const e = p.instanceMatrix, tint = p.instanceColor, look = p.looks;
        if (whole[m]! >= 0) {
          matrices.set(e.subarray(0, p.count * 16), at * 16);
          if (colours && tint) colours.set(tint.subarray(0, p.count * 3), at * 3);
          if (looks && look) looks.set(look.subarray(0, p.count * LOOK_FLOATS), at * LOOK_FLOATS);
          at += p.count;
          continue;
        }
        const bands = bandsOf[m]!;
        for (let i = 0; i < p.count; i++) {
          if (into[bands[i]!] !== band) continue;
          for (let k = 0; k < 16; k++) matrices[at * 16 + k] = e[i * 16 + k]!;
          if (colours && tint) for (let k = 0; k < 3; k++) colours[at * 3 + k] = tint[i * 3 + k]!;
          if (looks && look) for (let k = 0; k < LOOK_FLOATS; k++) looks[at * LOOK_FLOATS + k] = look[i * LOOK_FLOATS + k]!;
          at++;
        }
      }
      start[LEAVES] = at;
      out.push({
        kind, screen, start, box, scale,
        matrices: new InstancedInterleavedBuffer(matrices, 16), colours: colours ? new InstancedInterleavedBuffer(colours, 3) : null,
        looks: looks ? new InstancedInterleavedBuffer(looks, LOOK_FLOATS) : null,
        meshes: new Map(), drawn: new Map(), held: new Uint8Array(LEAVES), casts: false, width: 0,
      });
    }
    return out;
  }

  /** Each sub-cell of each band at the coarsest level whose error is under a pixel, none where an instance is; shadows cast where a piece spans a texel. */
  choose(view: PartView): void {
    const was = this.chosenFor;
    if (was.x === view.x && was.y === view.y && was.z === view.z && was.pxAtMetre === view.pxAtMetre && was.orthoPx === view.orthoPx && was.shadowTexel === view.shadowTexel) return;
    Object.assign(was, view);
    for (const band of this.bands) {
      const runs = this.runsOf(band, view);
      let width = 0;
      for (const piece of band.screen.pieces) width = Math.max(width, middle(piece, band.scale, LEAVES * 3));
      // A shell's part casts at any size, as the shell it was laid in did.
      if (band.screen.whole) width = Infinity;
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
        // A shell's part keeps its run's own copy of its one level (`make`).
        if (!band.looks) mesh.geometry = band.screen.levels[level]!.geometry;
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
        if (mesh.userData['ownGeometry']) mesh.geometry.dispose();
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
    // A shell's part is drawn under a pixel too, as the shell it was laid in was.
    return k === levels.length ? (band.screen.whole ? levels.length - 1 : NONE) : k;
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

  /** A run's mesh: the band's buffers bound at its first instance, its own bounds (three would read the matrices for them). */
  private make(band: Band, first: number, last: number): InstancedMesh {
    const look = partLook(this.kit, band.kind, this.faded);
    const at = band.start[first]!;
    // A shell's part reads its finish, wear and ground per instance off its own copy of the model, bound at the run's first (`shellParts.ts`).
    const geometry = band.looks ? band.screen.levels[0]!.geometry.clone() : band.screen.levels[0]!.geometry;
    if (band.looks) {
      geometry.setAttribute(FINISH_ATTRIBUTE, new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS));
      geometry.setAttribute('aDecay', new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS + 1));
      geometry.setAttribute(GROUND_ATTRIBUTE, new InterleavedBufferAttribute(band.looks, 1, at * LOOK_FLOATS + 2));
    }
    const mesh = new InstancedMesh(geometry, look.material, 0);
    if (band.looks) mesh.userData['ownGeometry'] = true;
    mesh.instanceMatrix = new InterleavedBufferAttribute(band.matrices, 16, at * 16) as unknown as InstancedBufferAttribute;
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
