import { ageFromYears, yearsFromAge, type MacroParams } from '@people/body/macro';
import type { HairShape } from './hairShape';
import { EYE_COLOURS, WARDROBE, type PersonLook, type PersonSpec } from '@people/spec';
import { itemsOf, type WardrobeItem } from '@people/wardrobe';
import type { CartoonStyle } from '@render/people/cartoon';
import { CLOTH, FACE, HAIR_CATALOGUE, HAIR_FRINGED, HAIR_LABELS, HAIR_TIED, HAIR_COLOURS, HEAD_SHAPES, MOODS, SHOES_CATALOGUE, SKIN, STYLE_PRESETS } from './choices';
import type { PoseName } from './pose';
import type { LibraryClipName } from '@render/citizenWalk';
import { BODIES, FACES, LOOKS, PARTS, mannequin, currentPreset, withBody, withFace, withPart } from './presets';
import type { LabPerson } from './record';
import type { Framing, Thumbs } from './thumbs';
import { el, type widgets } from './widgets';
import { icon } from './icons';

/** THE CREATOR'S PANELS, as Create-a-Sim lays them out: pictures of every choice first, the fine sliders folded away under them */

export interface PanelContext {
  readonly person: LabPerson;
  readonly showAll: boolean;
  readonly activity: string | undefined;
  readonly pose: PoseName;
  readonly clip: LibraryClipName;
  readonly ui: ReturnType<typeof widgets>;
  readonly pictures: Thumbs;
  setSpec(patch: Partial<PersonSpec>): void;
  setLook(patch: { [K in keyof PersonLook]?: PersonLook[K] | undefined }): void;
  setBody(k: keyof MacroParams, v: number): void;
  setFeature(k: string, v: number): void;
  setStyle(s: CartoonStyle): void;
  setMood(v: number): void;
  setShowAll(v: boolean): void;
  act(activity: string | undefined, pose: PoseName, clip: LibraryClipName): void;
  render(): void;
  openSculptor(item?: string): void;
  /** Takes a piece's sculpt off. */
  dropPiece(item: string): void;
  dropSculpt(): void;
  /** The worn hairstyle's length, volume and waves (`hairShape.ts`). */
  hairShape(): HairShape;
  setHairShape(s: HairShape): void;
  /** The worn outfit's length and looseness. */
  outfitShape(): HairShape;
  setOutfitShape(s: HairShape): void;
  fitFace(): void;
  extraOf(kinds: readonly WardrobeItem['kind'][]): string;
  setExtra(kinds: readonly WardrobeItem['kind'][], name: string): void;
  sex(): 'female' | 'male';
  setSex(v: 'female' | 'male'): void;
  /** The garment atelier (`atelier.ts`). */
  openAtelier(): void;
  /** Brushes on the body and face (`bodySculpt.ts`). */
  openCarver(): void;
}

interface Pic { readonly id: string; readonly label: string; readonly variant: LabPerson }

/** A category's groups, in order: each an id, a label and what it shows. */
export type Groups = readonly (readonly [string, string, () => Node[]])[];

/** Regional body sliders by group, with their names (`modifiers.json` regional). */
const BODY_SLIDERS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
  tronco: [['measure-shoulder-dist-decr-incr', 'Ombros'], ['measure-bust-circ-decr-incr', 'Peito'], ['measure-underbust-circ-decr-incr', 'Sob o busto'],
    ['measure-waist-circ-decr-incr', 'Cintura'], ['stomach-pregnant-decr-incr', 'Barriga'], ['measure-hips-circ-decr-incr', 'Quadril'],
    ['buttocks-volume-decr-incr', 'Glúteos'], ['torso-vshape-decr-incr', 'Forma em V'], ['torso-scale-vert-decr-incr', 'Altura do tronco'],
    ['measure-neck-circ-decr-incr', 'Pescoço'], ['measure-neck-height-decr-incr', 'Altura do pescoço']],
  bracos: [['measure-upperarm-length-decr-incr', 'Comprimento'], ['measure-upperarm-circ-decr-incr', 'Braço'], ['upperarm-muscle-decr-incr', 'Bíceps'],
    ['upperarm-fat-decr-incr', 'Gordura'], ['lowerarm-muscle-decr-incr', 'Antebraço'], ['hand-scale-decr-incr', 'Mãos'], ['hand-fingers-length-decr-incr', 'Dedos']],
  pernas: [['upperlegs-height-decr-incr', 'Coxas (altura)'], ['lowerlegs-height-decr-incr', 'Canelas (altura)'], ['measure-thigh-circ-decr-incr', 'Coxas'],
    ['measure-calf-circ-decr-incr', 'Panturrilhas'], ['upperleg-muscle-decr-incr', 'Músculo'], ['measure-knee-circ-decr-incr', 'Joelhos'],
    ['foot-scale-decr-incr', 'Pés'], ['measure-ankle-circ-decr-incr', 'Tornozelos']],
};

/** Each face part's pictures framed on the part itself. */
const FRAMES: Readonly<Record<string, Framing>> = { eyes: 'eyes', brows: 'brows', nose: 'nose', mouth: 'mouth', cheeks: 'cheeks', jaw: 'jaw', ears: 'ears' };

export function makePanels(c: PanelContext): Record<string, Groups> {
  const { slider, swatches, seg } = c.ui;
  const p = (): LabPerson => c.person;

  /** A grid of pictures, each the person wearing that choice. */
  const pics = (entries: readonly Pic[], current: string | null | undefined, pick: (id: string) => void, framing: Framing): HTMLElement => {
    const grid = el('div', { cls: 'pics' });
    for (const e of entries) {
      const key = `${framing}:${JSON.stringify([e.variant.spec.body, e.variant.spec.features, e.variant.spec.look, e.variant.style, e.variant.sculpt?.deltas.length])}`;
      // The picture says it; the name is only the tooltip.
      const t = el('button', { cls: `pic${e.id === current ? ' on' : ''}`, title: e.label }, c.pictures.image(key, e.variant, framing));
      t.onclick = () => { pick(e.id); c.render(); };
      grid.append(t);
    }
    return grid;
  };
  /** Pictures are of the mannequin (`presets.ts` mannequin), never of the person: the item shown alone, each picture made once. */
  const m = (): LabPerson => mannequin(c.sex());
  const withLook = (patch: Partial<PersonLook>): LabPerson => ({ ...m(), spec: { ...m().spec, look: { ...m().spec.look, ...patch } } });
  const withFeatures = (features: Record<string, number>): LabPerson => ({ ...m(), spec: { ...m().spec, features } });
  /** A face preset on the mannequin's own face. */
  const mf = (): Readonly<Record<string, number>> => m().spec.features;
  const sliderLabel = new Map(FACE.flatMap(([, sliders]) => sliders.map(([k, label]) => [k, label] as const)));
  const featureSlider = (k: string, label = sliderLabel.get(k) ?? k): HTMLElement => slider(label, -1, 1, 0.01, p().spec.features[k] ?? 0, (v) => c.setFeature(k, v));
  /** A worn piece's sculpt buttons: open the sculptor on it, or take its sculpt off. */
  const carvePiece = (item: string | undefined, label: string): HTMLElement[] => {
    if (!item || item === 'none') return [];
    const carve = el('button', { cls: 'big alt' }, icon('sculpt', 15), label);
    carve.onclick = () => c.openSculptor(item);
    const sculpted = p().sculpts?.some((x) => x.base === item);
    if (!sculpted) return [carve];
    const drop = el('button', { cls: 'big alt', textContent: 'Desfazer escultura' });
    drop.onclick = () => c.dropPiece(item);
    return [el('div', { cls: 'pair' }, carve, drop)];
  };
  const nameOf = (n: string): string => n.replace(/^(female|male)_/, '').replace(/^[a-z0-9]+_(?=[a-z])/i, '').replace(/_/g, ' ').slice(0, 18);

  const b = (): LabPerson['spec']['body'] => p().spec.body;
  const shares = (k: 'african' | 'asian' | 'caucasian', v: number): void => {
    const bb = b();
    const others = (['african', 'asian', 'caucasian'] as const).filter((o) => o !== k);
    const rest = others.reduce((s, o) => s + bb[o], 0) || 1;
    c.setSpec({ body: { ...bb, [k]: v, [others[0]!]: (bb[others[0]!] / rest) * (1 - v), [others[1]!]: (bb[others[1]!] / rest) * (1 - v) } });
  };
  const sliderList = (list: readonly (readonly [string, string])[]): HTMLElement[] => list.map(([k, label]) => featureSlider(k, label));
  const partGroup = (id: string): (() => Node[]) => () => {
    const part = PARTS.find((x) => x.id === id)!;
    const f = p().spec.features;
    return [
      pics(part.presets.map((pr) => ({ id: pr.label, label: pr.label, variant: withFeatures(withPart(mf(), part, pr)) })), currentPreset(f, part),
        (pid) => c.setSpec({ features: withPart(f, part, part.presets.find((x) => x.label === pid)!) }), FRAMES[part.id] ?? 'face'),
      el('div', { cls: 'gap' }),
      ...part.sliders.filter((k) => sliderLabel.has(k)).map((k) => featureSlider(k)),
    ];
  };
  const sex = (): 'female' | 'male' => c.sex();
  const outfitPics = (names: readonly string[]): HTMLElement =>
    pics(names.map((n) => ({ id: n, label: nameOf(n), variant: withLook({ outfit: n }) })), p().spec.look.outfit, (id) => c.setLook({ outfit: id }), 'body');
  const allToggle = (label: string): HTMLElement => {
    const all = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: c.showAll }), label);
    all.querySelector('input')!.addEventListener('change', (e) => { c.setShowAll((e.target as HTMLInputElement).checked); });
    return all;
  };
  const opts = (kind: WardrobeItem['kind']): readonly string[] => itemsOf(kind, { street: !c.showAll, sex: sex() });
  const child = (): boolean => yearsFromAge(b().age) < 16;
  const extraPics = (kind: WardrobeItem['kind'], none: string): HTMLElement =>
    pics(['none', ...itemsOf(kind, { street: true, sex: sex() })].map((n) => ({ id: n, label: n === 'none' ? none : nameOf(n), variant: withLook({ extras: n === 'none' ? [] : [n] }) })),
      c.extraOf([kind]), (id) => c.setExtra([kind], id), kind === 'beard' ? 'jaw' : kind === 'glasses' ? 'eyes' : kind === 'jewelry' ? 'head' : 'body');

  return {
    pessoa: [
      ['tipo', 'Tipo', () => [
        seg([['female', 'Mulher'], ['male', 'Homem']] as const, sex(), (v) => c.setSex(v)),
        pics(BODIES.map((pr) => ({ id: pr.label, label: pr.label, variant: { ...m(), spec: { ...m().spec, ...withBody(m().spec.body, m().spec.features, pr) } } })), null,
          (id) => c.setSpec(withBody(b(), p().spec.features, BODIES.find((x) => x.label === id)!)), 'body'),
      ]],
      ['medidas', 'Medidas', () => [
        slider('Idade', 3, 90, 1, Math.round(yearsFromAge(b().age)), (v) => c.setBody('age', ageFromYears(v)), (v) => `${v} a`),
        slider('Altura', 0, 1, 0.01, b().height, (v) => c.setBody('height', v)),
        slider('Peso', 0, 1, 0.01, b().weight, (v) => c.setBody('weight', v)),
        slider('Músculos', 0, 1, 0.01, b().muscle, (v) => c.setBody('muscle', v)),
        slider('Proporções', 0, 1, 0.01, b().proportions, (v) => c.setBody('proportions', v)),
        ...(sex() === 'female' ? [slider('Busto', 0, 1, 0.01, b().cupsize, (v) => c.setBody('cupsize', v)), slider('Firmeza', 0, 1, 0.01, b().firmness, (v) => c.setBody('firmness', v))] : []),
      ]],
      ['esculpir', 'Esculpir', () => { const b = el('button', { cls: 'big save' }, icon('sculpt', 16), 'Esculpir corpo e rosto'); b.onclick = () => c.openCarver(); return [b]; }],
      ['tronco', 'Tronco', () => sliderList(BODY_SLIDERS['tronco']!)],
      ['bracos', 'Braços', () => sliderList(BODY_SLIDERS['bracos']!)],
      ['pernas', 'Pernas', () => sliderList(BODY_SLIDERS['pernas']!)],
      ['pele', 'Pele', () => [
        swatches(SKIN, p().spec.look.skin, (col) => c.setLook({ skin: col, melanin: undefined, undertone: undefined })),
        el('div', { cls: 'gap' }),
        slider('Africana', 0, 1, 0.01, b().african, (v) => shares('african', v)),
        slider('Asiática', 0, 1, 0.01, b().asian, (v) => shares('asian', v)),
        slider('Europeia', 0, 1, 0.01, b().caucasian, (v) => shares('caucasian', v)),
      ]],
    ],
    rosto: [
      ['rosto', 'Rosto', () => {
        const f = p().spec.features;
        const fit = el('button', { cls: 'big alt', textContent: 'Proporção do cânone' });
        fit.onclick = () => c.fitFace();
        return [
          pics(FACES.map((face) => ({ id: face.label, label: face.label, variant: withFeatures(withFace(mf(), face)) })), null,
            (id) => c.setSpec({ features: withFace(f, FACES.find((x) => x.label === id)!) }), 'face'),
          fit,
        ];
      }],
      ['cabeca', 'Cabeça', () => {
        const f = p().spec.features;
        return [
          pics(HEAD_SHAPES.map(([k, label]) => {
            const next: Record<string, number> = { ...mf() };
            for (const [h] of HEAD_SHAPES) delete next[h];
            next[k] = 0.35;
            return { id: k, label, variant: withFeatures(next) };
          }), HEAD_SHAPES.find(([k]) => (f[k] ?? 0) > 0)?.[0], (id) => {
            const next: Record<string, number> = { ...f };
            for (const [h] of HEAD_SHAPES) delete next[h];
            next[id] = 0.35;
            c.setSpec({ features: next });
          }, 'face'),
          el('div', { cls: 'gap' }),
          ...FACE[0]![1].map(([k, label]) => featureSlider(k, label)),
        ];
      }],
      ['olhos', 'Olhos', () => [...partGroup('eyes')(), el('div', { cls: 'gap' }), swatches(EYE_COLOURS.concat([0x2e8b57, 0x6a9fd8, 0x8b5a2b]), p().spec.look.eyes, (col) => c.setLook({ eyes: col }))]],
      ['sobrancelhas', 'Sobrancelhas', () => [
        pics([...WARDROBE.brows, ...itemsOf('eyebrows')].map((n) => ({ id: n, label: nameOf(n), variant: withLook({ brows: n }) })), p().spec.look.brows, (id) => c.setLook({ brows: id }), 'brows'),
        ...partGroup('brows')(),
      ]],
      ['nariz', 'Nariz', partGroup('nose')],
      ['boca', 'Boca', partGroup('mouth')],
      ['bochechas', 'Bochechas', partGroup('cheeks')],
      ['queixo', 'Queixo', partGroup('jaw')],
      ['orelhas', 'Orelhas', partGroup('ears')],
      ['esculpir', 'Esculpir', () => { const b = el('button', { cls: 'big save' }, icon('sculpt', 16), 'Esculpir rosto'); b.onclick = () => c.openCarver(); return [b]; }],
      ['maquiagem', 'Maquiagem', () => [slider('Intensidade', 0, 1, 0.01, p().spec.look.makeup ?? 0, (v) => c.setLook({ makeup: v }))]],
    ],
    estilo: [
      ['estilo', 'Estilo', () => {
        const s = p().style;
        const set = (k: keyof CartoonStyle, v: number): void => c.setStyle({ ...s, [k]: v });
        return [
          pics(STYLE_PRESETS.map(([label, preset]) => ({ id: label, label, variant: { ...m(), style: preset } })),
            STYLE_PRESETS.find(([, pr]) => (Object.keys(pr) as (keyof CartoonStyle)[]).every((k) => Math.abs(pr[k] - s[k]) < (k === 'head' ? 0.08 : 0.01)))?.[0],
            (id) => c.setStyle(STYLE_PRESETS.find(([l]) => l === id)![1]), 'body'),
          el('div', { cls: 'gap' }),
          slider('Cabeça', 0.8, 1.8, 0.01, s.head, (v) => set('head', v)),
          slider('Pernas', 0.7, 1.15, 0.01, s.legs, (v) => set('legs', v)),
          slider('Mãos', 0.8, 1.4, 0.01, s.hands, (v) => set('hands', v)),
          slider('Pés', 0.8, 1.4, 0.01, s.feet, (v) => set('feet', v)),
        ];
      }],
    ],
    cabelo: [
      ['penteado', 'Penteado', () => {
        const l = p().spec.look;
        const list = c.showAll ? [...HAIR_CATALOGUE[sex()], ...HAIR_CATALOGUE[sex() === 'female' ? 'male' : 'female']] : HAIR_CATALOGUE[sex()];
        return [
          allToggle('Mostrar tudo'),
          pics(['none', ...list].map((n) => ({ id: n, label: n === 'none' ? 'Careca' : HAIR_LABELS[n] ?? nameOf(n), variant: withLook({ hairCut: n }) })), l.hairCut, (id) => c.setLook({ hairCut: id }), 'head'),
        ];
      }],
      ['cor', 'Cor', () => [swatches(HAIR_COLOURS, p().spec.look.hair, (col) => c.setLook({ hair: col }))]],
      ['montar', 'Montar', () => {
        // Whole hairstyles of the catalogue by kind, then shaped with the sculptor: made hair, no seams (its pieces were never made to be
        // joined, so none is cut and joined).
        const all = [...HAIR_CATALOGUE[sex()], ...(c.showAll ? HAIR_CATALOGUE[sex() === 'female' ? 'male' : 'female'] : [])];
        const kind = (n: string): 'fringe' | 'tied' | 'loose' => (HAIR_FRINGED.includes(n) ? 'fringe' : HAIR_TIED.includes(n) ? 'tied' : 'loose');
        const group = (k: 'fringe' | 'tied' | 'loose'): HTMLElement =>
          pics(all.filter((n) => kind(n) === k).map((n) => ({ id: n, label: HAIR_LABELS[n] ?? nameOf(n), variant: withLook({ hairCut: n }) })),
            p().spec.look.hairCut, (id) => c.setLook({ hairCut: id }), 'head');
        const hs = c.hairShape();
        const shape = el('button', { cls: 'big save' }, icon('sculpt', 16), 'Esculpir este penteado');
        shape.onclick = () => c.openSculptor();
        return [
          allToggle('Mostrar tudo'),
          el('h3', { textContent: 'Solto' }), group('loose'),
          el('h3', { textContent: 'Com franja' }), group('fringe'),
          el('h3', { textContent: 'Preso' }), group('tied'),
          el('h3', { textContent: 'Ajustar' }),
          slider('Comprimento', 0.5, 1.6, 0.01, hs.length, (v) => c.setHairShape({ ...c.hairShape(), length: v }), (v) => `${Math.round(v * 100)}%`),
          slider('Volume', -0.4, 2, 0.05, hs.volume * 10, (v) => c.setHairShape({ ...c.hairShape(), volume: v / 10 }), (v) => `${v.toFixed(1)} cm`),
          slider('Ondas', 0, 1.2, 0.05, hs.wave * 10, (v) => c.setHairShape({ ...c.hairShape(), wave: v / 10 }), (v) => `${v.toFixed(1)} cm`),
          shape,
        ];
      }],
      ['barba', 'Barba', () => [extraPics('beard', 'Sem barba')]],
      ['chapeu', 'Chapéu', () => [
        pics(['none', ...WARDROBE.hats, ...itemsOf('hat', { street: true })].map((n) => ({ id: n, label: n === 'none' ? 'Sem' : nameOf(n), variant: withLook({ hat: n }) })),
          p().spec.look.hat ?? 'none', (id) => c.setLook({ hat: id }), 'head'),
      ]],
    ],
    roupas: child() ? [
      ['roupa', 'Roupa', () => {
        const l = p().spec.look;
        return [
          el('h3', { textContent: 'Em cima' }), seg([['tank', 'Regata'], ['tshirt', 'Camiseta'], ['longsleeve', 'Manga longa']] as const, l.top === 'none' ? 'tshirt' : l.top, (v) => c.setLook({ top: v })),
          swatches(CLOTH, l.topColour, (col) => c.setLook({ topColour: col })),
          el('h3', { textContent: 'Embaixo' }), seg([['shorts', 'Bermuda'], ['trousers', 'Calça'], ['skirt', 'Saia']] as const, l.bottom, (v) => c.setLook({ bottom: v })),
          swatches(CLOTH, l.bottomColour, (col) => c.setLook({ bottomColour: col })),
        ];
      }],
    ] : [
      ['ajustar', 'Ajustar', () => {
        // The outfit worn, made longer or shorter below the waist and looser or closer, on the piece itself.
        const os = c.outfitShape();
        return [
          slider('Comprimento', 0.6, 1.6, 0.01, os.length, (v) => c.setOutfitShape({ ...c.outfitShape(), length: v }), (v) => `${Math.round(v * 100)}%`),
          slider('Folga', -0.3, 1.5, 0.05, os.volume * 10, (v) => c.setOutfitShape({ ...c.outfitShape(), volume: v / 10 }), (v) => `${v.toFixed(1)} cm`),
        ];
      }],
      ['looks', 'Looks', () => [
        pics(LOOKS.map((lk) => ({ id: lk.label, label: lk.label, variant: withLook(sex() === 'female' ? lk.female : lk.male) })), null,
          (id) => { const lk = LOOKS.find((x) => x.label === id)!; c.setLook(sex() === 'female' ? lk.female : lk.male); }, 'body'),
      ]],
      ['inteira', 'Conjuntos', () => [allToggle('Mostrar tudo'), outfitPics([...WARDROBE.outfits[sex()], ...opts('suit'), ...opts('dress')]), ...carvePiece(p().spec.look.outfit, 'Editar peça')]],
      ['cima', 'Parte de cima', () => [allToggle('Mostrar tudo'), outfitPics(opts('top')), ...carvePiece(p().spec.look.outfit, 'Editar peça')]],
      ['baixo', 'Parte de baixo', () => [extraPics('bottom', 'Nenhuma'), el('div', { cls: 'gap' }), extraPics('skirt', 'Nenhuma')]],
      ['cor', 'Cor', () => [swatches(CLOTH, p().spec.look.outfitTint ?? -1, (col) => c.setLook({ outfitTint: col }))]],
      ['sapatos', 'Sapatos', () => [
        pics(SHOES_CATALOGUE[sex()].map((n) => ({ id: n, label: nameOf(n), variant: withLook({ footwear: n }) })), p().spec.look.footwear, (id) => c.setLook({ footwear: id }), 'feet'),
        ...carvePiece(p().spec.look.footwear, 'Editar sapatos'),
      ]],
      ['oculos', 'Óculos', () => [extraPics('glasses', 'Sem')]],
      ['joias', 'Joias', () => [extraPics('jewelry', 'Sem')]],
      ['criar', 'Criar', () => {
        const make = el('button', { cls: 'big save' }, icon('pattern', 16), 'Ateliê');
        make.onclick = () => c.openAtelier();
        return [make];
      }],
    ],
    expressao: [
      ['acoes', 'Ações', () => [
        el('div', { cls: 'grid' }, ...MOODS.map(([label, act, pose, clip]) => {
          const t = el('button', { cls: `tile${act === c.activity && clip === c.clip ? ' on' : ''}` }, label);
          t.onclick = () => c.act(act, pose, clip);
          return t;
        })),
      ]],
      ['humor', 'Humor', () => [slider('Humor', -1, 1, 0.01, p().spec.mood ?? 0, (v) => c.setMood(v))]],
    ],
  };
}
