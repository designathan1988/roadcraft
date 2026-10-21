import { ageFromYears, yearsFromAge, type MacroParams } from '@people/body/macro';
import { EYE_COLOURS, WARDROBE, type PersonLook, type PersonSpec } from '@people/spec';
import { itemsOf, type WardrobeItem } from '@people/wardrobe';
import type { CartoonStyle } from '@render/people/cartoon';
import { CLOTH, FACE, HAIR_CATALOGUE, HAIR_LABELS, HAIR_COLOURS, HEAD_SHAPES, MOODS, SHOES_CATALOGUE, SKIN, STYLE_PRESETS } from './choices';
import type { PoseName } from './pose';
import type { LibraryClipName } from '@render/citizenWalk';
import { BODIES, FACES, LOOKS, PARTS, mannequin, currentPreset, withBody, withFace, withPart } from './presets';
import type { LabPerson } from './record';
import type { Framing, Thumbs } from './thumbs';
import { el, type widgets } from './widgets';

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
  fitFace(): void;
  extraOf(kinds: readonly WardrobeItem['kind'][]): string;
  setExtra(kinds: readonly WardrobeItem['kind'][], name: string): void;
  sex(): 'female' | 'male';
  setSex(v: 'female' | 'male'): void;
}

interface Pic { readonly id: string; readonly label: string; readonly variant: LabPerson }

export function makePanels(c: PanelContext): Record<string, () => Node[]> {
  const { slider, swatches, seg } = c.ui;
  const p = (): LabPerson => c.person;
  const female = (): boolean => c.sex() === 'female';

  /** A grid of pictures, each the person wearing that choice. */
  const pics = (entries: readonly Pic[], current: string | null | undefined, pick: (id: string) => void, framing: Framing): HTMLElement => {
    const grid = el('div', { cls: 'pics' });
    for (const e of entries) {
      const key = `${framing}:${JSON.stringify([e.variant.spec.body, e.variant.spec.features, e.variant.spec.look, e.variant.style, e.variant.sculpt?.deltas.length])}`;
      const t = el('button', { cls: `pic${e.id === current ? ' on' : ''}`, title: e.label }, c.pictures.image(key, e.variant, framing), el('span', { textContent: e.label }));
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
  /** Fine sliders, folded away. */
  const fine = (title: string, ...kids: Node[]): HTMLElement => {
    const d = el('details', { cls: 'fine' }, el('summary', { textContent: title }), ...kids);
    return d;
  };
  const sliderLabel = new Map(FACE.flatMap(([, , sliders]) => sliders.map(([k, label]) => [k, label] as const)));
  const featureSlider = (k: string, label = sliderLabel.get(k) ?? k): HTMLElement => slider(label, -1, 1, 0.01, p().spec.features[k] ?? 0, (v) => c.setFeature(k, v));
  /** A worn piece's sculpt buttons: open the sculptor on it, or take its sculpt off. */
  const carvePiece = (item: string | undefined, label: string): HTMLElement[] => {
    if (!item || item === 'none') return [];
    const carve = el('button', { cls: 'big alt', textContent: label });
    carve.onclick = () => c.openSculptor(item);
    const sculpted = p().sculpts?.some((x) => x.base === item);
    if (!sculpted) return [carve];
    const drop = el('button', { cls: 'big alt', textContent: 'Desfazer escultura' });
    drop.onclick = () => c.dropPiece(item);
    return [el('div', { cls: 'pair' }, carve, drop)];
  };
  const nameOf = (n: string): string => n.replace(/^(female|male)_/, '').replace(/^[a-z0-9]+_(?=[a-z])/i, '').replace(/_/g, ' ').slice(0, 18);

  return {
    pessoa: () => {
      const b = p().spec.body;
      const shares = (k: 'african' | 'asian' | 'caucasian', v: number): void => {
        const others = (['african', 'asian', 'caucasian'] as const).filter((o) => o !== k);
        const rest = others.reduce((s, o) => s + b[o], 0) || 1;
        c.setSpec({ body: { ...b, [k]: v, [others[0]!]: (b[others[0]!] / rest) * (1 - v), [others[1]!]: (b[others[1]!] / rest) * (1 - v) } });
      };
      return [
        seg([['female', 'Mulher'], ['male', 'Homem']] as const, c.sex(), (v) => c.setSex(v)),
        el('h3', { textContent: 'Corpo' }),
        pics(BODIES.map((pr) => ({ id: pr.label, label: pr.label, variant: { ...m(), spec: { ...m().spec, ...withBody(m().spec.body, m().spec.features, pr) } } })), null,
          (id) => c.setSpec(withBody(b, p().spec.features, BODIES.find((x) => x.label === id)!)), 'body'),
        el('h3', { textContent: 'Pele' }),
        swatches(SKIN, p().spec.look.skin, (col) => c.setLook({ skin: col, melanin: undefined, undertone: undefined })),
        fine('Ajuste do corpo',
          slider('Idade', 3, 90, 1, Math.round(yearsFromAge(b.age)), (v) => c.setBody('age', ageFromYears(v)), (v) => `${v} a`),
          slider('Altura', 0, 1, 0.01, b.height, (v) => c.setBody('height', v)),
          slider('Peso', 0, 1, 0.01, b.weight, (v) => c.setBody('weight', v)),
          slider('Músculos', 0, 1, 0.01, b.muscle, (v) => c.setBody('muscle', v)),
          ...(female() ? [slider('Busto', 0, 1, 0.01, b.cupsize, (v) => c.setBody('cupsize', v))] : []),
          slider('Africana', 0, 1, 0.01, b.african, (v) => shares('african', v)),
          slider('Asiática', 0, 1, 0.01, b.asian, (v) => shares('asian', v)),
          slider('Europeia', 0, 1, 0.01, b.caucasian, (v) => shares('caucasian', v))),
      ];
    },
    rosto: () => {
      const f = p().spec.features;
      const out: Node[] = [
        el('h3', { textContent: 'Rostos' }),
        pics(FACES.map((face) => ({ id: face.label, label: face.label, variant: withFeatures(withFace(mf(), face)) })), null,
          (id) => c.setSpec({ features: withFace(f, FACES.find((x) => x.label === id)!) }), 'face'),
        el('h3', { textContent: 'Cabeça' }),
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
      ];
      for (const part of PARTS) {
        out.push(el('h3', { textContent: part.label }),
          pics(part.presets.map((pr) => ({ id: pr.label, label: pr.label, variant: withFeatures(withPart(mf(), part, pr)) })), currentPreset(f, part),
            (id) => c.setSpec({ features: withPart(f, part, part.presets.find((x) => x.label === id)!) }), part.id === 'ears' ? 'head' : 'face'),
          fine('Ajuste', ...part.sliders.filter((k) => sliderLabel.has(k)).map((k) => featureSlider(k))));
      }
      const fit = el('button', { cls: 'big alt', textContent: '📐 Proporção do cânone' });
      fit.onclick = () => c.fitFace();
      out.push(
        el('h3', { textContent: 'Cor dos olhos' }), swatches(EYE_COLOURS.concat([0x2e8b57, 0x6a9fd8, 0x8b5a2b]), p().spec.look.eyes, (col) => c.setLook({ eyes: col })),
        el('h3', { textContent: 'Sobrancelhas' }),
        pics([...WARDROBE.brows, ...itemsOf('eyebrows')].map((n) => ({ id: n, label: nameOf(n), variant: withLook({ brows: n }) })), p().spec.look.brows, (id) => c.setLook({ brows: id }), 'face'),
        el('h3', { textContent: 'Maquiagem' }), slider('Intensidade', 0, 1, 0.01, p().spec.look.makeup ?? 0, (v) => c.setLook({ makeup: v })),
        fine('Cabeça', ...FACE[0]![2].map(([k, label]) => featureSlider(k, label))),
        fit,
      );
      if (!female()) {
        out.push(el('h3', { textContent: 'Barba' }),
          pics(['none', ...itemsOf('beard')].map((n) => ({ id: n, label: n === 'none' ? 'Sem barba' : nameOf(n),
            variant: withLook({ extras: n === 'none' ? [] : [n] }) })),
          c.extraOf(['beard']), (id) => { c.setExtra(['beard'], id); }, 'face'));
      }
      return out;
    },
    estilo: () => {
      const s = p().style;
      const set = (k: keyof CartoonStyle, v: number): void => c.setStyle({ ...s, [k]: v });
      return [
        el('h3', { textContent: 'Estilo' }),
        pics(STYLE_PRESETS.map(([label, preset]) => ({ id: label, label, variant: { ...m(), style: preset } })),
          STYLE_PRESETS.find(([, pr]) => (Object.keys(pr) as (keyof CartoonStyle)[]).every((k) => Math.abs(pr[k] - s[k]) < (k === 'head' ? 0.08 : 0.01)))?.[0], (id) => c.setStyle(STYLE_PRESETS.find(([l]) => l === id)![1]), 'body'),
        fine('Ajuste',
          slider('Cabeça', 0.8, 1.8, 0.01, s.head, (v) => set('head', v)),
          slider('Pernas', 0.7, 1.15, 0.01, s.legs, (v) => set('legs', v)),
          slider('Mãos', 0.8, 1.4, 0.01, s.hands, (v) => set('hands', v)),
          slider('Pés', 0.8, 1.4, 0.01, s.feet, (v) => set('feet', v))),
      ];
    },
    cabelo: () => {
      const l = p().spec.look;
      const list = c.showAll ? [...HAIR_CATALOGUE[c.sex()], ...HAIR_CATALOGUE[c.sex() === 'female' ? 'male' : 'female']] : HAIR_CATALOGUE[c.sex()];
      const sculpted = !!p().sculpt && p().sculpt?.base === l.hairCut;
      const carve = el('button', { cls: 'big save', textContent: sculpted ? '✋ Continuar esculpindo' : '✋ Esculpir o cabelo' });
      carve.disabled = !l.hairCut || l.hairCut === 'none';
      carve.onclick = () => c.openSculptor();
      const all = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: c.showAll }), 'Todos');
      all.querySelector('input')!.addEventListener('change', (e) => { c.setShowAll((e.target as HTMLInputElement).checked); });
      const out: Node[] = [
        el('h3', { textContent: 'Cor' }), swatches(HAIR_COLOURS, l.hair, (col) => c.setLook({ hair: col })),
        el('h3', { textContent: 'Penteado' }), all,
        pics(['none', ...list].map((n) => ({ id: n, label: n === 'none' ? 'Careca' : HAIR_LABELS[n] ?? nameOf(n), variant: withLook({ hairCut: n }) })), l.hairCut, (id) => c.setLook({ hairCut: id }), 'head'),
        carve,
      ];
      if (sculpted) {
        const drop = el('button', { cls: 'big alt', textContent: 'Desfazer escultura' });
        drop.onclick = () => c.dropSculpt();
        out.push(drop);
      }
      out.push(el('h3', { textContent: 'Chapéu' }),
        pics(['none', ...WARDROBE.hats, ...itemsOf('hat', { street: true })].map((n) => ({ id: n, label: n === 'none' ? 'Sem' : nameOf(n), variant: withLook({ hat: n }) })),
          l.hat ?? 'none', (id) => c.setLook({ hat: id }), 'head'));
      return out;
    },
    roupas: () => {
      const l = p().spec.look;
      if (yearsFromAge(p().spec.body.age) < 16) {
        return [
          el('h3', { textContent: 'Em cima' }), seg([['tank', 'Regata'], ['tshirt', 'Camiseta'], ['longsleeve', 'Manga longa']] as const, l.top === 'none' ? 'tshirt' : l.top, (v) => c.setLook({ top: v })),
          swatches(CLOTH, l.topColour, (col) => c.setLook({ topColour: col })),
          el('h3', { textContent: 'Embaixo' }), seg([['shorts', 'Bermuda'], ['trousers', 'Calça'], ['skirt', 'Saia']] as const, l.bottom, (v) => c.setLook({ bottom: v })),
          swatches(CLOTH, l.bottomColour, (col) => c.setLook({ bottomColour: col })),
        ];
      }
      const sex = c.sex();
      const outfits = [...WARDROBE.outfits[sex], ...itemsOf('top', { street: !c.showAll, sex }), ...itemsOf('dress', { street: !c.showAll, sex }), ...itemsOf('suit', { street: !c.showAll, sex })];
      const all = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: c.showAll }), 'Todas as peças');
      all.querySelector('input')!.addEventListener('change', (e) => { c.setShowAll((e.target as HTMLInputElement).checked); });
      return [
        el('h3', { textContent: 'Looks' }),
        pics(LOOKS.map((lk) => ({ id: lk.label, label: lk.label, variant: withLook(sex === 'female' ? lk.female : lk.male) })), null,
          (id) => { const lk = LOOKS.find((x) => x.label === id)!; c.setLook(sex === 'female' ? lk.female : lk.male); }, 'body'),
        el('h3', { textContent: 'Roupa' }), all,
        pics(outfits.map((n) => ({ id: n, label: nameOf(n), variant: withLook({ outfit: n }) })), l.outfit, (id) => c.setLook({ outfit: id }), 'body'),
        el('h3', { textContent: 'Cor' }),
        swatches(CLOTH, l.outfitTint ?? -1, (col) => c.setLook({ outfitTint: col })),
        ...carvePiece(l.outfit, '✋ Esculpir a roupa'),
        el('h3', { textContent: 'Sapatos' }),
        pics(SHOES_CATALOGUE[sex].map((n) => ({ id: n, label: nameOf(n), variant: withLook({ footwear: n }) })), l.footwear, (id) => c.setLook({ footwear: id }), 'feet'),
        ...carvePiece(l.footwear, '✋ Esculpir os sapatos'),
        el('h3', { textContent: 'Óculos' }),
        pics(['none', ...itemsOf('glasses', { street: true, sex })].map((n) => ({ id: n, label: n === 'none' ? 'Sem' : nameOf(n),
          variant: withLook({ extras: n === 'none' ? [] : [n] }) })),
        c.extraOf(['glasses']), (id) => c.setExtra(['glasses'], id), 'face'),
      ];
    },
    expressao: () => [
      el('h3', { textContent: 'Humor' }),
      slider('Triste ↔ Feliz', -1, 1, 0.01, p().spec.mood ?? 0, (v) => c.setMood(v)),
      el('h3', { textContent: 'Ações' }),
      el('div', { cls: 'grid' }, ...MOODS.map(([emoji, label, act, pose, clip]) => {
        const t = el('button', { cls: `tile${act === c.activity && clip === c.clip ? ' on' : ''}` }, el('span', { cls: 'glyph', textContent: emoji }), label);
        t.onclick = () => c.act(act, pose, clip);
        return t;
      })),
    ],
  };
}
