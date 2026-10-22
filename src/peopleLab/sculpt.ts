import {
  BufferAttribute, BufferGeometry, Color, DataTexture, DoubleSide, RGBAFormat, SRGBColorSpace, Group, Mesh, MeshStandardMaterial, Plane, Raycaster, RingGeometry, Vector2, Vector3,
  type Camera, type Intersection,
} from 'three';
import { fitProxy, type ProxyPack, type ProxyTexture } from '@people/body/proxy';

/** THE HAIR SCULPTOR: a solid hairstyle shaped with brushes on the person's own head; kept as moves of the item's offsets, so it fits any body */

export type BrushName = 'grab' | 'inflate' | 'smooth' | 'flatten' | 'pinch' | 'shorten';

/** Decimetres (the MakeHuman unit) to the scene's metres. */
const DM = 0.1;

/** A sculpt, saved: the base item and its vertices' offset moves (`encodeSculpt`). */
export interface HairSculpt {
  /** The hairstyle sculpted: a catalogue item or a grown `proc:` one. */
  readonly base: string;
  /** Base64 of [count u32][index u32, dx dy dz int16 in 1/4096 offset units] for every vertex moved. */
  readonly deltas: string;
}

const QUANTUM = 4096;

export function encodeSculpt(base: string, delta: Float32Array): HairSculpt {
  const moved: number[] = [];
  for (let v = 0; v < delta.length / 3; v++) {
    if (Math.abs(delta[v * 3]!) + Math.abs(delta[v * 3 + 1]!) + Math.abs(delta[v * 3 + 2]!) > 1.5 / QUANTUM) moved.push(v);
  }
  const bytes = new DataView(new ArrayBuffer(4 + moved.length * 10));
  bytes.setUint32(0, moved.length, true);
  moved.forEach((v, i) => {
    const at = 4 + i * 10;
    bytes.setUint32(at, v, true);
    for (let a = 0; a < 3; a++) bytes.setInt16(at + 4 + a * 2, Math.max(-32767, Math.min(32767, Math.round(delta[v * 3 + a]! * QUANTUM))), true);
  });
  let text = '';
  const u8 = new Uint8Array(bytes.buffer);
  for (let i = 0; i < u8.length; i += 0x8000) text += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return { base, deltas: btoa(text) };
}

export function decodeSculpt(sculpt: HairSculpt, vertexCount: number): Float32Array {
  const out = new Float32Array(vertexCount * 3);
  const raw = atob(sculpt.deltas);
  const u8 = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
  const bytes = new DataView(u8.buffer);
  const count = u8.length >= 4 ? bytes.getUint32(0, true) : 0;
  for (let i = 0; i < count && 4 + i * 10 + 10 <= u8.length; i++) {
    const at = 4 + i * 10, v = bytes.getUint32(at, true);
    if (v >= vertexCount) continue;
    for (let a = 0; a < 3; a++) out[v * 3 + a] = bytes.getInt16(at + 4 + a * 2, true) / QUANTUM;
  }
  return out;
}

/** The item with the sculpt's offsets added: the same refs and weights, so it is fitted to any body as the game fits it (`fitProxy`). */
export function sculptedPack(pack: ProxyPack, delta: Float32Array): ProxyPack {
  const offsets = new Float32Array(pack.offsets);
  for (let i = 0; i < offsets.length && i < delta.length; i++) offsets[i] = offsets[i]! + delta[i]!;
  return { ...pack, offsets };
}

/** `fitProxy`'s axis scales on this body: a position move of d decimetres is an offset move of d / scale. */
function axisScales(pack: ProxyPack, base: Float32Array): [number, number, number] {
  const axis = (i: number): number => {
    const a = pack.scaleRefs[i * 2]!, b = pack.scaleRefs[i * 2 + 1]!;
    const d = Math.abs(base[a * 3 + i]! - base[b * 3 + i]!);
    return d > 0 ? d / Math.max(1e-6, pack.scaleBase[i]!) : 1;
  };
  return [axis(0), axis(1), axis(2)];
}

export interface SculptBody {
  /** The person's base mesh as shaped (decimetres), the body's quads, and which of them are skin. */
  readonly positions: Float32Array;
  readonly faces: Uint16Array;
  readonly faceGroup: Uint8Array;
  readonly skinGroup: number;
}

export class HairSculptor {
  readonly group = new Group();
  readonly hair: Mesh;
  private readonly cursor: Mesh;
  private readonly fitted: Float32Array;
  private readonly work: Float32Array;
  private readonly scales: [number, number, number];
  /** Welded vertices: seams split one point into several; a brush moves them as one. */
  private readonly weld: Int32Array;
  private readonly neighbours: number[][];
  private readonly undo: Float32Array[] = [];
  private readonly redo: Float32Array[] = [];
  private readonly raycaster = new Raycaster();
  private stroke: { plane: Plane; start: Vector3; side: number; picked: Map<number, number>; from: Float32Array } | null = null;
  brush: BrushName = 'grab';
  /** Brush radius, decimetres. */
  radius = 1.1;
  strength = 0.5;
  mirror = true;
  /** The skull, for shortening towards it. */
  private readonly skull = new Vector3();

  constructor(private readonly pack: ProxyPack, body: SculptBody, start: Float32Array | null, colour: number, skinColour: number, texture: ProxyTexture | null = null) {
    const lowest = (() => { let y = Infinity; for (let i = 1; i < body.positions.length; i += 3) y = Math.min(y, body.positions[i]!); return y; })();
    this.group.scale.setScalar(DM);
    this.group.position.y = -lowest * DM;
    this.fitted = fitProxy(pack, body.positions);
    this.scales = axisScales(pack, body.positions);
    this.work = new Float32Array(this.fitted);
    if (start) for (let v = 0; v < this.work.length; v++) this.work[v] = this.work[v]! + start[v]! * this.scales[v % 3]!;

    // The body, still, in its bind posture: the skin's quads only.
    const tris: number[] = [];
    // The skin the piece covers is not drawn (as the game hides it): no skin poking through the cloth.
    const covered = new Set(pack.deleteVerts);
    for (let f = 0; f < body.faceGroup.length; f++) {
      if (body.faceGroup[f] !== body.skinGroup) continue;
      const [a, b, c, d] = [body.faces[f * 4]!, body.faces[f * 4 + 1]!, body.faces[f * 4 + 2]!, body.faces[f * 4 + 3]!];
      if (covered.has(a) || covered.has(b) || covered.has(c) || covered.has(d)) continue;
      tris.push(a, b, c);
      if (d !== c) tris.push(a, c, d);
    }
    const bodyGeometry = new BufferGeometry();
    bodyGeometry.setAttribute('position', new BufferAttribute(body.positions, 3));
    bodyGeometry.setIndex(tris);
    bodyGeometry.computeVertexNormals();
    // The skin in its own colour everywhere, the scalp included (no hair colour painted on it).
    const tint = new Float32Array(body.positions.length);
    const skinC = new Color(skinColour);
    for (let v = 0; v < tint.length / 3; v++) skinC.toArray(tint, v * 3);
    let headTop = -Infinity;
    for (let i = 1; i < body.positions.length; i += 3) headTop = Math.max(headTop, body.positions[i]!);
    bodyGeometry.setAttribute('color', new BufferAttribute(tint, 3));
    const skin = new Mesh(bodyGeometry, new MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
    skin.castShadow = skin.receiveShadow = true;
    this.group.add(skin);
    // The skull's middle: the mean of the skin within ~22 cm of the head's top (the brain case), front to back and side to side.
    let sx = 0, sz = 0, count = 0;
    for (let i = 0; i < body.positions.length; i += 3) if (body.positions[i + 1]! > headTop - 1.4) { sx += body.positions[i]!; sz += body.positions[i + 2]!; count++; }
    this.skull.set(count ? sx / count : 0, headTop - 1.0, count ? sz / count : 0);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.work, 3));
    geometry.setIndex(new BufferAttribute(pack.index, 1));
    // Its own strand texture, as the game draws the item: the cards read as hair, not as flat ribbons.
    const material = new MeshStandardMaterial({ color: colour, roughness: 0.55, side: DoubleSide });
    if (texture && pack.uvs) {
      geometry.setAttribute('uv', new BufferAttribute(pack.uvs, 2));
      // White strands with the texture's alpha: the hair's own colour shows, the cards cut to strands.
      const pixels = new Uint8Array(texture.data.length);
      for (let i = 0; i < pixels.length; i += 4) { pixels[i] = pixels[i + 1] = pixels[i + 2] = 200 + (texture.data[i]! >> 3); pixels[i + 3] = texture.data[i + 3]!; }
      const map = new DataTexture(pixels, texture.width, texture.height, RGBAFormat);
      map.flipY = true;
      map.needsUpdate = true;
      // Its colour (grey strands) tinted by the hair's, its alpha cut out (alphaMap would read the green channel, not the alpha).
      map.colorSpace = SRGBColorSpace;
      material.map = map;
      material.alphaTest = 0.45;
    }
    this.hair = new Mesh(geometry, material);
    this.hair.castShadow = true;
    this.group.add(this.hair);

    // Weld by position, then each welded point's neighbours along the triangles.
    const n = this.work.length / 3;
    this.weld = new Int32Array(n);
    const keyed = new Map<string, number>();
    for (let v = 0; v < n; v++) {
      const key = `${Math.round(this.fitted[v * 3]! * 2000)},${Math.round(this.fitted[v * 3 + 1]! * 2000)},${Math.round(this.fitted[v * 3 + 2]! * 2000)}`;
      let id = keyed.get(key);
      if (id === undefined) { id = v; keyed.set(key, v); }
      this.weld[v] = id;
    }
    const sets = new Map<number, Set<number>>();
    for (let t = 0; t < pack.index.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const a = this.weld[pack.index[t + k]!]!, b = this.weld[pack.index[t + ((k + 1) % 3)]!]!;
        if (a === b) continue;
        (sets.get(a) ?? sets.set(a, new Set()).get(a)!).add(b);
        (sets.get(b) ?? sets.set(b, new Set()).get(b)!).add(a);
      }
    }
    this.neighbours = Array.from({ length: n }, (_, v) => [...(sets.get(v) ?? [])]);
    this.refresh();

    this.cursor = new Mesh(new RingGeometry(0.92, 1, 48), new MeshStandardMaterial({ color: 0x1e9bf0, emissive: 0x1e9bf0, side: DoubleSide, transparent: true, opacity: 0.85, depthTest: false }));
    this.cursor.renderOrder = 10;
    this.cursor.visible = false;
    this.group.add(this.cursor);
  }

  /** The sculpt as moves of the item's offsets. */
  delta(): Float32Array {
    const out = new Float32Array(this.work.length);
    for (let v = 0; v < out.length; v++) out[v] = (this.work[v]! - this.fitted[v]!) / this.scales[v % 3]!;
    return out;
  }

  /** The item as sculpted. */
  sculpted(): ProxyPack { return sculptedPack(this.pack, this.delta()); }

  get canUndo(): boolean { return this.undo.length > 0; }

  reset(): void {
    this.remember();
    this.work.set(this.fitted);
    this.refresh();
  }

  undoStep(): void {
    const last = this.undo.pop();
    if (!last) return;
    this.redo.push(new Float32Array(this.work));
    this.work.set(last);
    this.refresh();
  }

  redoStep(): void {
    const next = this.redo.pop();
    if (!next) return;
    this.undo.push(new Float32Array(this.work));
    this.work.set(next);
    this.refresh();
  }

  private remember(): void {
    this.undo.push(new Float32Array(this.work));
    if (this.undo.length > 40) this.undo.shift();
    this.redo.length = 0;
  }

  /** No vertex further than this from where the item sits on the body (dm): a stroke never flings a strand off into a sheet. */
  private static readonly MAX_MOVE = 2.5;

  private refresh(): void {
    for (let v = 0; v < this.weld.length; v++) {
      const dx = this.work[v * 3]! - this.fitted[v * 3]!, dy = this.work[v * 3 + 1]! - this.fitted[v * 3 + 1]!, dz = this.work[v * 3 + 2]! - this.fitted[v * 3 + 2]!;
      const d = Math.hypot(dx, dy, dz);
      if (d > HairSculptor.MAX_MOVE) {
        const k = HairSculptor.MAX_MOVE / d;
        this.work[v * 3] = this.fitted[v * 3]! + dx * k; this.work[v * 3 + 1] = this.fitted[v * 3 + 1]! + dy * k; this.work[v * 3 + 2] = this.fitted[v * 3 + 2]! + dz * k;
      }
    }
    // Welded copies share one place, so seams never open.
    for (let v = 0; v < this.weld.length; v++) {
      const w = this.weld[v]!;
      if (w !== v) for (let a = 0; a < 3; a++) this.work[v * 3 + a] = this.work[w * 3 + a]!;
    }
    const g = this.hair.geometry;
    g.getAttribute('position').needsUpdate = true;
    g.computeVertexNormals();
    // One normal for each welded point: the seams' copies shade alike, smooth rather than faceted.
    const normal = g.getAttribute('normal') as BufferAttribute;
    const sum = new Float32Array(normal.array.length);
    for (let v = 0; v < this.weld.length; v++) {
      const w = this.weld[v]!;
      for (let a = 0; a < 3; a++) sum[w * 3 + a] = sum[w * 3 + a]! + normal.array[v * 3 + a]!;
    }
    for (let v = 0; v < this.weld.length; v++) {
      const w = this.weld[v]!;
      const l = Math.hypot(sum[w * 3]!, sum[w * 3 + 1]!, sum[w * 3 + 2]!) || 1;
      normal.setXYZ(v, sum[w * 3]! / l, sum[w * 3 + 1]! / l, sum[w * 3 + 2]! / l);
    }
    normal.needsUpdate = true;
    g.computeBoundingSphere();
  }

  private hit(ndc: Vector2, camera: Camera): Intersection | null {
    this.raycaster.setFromCamera(ndc, camera);
    return this.raycaster.intersectObject(this.hair, false)[0] ?? null;
  }

  /** The cursor over the hair; false when the pointer is off it. */
  hover(ndc: Vector2, camera: Camera): boolean {
    const h = this.hit(ndc, camera);
    this.cursor.visible = !!h;
    if (!h) return false;
    const local = this.group.worldToLocal(h.point.clone());
    this.cursor.position.copy(local);
    this.cursor.scale.setScalar(this.radius);
    const normal = h.face?.normal ?? new Vector3(0, 0, 1);
    this.cursor.lookAt(local.clone().add(normal));
    return true;
  }

  /** The whole piece longer (`factor` > 1) or shorter: its lower part stretched down from a line a little below its middle, evenly all round. */
  lengthen(factor: number): void {
    this.remember();
    let lo = Infinity, hi = -Infinity;
    for (let v = 1; v < this.work.length; v += 3) { lo = Math.min(lo, this.work[v]!); hi = Math.max(hi, this.work[v]!); }
    const pivot = hi - (hi - lo) * 0.45;
    for (let v = 1; v < this.work.length; v += 3) {
      const y = this.work[v]!;
      if (y < pivot) this.work[v] = pivot - (pivot - y) * factor;
    }
    this.refresh();
  }

  /** The whole piece looser (`dm` > 0) or tighter: every vertex moved along its normal, more at the hem (cloth hangs, it does not swell at the shoulders). */
  loosen(dm: number): void {
    this.remember();
    const normal = this.hair.geometry.getAttribute('normal');
    let lo = Infinity, hi = -Infinity;
    for (let v = 1; v < this.work.length; v += 3) { lo = Math.min(lo, this.work[v]!); hi = Math.max(hi, this.work[v]!); }
    for (let v = 0; v < this.weld.length; v++) {
      if (this.weld[v] !== v) continue;
      const down = 0.35 + 0.65 * (hi - this.work[v * 3 + 1]!) / Math.max(1e-4, hi - lo);
      for (let a = 0; a < 3; a++) this.work[v * 3 + a] = this.work[v * 3 + a]! + normal.getComponent(v, a) * dm * down;
    }
    this.refresh();
  }

  /** Vertices (welded) within the brush round `centre` (local, dm), with their falloff. */
  private within(centre: Vector3, out = new Map<number, number>()): Map<number, number> {
    const r2 = this.radius * this.radius;
    for (let v = 0; v < this.weld.length; v++) {
      if (this.weld[v] !== v) continue;
      const dx = this.work[v * 3]! - centre.x, dy = this.work[v * 3 + 1]! - centre.y, dz = this.work[v * 3 + 2]! - centre.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      // Smooth falloff (1 - t^2)^2: full in the middle, nothing at the rim.
      const t = d2 / r2;
      const w = (1 - t) * (1 - t);
      out.set(v, Math.max(out.get(v) ?? 0, w));
    }
    return out;
  }

  private centres(local: Vector3): Vector3[] {
    return this.mirror && Math.abs(local.x) > this.radius * 0.3 ? [local, new Vector3(-local.x, local.y, local.z)] : [local];
  }

  /** Starts a stroke; false when the pointer is not over the hair. */
  begin(ndc: Vector2, camera: Camera): boolean {
    const h = this.hit(ndc, camera);
    if (!h) return false;
    this.remember();
    const local = this.group.worldToLocal(h.point.clone());
    const picked = new Map<number, number>();
    for (const c of this.centres(local)) this.within(c, picked);
    const facing = new Vector3();
    camera.getWorldDirection(facing);
    this.stroke = { plane: new Plane().setFromNormalAndCoplanarPoint(facing, h.point), start: h.point.clone(), side: Math.sign(local.x), picked, from: new Float32Array(this.work) };
    if (this.brush !== 'grab') this.dab(local, 1);
    return true;
  }

  move(ndc: Vector2, camera: Camera, invert: boolean): void {
    this.hover(ndc, camera);
    const s = this.stroke;
    if (!s) return;
    if (this.brush === 'grab') {
      // The picked vertices follow the pointer on the plane facing the camera, each by its falloff (Blender's Grab).
      this.raycaster.setFromCamera(ndc, camera);
      const at = this.raycaster.ray.intersectPlane(s.plane, new Vector3());
      if (!at) return;
      const move = at.sub(s.start).divideScalar(DM);
      for (const [v, w] of s.picked) {
        // The mirrored side moves mirrored across the middle.
        const mx = this.mirror && s.side !== 0 && Math.sign(s.from[v * 3]!) === -s.side ? -1 : 1;
        this.work[v * 3] = s.from[v * 3]! + move.x * w * mx;
        this.work[v * 3 + 1] = s.from[v * 3 + 1]! + move.y * w;
        this.work[v * 3 + 2] = s.from[v * 3 + 2]! + move.z * w;
      }
      this.refresh();
      return;
    }
    const h = this.hit(ndc, camera);
    if (h) this.dab(this.group.worldToLocal(h.point.clone()), invert ? -1 : 1);
  }

  end(): void { this.stroke = null; }

  /** One touch of a brush at `local` (dm). */
  private dab(local: Vector3, sign: number): void {
    const normal = this.hair.geometry.getAttribute('normal');
    // Each touch moves a vertex at most this share of the brush radius: a stroke of ~10 touches reshapes the brush's width.
    const k = this.strength * 0.18;
    for (const c of this.centres(local)) {
      const picked = this.within(c);
      if (!picked.size) continue;
      // The plane under the brush (Flatten): the picked vertices' average place and normal.
      const mid = new Vector3(), avgN = new Vector3();
      for (const v of picked.keys()) {
        mid.x += this.work[v * 3]!; mid.y += this.work[v * 3 + 1]!; mid.z += this.work[v * 3 + 2]!;
        avgN.x += normal.getX(v); avgN.y += normal.getY(v); avgN.z += normal.getZ(v);
      }
      mid.divideScalar(picked.size);
      avgN.normalize();
      let meanReach = 0;
      for (const v of picked.keys()) meanReach += Math.hypot(this.work[v * 3]! - this.skull.x, this.work[v * 3 + 1]! - this.skull.y, this.work[v * 3 + 2]! - this.skull.z);
      meanReach /= picked.size;
      for (const [v, w] of picked) {
        const p = new Vector3(this.work[v * 3]!, this.work[v * 3 + 1]!, this.work[v * 3 + 2]!);
        switch (this.brush) {
          case 'inflate': {
            // Volume: out from the skull's middle (cards' normals point any way; out from the head is the hair's own 'out').
            const out = p.clone().sub(this.skull).normalize();
            p.addScaledVector(out, sign * w * k * this.radius * 0.6);
            break;
          }
          case 'smooth': {
            const ns = this.neighbours[v]!;
            if (!ns.length) break;
            const avg = new Vector3();
            for (const u of ns) avg.add(new Vector3(this.work[u * 3]!, this.work[u * 3 + 1]!, this.work[u * 3 + 2]!));
            avg.divideScalar(ns.length);
            p.lerp(avg, Math.min(1, w * this.strength));
            break;
          }
          case 'flatten': {
            // Flat to the head: each vertex brought towards the mean distance from the skull of those under the brush.
            const out = p.clone().sub(this.skull);
            const target = meanReach;
            p.copy(this.skull).addScaledVector(out.normalize(), out.length() + (target - p.distanceTo(this.skull)) * w * this.strength * 0.5 * sign);
            break;
          }
          case 'pinch':
            p.lerp(c, Math.min(0.5, sign * w * k));
            break;
          case 'shorten':
            // Drawn up towards the skull: long hair gets shorter, loose ends tuck in.
            p.lerp(this.skull, Math.min(0.5, sign * w * k * 0.35));
            break;
          case 'grab':
            break;
        }
        this.work[v * 3] = p.x; this.work[v * 3 + 1] = p.y; this.work[v * 3 + 2] = p.z;
      }
    }
    this.refresh();
  }

  dispose(): void {
    this.group.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
    });
  }
}
