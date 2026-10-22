import {
  BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Plane, Ray, Raycaster, RingGeometry, SphereGeometry, Vector2, Vector3,
  type Camera,
} from 'three';
import type { ProxyPack } from '@people/body/proxy';
import { GroomBody, type Tie } from './groom';
import {
  COLUMNS, KNOTS, compactShell, layShell, presetRecord, shellBuffer, shellGeometry, shellOf, shellPack, type ShellPreset, type ShellRecord,
} from './hairShell';

/** THE HAIR STUDIO: a hairstyle made the way VRoid Studio makes one (`hairShell.ts`) - a guide surface round the head with strands generated on it.
 *  The tools reshape the surface and the strands follow: comb and pull it, cut and grow it, give it volume, smooth it, wave it, move the parting,
 *  tie it. The hair is always one closed covering of strands: no scalp shows, nothing is painted. */

export type HairTool = 'comb' | 'grab' | 'cut' | 'grow' | 'puff' | 'smooth' | 'curl' | 'part' | 'tie';

const DM = 0.1;

export interface StudioBody {
  readonly positions: Float32Array;
  readonly faces: Uint16Array;
  readonly faceGroup: Uint8Array;
  readonly skinGroup: number;
  /** The skin's vertices (the body's own range). */
  readonly skin: readonly number[];
  /** Head and neck skin vertices: what the finished hair is pinned to. */
  readonly anchors: readonly number[];
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? U[] : T[K] };

export class HairStudio {
  readonly group = new Group();
  readonly body: GroomBody;
  tool: HairTool = 'comb';
  /** Brush radius, dm (as seen at the hair's depth). */
  radius = 0.9;
  strength = 0.6;
  mirror = true;
  private style: Mutable<ShellRecord>;
  /** The surface's rings of columns as last laid (for the brush to find what it touches). */
  private rings: number[][][][] = [];
  private readonly hairMesh: Mesh;
  private readonly skinMesh: Mesh;
  private readonly cursor: Mesh;
  private readonly tieMarks = new Group();
  private readonly raycaster = new Raycaster();
  private stroke: { plane: Plane; last: Vector3; tie: number } | null = null;
  private readonly undo: string[] = [];
  private readonly redo: string[] = [];
  private readonly anchors: readonly number[];
  /** When the hair was last rebuilt during a stroke (ms): at most twenty times a second while dragging. */
  private builtAt = 0;

  constructor(body: StudioBody, record: unknown, hairColour: number, skinColour: number) {
    this.body = new GroomBody(body.positions, body.skin, body.faces, body.faceGroup, body.skinGroup);
    this.anchors = body.anchors;
    let lowest = Infinity;
    for (let i = 1; i < body.positions.length; i += 3) lowest = Math.min(lowest, body.positions[i]!);
    this.group.scale.setScalar(DM);
    this.group.position.y = -lowest * DM;

    const tris: number[] = [];
    for (let f = 0; f < body.faceGroup.length; f++) {
      if (body.faceGroup[f] !== body.skinGroup) continue;
      const q = [body.faces[f * 4]!, body.faces[f * 4 + 1]!, body.faces[f * 4 + 2]!, body.faces[f * 4 + 3]!];
      tris.push(q[0]!, q[1]!, q[2]!);
      if (q[3] !== q[2]) tris.push(q[0]!, q[2]!, q[3]!);
    }
    const skinGeometry = new BufferGeometry();
    skinGeometry.setAttribute('position', new BufferAttribute(body.positions, 3));
    skinGeometry.setAttribute('normal', new BufferAttribute(this.body.normals, 3));
    skinGeometry.setIndex(tris);
    this.skinMesh = new Mesh(skinGeometry, new MeshStandardMaterial({ color: skinColour, roughness: 0.7 }));
    this.group.add(this.skinMesh);

    // The strands, the highlight drawn along them by the material's anisotropy (KHR_materials_anisotropy; its direction the geometry's tangent).
    this.hairMesh = new Mesh(new BufferGeometry(), new MeshPhysicalMaterial({ color: hairColour, roughness: 0.62, metalness: 0, anisotropy: 0.45, specularIntensity: 0.45, envMapIntensity: 0.12 }));
    this.hairMesh.castShadow = true;
    this.group.add(this.hairMesh);
    this.group.add(this.tieMarks);

    this.cursor = new Mesh(new RingGeometry(0.94, 1, 48), new MeshStandardMaterial({ color: 0x4f8cff, emissive: 0x4f8cff, side: DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.group.add(this.cursor);

    this.style = clone(shellOf(record) ?? presetRecord('bob', this.body));
    this.rebuild();
  }

  // ------------------------------------------------------------ styles

  preset(name: ShellPreset): void {
    this.remember();
    this.style = clone(presetRecord(name, this.body));
    this.rebuild();
  }

  /** The strands' count each side, their width against their spacing, the whole style's length and volume. */
  setStrands(n: number): void { this.style.strands = Math.round(n); this.rebuild(); }
  setOverlap(x: number): void { this.style.overlap = x; this.rebuild(); }
  get strands(): number { return this.style.strands; }
  get overlap(): number { return this.style.overlap; }
  get length(): number { return this.style.length.reduce((s, x) => s + x, 0) / this.style.length.length; }
  setLength(dm: number): void { const k = dm / Math.max(0.1, this.length); this.style.length = this.style.length.map((x) => Math.max(0.3, x * k)); this.rebuild(); }
  get volume(): number { return this.style.lift.reduce((s, x) => s + x, 0) / this.style.lift.length; }
  setVolume(dm: number): void { const d = dm - this.volume; this.style.lift = this.style.lift.map((x) => Math.max(0.02, x + d)); this.rebuild(); }
  get blunt(): boolean { return this.style.blunt; }
  setBlunt(on: boolean): void { this.style.blunt = on; this.rebuild(); }

  clearTies(): void { this.remember(); this.style.ties = []; this.rebuild(); }

  /** Kept for the frame loop: the hairstyle has no dynamics of its own in the studio. */
  tick(_dt: number): void { /* the surface is the style */ }

  // ------------------------------------------------------------ strokes

  private ray(ndc: Vector2, camera: Camera): Ray {
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster.ray.clone().applyMatrix4(this.group.matrixWorld.clone().invert());
  }

  /** The point under the pointer on the hair or the body, in dm. */
  private hit(ndc: Vector2, camera: Camera): Vector3 | null {
    this.raycaster.setFromCamera(ndc, camera);
    const h = this.raycaster.intersectObjects([this.hairMesh, this.skinMesh], false)[0];
    return h ? this.group.worldToLocal(h.point.clone()) : null;
  }

  /** The columns' points under the brush (round the pointer's ray, and its mirror): per column the nearest point's place along it and the falloff. */
  private under(ray: Ray): { k: number; t: number; w: number }[] {
    const rays = this.mirror ? [ray, mirrorRay(ray, this.body.skull[0])] : [ray];
    const out: { k: number; t: number; w: number }[] = [];
    const p = new Vector3(), r2 = this.radius * this.radius;
    // Every ring's column k is the style's column k (a tied style has two rings on the same columns).
    this.rings.flat().forEach((col, flat) => {
      const k = flat % (COLUMNS * 2);
      let best = Infinity, at = 0;
      col.forEach((q, i) => {
        p.set(q[0]!, q[1]!, q[2]!);
        for (const r of rays) { const d = r.distanceSqToPoint(p); if (d < best) { best = d; at = i; } }
      });
      if (best < r2) out.push({ k, t: at / (col.length - 1), w: (1 - best / r2) ** 2 });
    });
    return out;
  }

  hover(ndc: Vector2, camera: Camera): void {
    const at = this.hit(ndc, camera);
    this.cursor.visible = !!at;
    if (!at) return;
    this.cursor.position.copy(at);
    this.cursor.scale.setScalar(this.radius);
    this.cursor.lookAt(this.group.worldToLocal(camera.position.clone()));
  }

  /** A stroke starts; false when the pointer is on nothing. */
  begin(ndc: Vector2, camera: Camera, invert: boolean): boolean {
    const at = this.hit(ndc, camera);
    if (!at) return false;
    this.remember();
    const facing = new Vector3();
    camera.getWorldDirection(facing);
    let tie = -1;
    if (this.tool === 'tie') {
      // A tie grabbed near its middle is moved; elsewhere a new one (a pair, mirrored, when away from the middle).
      tie = this.style.ties.findIndex((t) => at.distanceTo(new Vector3(t.x, t.y, t.z)) < Math.max(0.35, t.radius * 1.5));
      if (tie < 0) {
        const out = at.clone().sub(new Vector3(...this.body.skull)).normalize().multiplyScalar(0.12);
        const t: Tie = { x: at.x + out.x, y: at.y + out.y, z: at.z + out.z, radius: 0.2 };
        const mid = this.body.skull[0];
        this.style.ties = this.mirror && Math.abs(t.x - mid) > 0.3 ? [t, { ...t, x: 2 * mid - t.x }] : [t];
        tie = 0;
      }
    }
    if (this.tool === 'part') this.style.part = Math.max(-0.6, Math.min(0.6, at.x - this.body.skull[0]));
    this.stroke = { plane: new Plane().setFromNormalAndCoplanarPoint(facing.clone().transformDirection(this.group.matrixWorld.clone().invert()).normalize(), at), last: at, tie };
    this.apply(ndc, camera, new Vector3(), invert);
    this.rebuild();
    return true;
  }

  move(ndc: Vector2, camera: Camera, invert: boolean): void {
    this.hover(ndc, camera);
    const s = this.stroke;
    if (!s) return;
    const at = this.ray(ndc, camera).intersectPlane(s.plane, new Vector3());
    if (!at) return;
    const delta = at.clone().sub(s.last);
    s.last = at;
    this.apply(ndc, camera, delta, invert);
    if (performance.now() - this.builtAt > 50) this.rebuild();
  }

  end(): void {
    if (!this.stroke) return;
    this.stroke = null;
    this.rebuild();
  }

  /** One touch of the tool; `delta` is how far the pointer moved on the stroke's plane (dm). */
  private apply(ndc: Vector2, camera: Camera, delta: Vector3, invert: boolean): void {
    const st = this.style, k = this.strength, sign = invert ? -1 : 1;
    const ray = this.ray(ndc, camera);
    const hits = this.under(ray);
    const mid = this.body.skull[0];
    // The mirrored side moves mirrored across the middle.
    const mx = (col: number): number => (this.mirror && (col < COLUMNS) !== (ray.origin.x + ray.direction.x * 10 > mid) ? -1 : 1);
    switch (this.tool) {
      case 'comb':
      case 'grab':
        // The surface's knots follow the pointer: a comb moves them more towards the ends (as a comb drags hair), a pull round the point grabbed.
        for (const { k: col, t, w } of hits) {
          for (let j = 1; j < KNOTS; j++) {
            const kt = j / (KNOTS - 1);
            const f = this.tool === 'comb' ? w * k * Math.max(0, kt - t + 0.35) : w * Math.max(0, 1 - Math.abs(kt - t) * 2.5);
            const o = (col * KNOTS + j) * 3;
            st.offsets[o] = st.offsets[o]! + delta.x * f * mx(col); st.offsets[o + 1] = st.offsets[o + 1]! + delta.y * f; st.offsets[o + 2] = st.offsets[o + 2]! + delta.z * f;
          }
        }
        break;
      case 'cut':
        // Scissors: each column under the brush cut where the pointer crosses it.
        for (const { k: col, t, w } of hits) if (w > 0.2 && t > 0.08) st.length[col] = Math.min(st.length[col]!, st.length[col]! * t);
        break;
      case 'grow':
        for (const { k: col, w } of hits) st.length[col] = Math.max(0.3, Math.min(8, st.length[col]! + sign * w * k * 0.12));
        break;
      case 'puff':
        for (const { k: col, w } of hits) st.lift[col] = Math.max(0.02, Math.min(0.8, st.lift[col]! + sign * w * k * 0.03));
        break;
      case 'curl':
        for (const { k: col, w } of hits) st.wave[col] = Math.max(0, Math.min(0.25, st.wave[col]! + sign * w * k * 0.01));
        break;
      case 'smooth': {
        // Each touched column brought towards its neighbours: lengths, lift, waves and pulls.
        const n = COLUMNS * 2;
        const nb = (col: number, d: number): number => (col + d + n) % n;
        for (const { k: col, w } of hits) {
          const f = w * k * 0.5;
          for (const arr of [st.length, st.lift, st.wave]) arr[col] = arr[col]! + ((arr[nb(col, -1)]! + arr[nb(col, 1)]!) / 2 - arr[col]!) * f;
          for (let j = 0; j < KNOTS * 3; j++) {
            const o = col * KNOTS * 3 + j;
            st.offsets[o] = st.offsets[o]! + ((st.offsets[nb(col, -1) * KNOTS * 3 + j]! + st.offsets[nb(col, 1) * KNOTS * 3 + j]!) / 2 - st.offsets[o]!) * f;
          }
        }
        break;
      }
      case 'tie': {
        const t = this.stroke ? st.ties[this.stroke.tie] : undefined;
        if (t) { t.x += delta.x; t.y += delta.y; t.z += delta.z; }
        const pair = this.stroke && st.ties.length === 2 ? st.ties[1 - this.stroke.tie] : undefined;
        if (t && pair) { pair.x -= delta.x; pair.y += delta.y; pair.z += delta.z; }
        break;
      }
      case 'part':
        if (this.stroke) this.style.part = Math.max(-0.6, Math.min(0.6, this.stroke.last.x - mid));
        break;
    }
  }

  // ------------------------------------------------------------ the mesh

  private rebuild(): void {
    this.rings = layShell(this.body, this.style);
    shellBuffer(shellGeometry(this.body, this.style, this.rings), this.hairMesh.geometry);
    this.builtAt = performance.now();
    this.tieMarks.clear();
    for (const t of this.style.ties) {
      const mark = new Mesh(new SphereGeometry(t.radius * 0.7, 16, 12), new MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.4 }));
      mark.position.set(t.x, t.y, t.z);
      this.tieMarks.add(mark);
    }
  }

  // ------------------------------------------------------------ keeping

  private remember(): void {
    this.undo.push(JSON.stringify(this.style));
    if (this.undo.length > 60) this.undo.shift();
    this.redo.length = 0;
  }

  undoStep(): void {
    const last = this.undo.pop();
    if (!last) return;
    this.redo.push(JSON.stringify(this.style));
    this.style = JSON.parse(last) as Mutable<ShellRecord>;
    this.rebuild();
  }

  redoStep(): void {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(JSON.stringify(this.style));
    this.style = JSON.parse(next) as Mutable<ShellRecord>;
    this.rebuild();
  }

  setColour(c: number): void { (this.hairMesh.material as MeshPhysicalMaterial).color.set(c); }

  record(): ShellRecord { return compactShell(this.style); }
  pack(): ProxyPack { return shellPack(this.style, this.body, this.anchors); }
  get count(): number { return this.style.strands * 4; }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
    });
  }
}

function clone(r: ShellRecord): Mutable<ShellRecord> { return JSON.parse(JSON.stringify(r)) as Mutable<ShellRecord>; }

/** The ray mirrored across the body's middle (x = `mid`). */
function mirrorRay(r: Ray, mid: number): Ray {
  return new Ray(new Vector3(2 * mid - r.origin.x, r.origin.y, r.origin.z), new Vector3(-r.direction.x, r.direction.y, r.direction.z));
}
