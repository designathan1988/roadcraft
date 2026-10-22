import { SkinnedMesh, type Object3D } from 'three';
import { loadPeopleAssets, type PeopleAssets } from '@people/body/assets';
import { Morpher } from '@people/body/morph';
import { loadProxyItem, type ProxyItem } from '@people/body/proxy';
import { expressionShapes } from '@people/body/expressions';
import { generateHair, type HairBase, type HairStyle } from '@people/hair/procedural';
import { wornItems } from '@people/spec';
import { cartoonBody, type CartoonStyle } from '@render/people/cartoon';
import { createPersonRig, personSimplifier, type Reshaped } from '@render/people/personRig';
import { attachFacialMorphs } from '@render/people/facialMorphs';
import { channelShapes } from '@render/people/faceExpression';
import { captureBind, captureBindRotations } from '@render/citizenWalk';
import { GROOM, PROC_PREFIX, type LabPerson } from './record';
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
  /** The body's shape it was built on (decimetres): what the face's shapes are added to (`faceRig.ts`). */
  readonly shape: Float32Array;
  /** A changed body shape as the build would make it, without building (`PersonRig.reshape`). */
  readonly reshape?: (positions: Float32Array) => Reshaped;
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


  /** Any worn item by name, before its sculpt. */
  async item(person: LabPerson, name: string): Promise<ProxyItem | null> {
    if (name === person.spec.look.hairCut) return this.hairItem(person);
    try { return await loadProxyItem(name); } catch (error) { console.warn('[people-lab] no such item to sculpt', name, error); return null; }
  }

  /** The hairstyle or the outfit with its length, volume and waves (`hairShape.ts`) on this body (dm), moved points kept out of the skin
   *  (`GroomBody.collide`); any other piece as it is. */
  private shaped(person: LabPerson, name: string, item: ProxyItem, body: Float32Array, a: PeopleAssets): ProxyItem {
    const hair = name === person.spec.look.hairCut, outfit = name === person.spec.look.outfit;
    const shape = hair ? person.hairShape : outfit ? person.outfitShape : undefined;
    if (!shape || isPlain(shape)) return item;
    const skin: number[] = [];
    for (const [lo, hi] of a.bodyRange) for (let v = lo; v <= hi; v++) skin.push(v);
    const surface = new GroomBody(body, skin, a.mesh.faces, a.mesh.faceGroup, a.mesh.faceGroups.indexOf('body'));
    const out = (margin: number) => (q: number[]): void => surface.collide(q, 0, margin, false);
    // A garment stands a centimetre off the skin where it was moved: skirts hang clear of the knees, whose skinning differs a little from the cloth's.
    return { ...item, pack: hair ? shapedPack(item.pack, body, shape, out(0.02))
      : shapedPack(item.pack, body, { ...shape, length: Math.min(1, shape.length) }, out(0.1), skin, true) };
  }

  /** A worn piece as the person wears it, before its sculpt: what the sculptor works on. */
  async wornPiece(person: LabPerson, name: string): Promise<ProxyItem | null> {
    const item = await this.item(person, name);
    if (!item) return null;
    const { assets: a } = await this.setup();
    return this.shaped(person, name, item, await this.shape(person), a);
  }

  /** The person's body as the sculptor shows it: as built (shaped, styled, its own sculpt), in its bind posture. */
  async sculptBody(person: LabPerson): Promise<SculptBody> {
    const { assets: a } = await this.setup();
    return { positions: await this.shape(person), faces: a.mesh.faces, faceGroup: a.mesh.faceGroup, skinGroup: a.mesh.faceGroups.indexOf('body') };
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
        [n, n === GROOM ? await loadProxyItem('bob02') : n.startsWith(PROC_PREFIX) && person.hair ? this.grownHair(person.hair, a, mo) : await loadProxyItem(n)] as const))) proxies.set(name, item);
    } catch (error) {
      // Drawn in the tailored shells rather than not at all, as the game does.
      console.warn('[people-lab] an item could not be loaded; drawn in the tailored shells', error);
      proxies.clear();
    }
    const body = sculpted(cartoonBody(mo.shape(spec.body, spec.features), a.mesh, labStyle(person.style)), person.body);
    // The hairstyle's and outfit's length, volume and waves first (`shaped`), then each piece's sculpt on top: the sculptor works on the
    // piece as worn (`wornPiece`), so a stroke lands on the person where it was made.
    const cut = spec.look.hairCut, outfit = spec.look.outfit;
    for (const name of [cut, outfit]) {
      const item = name ? proxies.get(name) : undefined;
      if (name && item) proxies.set(name, this.shaped(person, name, item, body, a));
    }
    const sculpt = person.sculpt;
    for (const piece of [...(cut && sculpt?.base === cut ? [sculpt] : []), ...(person.sculpts ?? [])]) {
      const item = proxies.get(piece.base);
      if (item) proxies.set(piece.base, { ...item, pack: sculptedPack(item.pack, decodeSculpt(piece, item.pack.refs.length / 3)) });
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
    return { scene: rig.scene, meshes, triangles, shape: body, morphs: Object.keys(rig.mesh.morphTargetDictionary ?? {}).length, ...(rig.morph ? { morph: rig.morph } : {}), ...(rig.reshape ? { reshape: rig.reshape } : {}) };
  }
}
