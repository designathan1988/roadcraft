import { PARTS } from './presets';
import { Raycaster, Vector3, type BufferAttribute, type Camera, type SkinnedMesh, type Vector2 } from 'three';

/** SHAPING BY HAND, as Create-a-Sim does it: the part under the pointer is found, and dragging it changes that part (sideways one slider, up and down another) */

export interface Region {
  readonly id: string;
  readonly label: string;
  /** The slider dragging sideways changes, and the one dragging up and down changes; 'body:<macro>' is a macro slider. */
  readonly x: { readonly slider: string; readonly label: string };
  readonly y: { readonly slider: string; readonly label: string };
}

const R = (id: string, label: string, x: [string, string], y: [string, string]): Region =>
  ({ id, label, x: { slider: x[0], label: x[1] }, y: { slider: y[0], label: y[1] } });

export const REGIONS: Readonly<Record<string, Region>> = {
  head: R('head', 'Cabeça', ['head-scale-horiz-decr-incr', 'largura'], ['head-scale-vert-decr-incr', 'altura']),
  forehead: R('forehead', 'Testa', ['forehead-temple-decr-incr', 'têmporas'], ['forehead-scale-vert-decr-incr', 'altura']),
  brows: R('brows', 'Sobrancelhas', ['eyebrows-angle-down-up', 'ângulo'], ['eyebrows-trans-down-up', 'altura']),
  eyes: R('eyes', 'Olhos', ['eye-trans-in-out', 'distância'], ['eye-scale-decr-incr', 'tamanho']),
  nose: R('nose', 'Nariz', ['nose-scale-horiz-decr-incr', 'largura'], ['nose-point-down-up', 'ponta']),
  cheeks: R('cheeks', 'Bochechas', ['cheek-volume-decr-incr', 'volume'], ['cheek-bones-decr-incr', 'maçãs']),
  mouth: R('mouth', 'Boca', ['mouth-scale-horiz-decr-incr', 'largura'], ['mouth-lowerlip-volume-decr-incr', 'lábios']),
  jaw: R('jaw', 'Queixo', ['chin-width-decr-incr', 'largura'], ['chin-height-decr-incr', 'altura']),
  ears: R('ears', 'Orelhas', ['ear-flap-decr-incr', 'abertura'], ['ear-scale-decr-incr', 'tamanho']),
  neck: R('neck', 'Pescoço', ['measure-neck-circ-decr-incr', 'grossura'], ['measure-neck-height-decr-incr', 'altura']),
  chest: R('chest', 'Peito e ombros', ['measure-shoulder-dist-decr-incr', 'ombros'], ['measure-bust-circ-decr-incr', 'peito']),
  belly: R('belly', 'Barriga', ['measure-waist-circ-decr-incr', 'cintura'], ['stomach-pregnant-decr-incr', 'barriga']),
  hips: R('hips', 'Quadril', ['measure-hips-circ-decr-incr', 'quadril'], ['buttocks-volume-decr-incr', 'bumbum']),
  arms: R('arms', 'Braços', ['upperarm-fat-decr-incr', 'gordura'], ['upperarm-muscle-decr-incr', 'músculo']),
  legs: R('legs', 'Pernas', ['measure-thigh-circ-decr-incr', 'coxas'], ['upperlegs-height-decr-incr', 'comprimento']),
  hands: R('hands', 'Mãos', ['hand-fingers-length-decr-incr', 'dedos'], ['hand-scale-decr-incr', 'tamanho']),
  feet: R('feet', 'Pés', ['foot-scale-horiz-decr-incr', 'largura'], ['foot-scale-decr-incr', 'tamanho']),
};

/** Every slider of a part (the presets' lists, `presets.ts` PARTS): the part under the pointer is found by all of them, so its whole surface answers. */
const FINDERS: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(PARTS.map((p) => [p.id, p.sliders.filter((s) => s !== 'head-fat-decr-incr')])),
  forehead: ['forehead-scale-vert-decr-incr', 'forehead-temple-decr-incr', 'forehead-trans-backward-forward', 'forehead-nubian-decr-incr'],
  head: ['head-scale-horiz-decr-incr', 'head-scale-vert-decr-incr', 'head-back-scale-depth-decr-incr'],
  // Lengths carry everything beyond them along (a longer neck lifts the whole head): parts are found by their girth only.
  // The brows' height drags the forehead along: they are found by their angle, which bends only the brow.
  brows: ['eyebrows-angle-down-up'],
  neck: ['measure-neck-circ-decr-incr', 'neck-double-decr-incr', 'neck-scale-horiz-decr-incr'],
  legs: ['measure-thigh-circ-decr-incr', 'upperleg-fat-decr-incr', 'measure-calf-circ-decr-incr'],
  arms: ['upperarm-fat-decr-incr', 'upperarm-muscle-decr-incr', 'measure-upperarm-circ-decr-incr'],
  chest: ['measure-bust-circ-decr-incr', 'torso-muscle-pectoral-decr-incr'],
  belly: ['measure-waist-circ-decr-incr', 'stomach-pregnant-decr-incr'],
  hips: ['measure-hips-circ-decr-incr', 'buttocks-volume-decr-incr'],
};

/** The regions in a fixed order (their ids in the glow attribute). */
export const REGION_IDS: readonly string[] = Object.keys(REGIONS);

/** The face as drawn: its middle line, the eyes' height, the chin's, and the head's half width, metres. */
interface FaceFrame { readonly cx: number; readonly eyeY: number; readonly chinY: number; readonly topY: number; readonly halfX: number; readonly midZ: number }

export class HandShaper {
  private readonly raycaster = new Raycaster();
  private face: FaceFrame | null = null;
  private readonly v = new Vector3();

  /** `influence(slider)`: how much each base-mesh vertex that slider moves, 0..1 (`FaceProportions.influenceOf`): the part under the pointer is the one whose sliders move the vertex there, not a guessed height. */
  constructor(private readonly mesh: SkinnedMesh, private readonly influence?: (slider: string) => Float32Array) {}

  /** The region whose sliders move base vertex `v` most, or null when none moves it. The whole head's sizes move every vertex of it, so they count last. */
  private regionOfVertex(v: number): Region | null {
    if (!this.influence) return null;
    let best: Region | null = null, most = 0.08;
    for (const region of Object.values(REGIONS)) {
      let weight = 0;
      for (const slider of FINDERS[region.id] ?? [region.x.slider, region.y.slider]) weight = Math.max(weight, this.influence(slider)[v] ?? 0);
      if (region.id === 'head') weight *= 0.35;
      if (weight > most) { most = weight; best = region; }
    }
    return best;
  }

  private boneOf(vertex: number): string {
    const g = this.mesh.geometry;
    const index = g.getAttribute('skinIndex') as BufferAttribute, weight = g.getAttribute('skinWeight') as BufferAttribute;
    let best = 0, bone = 0;
    for (let k = 0; k < 4; k++) {
      const w = weight.getComponent(vertex, k);
      if (w > best) { best = w; bone = index.getComponent(vertex, k); }
    }
    return this.mesh.skeleton.bones[bone]?.name ?? '';
  }

  /** The face's landmarks in the pose drawn now (skinned): the eyeballs' middle (`eyeMask`), the head's lowest front point (the chin) and top. */
  private faceFrame(): FaceFrame {
    const g = this.mesh.geometry;
    const n = g.getAttribute('position').count;
    const eyeMask = g.getAttribute('eyeMask') as BufferAttribute | undefined;
    let eyeY = 0, eyes = 0, minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < n; i++) {
      const eye = !!eyeMask && eyeMask.getX(i) > 0.5;
      if (!eye && (i % 3 !== 0 || !/head/i.test(this.boneOf(i)))) continue;
      this.mesh.getVertexPosition(i, this.v);
      this.v.applyMatrix4(this.mesh.matrixWorld);
      if (eye) { eyeY += this.v.y; eyes++; continue; }
      minY = Math.min(minY, this.v.y); maxY = Math.max(maxY, this.v.y);
      minX = Math.min(minX, this.v.x); maxX = Math.max(maxX, this.v.x);
      minZ = Math.min(minZ, this.v.z); maxZ = Math.max(maxZ, this.v.z);
    }
    return { cx: (minX + maxX) / 2, halfX: (maxX - minX) / 2, midZ: (minZ + maxZ) / 2, topY: maxY,
      eyeY: eyes ? eyeY / eyes : minY + (maxY - minY) * 0.55, chinY: minY };
  }

  /** Each drawn vertex's region, as its place in `REGION_IDS` + 1 (0: none): the glow over the part under the pointer reads it. */
  regionAttribute(): Float32Array {
    const g = this.mesh.geometry;
    const n = g.getAttribute('position').count;
    const out = new Float32Array(n);
    const source = g.userData['morphSource'] as { kind: Int16Array; index: Int32Array } | undefined;
    const hairMask = g.getAttribute('hairMask') as BufferAttribute | undefined;
    const ids = new Map(REGION_IDS.map((id, i) => [id, i + 1]));
    const byVertex = new Map<number, number>();
    for (let i = 0; i < n; i++) {
      if (hairMask && Math.round(hairMask.getX(i)) === 2) { out[i] = ids.get('brows')!; continue; }
      if (hairMask && Math.round(hairMask.getX(i)) >= 1) continue;
      if (source && source.kind[i] === -1) {
        const v = source.index[i]!;
        let r = byVertex.get(v);
        if (r === undefined) { const region = this.regionOfVertex(v); r = region ? ids.get(region.id)! : 0; byVertex.set(v, r); }
        out[i] = r;
        continue;
      }
      // A garment: the body part its bone moves.
      const bone = this.boneOf(i);
      const id = /neck/i.test(bone) ? 'neck' : /finger|hand/i.test(bone) ? 'hands' : /foot|toe/i.test(bone) ? 'feet' : /arm|clavicle/i.test(bone) ? 'arms'
        : /thigh|calf/i.test(bone) ? 'legs' : /pelvis/i.test(bone) ? 'hips' : /spine2|spine1/i.test(bone) ? 'chest' : /spine/i.test(bone) ? 'belly' : '';
      out[i] = id ? ids.get(id)! : 0;
    }
    return out;
  }

  /** The region under the pointer, or null off the person. */
  pick(ndc: Vector2, camera: Camera): Region | null {
    this.raycaster.setFromCamera(ndc, camera);
    const hit = this.raycaster.intersectObject(this.mesh, false)[0];
    if (!hit?.face) return null;
    // On an eyebrow (the brow item, `hairMask` 2): the brows themselves.
    const hairMask = this.mesh.geometry.getAttribute('hairMask') as BufferAttribute | undefined;
    if (hairMask && Math.round(hairMask.getX(hit.face.a)) === 2) return REGIONS['brows']!;
    // The hit's nearest corner, as a vertex of the base mesh (`morphSource`: kind -1 is the body, its index the base vertex).
    const source = this.mesh.geometry.userData['morphSource'] as { kind: Int16Array; index: Int32Array } | undefined;
    if (source) {
      let near = hit.face.a, nearest = Infinity;
      for (const c of [hit.face.a, hit.face.b, hit.face.c]) {
        this.mesh.getVertexPosition(c, this.v).applyMatrix4(this.mesh.matrixWorld);
        const d = this.v.distanceToSquared(hit.point);
        if (d < nearest) { nearest = d; near = c; }
      }
      if (source.kind[near] === -1) {
        const region = this.regionOfVertex(source.index[near]!);
        if (region) return region;
      }
    }
    const bone = this.boneOf(hit.face.a);
    const p = hit.point;
    if (/head/i.test(bone)) {
      this.face ??= this.faceFrame();
      const f = this.face;
      // Heights in units of eyes-to-chin (D) from the eyes: brows above them, nose and cheeks below, the mouth lower, the jaw last.
      const d = Math.max(1e-4, f.eyeY - f.chinY);
      const u = (p.y - f.eyeY) / d;
      const side = Math.abs(p.x - f.cx) / Math.max(1e-4, f.halfX);
      if (p.z < f.midZ || p.y > f.eyeY + (f.topY - f.eyeY) * 0.75) return REGIONS['head']!;
      if (side > 0.8 && u > -0.6 && u < 0.3) return REGIONS['ears']!;
      if (u > 0.4) return REGIONS['forehead']!;
      if (u > 0.13) return REGIONS['brows']!;
      if (u > -0.13 && side > 0.12) return REGIONS['eyes']!;
      if (u > -0.5 && side < 0.22) return REGIONS['nose']!;
      if (u > -0.55) return REGIONS['cheeks']!;
      if (u > -0.82 && side < 0.45) return REGIONS['mouth']!;
      return REGIONS['jaw']!;
    }
    if (/neck/i.test(bone)) return REGIONS['neck']!;
    if (/finger|hand/i.test(bone)) return REGIONS['hands']!;
    if (/foot|toe/i.test(bone)) return REGIONS['feet']!;
    if (/arm|clavicle/i.test(bone)) return REGIONS['arms']!;
    if (/thigh|calf/i.test(bone)) return REGIONS['legs']!;
    if (/pelvis/i.test(bone)) return REGIONS['hips']!;
    if (/spine2|spine1/i.test(bone)) return REGIONS['chest']!;
    if (/spine/i.test(bone)) return REGIONS['belly']!;
    return null;
  }
}
