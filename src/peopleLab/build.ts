import { SkinnedMesh, type Object3D, type Vector3 } from 'three';
import { loadPeopleAssets, type PeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { expressionShapes } from '@people/body/expressions';
import { generateHair, type HairBase, type HairStyle } from '@people/hair/procedural';
import { wornItems } from '@people/spec';
import { cartoonBody, type CartoonStyle } from '@render/people/cartoon';
import { createPersonRig, personSimplifier } from '@render/people/personRig';
import { attachFacialMorphs } from '@render/people/facialMorphs';
import { channelShapes } from '@render/people/faceExpression';
import { captureBind, captureBindRotations } from '@render/citizenWalk';
import { ATELIER, GROOM, PROC_PREFIX, type LabPerson } from './record';
import { ClothSim, PATTERNS } from './cloth';
import { garmentPack } from './atelier';
import { GroomBody, type StudioBody } from './groom';
import { FaceProportions } from './proportions';
import { isPlain, shapedPack } from './hairShape';
import { decodeSculpt, sculptedPack, type SculptBody } from './sculpt';
import type { HairSculpt } from './sculpt';

/** A LAB PERSON BUILT THE GAME'S WAY: `buildPersonScene` (`render/people/personBuild.ts`), with the hair studio's hairstyle worn as an item */

const hairBase = (a: PeopleAssets, mo: Morpher): HairBase => ({ positions: mo.base, vertexCount: a.mesh.vertexCount,
  bodyRange: a.bodyRange, joints: a.mesh.joints, weights: a.mesh.weights, boneNames: a.mesh.boneNames, faces: a.mesh.faces });

/** The style as the lab draws it: the eyes never swollen by `cartoonBody` (its sphere round each eye leaves a crater round the socket, an alien's face); big eyes come from the face's own `eye-scale` slider. */
const labStyle = (style: CartoonStyle): CartoonStyle => ({ ...style, eyes: 1 });

/** The body with its brush sculpt (`bodySculpt.ts`) added. */
function sculpted(positions: Float32Array, body: HairSculpt | undefined): Float32Array {
  if (!body) return positions;
  const d = decodeSculpt(body, positions.length / 3);
  for (let i = 0; i < positions.length; i++) positions[i] = positions[i]! + d[i]!;
  return positions;
}

export interface BuiltPerson {
  readonly scene: Object3D;
  readonly meshes: readonly SkinnedMesh[];
  readonly triangles: number;
  readonly morphs: number;
  /** A changed body shape (decimetres, `shape`) as relative moves of the mesh's vertices: live dragging (`PersonRig.morph`); absent on the tailored shells. */
  readonly morph?: (positions: Float32Array) => Float32Array;
  /** The bones' heads for a changed body shape (`PersonRig.heads`): the skeleton refitted without building. */
  readonly heads?: (positions: Float32Array) => Vector3[];
}

/** Builds the lab's people; keeps the MakeHuman packs and the grown hairstyles between builds. */
export class LabBuilder {
  private morpher: Morpher | null = null;
  private assets: PeopleAssets | null = null;
  /** Grown hairstyles by their settings: the same settings are grown once. */
  private readonly grown = new Map<string, ProxyItem>();

  private grownHair(style: HairStyle, a: PeopleAssets, mo: Morpher): ProxyItem {
    const key = JSON.stringify(style);
    let item = this.grown.get(key);
    if (!item) {
      // Plain-coloured cards, no strand texture: the solid, sculpted hair of The Sims ("Maxis Match").
      item = { pack: generateHair(style, hairBase(a, mo)), texture: null, transparent: false, textureFile: null };
      if (this.grown.size > 24) this.grown.clear();
      this.grown.set(key, item);
    }
    return item;
  }

  private faces: FaceProportions | null = null;

  /** The face's proportions, measured and set to the canon (`proportions.ts`). */
  async proportions(): Promise<FaceProportions> {
    const { assets: a, morpher: mo } = await this.setup();
    this.faces ??= new FaceProportions(a, mo, (spec) => mo.shape(spec.body, spec.features));
    return this.faces;
  }

  /** The MakeHuman packs, loaded once. */
  async setup(): Promise<{ assets: PeopleAssets; morpher: Morpher }> {
    this.assets ??= await loadPeopleAssets();
    this.morpher ??= new Morpher(this.assets.packs);
    return { assets: this.assets, morpher: this.morpher };
  }

  /** The hairstyle worn, as an item, before any sculpt: grown or loaded. */
  async hairItem(person: LabPerson): Promise<ProxyItem | null> {
    const { assets: a, morpher: mo } = await this.setup();
    const cut = person.spec.look.hairCut;
    if (!cut || cut === 'none') return null;
    // An older studio's hair: that studio is gone, worn as a bob.
    if (cut === GROOM) return loadProxyItem('bob02');
    return cut.startsWith(PROC_PREFIX) && person.hair ? this.grownHair(person.hair, a, mo) : loadProxyItem(cut);
  }

  /** The person's body for the hair studio: shaped, in the bind posture, its skin and the head and neck vertices hair is pinned to. */
  async studioBody(person: LabPerson): Promise<StudioBody> {
    const { assets: a } = await this.setup();
    const positions = await this.shape(person);
    const skin: number[] = [];
    for (const [lo, hi] of a.bodyRange) for (let v = lo; v <= hi; v++) skin.push(v);
    const m = a.mesh;
    const head = m.boneNames.indexOf('head'), neck = m.boneNames.indexOf('neck_01');
    const anchors = skin.filter((v) => {
      let w = 0;
      for (let k = 0; k < 4; k++) { const j = m.joints[v * 4 + k]; if (j === head || j === neck) w += m.weights[v * 4 + k]! / 65535; }
      return w >= 0.5;
    });
    return { positions, faces: m.faces, faceGroup: m.faceGroup, skinGroup: m.faceGroups.indexOf('body'), skin, anchors };
  }


  /** The atelier's garment as an item: its draped positions pinned to this body's skin. */
  async garmentItem(person: LabPerson): Promise<ProxyItem> {
    const body = await this.studioBody(person);
    const g = person.garment!;
    const raw = atob(g.pos);
    const view = new DataView(Uint8Array.from(raw, (ch) => ch.charCodeAt(0)).buffer);
    const pos = new Float32Array(raw.length / 2);
    for (let i = 0; i < pos.length; i++) pos[i] = view.getInt16(i * 2, true) / 1000;
    // The topology from the pattern and the measures it was drafted to (deterministic); only the drape is kept.
    const sim = new ClothSim(PATTERNS[g.pattern]!(g.measures, g.cut), 0.12, g.measures.axis);
    const tris = sim.tris;
    const P = body.positions;
    return { pack: garmentPack(pos, tris, P, body.skin, g.colour), texture: null, transparent: false, textureFile: null };
  }

  /** Any worn item by name, before its sculpt. */
  async item(person: LabPerson, name: string): Promise<ProxyItem | null> {
    if (name === person.spec.look.hairCut) return this.hairItem(person);
    try { return await loadProxyItem(name); } catch (error) { console.warn('[people-lab] no such item to sculpt', name, error); return null; }
  }

  /** The person's body as the sculptor shows it: shaped and styled, in its bind posture. */
  async sculptBody(person: LabPerson): Promise<SculptBody> {
    const { assets: a, morpher: mo } = await this.setup();
    return { positions: cartoonBody(mo.shape(person.spec.body, person.spec.features), a.mesh, labStyle(person.style)),
      faces: a.mesh.faces, faceGroup: a.mesh.faceGroup, skinGroup: a.mesh.faceGroups.indexOf('body') };
  }

  /** The body's shape for a person (decimetres): what `BuiltPerson.morph` reads. */
  async shape(person: LabPerson): Promise<Float32Array> {
    const { assets: a, morpher: mo } = await this.setup();
    return sculpted(cartoonBody(mo.shape(person.spec.body, person.spec.features), a.mesh, labStyle(person.style)), person.body);
  }

  async build(person: LabPerson): Promise<BuiltPerson> {
    const { assets: a, morpher: mo } = await this.setup();
    const { spec } = person;
    const proxies = new Map<string, ProxyItem>();
    try {
      for (const [name, item] of await Promise.all(wornItems(spec.look).map(async (n) =>
        [n, n === ATELIER && person.garment ? await this.garmentItem(person) : n === GROOM ? await loadProxyItem('bob02') : n.startsWith(PROC_PREFIX) && person.hair ? this.grownHair(person.hair, a, mo) : await loadProxyItem(n)] as const))) proxies.set(name, item);
    } catch (error) {
      // Drawn in the tailored shells rather than not at all, as the game does.
      console.warn('[people-lab] an item could not be loaded; drawn in the tailored shells', error);
      proxies.clear();
    }
    // The sculpt worn on its own hairstyle: the same item with its offsets moved.
    const cut = spec.look.hairCut;
    const worn = cut ? proxies.get(cut) : undefined;
    const sculpt = person.sculpt;
    if (cut && worn && sculpt?.base === cut) {
      const n = worn.pack.refs.length / 3;
      proxies.set(cut, { ...worn, pack: sculptedPack(worn.pack, decodeSculpt(sculpt, n)) });
    }
    // Every other sculpted piece worn, the same way.
    for (const piece of person.sculpts ?? []) {
      const item = proxies.get(piece.base);
      if (item) proxies.set(piece.base, { ...item, pack: sculptedPack(item.pack, decodeSculpt(piece, item.pack.refs.length / 3)) });
    }
    const body = sculpted(cartoonBody(mo.shape(spec.body, spec.features), a.mesh, labStyle(person.style)), person.body);
    // The worn hairstyle's length, volume and waves, on this body (`hairShape.ts`).
    const shaped = cut ? proxies.get(cut) : undefined;
    const outfit = spec.look.outfit, dressed = outfit ? proxies.get(outfit) : undefined;
    const shapeHair = !!(cut && shaped && !isPlain(person.hairShape)), shapeOutfit = !!(outfit && dressed && !isPlain(person.outfitShape));
    if (shapeHair || shapeOutfit) {
      // Moved points kept out of the skin (`GroomBody.collide`, the body's own surface).
      const skin: number[] = [];
      for (const [lo, hi] of a.bodyRange) for (let v = lo; v <= hi; v++) skin.push(v);
      const surface = new GroomBody(body, skin, a.mesh.faces, a.mesh.faceGroup, a.mesh.faceGroups.indexOf('body'));
      const out = (margin: number) => (q: number[]): void => surface.collide(q, 0, margin, false);
      if (shapeHair) proxies.set(cut!, { ...shaped!, pack: shapedPack(shaped!.pack, body, person.hairShape!, out(0.02)) });
      // The worn outfit's length and looseness, the same way.
      // A garment stands a centimetre off the skin where it was moved: skirts hang clear of the knees, whose skinning differs a little from the cloth's.
      if (shapeOutfit) proxies.set(outfit!, { ...dressed!, pack: shapedPack(dressed!.pack, body, { ...person.outfitShape!, length: Math.min(1, person.outfitShape!.length) }, out(0.1), skin, true) });
    }
    const sex = spec.body.gender < 0.5 ? 'female' : 'male';
    const input = {
      proxies,
      texturedSkin: true,
      data: a.mesh, skeleton: a.skeleton, bodyRange: a.bodyRange,
      positions: body, look: spec.look,
      capture: captureBind(sex), captureAxes: captureBindRotations(sex),
    };
    await personSimplifier;
    const rig = createPersonRig(input);
    await attachFacialMorphs(input, rig, channelShapes(await expressionShapes()));
    const meshes: SkinnedMesh[] = [];
    const waits: Promise<unknown>[] = [];
    rig.scene.traverse((o) => {
      if (!(o instanceof SkinnedMesh)) return;
      meshes.push(o);
      waits.push(o.geometry.userData['lodReady'] as Promise<unknown>);
    });
    await Promise.all(waits);
    let triangles = 0;
    for (const m of meshes) triangles += (m.geometry.index?.count ?? m.geometry.getAttribute('position').count) / 3;
    return { scene: rig.scene, meshes, triangles, morphs: Object.keys(rig.mesh.morphTargetDictionary ?? {}).length, ...(rig.morph ? { morph: rig.morph } : {}), ...(rig.heads ? { heads: rig.heads } : {}) };
  }
}
