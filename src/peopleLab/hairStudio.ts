import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshStandardMaterial, Plane, Ray, Raycaster, RingGeometry, SphereGeometry, Vector2, Vector3,
  type Camera,
} from 'three';
import {
  GroomBody, decodeGroom, encodeGroom, gather, groomMargin, levelCut, groomPack, plant, remember, settle, step,
  type Guide, type GroomRecord, type Tie,
} from './groom';
import type { ProxyPack } from '@people/body/proxy';
import { HairVolume } from './hairVolume';

/** THE HAIR STUDIO: hair made from guide strands with the grooming tools (Blender's curves sculpting, XGen's and Ornatrix's guides) -
 *  plant, fill, comb, pull, cut, grow, puff, smooth, curl, part, tie, delete - with gravity on or off and the body never passed through. */

export type HairTool = 'plant' | 'comb' | 'grab' | 'cut' | 'grow' | 'puff' | 'smooth' | 'curl' | 'part' | 'tie' | 'erase';

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

export class HairStudio {
  readonly group = new Group();
  readonly body: GroomBody;
  guides: Guide[] = [];
  ties: Tie[] = [];
  tool: HairTool = 'comb';
  /** Brush radius, dm (as seen at the hair's depth). */
  radius = 0.9;
  strength = 0.6;
  /** New guides: length (dm), clump half width (dm), how many a click plants. */
  length = 3.2;
  thickness = 0.18;
  density = 6;
  gravity = false;
  /** How firmly the hair keeps its style while gravity pulls (0 loose, 1 set). */
  hold = 0.06;
  mirror = true;
  private readonly hairMesh: Mesh;
  private readonly skinMesh: Mesh;
  private readonly cursor: Mesh;
  private readonly tieMarks = new Group();
  private readonly raycaster = new Raycaster();
  private stroke: { plane: Plane; last: Vector3; tie: number } | null = null;
  private readonly undo: string[] = [];
  private readonly redo: string[] = [];
  private readonly anchors: readonly number[];
  private readonly hairColour: Color;
  /** The hair's surface: the guides' clumps as one volume (`hairVolume.ts`). */
  private readonly volume: HairVolume;
  /** When the surface was last rebuilt during a stroke (ms): rebuilt at most ten times a second while dragging. */
  private builtAt = 0;

  constructor(body: StudioBody, record: GroomRecord | null, hairColour: number, skinColour: number) {
    this.body = new GroomBody(body.positions, body.skin, body.faces, body.faceGroup, body.skinGroup);
    this.anchors = body.anchors;
    this.hairColour = new Color(hairColour);
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
    skinGeometry.setAttribute('color', new BufferAttribute(new Float32Array(body.positions.length), 3));
    skinGeometry.setIndex(tris);
    this.skinMesh = new Mesh(skinGeometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.7 }));
    this.skinMesh.userData['skin'] = new Color(skinColour);
    this.group.add(this.skinMesh);

    // A soft sheen, little sky: solid painted hair.
    const hairMaterial = new MeshStandardMaterial({ color: hairColour, roughness: 0.55, metalness: 0, envMapIntensity: 0.3 });
    this.volume = new HairVolume(hairMaterial, 100);
    this.hairMesh = this.volume.mesh;
    this.group.add(this.hairMesh);
    this.group.add(this.tieMarks);

    this.cursor = new Mesh(new RingGeometry(0.94, 1, 48), new MeshStandardMaterial({ color: 0x4f8cff, emissive: 0x4f8cff, side: DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.group.add(this.cursor);

    if (record) { this.guides = decodeGroom(record, this.body); this.ties = record.ties.map((t) => ({ ...t })); }
    this.rebuild();
  }

  // ------------------------------------------------------------ the whole head

  /** Hair all over the scalp: a guide every `spacing` dm, each `length` long, settled under gravity. */
  fill(length = this.length, spacing = 0.2): void {
    this.remember();
    // Rings round the head from the crown down, a guide every `spacing` dm along each: curtains (`curtainTopology`).
    const P = this.body.positions;
    const [sx, sy, sz] = this.body.skull;
    const crownY = this.body.top;
    const scalp = this.body.scalp;
    const angleOf = (v: number): number => Math.atan2(P[v * 3]! - sx, P[v * 3 + 2]! - sz);
    const fall = (v: number): number => crownY - P[v * 3 + 1]! + Math.max(0, sz - 0.3 - P[v * 3 + 2]!) * 0.6;
    const guides: Guide[] = [];
    const used = new Set<number>();
    let row = 0;
    const deepest = Math.max(...scalp.map(fall));
    for (let ring = 0.03; ring <= deepest; ring += spacing * 0.85, row++) {
      const band = scalp.filter((v) => Math.abs(fall(v) - ring) < spacing * 0.42 && !used.has(v));
      if (!band.length) continue;
      band.sort((a, b) => angleOf(a) - angleOf(b));
      let last: number | null = null;
      for (const v of band) {
        if (last !== null && Math.hypot(P[last * 3]! - P[v * 3]!, P[last * 3 + 1]! - P[v * 3 + 1]!, P[last * 3 + 2]! - P[v * 3 + 2]!) < spacing) continue;
        last = v;
        used.add(v);
        // A point every 1.6 cm or so: long strands follow the head's curve instead of cutting across it.
        const g = plant(this.body, v, length * (0.96 + 0.08 * hash(v)), this.thickness, Math.max(14, Math.round(length / 0.16) + 1));
        g.row = row; g.theta = angleOf(v);
        guides.push(g);
      }
    }
    // The hairline itself a little denser: a guide every 1 cm along its edge where none grows, so the edge is a smooth line, not ragged.
    const roots = guides.map((g) => g.root);
    const near = (v: number, d: number): boolean => roots.some((r) => Math.hypot(P[r * 3]! - P[v * 3]!, P[r * 3 + 1]! - P[v * 3 + 1]!, P[r * 3 + 2]! - P[v * 3 + 2]!) < d);
    const rim = scalp.filter((v) => (this.body.edges.get(v) ?? 0) > 0.75).sort((a, b) => angleOf(a) - angleOf(b));
    for (const v of rim) {
      if (near(v, Math.max(0.1, spacing * 0.6))) continue;
      const g = plant(this.body, v, length * (0.96 + 0.08 * hash(v)), this.thickness, Math.max(14, Math.round(length / 0.16) + 1));
      g.row = row; g.theta = angleOf(v);
      guides.push(g);
      roots.push(v);
    }
    void sy;
    this.guides = guides;
    this.pairUp();
    this.ties = [];
    this.relax(90);
    this.symmetrize();
    this.rebuild();
  }

  /** The style presets: lengths and ties on a full head. */
  preset(name: 'short' | 'bob' | 'long' | 'ponytail' | 'bun' | 'pigtails'): void {
    const lengths = { short: 0.9, bob: 2.4, long: 3.5, ponytail: 4.4, bun: 4.4, pigtails: 4.0 } as const;
    const thick = { short: 0.16, bob: 0.18, long: 0.18, ponytail: 0.17, bun: 0.17, pigtails: 0.17 } as const;
    const keep = this.thickness;
    this.thickness = thick[name];
    this.fill(lengths[name], 0.15);
    // Short hair cut clear of the ears: the locks growing round them trimmed to a few centimetres.
    if (name === 'short') {
      const P = this.body.positions;
      this.guides = this.guides.map((g) => {
        if (P[g.root * 3 + 1]! > this.body.hugFloor + 0.45) return g;
        const t = plant(this.body, g.root, 0.25, g.radius);
        t.row = g.row; t.theta = g.theta;
        return t;
      });
    }
    this.thickness = keep;
    const [sx, , sz] = this.body.skull;
    const top = this.body.top;
    if (name === 'ponytail') this.tieAll({ x: sx, y: top - 0.9, z: sz - 0.95, radius: 0.22 });
    if (name === 'bun') this.tieAll({ x: sx, y: top - 0.25, z: sz - 0.8, radius: 0.3 });
    if (name === 'pigtails') {
      this.tieAll({ x: sx + 0.8, y: top - 1.1, z: sz - 0.4, radius: 0.2 }, (g) => this.body.positions[g.root * 3]! >= sx);
      this.tieAll({ x: sx - 0.8, y: top - 1.1, z: sz - 0.4, radius: 0.2 }, (g) => this.body.positions[g.root * 3]! < sx);
    }
    this.relax(120);
    this.symmetrize();
    // A bob cut straight across at the jaw.
    if (name === 'bob') for (const g of this.guides) levelCut(g, this.body.face.bottom + 0.45);
    if (name === 'bun') {
      // The tail wound round the tie into a bun: a flat spiral out from it, each strand at its own angle.
      const t = this.ties[0]!;
      for (const g of this.guides) {
        if (!g.tie) continue;
        const n = g.pts.length / 3;
        const a0 = hash(g.root) * Math.PI * 2;
        for (let i = g.tie.k + 1; i < n; i++) {
          const u = (i - g.tie.k) / Math.max(1, n - g.tie.k);
          const a = a0 + u * Math.PI * 3, r = t.radius * (0.6 + 1.3 * u);
          g.pts[i * 3] = t.x + Math.cos(a) * r; g.pts[i * 3 + 1] = t.y + Math.sin(a) * r; g.pts[i * 3 + 2] = t.z - 0.12 - 0.15 * Math.sin(u * Math.PI);
        }
        remember(g);
      }
    }
    this.rebuild();
  }

  /** Every guide (passing `only`) tied at a new tie. */
  private tieAll(t: Tie, only: (g: Guide) => boolean = () => true): void {
    this.ties.push(t);
    const id = this.ties.length - 1;
    for (const g of this.guides) if (only(g)) gather(g, this.body, t, id, this.margin(g));
  }

  /** Each guide's mirror twin across the body's middle (the guide whose root is nearest its root's mirror image), or -1. */
  private twins: number[] = [];

  private pairUp(): void {
    const P = this.body.positions, mid = this.body.skull[0];
    this.twins = this.guides.map((g) => {
      const mx = 2 * mid - P[g.root * 3]!, my = P[g.root * 3 + 1]!, mz = P[g.root * 3 + 2]!;
      let best = -1, bd = 0.2 * 0.2;
      this.guides.forEach((h, j) => {
        const d = (P[h.root * 3]! - mx) ** 2 + (P[h.root * 3 + 1]! - my) ** 2 + (P[h.root * 3 + 2]! - mz) ** 2;
        if (d < bd) { bd = d; best = j; }
      });
      return best;
    });
  }

  /** A style made symmetric: every guide on the left takes its right twin's shape, mirrored (hair falls the same on both sides). */
  private symmetrize(): void {
    if (this.twins.length !== this.guides.length) return;
    const P = this.body.positions, mid = this.body.skull[0];
    this.guides.forEach((g, i) => {
      const j = this.twins[i]!;
      if (j < 0 || P[g.root * 3]! >= mid) return;
      const t = this.guides[j]!;
      const n = Math.min(g.pts.length, t.pts.length) / 3;
      if (g.pts.length !== t.pts.length) { g.pts = new Float32Array(t.pts.length); g.vel = new Float32Array(t.pts.length); g.rest = new Float32Array(t.pts.length); }
      for (let k = 1; k < t.pts.length / 3; k++) {
        g.pts[k * 3] = 2 * mid - t.pts[k * 3]!; g.pts[k * 3 + 1] = t.pts[k * 3 + 1]!; g.pts[k * 3 + 2] = t.pts[k * 3 + 2]!;
      }
      g.pts[0] = P[g.root * 3]! + this.body.normals[g.root * 3]! * 0.04; g.pts[1] = P[g.root * 3 + 1]! + this.body.normals[g.root * 3 + 1]! * 0.04; g.pts[2] = P[g.root * 3 + 2]! + this.body.normals[g.root * 3 + 2]! * 0.04;
      g.seg = t.seg; g.radius = t.radius;
      // Its tie: the mirror of the twin's (the same one when it sits on the middle, the other of a pair of pigtails).
      if (t.tie) {
        const src = this.ties[t.tie.id]!;
        const m = this.ties.findIndex((x) => Math.abs(x.x - (2 * mid - src.x)) < 0.05 && Math.abs(x.y - src.y) < 0.05 && Math.abs(x.z - src.z) < 0.05);
        g.tie = m >= 0 ? { id: m, k: t.tie.k } : null;
      } else g.tie = null;
      void n;
      remember(g);
    });
  }

  /** Run the dynamics `steps` times with gravity (settling a new style). */
  relax(steps: number): void {
    for (let s = 0; s < steps; s++) for (const g of this.guides) step(g, this.body, this.ties, 1 / 60, 30, 0, this.margin(g));
    for (const g of this.guides) { g.vel.fill(0); remember(g); }
  }

  /** How far a guide's middle stays off the skin: the clump's surface (a radius further out) then lies a few centimetres off the head, not a helmet. */
  private margin(g: Guide): number { return groomMargin(g.radius); }

  /** Each frame: the dynamics when gravity is on. */
  tick(dt: number): void {
    if (!this.gravity || this.stroke) return;
    const h = Math.min(1 / 30, dt);
    for (const g of this.guides) step(g, this.body, this.ties, h, 60, this.hold, this.margin(g));
    this.updatePositions();
  }

  // ------------------------------------------------------------ strokes

  private ray(ndc: Vector2, camera: Camera): Ray {
    this.raycaster.setFromCamera(ndc, camera);
    // In the group's own frame (dm).
    const inv = this.group.matrixWorld.clone().invert();
    return this.raycaster.ray.clone().applyMatrix4(inv);
  }

  /** The point under the pointer on the hair or the body, in dm. */
  private hit(ndc: Vector2, camera: Camera, bodyOnly = false): Vector3 | null {
    this.raycaster.setFromCamera(ndc, camera);
    const h = this.raycaster.intersectObjects(bodyOnly ? [this.skinMesh] : [this.hairMesh, this.skinMesh], false)[0];
    return h ? this.group.worldToLocal(h.point.clone()) : null;
  }

  /** Points under the brush: within `radius` of the pointer's ray, each with its falloff and the guide and index it belongs to. */
  private under(ray: Ray, radius = this.radius): { g: Guide; i: number; w: number }[] {
    const out: { g: Guide; i: number; w: number }[] = [];
    const p = new Vector3();
    const rays = this.mirror ? [ray, mirrorRay(ray, this.body.skull[0])] : [ray];
    for (const g of this.guides) {
      const n = g.pts.length / 3;
      for (let i = 1; i < n; i++) {
        p.set(g.pts[i * 3]!, g.pts[i * 3 + 1]!, g.pts[i * 3 + 2]!);
        let best = Infinity;
        for (const r of rays) best = Math.min(best, r.distanceSqToPoint(p));
        if (best < radius * radius) out.push({ g, i, w: (1 - best / (radius * radius)) ** 2 });
      }
    }
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

  /** A stroke starts; false when the pointer is on nothing the tool works on. */
  begin(ndc: Vector2, camera: Camera, invert: boolean): boolean {
    const at = this.hit(ndc, camera, this.tool === 'plant' || this.tool === 'part');
    if (!at) return false;
    this.remember();
    const facing = new Vector3();
    camera.getWorldDirection(facing);
    // A tie grabbed near its middle is moved; elsewhere the tie tool makes a new one.
    let tie = -1;
    if (this.tool === 'tie') {
      tie = this.ties.findIndex((t) => at.distanceTo(new Vector3(t.x, t.y, t.z)) < Math.max(0.35, t.radius * 1.5));
      if (tie < 0) {
        const out = at.clone().sub(new Vector3(...this.body.skull)).normalize().multiplyScalar(0.15);
        const t = { x: at.x + out.x, y: at.y + out.y, z: at.z + out.z, radius: 0.22 };
        const id = this.ties.length;
        let caught = 0;
        for (const g of this.guides) {
          let bestD = Infinity;
          for (let i = 2; i < g.pts.length / 3; i++) bestD = Math.min(bestD, Math.hypot(g.pts[i * 3]! - t.x, g.pts[i * 3 + 1]! - t.y, g.pts[i * 3 + 2]! - t.z));
          if (bestD < this.radius * 1.6 && gather(g, this.body, t, id, this.margin(g))) caught++;
        }
        if (caught) { this.ties.push(t); tie = id; } else for (const g of this.guides) if (g.tie?.id === id) g.tie = null;
      }
    }
    this.stroke = { plane: new Plane().setFromNormalAndCoplanarPoint(facing.clone().transformDirection(this.group.matrixWorld.clone().invert()).normalize(), at), last: at, tie };
    if (this.tool === 'plant') this.plantAt(at);
    else this.apply(ndc, camera, new Vector3(), invert);
    this.rebuild();
    return true;
  }

  move(ndc: Vector2, camera: Camera, invert: boolean): void {
    this.hover(ndc, camera);
    const s = this.stroke;
    if (!s) return;
    const ray = this.ray(ndc, camera);
    const at = ray.intersectPlane(s.plane, new Vector3());
    if (!at) return;
    const delta = at.clone().sub(s.last);
    s.last = at;
    if (this.tool === 'plant') { const h = this.hit(ndc, camera, true); if (h && delta.length() > this.radius * 0.6) this.plantAt(h); this.rebuild(); return; }
    this.apply(ndc, camera, delta, invert);
    if (this.tool === 'erase' || this.tool === 'cut') this.rebuild(); else this.updatePositions();
  }

  end(): void {
    if (!this.stroke) return;
    this.stroke = null;
    for (const g of this.guides) { g.vel.fill(0); remember(g); }
    this.rebuild();
  }

  private plantAt(at: Vector3): void {
    const P = this.body.positions;
    const near = this.body.scalp.filter((v) => Math.hypot(P[v * 3]! - at.x, P[v * 3 + 1]! - at.y, P[v * 3 + 2]! - at.z) < this.radius);
    const used = new Set(this.guides.map((g) => g.root));
    const pick: number[] = [];
    for (const v of near.sort((a, b) => hash(a) - hash(b))) {
      if (pick.length >= this.density) break;
      if (used.has(v) || pick.some((u) => Math.hypot(P[u * 3]! - P[v * 3]!, P[u * 3 + 1]! - P[v * 3 + 1]!, P[u * 3 + 2]! - P[v * 3 + 2]!) < 0.12)) continue;
      pick.push(v);
    }
    for (const v of pick) this.guides.push(plant(this.body, v, this.length, this.thickness));
  }

  /** One touch of the tool along the pointer's ray; `delta` is how far the pointer moved on the stroke's plane (dm). */
  private apply(ndc: Vector2, camera: Camera, delta: Vector3, invert: boolean): void {
    const ray = this.ray(ndc, camera);
    const hits = this.under(ray);
    const k = this.strength;
    const [sx, sy, sz] = this.body.skull;
    const touched = new Set<Guide>();
    const sign = invert ? -1 : 1;
    switch (this.tool) {
      case 'comb':
      case 'grab': {
        // Comb: the tips follow most, the root stays (as a comb drags hair); pull: every touched point follows the pointer.
        for (const { g, i, w } of hits) {
          const t = i / (g.pts.length / 3 - 1);
          const f = this.tool === 'comb' ? w * k * Math.sqrt(t) : w;
          const mx = this.mirror && Math.sign(g.pts[0]! - sx) !== Math.sign(ray.origin.x - sx) ? -1 : 1;
          const n = g.pts.length / 3;
          for (let j = i; j < n; j++) {
            const fall = this.tool === 'comb' ? f : f * Math.max(0, 1 - (j - i) * 0.12);
            g.pts[j * 3] = g.pts[j * 3]! + delta.x * fall * mx; g.pts[j * 3 + 1] = g.pts[j * 3 + 1]! + delta.y * fall; g.pts[j * 3 + 2] = g.pts[j * 3 + 2]! + delta.z * fall;
            if (this.tool === 'comb') break;
          }
          touched.add(g);
        }
        break;
      }
      case 'puff':
        for (const { g, i, w } of hits) {
          const o = new Vector3(g.pts[i * 3]! - sx, g.pts[i * 3 + 1]! - sy, g.pts[i * 3 + 2]! - sz).normalize();
          const f = sign * w * k * 0.08 * (1 - 0.5 * i / (g.pts.length / 3));
          g.pts[i * 3] = g.pts[i * 3]! + o.x * f; g.pts[i * 3 + 1] = g.pts[i * 3 + 1]! + o.y * f; g.pts[i * 3 + 2] = g.pts[i * 3 + 2]! + o.z * f;
          touched.add(g);
        }
        break;
      case 'smooth':
        for (const { g, i, w } of hits) {
          const n = g.pts.length / 3;
          if (i >= n - 1) continue;
          for (let a = 0; a < 3; a++) {
            const mid = (g.pts[(i - 1) * 3 + a]! + g.pts[(i + 1) * 3 + a]!) / 2;
            g.pts[i * 3 + a] = g.pts[i * 3 + a]! + (mid - g.pts[i * 3 + a]!) * w * k;
          }
          touched.add(g);
        }
        break;
      case 'curl':
        // Each touched strand wound round its own line, more towards the tip: waves, then curls.
        for (const g of new Set(hits.map((h) => h.g))) {
          const n = g.pts.length / 3;
          const phase = hash(g.root) * Math.PI * 2;
          for (let j = 2; j < n; j++) {
            const amp = sign * k * 0.035 * (j / n);
            const a = j * 1.3 + phase;
            g.pts[j * 3] = g.pts[j * 3]! + Math.cos(a) * amp; g.pts[j * 3 + 2] = g.pts[j * 3 + 2]! + Math.sin(a) * amp;
          }
          touched.add(g);
        }
        break;
      case 'grow':
        for (const g of new Set(hits.map((h) => h.g))) {
          const n = g.pts.length / 3;
          if (invert) { if (n > 3) this.trim(g, n - 1); continue; }
          if (n >= 40) continue;
          const pts = new Float32Array((n + 1) * 3);
          pts.set(g.pts);
          for (let a = 0; a < 3; a++) pts[n * 3 + a] = g.pts[(n - 1) * 3 + a]! * 2 - g.pts[(n - 2) * 3 + a]!;
          pts[n * 3 + 1] = pts[n * 3 + 1]! - g.seg * 0.2;
          g.pts = pts; g.rest = new Float32Array(pts.length); g.vel = new Float32Array(pts.length);
          touched.add(g);
        }
        break;
      case 'cut':
        for (const { g, i } of hits) if (i >= 2 && i < g.pts.length / 3) this.trim(g, i);
        break;
      case 'erase': {
        const gone = new Set(hits.map((h) => h.g));
        this.guides = this.guides.filter((g) => !gone.has(g));
        break;
      }
      case 'part': {
        // A parting: strands rooted near the pointer pushed away from the line the pointer draws, each to its own side.
        if (delta.lengthSq() < 1e-8) break;
        const P = this.body.positions, N = this.body.normals;
        const at = this.stroke!.last;
        for (const g of this.guides) {
          const r = g.root;
          const root = new Vector3(P[r * 3]!, P[r * 3 + 1]!, P[r * 3 + 2]!);
          if (root.distanceTo(at) > this.radius) continue;
          const side = new Vector3().crossVectors(delta, new Vector3(N[r * 3]!, N[r * 3 + 1]!, N[r * 3 + 2]!)).normalize();
          if (side.dot(root.clone().sub(at)) < 0) side.negate();
          const n = g.pts.length / 3;
          for (let j = 1; j < n; j++) {
            const f = k * 0.06 * Math.min(1, j / 3);
            g.pts[j * 3] = g.pts[j * 3]! + side.x * f; g.pts[j * 3 + 1] = g.pts[j * 3 + 1]! + side.y * f; g.pts[j * 3 + 2] = g.pts[j * 3 + 2]! + side.z * f;
          }
          touched.add(g);
        }
        break;
      }
      case 'tie': {
        const t = this.stroke ? this.ties[this.stroke.tie] : undefined;
        if (t) { t.x += delta.x; t.y += delta.y; t.z += delta.z; }
        for (const g of this.guides) if (g.tie && this.stroke && g.tie.id === this.stroke.tie) touched.add(g);
        if (t) for (const g of touched) this.holdTie(g);
        break;
      }
      case 'plant':
        break;
    }
    for (const g of touched) settle(g, this.body, this.margin(g));
  }

  /** A tied strand's held point put in its tie, the strand settled again from there. */
  private holdTie(g: Guide): void {
    const t = g.tie ? this.ties[g.tie.id] : undefined;
    if (!t || !g.tie) return;
    gather(g, this.body, t, g.tie.id, this.margin(g));
  }


  /** The strand cut to `points` points. */
  private trim(g: Guide, points: number): void {
    g.pts = g.pts.slice(0, points * 3); g.rest = g.rest.slice(0, points * 3); g.vel = g.vel.slice(0, points * 3);
    if (g.tie && g.tie.k >= points) g.tie = null;
  }

  // ------------------------------------------------------------ the mesh

  private rebuild(): void {
    this.volume.build(this.guides, this.body.skull, this.body.cap(this.guides));
    this.builtAt = performance.now();
    this.paintScalp();
    this.tieMarks.clear();
    for (const t of this.ties) {
      const mark = new Mesh(new SphereGeometry(t.radius * 0.9, 16, 12), new MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.4 }));
      mark.position.set(t.x, t.y, t.z);
      this.tieMarks.add(mark);
    }
  }

  /** The surface again after the guides moved: at most ten times a second, the stroke's end rebuilds it exactly. */
  private updatePositions(): void {
    if (performance.now() - this.builtAt < 100) return;
    this.volume.build(this.guides, this.body.skull, this.body.cap(this.guides));
    this.builtAt = performance.now();
  }

  /** The scalp under the hair in the hair's colour: skin within a guide's clump width of a root. */
  private paintScalp(): void {
    const colour = this.skinMesh.geometry.getAttribute('color') as BufferAttribute;
    const skin = this.skinMesh.userData['skin'] as Color;
    const P = this.body.positions;
    const roots = this.guides.map((g) => g.root);
    for (let v = 0; v < colour.count; v++) colour.setXYZ(v, skin.r, skin.g, skin.b);
    const reach = 0.42;
    for (const v of this.body.scalp) {
      for (const r of roots) {
        if (Math.abs(P[v * 3 + 1]! - P[r * 3 + 1]!) > reach) continue;
        if (Math.hypot(P[v * 3]! - P[r * 3]!, P[v * 3 + 1]! - P[r * 3 + 1]!, P[v * 3 + 2]! - P[r * 3 + 2]!) < reach) {
          colour.setXYZ(v, this.hairColour.r * 0.85, this.hairColour.g * 0.85, this.hairColour.b * 0.85);
          break;
        }
      }
    }
    colour.needsUpdate = true;
  }

  // ------------------------------------------------------------ keeping

  private remember(): void {
    this.undo.push(JSON.stringify(encodeGroom(this.guides, this.ties)));
    if (this.undo.length > 40) this.undo.shift();
    this.redo.length = 0;
  }

  undoStep(): void {
    const last = this.undo.pop();
    if (!last) return;
    this.redo.push(JSON.stringify(encodeGroom(this.guides, this.ties)));
    const r = JSON.parse(last) as GroomRecord;
    this.guides = decodeGroom(r, this.body); this.ties = r.ties.map((t) => ({ ...t }));
    this.rebuild();
  }

  redoStep(): void {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(JSON.stringify(encodeGroom(this.guides, this.ties)));
    const r = JSON.parse(next) as GroomRecord;
    this.guides = decodeGroom(r, this.body); this.ties = r.ties.map((t) => ({ ...t }));
    this.rebuild();
  }

  clear(): void { this.remember(); this.guides = []; this.ties = []; this.rebuild(); }
  clearTies(): void { this.remember(); this.ties = []; for (const g of this.guides) g.tie = null; this.rebuild(); }
  /** Every clump's width set. */
  setThickness(dm: number): void { this.thickness = dm; for (const g of this.guides) g.radius = dm; this.updatePositions(); }
  setColour(c: number): void { this.hairColour.set(c); (this.hairMesh.material as MeshStandardMaterial).color.set(c); this.paintScalp(); }

  record(): GroomRecord { return encodeGroom(this.guides, this.ties); }
  pack(): ProxyPack { return groomPack(this.guides, this.body, this.anchors); }
  get count(): number { return this.guides.length; }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
    });
  }
}

/** A number in 0..1 from an integer, the same each time. */
function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b1, 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/** The ray mirrored across the body's middle (x = `mid`). */
function mirrorRay(r: Ray, mid: number): Ray {
  return new Ray(new Vector3(2 * mid - r.origin.x, r.origin.y, r.origin.z), new Vector3(-r.direction.x, r.direction.y, r.direction.z));
}
