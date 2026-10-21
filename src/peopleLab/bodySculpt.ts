import {
  BufferAttribute, BufferGeometry, DoubleSide, Group, Mesh, MeshStandardMaterial, Plane, Raycaster, RingGeometry, Vector3, type Camera, type Vector2,
} from 'three';
import { decodeSculpt, encodeSculpt, type HairSculpt } from './sculpt';

/** SCULPTING THE BODY AND FACE, as ZBrush and Blender's sculpt mode: brushes on the skin itself (draw, inflate, grab, smooth, flatten, pinch, crease),
 *  mirrored across the body, kept as moves of the base mesh's vertices so every garment still fits (`fitProxy` reads the moved body). */

export type BodyBrush = 'draw' | 'inflate' | 'grab' | 'smooth' | 'flatten' | 'pinch' | 'crease';

const DM = 0.1;

export class BodySculptor {
  readonly group = new Group();
  brush: BodyBrush = 'draw';
  radius = 0.4;
  strength = 0.5;
  mirror = true;
  private readonly mesh: Mesh;
  private readonly cursor: Mesh;
  private readonly base: Float32Array;
  private readonly work: Float32Array;
  private readonly neighbours: number[][];
  private readonly skin: readonly number[];
  private readonly raycaster = new Raycaster();
  private stroke: { plane: Plane; start: Vector3; picked: Map<number, number>; from: Float32Array; side: number } | null = null;
  private readonly undo: Float32Array[] = [];
  private readonly redo: Float32Array[] = [];

  constructor(positions: Float32Array, start: Float32Array | null, faces: Uint16Array, faceGroup: Uint8Array, skinGroup: number, skin: readonly number[], skinColour: number) {
    this.base = new Float32Array(positions);
    this.work = new Float32Array(positions);
    if (start) for (let i = 0; i < this.work.length; i++) this.work[i] = this.work[i]! + start[i]!;
    this.skin = skin;
    let lowest = Infinity;
    for (let i = 1; i < positions.length; i += 3) lowest = Math.min(lowest, positions[i]!);
    this.group.scale.setScalar(DM);
    this.group.position.y = -lowest * DM;
    const tris: number[] = [];
    const sets = new Map<number, Set<number>>();
    for (let f = 0; f < faceGroup.length; f++) {
      if (faceGroup[f] !== skinGroup) continue;
      const q = [faces[f * 4]!, faces[f * 4 + 1]!, faces[f * 4 + 2]!, faces[f * 4 + 3]!];
      tris.push(q[0]!, q[1]!, q[2]!);
      if (q[3] !== q[2]) tris.push(q[0]!, q[2]!, q[3]!);
      const ring = q[3] !== q[2] ? q : q.slice(0, 3);
      for (let k = 0; k < ring.length; k++) {
        const a = ring[k]!, b = ring[(k + 1) % ring.length]!;
        (sets.get(a) ?? sets.set(a, new Set()).get(a)!).add(b);
        (sets.get(b) ?? sets.set(b, new Set()).get(b)!).add(a);
      }
    }
    this.neighbours = Array.from({ length: positions.length / 3 }, (_, v) => [...(sets.get(v) ?? [])]);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.work, 3));
    geometry.setIndex(tris);
    geometry.computeVertexNormals();
    this.mesh = new Mesh(geometry, new MeshStandardMaterial({ color: skinColour, roughness: 0.6 }));
    this.mesh.castShadow = true;
    this.group.add(this.mesh);
    this.cursor = new Mesh(new RingGeometry(0.94, 1, 48), new MeshStandardMaterial({ color: 0x4f8cff, emissive: 0x4f8cff, side: DoubleSide, transparent: true, opacity: 0.9, depthTest: false }));
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.group.add(this.cursor);
  }

  /** The sculpt: the body's moves from where it was built (dm a vertex). */
  delta(): Float32Array {
    const out = new Float32Array(this.work.length);
    for (let i = 0; i < out.length; i++) out[i] = this.work[i]! - this.base[i]!;
    return out;
  }

  record(base: HairSculpt | undefined): HairSculpt {
    // Kept on top of a sculpt already worn (the base it was opened on already had it).
    void base;
    return encodeSculpt('body', this.delta());
  }

  private hit(ndc: Vector2, camera: Camera): { p: Vector3; n: Vector3 } | null {
    this.raycaster.setFromCamera(ndc, camera);
    const h = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!h) return null;
    return { p: this.group.worldToLocal(h.point.clone()), n: h.face?.normal.clone() ?? new Vector3(0, 0, 1) };
  }

  hover(ndc: Vector2, camera: Camera): void {
    const h = this.hit(ndc, camera);
    this.cursor.visible = !!h;
    if (!h) return;
    this.cursor.position.copy(h.p);
    this.cursor.scale.setScalar(this.radius);
    this.cursor.lookAt(h.p.clone().add(h.n));
  }

  private within(c: Vector3, out = new Map<number, number>()): Map<number, number> {
    const r2 = this.radius * this.radius;
    for (const v of this.skin) {
      const d2 = (this.work[v * 3]! - c.x) ** 2 + (this.work[v * 3 + 1]! - c.y) ** 2 + (this.work[v * 3 + 2]! - c.z) ** 2;
      if (d2 >= r2) continue;
      const t = d2 / r2;
      out.set(v, Math.max(out.get(v) ?? 0, (1 - t) * (1 - t)));
    }
    return out;
  }

  begin(ndc: Vector2, camera: Camera, invert = false): boolean {
    const h = this.hit(ndc, camera);
    if (!h) return false;
    this.undo.push(new Float32Array(this.work)); if (this.undo.length > 40) this.undo.shift(); this.redo.length = 0;
    const facing = new Vector3();
    camera.getWorldDirection(facing);
    const inv = this.group.matrixWorld.clone().invert();
    // Mirrored by a second brush at the mirrored point (the base mesh is not exactly symmetric: vertex partners left spikes).
    const picked = this.within(h.p);
    const mirrored = this.mirror && Math.abs(h.p.x) > this.radius * 0.3 ? this.within(new Vector3(-h.p.x, h.p.y, h.p.z)) : new Map<number, number>();
    for (const [v, w] of mirrored) if (!picked.has(v)) picked.set(v, -w);
    this.stroke = { plane: new Plane().setFromNormalAndCoplanarPoint(facing.transformDirection(inv).normalize(), h.p), start: h.p, picked, from: new Float32Array(this.work), side: Math.sign(h.p.x) };
    if (this.brush !== 'grab') this.dab(h.p, invert ? -1 : 1);
    return true;
  }

  move(ndc: Vector2, camera: Camera, invert: boolean): void {
    this.hover(ndc, camera);
    const s = this.stroke;
    if (!s) return;
    if (this.brush === 'grab') {
      this.raycaster.setFromCamera(ndc, camera);
      const ray = this.raycaster.ray.clone().applyMatrix4(this.group.matrixWorld.clone().invert());
      const at = ray.intersectPlane(s.plane, new Vector3());
      if (!at) return;
      const d = at.sub(s.start);
      // A negative weight marks the mirrored side: it moves mirrored in x.
      for (const [v, sw] of s.picked) {
        const w = Math.abs(sw), mx = sw < 0 ? -1 : 1;
        this.work[v * 3] = s.from[v * 3]! + d.x * w * mx; this.work[v * 3 + 1] = s.from[v * 3 + 1]! + d.y * w; this.work[v * 3 + 2] = s.from[v * 3 + 2]! + d.z * w;
      }
      this.refresh();
      return;
    }
    const h = this.hit(ndc, camera);
    if (h) this.dab(h.p, invert ? -1 : 1);
  }

  end(): void { this.stroke = null; }

  private dab(at: Vector3, sign: number): void {
    this.dabAt(at, sign);
    if (this.mirror && Math.abs(at.x) > this.radius * 0.3) this.dabAt(new Vector3(-at.x, at.y, at.z), sign);
    this.refresh();
  }

  private dabAt(c: Vector3, sign: number): void {
    const normal = this.mesh.geometry.getAttribute('normal');
    const picked = this.within(c);
    if (!picked.size) return;
    // Gentle: a stroke of a dozen touches lifts the skin about a millimetre at full strength.
    const k = this.strength * 0.006 * this.radius / 0.4;
    const mid = new Vector3(), avgN = new Vector3();
    for (const v of picked.keys()) { mid.x += this.work[v * 3]!; mid.y += this.work[v * 3 + 1]!; mid.z += this.work[v * 3 + 2]!; avgN.x += normal.getX(v); avgN.y += normal.getY(v); avgN.z += normal.getZ(v); }
    mid.divideScalar(picked.size); avgN.normalize();
    const moves = new Map<number, [number, number, number]>();
    for (const [v, w] of picked) {
      const p = new Vector3(this.work[v * 3]!, this.work[v * 3 + 1]!, this.work[v * 3 + 2]!);
      const n = new Vector3(normal.getX(v), normal.getY(v), normal.getZ(v));
      const q = p.clone();
      switch (this.brush) {
        case 'draw': q.addScaledVector(avgN, sign * w * k); break;
        case 'inflate': q.addScaledVector(n, sign * w * k); break;
        case 'crease': q.addScaledVector(n, -sign * w * k * 0.8).lerp(c, Math.min(0.3, w * k * 2)); break;
        case 'smooth': {
          const ns = this.neighbours[v]!;
          if (!ns.length) break;
          const avg = new Vector3();
          for (const u of ns) avg.add(new Vector3(this.work[u * 3]!, this.work[u * 3 + 1]!, this.work[u * 3 + 2]!));
          q.lerp(avg.divideScalar(ns.length), Math.min(1, w * this.strength));
          break;
        }
        case 'flatten': q.addScaledVector(avgN, -p.clone().sub(mid).dot(avgN) * w * this.strength * 0.5); break;
        case 'pinch': q.lerp(c, Math.min(0.4, sign * w * k * 3)); break;
        case 'grab': break;
      }
      moves.set(v, [q.x - p.x, q.y - p.y, q.z - p.z]);
    }
    for (const [v, [dx, dy, dz]] of moves) {
      this.work[v * 3] = this.work[v * 3]! + dx; this.work[v * 3 + 1] = this.work[v * 3 + 1]! + dy; this.work[v * 3 + 2] = this.work[v * 3 + 2]! + dz;
    }
  }

  private refresh(): void {
    const g = this.mesh.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }

  undoStep(): void { const last = this.undo.pop(); if (!last) return; this.redo.push(new Float32Array(this.work)); this.work.set(last); this.refresh(); }
  redoStep(): void { const next = this.redo.pop(); if (!next) return; this.undo.push(new Float32Array(this.work)); this.work.set(next); this.refresh(); }
  reset(): void { this.undo.push(new Float32Array(this.work)); this.work.set(this.base); this.refresh(); }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
    });
  }
}

/** A saved body sculpt as moves of the base mesh. */
export const bodyDelta = (s: HairSculpt, vertexCount: number): Float32Array => decodeSculpt(s, vertexCount);
