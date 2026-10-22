import {
  BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshPhysicalMaterial, MeshStandardMaterial, Plane, Ray, Raycaster, RingGeometry, SphereGeometry, Vector2, Vector3,
  type Camera,
} from 'three';
import type { ProxyPack } from '@people/body/proxy';
import { GroomBody, type Tie } from './groom';
import {
  COLUMNS, KNOTS, LOCK_STEP, compactShell, fringeLocks, layShell, onHead, presetRecord, resample, shellBuffer, shellGeometry, shellOf, shellPack,
  type Lock, type ShellPreset, type ShellRecord,
} from './hairShell';

/** THE HAIR STUDIO: a hairstyle made the way VRoid Studio makes one (`hairShell.ts`) - a guide surface round the head with strands generated on it.
 *  The tools reshape the surface and the strands follow: comb and pull it, cut and grow it, give it volume, smooth it, wave it, move the parting,
 *  tie it. The hair is always one closed covering of strands: no scalp shows, nothing is painted. */

export type HairTool = 'draw' | 'comb' | 'grab' | 'cut' | 'grow' | 'puff' | 'smooth' | 'curl' | 'part' | 'tie' | 'erase';
export type LockKind = 'straight' | 'curl' | 'braid';

const DM = 0.1;
/** How far the parting may move off the middle (dm): a side parting sits 2-3 cm off it. */
const PART = 0.3;
/** Real limits (dm): hair up to 60 cm, standing at most 2.5 cm off the head, waves up to 1.2 cm, a lock pulled at most 15 cm. */
const MAX_LENGTH = 6, MAX_LIFT = 0.25, MAX_WAVE = 0.12, MAX_PULL = 1.5;

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
  /** New drawn locks: half width (dm) and kind. */
  lockWidth = 0.08;
  lockKind: LockKind = 'straight';
  private style: Mutable<ShellRecord>;
  /** The lock being drawn (points, dm), shown as it is drawn. */
  private drawing: number[][] | null = null;
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
    this.hairMesh = new Mesh(new BufferGeometry(), new MeshPhysicalMaterial({ color: hairColour, roughness: 0.6, metalness: 0, anisotropy: 0.35, specularIntensity: 0.4, envMapIntensity: 0.12 }));
    this.hairMesh.castShadow = true;
    this.group.add(this.hairMesh);
    this.group.add(this.tieMarks);

    this.cursor = new Mesh(new RingGeometry(0.94, 1, 48), new MeshStandardMaterial({ color: 0x4f8cff, emissive: 0x4f8cff, side: DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.group.add(this.cursor);

    this.style = clone(shellOf(record, this.body) ?? presetRecord('bob', this.body));
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
  setLength(dm: number): void { const k = dm / Math.max(0.1, this.length); this.style.length = this.style.length.map((x) => Math.max(0.3, Math.min(MAX_LENGTH, x * k))); this.rebuild(); }
  get volume(): number { return this.style.lift.reduce((s, x) => s + x, 0) / this.style.lift.length; }
  setVolume(dm: number): void { const d = dm - this.volume; this.style.lift = this.style.lift.map((x) => Math.max(0.02, Math.min(MAX_LIFT, x + d))); this.rebuild(); }
  get blunt(): boolean { return this.style.blunt; }
  setBlunt(on: boolean): void { this.style.blunt = on; this.rebuild(); }

  clearTies(): void { this.remember(); this.style.ties = []; this.rebuild(); }

  /** A fringe added over the front (straight, or swept to one side); a tied tail braided or not; every drawn lock taken off. */
  addFringe(side: boolean): void { this.remember(); this.style.locks = [...this.locks().filter((l) => !l.fringe), ...fringeLocks(this.body, side).map((l) => ({ ...l, fringe: true }))]; this.rebuild(); }
  toggleBraid(): void { this.remember(); this.style.braid = !this.style.braid; this.rebuild(); }
  get braid(): boolean { return !!this.style.braid; }
  clearLocks(): void { this.remember(); this.style.locks = []; this.rebuild(); }
  get lockCount(): number { return this.locks().length; }
  private locks(): (Lock & { fringe?: boolean })[] { return (this.style.locks ??= []) as (Lock & { fringe?: boolean })[]; }

  /** Kept for the frame loop: the hairstyle has no dynamics of its own in the studio. */
  tick(_dt: number): void { /* the surface is the style */ }

  // ------------------------------------------------------------ strokes

  private ray(ndc: Vector2, camera: Camera): Ray {
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster.ray.clone().applyMatrix4(this.group.matrixWorld.clone().invert());
  }

  /** The point under the pointer on the hair or the body, in dm. */
  private hit(ndc: Vector2, camera: Camera, bodyOnly = false): Vector3 | null {
    this.raycaster.setFromCamera(ndc, camera);
    const h = this.raycaster.intersectObjects(bodyOnly ? [this.skinMesh] : [this.hairMesh, this.skinMesh], false)[0];
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
    if (this.tool === 'draw') { const skin = this.hit(ndc, camera, true); this.drawing = [this.drawPoint(skin ?? at, true)]; }
    if (this.tool === 'erase') {
      const ray = this.ray(ndc, camera);
      const r2 = this.radius * this.radius;
      this.style.locks = this.locks().filter((l) => { for (let i = 0; i + 2 < l.pts.length; i += 3) if (ray.distanceSqToPoint(new Vector3(l.pts[i], l.pts[i + 1], l.pts[i + 2])) < r2) return false; return true; });
    }
    if (this.tool === 'part') this.style.part = Math.max(-PART, Math.min(PART, at.x - this.body.skull[0]));
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
    if (this.tool === 'draw' && this.drawing) {
      // The stroke follows the head and the hair where the pointer is on them, the stroke's plane where it is past them (a lock hanging free).
      // On the body only: the hair (and the lock being drawn) would lift every next point onto the last one.
      const on = this.hit(ndc, camera, true);
      const q = on ? this.drawPoint(on, true) : this.drawPoint(at, false);
      if (Math.hypot(q[0]! - this.drawing.at(-1)![0]!, q[1]! - this.drawing.at(-1)![1]!, q[2]! - this.drawing.at(-1)![2]!) > LOCK_STEP * 0.6) this.drawing.push(q);
      if (performance.now() - this.builtAt > 50) this.rebuild();
      return;
    }
    if (this.tool === 'erase') return;
    this.apply(ndc, camera, delta, invert);
    if (performance.now() - this.builtAt > 50) this.rebuild();
  }

  end(): void {
    if (!this.stroke) return;
    this.stroke = null;
    if (this.drawing) {
      const lock = this.lockOf(this.drawing);
      this.drawing = null;
      if (lock) {
        this.locks().push(lock);
        // Mirrored across the middle, as the base is (a centred lock is not doubled).
        const mid = this.body.skull[0];
        if (this.mirror && Math.abs(lock.pts[0]! - mid) > 0.15) this.locks().push({ ...lock, pts: lock.pts.map((v, i) => (i % 3 === 0 ? 2 * mid - v : v)) });
      }
    }
    this.rebuild();
  }

  /** A drawn point. Drawn on the scalp or the hair over it: on the outside of the base hair (layered over it). Drawn on the skin elsewhere (the
   *  forehead, a cheek, the neck): just over it. Drawn in the air (past the head - a quiff, a lock held out): exactly where drawn, out of the body. */
  private drawPoint(at: Vector3, onSurface: boolean): number[] {
    const h = this.body.head;
    const q = [at.x, at.y, at.z];
    if (onSurface && at.y > this.body.hugFloor && this.body.aboveHairline(at.x, at.y, at.z) > -0.03) return onHead(h, [at.x - h.c[0]!, at.y - h.c[1]!, at.z - h.c[2]!], 0.13);
    if (onSurface) {
      const o = [q[0]! - h.c[0]!, Math.max(0, q[1]! - h.c[1]!), q[2]! - h.c[2]!], l = Math.hypot(o[0]!, o[1]!, o[2]!) || 1;
      for (let c = 0; c < 3; c++) q[c] = q[c]! + o[c]! / l * 0.04;
    }
    this.body.collide(q, 0, 0.04, false);
    return q;
  }

  /** A stroke as a lock: smoothed (a few 1-2-1 passes), resampled LOCK_STEP apart; null when too short. */
  private lockOf(stroke: number[][]): Lock | null {
    if (stroke.length < 2) return null;
    let pts = stroke.map((q) => [...q]);
    for (let pass = 0; pass < 3; pass++) pts = pts.map((q, i) => (i === 0 || i === pts.length - 1 ? q : [0, 1, 2].map((c) => (pts[i - 1]![c]! + 2 * q[c]! + pts[i + 1]![c]!) / 4)));
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0]! - pts[i - 1]![0]!, pts[i]![1]! - pts[i - 1]![1]!, pts[i]![2]! - pts[i - 1]![2]!);
    if (len < LOCK_STEP * 2) return null;
    const even = resample(pts, Math.round(len / LOCK_STEP) + 1);
    return { pts: even.flat(), width: this.lockWidth, curl: this.lockKind === 'curl' ? 0.07 : 0, braid: this.lockKind === 'braid', blunt: false };
  }

  /** The drawn locks' points under the brush (round the ray and its mirror): lock, point and falloff. */
  private locksUnder(ray: Ray): { l: Lock; i: number; w: number }[] {
    const rays = this.mirror ? [ray, mirrorRay(ray, this.body.skull[0])] : [ray];
    const out: { l: Lock; i: number; w: number }[] = [], r2 = this.radius * this.radius, p = new Vector3();
    for (const l of this.locks()) {
      let best = Infinity, at = -1;
      for (let i = 3; i + 2 < l.pts.length; i += 3) {
        p.set(l.pts[i]!, l.pts[i + 1]!, l.pts[i + 2]!);
        for (const r of rays) { const d = r.distanceSqToPoint(p); if (d < best) { best = d; at = i / 3; } }
      }
      if (at > 0 && best < r2) out.push({ l, i: at, w: (1 - best / r2) ** 2 });
    }
    return out;
  }

  /** A lock made physical again after an edit: every segment back to LOCK_STEP from its root, out of the head and the body. */
  private settleLock(l: Lock): void {
    const h = this.body.head;
    for (let i = 3; i + 2 < l.pts.length; i += 3) {
      const a = [l.pts[i - 3]!, l.pts[i - 2]!, l.pts[i - 1]!];
      let q = [l.pts[i]!, l.pts[i + 1]!, l.pts[i + 2]!];
      const d = Math.hypot(q[0]! - a[0]!, q[1]! - a[1]!, q[2]! - a[2]!) || 1;
      q = [0, 1, 2].map((c) => a[c]! + (q[c]! - a[c]!) / d * LOCK_STEP);
      const v = [q[0]! - h.c[0]!, q[1]! - h.c[1]!, q[2]! - h.c[2]!], r = Math.hypot(v[0]!, v[1]!, v[2]!) || 1;
      const min = h.radius([v[0]! / r, v[1]! / r, v[2]! / r]) + 0.03;
      if (r < min) q = [0, 1, 2].map((c) => h.c[c]! + v[c]! / r * min);
      this.body.collide(q, 0, 0.04, false);
      l.pts[i] = q[0]!; l.pts[i + 1] = q[1]!; l.pts[i + 2] = q[2]!;
    }
  }

  /** One touch of the tool; `delta` is how far the pointer moved on the stroke's plane (dm). */
  private apply(ndc: Vector2, camera: Camera, delta: Vector3, invert: boolean): void {
    const st = this.style, k = this.strength, sign = invert ? -1 : 1;
    const ray = this.ray(ndc, camera);
    const hits = this.under(ray);
    const mid = this.body.skull[0];
    // The mirrored side moves mirrored across the middle.
    const mx = (col: number): number => (this.mirror && (col < COLUMNS) !== (ray.origin.x + ray.direction.x * 10 > mid) ? -1 : 1);
    // The drawn locks under the brush, edited with the same tools.
    for (const { l, i, w } of this.locksUnder(ray)) {
      const n = l.pts.length / 3;
      switch (this.tool) {
        case 'comb': case 'grab':
          for (let j = Math.max(1, this.tool === 'grab' ? i - 3 : i); j < n; j++) {
            const f = this.tool === 'comb' ? w * k * Math.min(1, (j - i + 2) / 4) : w * Math.max(0, 1 - Math.abs(j - i) / 4);
            l.pts[j * 3] = l.pts[j * 3]! + delta.x * f * (this.mirror && Math.sign(l.pts[0]! - mid) !== Math.sign(ray.origin.x - mid) ? -1 : 1);
            l.pts[j * 3 + 1] = l.pts[j * 3 + 1]! + delta.y * f; l.pts[j * 3 + 2] = l.pts[j * 3 + 2]! + delta.z * f;
          }
          break;
        case 'cut': if (w > 0.2 && i >= 2) { l.pts = l.pts.slice(0, (i + 1) * 3); l.blunt = true; } break;
        case 'grow': if (!invert && n < 120) { const e = l.pts.slice(-6); l.pts.push(e[3]! * 2 - e[0]!, e[4]! * 2 - e[1]! - 0.01, e[5]! * 2 - e[2]!); } else if (invert && n > 3) l.pts = l.pts.slice(0, -3); break;
        case 'curl': l.curl = Math.max(0, Math.min(MAX_WAVE, l.curl + sign * w * k * 0.006)); break;
        case 'puff': l.width = Math.max(0.03, Math.min(0.16, l.width + sign * w * k * 0.004)); break;
        default: break;
      }
      this.settleLock(l);
    }
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
            const l = Math.hypot(st.offsets[o]!, st.offsets[o + 1]!, st.offsets[o + 2]!);
            if (l > MAX_PULL) for (let c = 0; c < 3; c++) st.offsets[o + c] = st.offsets[o + c]! * MAX_PULL / l;
          }
        }
        break;
      case 'cut':
        // Scissors: each column under the brush cut where the pointer crosses it.
        for (const { k: col, t, w } of hits) if (w > 0.2 && t > 0.08) st.length[col] = Math.min(st.length[col]!, st.length[col]! * t);
        break;
      case 'grow':
        for (const { k: col, w } of hits) st.length[col] = Math.max(0.3, Math.min(MAX_LENGTH, st.length[col]! + sign * w * k * 0.12));
        break;
      case 'puff':
        for (const { k: col, w } of hits) st.lift[col] = Math.max(0.02, Math.min(MAX_LIFT, st.lift[col]! + sign * w * k * 0.015));
        break;
      case 'curl':
        for (const { k: col, w } of hits) st.wave[col] = Math.max(0, Math.min(MAX_WAVE, st.wave[col]! + sign * w * k * 0.006));
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
        if (this.stroke) this.style.part = Math.max(-PART, Math.min(PART, this.stroke.last.x - mid));
        break;
    }
  }

  // ------------------------------------------------------------ the mesh

  private rebuild(): void {
    this.rings = layShell(this.body, this.style);
    const preview = this.drawing && this.drawing.length > 1 ? this.lockOf(this.drawing) : null;
    const shown = preview ? { ...this.style, locks: [...this.locks(), preview] } : this.style;
    shellBuffer(shellGeometry(this.body, shown, this.rings), this.hairMesh.geometry);
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
