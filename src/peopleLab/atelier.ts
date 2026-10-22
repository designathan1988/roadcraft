import {
  BufferAttribute, BufferGeometry, Color, DoubleSide, Group, Mesh, MeshStandardMaterial, Plane, Raycaster, Vector3, type Camera, type Vector2,
} from 'three';
import { nearestThree } from '@people/hair/procedural';
import type { ProxyPack } from '@people/body/proxy';
import { ClothSim, PATTERNS, type Cut, type Measures } from './cloth';
import { GroomBody } from './groom';
import type { StudioBody } from './groom';

/** THE ATELIER: a garment made as CLO 3D makes one - a pattern drafted to the body's measures, its pieces wrapped round the body, sewn and draped live;
 *  the cloth can be grabbed and pulled while it drapes. Finished, it is pinned to the body as a game item. */

const DM = 0.1;

/** A garment as kept with the person: its pattern and cut, colour, and the draped particle positions (int16, 1/1000 dm, base64). */
export interface GarmentRecord { readonly pattern: string; readonly cut: Cut; readonly colour: number; readonly pos: string; /** The measures it was drafted to (its topology depends on them). */ readonly measures: Measures }

export class Atelier {
  readonly group = new Group();
  readonly body: GroomBody;
  sim: ClothSim;
  pattern = 'vestido';
  cut: Cut = { length: 0, ease: 1.12, flare: 0.8, sleeve: 1.6, neck: 0.1 };
  colour = 0x3b6fd1;
  running = true;
  stiffness = 0.4;
  private readonly measures: Measures;
  private readonly clothMesh: Mesh;
  private readonly raycaster = new Raycaster();
  private grab: { i: number; plane: Plane; mass: number } | null = null;
  private readonly allSkin: readonly number[];

  constructor(body: StudioBody, record: GarmentRecord | null, skinColour: number) {
    this.body = new GroomBody(body.positions, body.skin, body.faces, body.faceGroup, body.skinGroup);
    this.allSkin = body.skin;
    this.measures = measure(body);
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
    const skin = new BufferGeometry();
    skin.setAttribute('position', new BufferAttribute(body.positions, 3));
    skin.setAttribute('normal', new BufferAttribute(this.body.normals, 3));
    skin.setIndex(tris);
    this.group.add(new Mesh(skin, new MeshStandardMaterial({ color: skinColour, roughness: 0.7 })));
    this.clothMesh = new Mesh(new BufferGeometry(), new MeshStandardMaterial({ color: this.colour, roughness: 0.85, side: DoubleSide }));
    this.clothMesh.castShadow = true;
    this.group.add(this.clothMesh);
    if (record) {
      this.pattern = record.pattern; this.cut = record.cut; this.colour = record.colour;
      this.sim = new ClothSim(PATTERNS[this.pattern]!(record.measures, this.cut), 0.12, record.measures.axis);
      this.sim.pos.set(decodePositions(record.pos, this.sim.pos.length));
      this.running = false;
    } else this.sim = this.make();
    this.setColour(this.colour);
    this.rebuild();
  }

  private make(): ClothSim {
    const sim = new ClothSim(PATTERNS[this.pattern]!(this.measures, this.cut), 0.12, this.measures.axis);
    sim.bendCompliance = this.stiffness;
    return sim;
  }

  /** A new pattern or cut: the pieces laid round the body again, draping from the start. */
  draft(pattern = this.pattern, cut: Partial<Cut> = {}): void {
    this.pattern = pattern;
    this.cut = { ...this.cut, ...cut };
    this.sim = this.make();
    this.running = true;
    this.rebuild();
  }

  setStiffness(v: number): void { this.stiffness = v; this.sim.bendCompliance = v; }
  setColour(c: number): void { this.colour = c; (this.clothMesh.material as MeshStandardMaterial).color = new Color(c); }

  tick(dt: number): void {
    // A fixed step: a zero or uneven frame time would divide by zero in the velocity update.
    if (!this.running || dt <= 0) return;
    const margin = 0.08;
    this.sim.simulate(1 / 60, 12, 9.8 * 10, (p, i) => this.body.collide(p, i, margin, false));
    this.update();
  }

  // ------------------------------------------------------------ pointer: grab the cloth

  private hit(ndc: Vector2, camera: Camera): Vector3 | null {
    this.raycaster.setFromCamera(ndc, camera);
    const h = this.raycaster.intersectObject(this.clothMesh, false)[0];
    return h ? this.group.worldToLocal(h.point.clone()) : null;
  }

  hover(ndc: Vector2, camera: Camera): void { void ndc; void camera; }

  begin(ndc: Vector2, camera: Camera): boolean {
    const at = this.hit(ndc, camera);
    if (!at) return false;
    const i = this.sim.nearest(at.x, at.y, at.z);
    const facing = new Vector3();
    camera.getWorldDirection(facing);
    this.grab = { i, plane: new Plane().setFromNormalAndCoplanarPoint(facing, at), mass: this.sim.invMass[i]! };
    this.sim.invMass[i] = 0;
    this.running = true;
    return true;
  }

  move(ndc: Vector2, camera: Camera): void {
    const g = this.grab;
    if (!g) return;
    this.raycaster.setFromCamera(ndc, camera);
    const inv = this.group.matrixWorld.clone().invert();
    const ray = this.raycaster.ray.clone().applyMatrix4(inv);
    const at = ray.intersectPlane(g.plane, new Vector3());
    if (!at) return;
    this.sim.pos[g.i * 3] = at.x; this.sim.pos[g.i * 3 + 1] = at.y; this.sim.pos[g.i * 3 + 2] = at.z;
  }

  end(): void {
    if (!this.grab) return;
    this.sim.invMass[this.grab.i] = this.grab.mass;
    this.grab = null;
  }

  undoStep(): void { this.draft(); }
  redoStep(): void { /* the drape is live: nothing to redo */ }

  // ------------------------------------------------------------ mesh and keeping

  private rebuild(): void {
    const g = this.clothMesh.geometry;
    g.setAttribute('position', new BufferAttribute(this.sim.pos, 3));
    g.setIndex(new BufferAttribute(this.sim.tris, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }

  private update(): void {
    const g = this.clothMesh.geometry;
    const attr = g.getAttribute('position') as BufferAttribute;
    if (attr.array !== this.sim.pos) { this.rebuild(); return; }
    attr.needsUpdate = true;
    g.computeVertexNormals();
    g.computeBoundingSphere();
  }

  record(): GarmentRecord { return { pattern: this.pattern, cut: this.cut, colour: this.colour, pos: encodePositions(this.sim.pos), measures: this.measures }; }

  /** The draped garment as a game item: each particle pinned to its three nearest skin vertices, both faces drawn (a thin sheet seen from inside too). */
  pack(): ProxyPack { return garmentPack(this.sim.pos, this.sim.tris, this.body.positions, this.allSkin, this.colour); }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
    });
  }
}

/** The body's measures for drafting: heights by share of the standing height, the trunk's axis and radius at the waist. */
function measure(body: StudioBody): Measures {
  const P = body.positions;
  let lo = Infinity, hi = -Infinity;
  for (const v of body.skin) { lo = Math.min(lo, P[v * 3 + 1]!); hi = Math.max(hi, P[v * 3 + 1]!); }
  const H = hi - lo;
  const at = (k: number): number => lo + H * k;
  const band = (y: number): number[] => body.skin.filter((v) => Math.abs(P[v * 3 + 1]! - y) < 0.15 && Math.abs(P[v * 3]!) < 1.6);
  const waist = band(at(0.6));
  const ax = waist.reduce((s, v) => s + P[v * 3]!, 0) / Math.max(1, waist.length);
  const az = waist.reduce((s, v) => s + P[v * 3 + 2]!, 0) / Math.max(1, waist.length);
  const chest = band(at(0.72));
  const radius = Math.max(...[waist, chest].map((b) => b.reduce((s, v) => s + Math.hypot(P[v * 3]! - ax, P[v * 3 + 2]! - az), 0) / Math.max(1, b.length)));
  return { shoulderY: at(0.815), chestY: at(0.72), waistY: at(0.6), hipY: at(0.52), kneeY: at(0.285), radius: radius * 1.05, axis: [ax, az] };
}

export function garmentPack(pos: Float32Array, tris: Uint32Array, P: Float32Array, skin: readonly number[], colour: number): ProxyPack {
  const n = pos.length / 3;
  const refs = new Uint32Array(n * 3), weights = new Float32Array(n * 3), offsets = new Float32Array(n * 3);
  const nearest = nearestThree(P, skin);
  for (let i = 0; i < n; i++) {
    const best = nearest([pos[i * 3]!, pos[i * 3 + 1]!, pos[i * 3 + 2]!]);
    const w = best.map(([d]) => 1 / (Math.sqrt(d) + 0.05));
    const total = w.reduce((s, x) => s + x, 0);
    let fx = 0, fy = 0, fz = 0;
    for (let k = 0; k < 3; k++) {
      const r = best[k]![1];
      refs[i * 3 + k] = r; weights[i * 3 + k] = w[k]! / total;
      fx += P[r * 3]! * w[k]! / total; fy += P[r * 3 + 1]! * w[k]! / total; fz += P[r * 3 + 2]! * w[k]! / total;
    }
    // Worn over the outfit: 1.2 cm further out from the skin than it draped, so it never fights the garment beneath.
    const ox = pos[i * 3]! - fx, oy = pos[i * 3 + 1]! - fy, oz = pos[i * 3 + 2]! - fz;
    const ol = Math.hypot(ox, oy, oz) || 1;
    offsets[i * 3] = ox + ox / ol * 0.12; offsets[i * 3 + 1] = oy + oy / ol * 0.12; offsets[i * 3 + 2] = oz + oz / ol * 0.12;
  }
  // One face only: the person's material draws both sides already, and a second, reversed copy fought it (blotches).
  const index = tris;
  const scaleRefs = [5399, 11998, 791, 881, 962, 5320];
  const axis = (k: number): number => Math.abs(P[scaleRefs[k * 2]! * 3 + k]! - P[scaleRefs[k * 2 + 1]! * 3 + k]!) || 1;
  return { name: 'atelier', kind: 'clothes', scaleRefs, scaleBase: [axis(0), axis(1), axis(2)], refs, weights, offsets, index, deleteVerts: new Uint32Array(0), colour, zDepth: 60 };
}

function encodePositions(pos: Float32Array): string {
  const view = new DataView(new ArrayBuffer(pos.length * 2));
  for (let i = 0; i < pos.length; i++) view.setInt16(i * 2, Math.max(-32767, Math.min(32767, Math.round(pos[i]! * 1000))), true);
  const u8 = new Uint8Array(view.buffer);
  let text = '';
  for (let i = 0; i < u8.length; i += 0x8000) text += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(text);
}

function decodePositions(text: string, length: number): Float32Array {
  const raw = atob(text);
  const u8 = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  const view = new DataView(u8.buffer);
  const out = new Float32Array(length);
  for (let i = 0; i < length && i * 2 + 2 <= u8.length; i++) out[i] = view.getInt16(i * 2, true) / 1000;
  return out;
}
