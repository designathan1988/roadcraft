import {
  ACESFilmicToneMapping, MOUSE, Vector2, type Texture, CircleGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial, PCFSoftShadowMap,
  PMREMGenerator, PerspectiveCamera, Scene, ShadowMaterial, SRGBColorSpace, Vector3, WebGLRenderer, type Object3D, type SkinnedMesh,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ageFromYears, yearsFromAge, type MacroParams } from '@people/body/macro';
import { HAIR_STYLES, type HairStyle } from '@people/hair/procedural';
import { EYE_COLOURS, WARDROBE, randomPerson, type PersonLook, type PersonSpec } from '@people/spec';
import { communityItem, itemsOf, type WardrobeItem } from '@people/wardrobe';
import { PIXAR, type CartoonStyle } from '@render/people/cartoon';
import { applyFace, faceAt } from '@render/people/faceExpression';
import { applySkinAppearance, createPersonLayers, loadSkinAppearance, releaseSkinAppearance, type SkinAppearance } from '@render/people/skinAppearance';
import { drainUploads } from '@render/uploads';
import { LabBuilder, type BuiltPerson } from './build';
import { Poser, type PoseName } from './pose';
import { BODIES, variedFace, FACES, LOOKS, PARTS, currentPreset, withBody, withFace, withPart } from './presets';
import { HandShaper, addDragMorphs, type Region } from './direct';
import { evenHairSheen, paintedSkin, polishPerson } from './polish';
import { HairSculptor, decodeSculpt, encodeSculpt } from './sculpt';
import { sculptPanel } from './sculptPanel';
import { PROC_PREFIX, loadRoster, loadThumbs, readRoster, rosterMarkdown, rosterOf, savedBytes, type LabPerson } from './record';
import { CLOTH, FACE, NICE_HAIR, HAIR_COLOURS, HAIR_NAMES, HEAD_SHAPES, MOODS, SKIN, STYLE_PRESETS } from './choices';
import { el, widgets } from './widgets';

/** THE PERSON CREATOR LAB (`people-lab.html`): people made one by one, saved for the game; the game's own build, nothing of the game changed */

/** The whole page: its state lives here, owned by the lab, not loose in the module. */
function startLab(): void {
  // ---------------------------------------------------------------- state

  const first = randomPerson(1, 11, { body: { age: ageFromYears(26), gender: 0.06 } });
  // The first person shows a face: no glasses over the eyes.
  let person: LabPerson = { spec: { ...first, name: '', body: { ...first.body, weight: 0.4, muscle: 0.4, proportions: 1 }, features: variedFace('female', () => 0.5), look: { ...first.look, makeup: 0, hairCut: 'long01', hairStyle: 'long', outfit: 'female_elegantsuit01', outfitTint: 0x3b6fd1, footwear: 'shoes03', extras: (first.look.extras ?? []).filter((x) => communityItem(x)?.kind !== 'glasses') } }, style: PIXAR };
  let activity: string | undefined;
  let pose: PoseName = 'idle';
  let built: BuiltPerson | null = null;
  let poser: Poser | null = null;
  let tab = 'pessoa';
  let showAll = false;
  let roster: LabPerson[] = loadRoster();
  const thumbs: Record<string, string> = loadThumbs();
  /** The hair sculptor while it is open, the person hidden. */
  let sculptor: HairSculptor | null = null;
  /** Click-and-drag shaping of the person built now. */
  let shaper: HandShaper | null = null;

  function freshPerson(seed: number): LabPerson {
    const id = Math.floor(Math.random() * 2 ** 30);
    const spec = randomPerson(id, seed + id);
    const hairs = NICE_HAIR[spec.body.gender < 0.5 ? 'female' : 'male'];
    const hairCut = hairs[Math.floor(Math.random() * hairs.length)]!;
    return { spec: { ...spec, name: '', features: variedFace(spec.body.gender < 0.5 ? 'female' : 'male', Math.random), look: { ...spec.look, makeup: 0, hairCut } }, style: PIXAR };
  }

  const years = (): number => yearsFromAge(person.spec.body.age);
  const female = (): boolean => person.spec.body.gender < 0.5;
  const sexName = (): 'female' | 'male' => (female() ? 'female' : 'male');

  function setSpec(patch: Partial<PersonSpec>): void { person = { ...person, spec: { ...person.spec, ...patch } }; rebuild(); }
  function setBody(k: keyof MacroParams, v: number): void { setSpec({ body: { ...person.spec.body, [k]: v } }); }
  /** Partial, where a field set to undefined is taken off. */
  type Loose<T> = { [K in keyof T]?: T[K] | undefined };
  const defined = <T extends object>(o: Loose<T>): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  function setLook(patch: Loose<PersonLook>): void {
    const merged: Loose<PersonLook> = { ...person.spec.look, ...patch };
    setSpec({ look: defined<PersonLook>(merged) });
  }
  function setFeature(k: string, v: number): void { setSpec({ features: { ...person.spec.features, [k]: v } }); }
  function setStyle(s: CartoonStyle): void { person = { ...person, style: s }; rebuild(); }
  function setHair(h: HairStyle): void {
    person = { ...person, hair: h, spec: { ...person.spec, look: { ...person.spec.look, hairCut: `${PROC_PREFIX}${h.name}`, hairStyle: h.length > 2 ? 'long' : 'short' } } };
    rebuild();
  }

  /** What is built and saved: a child wears the tailored shells (the garments are cut for grown bodies, as the game has it). */
  function effective(p: LabPerson): LabPerson {
    if (yearsFromAge(p.spec.body.age) >= 16) {
      if (p.spec.look.outfit) return p;
      return { ...p, spec: { ...p.spec, look: { ...p.spec.look, outfit: p.spec.body.gender < 0.5 ? 'female_casualsuit02' : 'male_casualsuit02', footwear: 'shoes01' } } };
    }
    const { outfit: _o, footwear: _f, extras: _e, ...look } = p.spec.look;
    void _o; void _f; void _e;
    return { ...p, spec: { ...p.spec, look } };
  }

  // ---------------------------------------------------------------- scene

  const app = document.getElementById('app')!;
  const { slider, swatches, seg, tiles } = widgets(() => render());

  const rail = el('nav', { cls: 'rail' });
  const panel = el('section', { cls: 'panel' });
  const stage = el('main', { cls: 'stage' });
  const side = el('aside', { cls: 'side' });
  app.append(rail, panel, stage, side);

  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  stage.append(renderer.domElement);

  const scene = new Scene();
  scene.environment = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  scene.add(new HemisphereLight(0xeaf6ff, 0x9fb7c9, 0.9));
  const key = new DirectionalLight(0xfff3e6, 2.2);
  key.position.set(1.6, 3.2, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = key.shadow.camera.bottom = -1.5;
  key.shadow.camera.right = key.shadow.camera.top = 1.5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key);
  const rim = new DirectionalLight(0xbfe3ff, 1.4);
  rim.position.set(-2, 2.4, -2.5);
  scene.add(rim);
  const pedestal = new Mesh(new CircleGeometry(0.75, 64), new MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 }));
  pedestal.rotation.x = -Math.PI / 2;
  pedestal.receiveShadow = true;
  scene.add(pedestal);
  const shadowCatcher = new Mesh(new CircleGeometry(4, 32), new ShadowMaterial({ opacity: 0.18 }));
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = -0.001;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  const camera = new PerspectiveCamera(30, 1, 0.05, 50);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.minDistance = 0.4;
  controls.maxDistance = 6;
  controls.maxPolarAngle = Math.PI * 0.55;
  let view: 'face' | 'body' = 'body';
  let height = 1.7;

  function frame(which: 'face' | 'body', instant = false): void {
    view = which;
    const head = new Vector3(0, height * 0.92, 0);
    built?.scene.traverse((o) => { if (o.name === 'head' || o.name === 'Bip01_Head') o.getWorldPosition(head); });
    const target = which === 'face' ? head.clone().add(new Vector3(0, 0.06, 0)) : new Vector3(0, height * 0.52, 0);
    const dist = which === 'face' ? (sculptor ? 1.7 : 1.15) : height * 2.3;
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6 || instant) dir.set(0.35, 0.12, 1);
    camera.position.copy(target).add(dir.normalize().multiplyScalar(dist));
    controls.target.copy(target);
    for (const b of viewButtons) b.classList.toggle('on', b.dataset['v'] === which);
  }

  function resize(): void {
    const w = stage.clientWidth, h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(stage);

  // ---------------------------------------------------------------- the viewport's furniture

  const busy = el('div', { cls: 'busy', textContent: 'Montando a pessoa…' });
  const stats = el('div', { cls: 'stats' });
  const nameInput = el('input', { type: 'text', placeholder: 'Nome da pessoa', cls: 'name-input', maxLength: 40 });
  nameInput.addEventListener('input', () => { person = { ...person, spec: { ...person.spec, name: nameInput.value } }; });
  const views = el('div', { cls: 'views' });
  const viewButtons = [['face', 'Rosto'], ['body', 'Corpo inteiro']].map(([v, label]) => {
    const b = el('button', { textContent: label! });
    b.dataset['v'] = v!;
    b.onclick = () => frame(v as 'face' | 'body');
    return b;
  });
  const spin = el('button', { textContent: 'Girar' });
  let spinning = false;
  spin.onclick = () => { spinning = !spinning; spin.classList.toggle('on', spinning); controls.autoRotate = spinning; };
  views.append(...viewButtons, spin);
  stage.append(el('div', { cls: 'top' }, el('div', { cls: 'title' }, el('span', { cls: 'gem' }), 'Criar Pessoa'), nameInput), busy, stats, views);

  // ---------------------------------------------------------------- building

  const builder = new LabBuilder();
  /** The texture arrays every person's eyes, hair cards and garments are drawn from (`skinAppearance.ts`), as the game keeps them. */
  const layers = createPersonLayers();
  let appearance: SkinAppearance | null = null;
  let paintedTexture: Texture | null = null;
  let generation = 0;
  /** When the waiting rebuild starts (ms, `performance.now`), or 0: sliders dragged are built once they rest, in the frame loop. */
  let buildAt = 0;
  function rebuild(delay = 280): void {
    busy.classList.add('on');
    buildAt = performance.now() + delay;
  }

  function dispose(root: Object3D): void {
    root.traverse((o) => {
      const m = o as Mesh;
      m.geometry?.dispose();
      for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
    });
  }

  async function runBuild(): Promise<void> {
    const mine = ++generation;
    const started = performance.now();
    try {
      const next = await builder.build(effective(person));
      if (mine !== generation) { dispose(next.scene); return; }
      if (built) { scene.remove(built.scene); dispose(built.scene); }
      built = next;
      polishPerson(next.meshes, effective(person).spec.look);
      // The game's second step (`riggedCitizens.ts`): skin, irises, hair strands and fabrics drawn from their textures.
      const skin = await loadSkinAppearance(effective(person).spec);
      if (mine !== generation) { releaseSkinAppearance(skin); dispose(next.scene); return; }
      const painted = paintedSkin(skin.texture, 1);
      if (painted) { paintedTexture?.dispose(); paintedTexture = painted; skin.texture = painted; }
      // Solid hair, as The Sims draws it: one colour, shaded, no strand texture (its strands read as stripes up close).
      delete skin.hairTexture;
      for (const m of next.meshes) {
        const materials = (Array.isArray(m.material) ? m.material : [m.material]).map((source) => {
          const material = (source as MeshStandardMaterial).clone();
          material.color.setHex(0xffffff);
          material.roughness = 0.82;
          material.metalness = 0;
          applySkinAppearance(material, m.geometry, skin, layers);
          evenHairSheen(material);
          return material;
        });
        m.material = Array.isArray(m.material) ? materials : materials[0]!;
      }
      if (appearance) releaseSkinAppearance(appearance);
      appearance = skin;
      for (const m of next.meshes) { m.castShadow = true; m.frustumCulled = false; }
      scene.add(next.scene);
      poser = new Poser(next.scene);
      if (!shaping) dragWeights = null;
      const faces = await builder.proportions();
      const spec = person.spec;
      shaper = next.meshes[0] ? new HandShaper(next.meshes[0], (slider) => faces.influenceOf(slider, spec)) : null;
      next.scene.updateWorldMatrix(true, true);
      // Standing height from the head bone (a skinned geometry's own box is in its bind space, not the scene's).
      let headY = 1.5;
      next.scene.traverse((o) => { if (o.name === 'head' || o.name === 'Bip01_Head') headY = o.getWorldPosition(new Vector3()).y; });
      height = Math.max(0.6, headY * 1.13);
      const first = !stage.dataset['framed'];
      if (first) { stage.dataset['framed'] = '1'; frame('body', true); }
      stats.innerHTML = `${Math.round(next.triangles).toLocaleString('pt-BR')} triângulos · ${next.morphs} expressões<br>`
        + `salvo: ${savedBytes(effective(person)).toLocaleString('pt-BR')} bytes · montado em ${Math.round(performance.now() - started)} ms`;
    } catch (error) {
      console.error('[people-lab] the person could not be built', error);
      stats.textContent = `Erro ao montar: ${String(error).slice(0, 120)}`;
    } finally {
      if (mine === generation) busy.classList.remove('on');
    }
  }

  // ---------------------------------------------------------------- controls

  const kindOf = (name: string): WardrobeItem['kind'] | undefined => communityItem(name)?.kind;

  /** One extra of a kind at a time (glasses, a beard, trousers): the others of that kind taken off. */
  function setExtra(kinds: readonly WardrobeItem['kind'][], name: string): void {
    const kept = (person.spec.look.extras ?? []).filter((x) => !kinds.includes(kindOf(x)!));
    setLook({ extras: name === 'none' ? kept : [...kept, name] });
  }
  const extraOf = (kinds: readonly WardrobeItem['kind'][]): string => (person.spec.look.extras ?? []).find((x) => kinds.includes(kindOf(x)!)) ?? 'none';

  const opts = (kind: WardrobeItem['kind']): readonly string[] => itemsOf(kind, { street: !showAll, sex: sexName() });

  // ---------------------------------------------------------------- the panels

  const TABS: readonly (readonly [string, string, string])[] = [
    ['pessoa', '🧍', 'Pessoa'], ['rosto', '🙂', 'Rosto'], ['estilo', '✨', 'Estilo'], ['cabelo', '💇', 'Cabelo'],
    ['roupas', '👕', 'Roupas'], ['expressao', '😄', 'Expressão'],
  ];
  for (const [id, ico, label] of TABS) {
    const b = el('button', {}, el('span', { cls: 'ico', textContent: ico }), label);
    b.dataset['tab'] = id;
    b.onclick = () => { tab = id; render(); if (id === 'rosto' || id === 'cabelo' || id === 'expressao') frame('face'); };
    rail.append(b);
  }

  function render(): void {
    for (const b of rail.querySelectorAll('button')) b.classList.toggle('on', (b as HTMLElement).dataset['tab'] === tab);
    nameInput.value = person.spec.name;
    const scroll = panel.scrollTop;
    panel.replaceChildren(...(sculptor ? sculptPanel(sculptor, { slider, render, close: closeSculptor }) : PANELS[tab]!()));
    panel.scrollTop = scroll;
  }

  const PANELS: Record<string, () => Node[]> = {
    pessoa: () => {
      const b = person.spec.body;
      const shares = (k: 'african' | 'asian' | 'caucasian', v: number): void => {
        const others = (['african', 'asian', 'caucasian'] as const).filter((o) => o !== k);
        const rest = others.reduce((s, o) => s + b[o], 0) || 1;
        setSpec({ body: { ...b, [k]: v, [others[0]!]: (b[others[0]!] / rest) * (1 - v), [others[1]!]: (b[others[1]!] / rest) * (1 - v) } });
      };
      return [
        el('h2', { textContent: 'Quem é' }),
        el('div', { cls: 'note', textContent: '✋ Clique e arraste no corpo da pessoa para modelar (barriga, quadril, peito, braços, pernas…).' }),
        seg([['f', 'Feminino'], ['m', 'Masculino']] as const, female() ? 'f' : 'm', (v) => {
          const gender = v === 'f' ? 0.08 : 0.92;
          const keep = person.spec.look.outfit && (communityItem(person.spec.look.outfit)?.sex ?? (person.spec.look.outfit.startsWith('female') ? 'female' : 'male'));
          const outfit = keep === 'any' || keep === (v === 'f' ? 'female' : 'male') ? person.spec.look.outfit : v === 'f' ? 'female_casualsuit02' : 'male_casualsuit02';
          // The hair goes with the sex unless it suits both.
          const cut = person.spec.look.hairCut ?? 'none';
          const wrong = v === 'm' ? (NICE_HAIR.female as readonly string[]).includes(cut) || communityItem(cut)?.sex === 'female'
            : (NICE_HAIR.male as readonly string[]).includes(cut) || communityItem(cut)?.sex === 'male';
          const hairCut = wrong ? (v === 'm' ? 'short02' : 'long01') : cut;
          setSpec({ body: { ...b, gender }, look: { ...person.spec.look, hairCut, ...(outfit ? { outfit } : {}) } });
        }),
        el('h3', { textContent: 'Corpos prontos' }),
        el('div', { cls: 'grid' }, ...BODIES.map((preset) => {
          const t = el('button', { cls: 'tile' }, el('span', { cls: 'glyph', textContent: preset.glyph }), preset.label);
          t.onclick = () => { setSpec(withBody(person.spec.body, person.spec.features, preset)); render(); };
          return t;
        })),
        el('h3', { textContent: 'Corpo' }),
        slider('Idade', 3, 90, 1, Math.round(years()), (v) => setBody('age', ageFromYears(v)), (v) => `${v} a`),
        slider('Feminino ↔ Masc.', 0, 1, 0.01, b.gender, (v) => setBody('gender', v)),
        slider('Altura', 0, 1, 0.01, b.height, (v) => setBody('height', v)),
        slider('Peso', 0, 1, 0.01, b.weight, (v) => setBody('weight', v)),
        slider('Músculos', 0, 1, 0.01, b.muscle, (v) => setBody('muscle', v)),
        slider('Proporções', 0, 1, 0.01, b.proportions, (v) => setBody('proportions', v)),
        ...(female() ? [slider('Busto', 0, 1, 0.01, b.cupsize, (v) => setBody('cupsize', v))] : []),
        el('h3', { textContent: 'Origem' }),
        slider('Africana', 0, 1, 0.01, b.african, (v) => shares('african', v)),
        slider('Asiática', 0, 1, 0.01, b.asian, (v) => shares('asian', v)),
        slider('Europeia', 0, 1, 0.01, b.caucasian, (v) => shares('caucasian', v)),
        el('h3', { textContent: 'Pele' }),
        swatches(SKIN, person.spec.look.skin, (c) => setLook({ skin: c, melanin: undefined, undertone: undefined })),
      ];
    },
    rosto: () => {
      const f = person.spec.features;
      const shape = HEAD_SHAPES.find(([k]) => (f[k] ?? 0) > 0)?.[0] ?? 'head-oval';
      const out: Node[] = [
        el('h2', { textContent: 'Rosto' }),
        el('div', { cls: 'note', textContent: '✋ Clique e arraste no rosto da pessoa para modelar: para os lados muda uma coisa, para cima e para baixo muda outra.' }),
        (() => {
          const fit = el('button', { cls: 'big save', textContent: '📐 Proporção correta' });
          fit.onclick = () => { void fitFace(); };
          return fit;
        })(),
        el('h3', { textContent: 'Rostos prontos' }),
        el('div', { cls: 'grid' }, ...FACES.map((face) => {
          const t = el('button', { cls: 'tile' }, el('span', { cls: 'glyph', textContent: face.glyph }), face.label);
          t.onclick = () => { setSpec({ features: withFace(f, face) }); render(); };
          return t;
        })),
        el('h3', { textContent: 'Formato da cabeça' }),
        el('div', { cls: 'chips' }, ...HEAD_SHAPES.map(([k, label]) => {
          const b = el('button', { textContent: label, cls: k === shape ? 'on' : '' });
          b.onclick = () => {
            const next: Record<string, number> = { ...f };
            for (const [h] of HEAD_SHAPES) delete next[h];
            next[k] = 0.35;
            setSpec({ features: next }); render();
          };
          return b;
        })),
      ];
      const labelOf = new Map(FACE.flatMap(([, , sliders]) => sliders.map(([k, label]) => [k, label] as const)));
      const owned = new Set(PARTS.flatMap((p) => p.sliders));
      // The head's own sliders: the ones no part owns.
      for (const [, , sliders] of FACE) for (const [k, label] of sliders) if (!owned.has(k)) out.push(slider(label, -1, 1, 0.01, f[k] ?? 0, (v) => setFeature(k, v)));
      for (const part of PARTS) {
        const on = currentPreset(f, part);
        out.push(el('h3', { textContent: `${part.glyph} ${part.label}` }),
          el('div', { cls: 'chips' }, ...part.presets.map((preset) => {
            const b = el('button', { textContent: `${preset.glyph} ${preset.label}`, cls: preset.label === on ? 'on' : '' });
            b.onclick = () => { setSpec({ features: withPart(f, part, preset) }); render(); };
            return b;
          })));
        for (const k of part.sliders) {
          const label = labelOf.get(k);
          if (label) out.push(slider(label, -1, 1, 0.01, f[k] ?? 0, (v) => setFeature(k, v)));
        }
      }
      out.push(
        el('h3', { textContent: 'Olhos' }), swatches(EYE_COLOURS.concat([0x2e8b57, 0x6a9fd8, 0x8b5a2b]), person.spec.look.eyes, (c) => setLook({ eyes: c })),
        el('h3', { textContent: 'Maquiagem' }), slider('Intensidade', 0, 1, 0.01, person.spec.look.makeup ?? 0, (v) => setLook({ makeup: v })),
        el('h3', { textContent: 'Sobrancelhas' }),
        tiles([...WARDROBE.brows, ...itemsOf('eyebrows')], person.spec.look.brows, (n) => setLook({ brows: n })),
        el('h3', { textContent: 'Cílios' }),
        tiles([...WARDROBE.lashes, ...itemsOf('eyelashes')], person.spec.look.lashes, (n) => setLook({ lashes: n })),
      );
      if (!female() || showAll) out.push(el('h3', { textContent: 'Barba' }), tiles(itemsOf('beard'), extraOf(['beard']), (n) => { setExtra(['beard'], n); setLook({ beard: n === 'none' ? 'none' : 'beard' }); }, 'Sem barba'));
      return out;
    },
    estilo: () => {
      const s = person.style;
      const set = (k: keyof CartoonStyle, v: number): void => setStyle({ ...s, [k]: v });
      return [
        el('h2', { textContent: 'Estilo do desenho' }),
        el('div', { cls: 'note', textContent: 'Proporções de animação: cabeça e olhos maiores deixam a pessoa mais expressiva e fácil de ler de longe na cidade.' }),
        el('div', { cls: 'chips' }, ...STYLE_PRESETS.map(([label, preset]) => {
          const b = el('button', { textContent: label, cls: JSON.stringify(preset) === JSON.stringify(s) ? 'on' : '' });
          b.onclick = () => { setStyle(preset); render(); };
          return b;
        })),
        el('h3', { textContent: 'Ajuste fino' }),
        slider('Cabeça', 0.8, 1.8, 0.01, s.head, (v) => set('head', v)),
        slider('Pernas', 0.7, 1.15, 0.01, s.legs, (v) => set('legs', v)),
        slider('Mãos', 0.8, 1.4, 0.01, s.hands, (v) => set('hands', v)),
        slider('Pés', 0.8, 1.4, 0.01, s.feet, (v) => set('feet', v)),
      ];
    },
    cabelo: () => {
      const l = person.spec.look;
      const proc = l.hairCut?.startsWith(PROC_PREFIX) ?? false;
      const out: Node[] = [
        el('h2', { textContent: 'Cabelo' }),
        el('h3', { textContent: 'Cor' }), swatches(HAIR_COLOURS, l.hair, (c) => setLook({ hair: c })),
        el('h3', { textContent: 'Estúdio de penteados' }),
        el('div', { cls: 'note', textContent: 'Penteados gerados em mechas sólidas, no estilo do The Sims: escolha uma base e modele com os controles.' }),
        el('div', { cls: 'chips' }, ...Object.keys(HAIR_STYLES).map((k) => {
          const b = el('button', { textContent: HAIR_NAMES[k] ?? k, cls: proc && person.hair?.name === k ? 'on' : '' });
          b.onclick = () => { setHair({ ...HAIR_STYLES[k]! }); render(); };
          return b;
        })),
      ];
      if (proc && person.hair) {
        const h = person.hair;
        const set = (patch: Loose<HairStyle>): void => setHair(defined<HairStyle>({ ...h, ...patch }));
        out.push(
          el('h3', { textContent: 'Modelar' }),
          slider('Comprimento', 0.2, 5, 0.05, h.length, (v) => set({ length: v })),
          slider('Volume', 0, 0.9, 0.01, h.volume, (v) => set({ volume: v })),
          slider('Repartição', -1, 1, 0.05, h.part, (v) => set({ part: v })),
          slider('Caimento', 0, 0.8, 0.01, h.gravity, (v) => set({ gravity: v })),
          slider('Jogado', -1, 1, 0.05, h.sweep ?? 0, (v) => set({ sweep: v })),
          slider('Topete', 0, 0.6, 0.01, h.quiff ?? 0, (v) => set({ quiff: v || undefined })),
          slider('Franja', 0, 1.6, 0.05, h.fringe?.length ?? 0, (v) => set({ fringe: v > 0.05 ? { length: v, width: h.fringe?.width ?? 0.55 } : undefined })),
          slider('Ondas', 0, 0.15, 0.005, h.wave?.amplitude ?? 0, (v) => set({ wave: v > 0.002 ? { amplitude: v, wavelength: h.wave?.wavelength ?? 1.3 } : undefined })),
          slider('Cachos', 0, 0.2, 0.005, h.curl?.radius ?? 0, (v) => set({ curl: v > 0.002 ? { radius: v, pitch: h.curl?.pitch ?? 0.3 } : undefined })),
          el('h3', { textContent: 'Mechas' }),
          slider('Quantidade', 60, 320, 10, h.clumps, (v) => set({ clumps: v }), (v) => String(v)),
          slider('Espessura', 0.15, 0.7, 0.01, h.cardWidth, (v) => set({ cardWidth: v })),
          seg([['1', 'Uma camada'], ['2', 'Duas camadas']] as const, String(h.layers) as '1' | '2', (v) => set({ layers: +v as 1 | 2 })),
        );
      }
      const sculpted = !!person.sculpt && person.sculpt.base === l.hairCut;
      const carve = el('button', { cls: 'big save', textContent: sculpted ? '✋ Continuar esculpindo' : '✋ Esculpir este cabelo' });
      carve.disabled = !l.hairCut || l.hairCut === 'none';
      carve.onclick = () => { void openSculptor(); };
      out.push(el('h3', { textContent: 'Esculpir' }),
        el('div', { cls: 'note', textContent: 'Escolha um cabelo (do estúdio ou do catálogo) e molde com pincéis: puxar, dar volume, alisar, achatar, apertar e encurtar.' }), carve);
      if (sculpted) {
        const drop = el('button', { cls: 'big alt', textContent: 'Remover escultura' });
        drop.onclick = () => { const { sculpt: _s, ...rest } = person; void _s; person = rest; rebuild(0); render(); };
        out.push(drop);
      }
      out.push(
        el('h3', { textContent: 'Catálogo pronto' }),
        tiles([...WARDROBE.hair.short, ...WARDROBE.hair.long, ...itemsOf('hair', { street: !showAll })], proc ? undefined : l.hairCut,
          (n) => { const { hair: _hair, ...rest } = person; void _hair; person = rest; setLook({ hairCut: n }); }, 'Careca'),
        el('h3', { textContent: 'Chapéu' }),
        tiles([...WARDROBE.hats, ...itemsOf('hat', { street: !showAll })], l.hat ?? 'none', (n) => setLook({ hat: n }), 'Sem chapéu'),
      );
      return out;
    },
    roupas: () => {
      const l = person.spec.look;
      if (years() < 16) {
        return [
          el('h2', { textContent: 'Roupas' }),
          el('div', { cls: 'note', textContent: 'Crianças usam as roupas sob medida do jogo (as peças prontas são cortadas para adultos).' }),
          el('h3', { textContent: 'Em cima' }), seg([['tank', 'Regata'], ['tshirt', 'Camiseta'], ['longsleeve', 'Manga longa']] as const, l.top === 'none' ? 'tshirt' : l.top, (v) => setLook({ top: v })),
          swatches(CLOTH, l.topColour, (c) => setLook({ topColour: c })),
          el('h3', { textContent: 'Embaixo' }), seg([['shorts', 'Bermuda'], ['trousers', 'Calça'], ['skirt', 'Saia']] as const, l.bottom, (v) => setLook({ bottom: v })),
          swatches(CLOTH, l.bottomColour, (c) => setLook({ bottomColour: c })),
        ];
      }
      const sys = WARDROBE.outfits[sexName()];
      const separateTop = !!l.outfit && kindOf(l.outfit) === 'top';
      const all = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: showAll }), 'Mostrar todas as peças (inclui fantasias)');
      all.querySelector('input')!.addEventListener('change', (e) => { showAll = (e.target as HTMLInputElement).checked; render(); });
      return [
        el('h2', { textContent: 'Roupas' }),
        el('h3', { textContent: 'Looks prontos' }),
        el('div', { cls: 'grid' }, ...LOOKS.map((preset) => {
          const t = el('button', { cls: 'tile' }, el('span', { cls: 'glyph', textContent: preset.glyph }), preset.label);
          t.onclick = () => { setLook(female() ? preset.female : preset.male); render(); };
          return t;
        })),
        all,
        el('h3', { textContent: 'Visual' }),
        tiles([...sys, ...opts('top'), ...opts('dress'), ...opts('suit')], l.outfit, (n) => setLook({ outfit: n })),
        ...(separateTop ? [el('h3', { textContent: 'Calça / saia' }), tiles([...opts('bottom'), ...opts('skirt')], extraOf(['bottom', 'skirt']), (n) => setExtra(['bottom', 'skirt'], n), 'Nada')] : []),
        el('h3', { textContent: 'Tingir a roupa' }),
        el('div', { cls: 'chips' }, (() => { const b = el('button', { textContent: 'Cores originais', cls: l.outfitTint == null ? 'on' : '' }); b.onclick = () => { setLook({ outfitTint: null }); render(); }; return b; })()),
        swatches(CLOTH, l.outfitTint ?? -1, (c) => setLook({ outfitTint: c })),
        el('h3', { textContent: 'Calçados' }),
        tiles([...WARDROBE.footwear, ...opts('shoes')], l.footwear, (n) => setLook({ footwear: n })),
        el('h3', { textContent: 'Óculos' }), tiles(opts('glasses'), extraOf(['glasses']), (n) => setExtra(['glasses'], n), 'Sem óculos'),
        el('h3', { textContent: 'Joias' }), tiles(opts('jewelry'), extraOf(['jewelry']), (n) => setExtra(['jewelry'], n), 'Sem joias'),
      ];
    },
    expressao: () => [
      el('h2', { textContent: 'Expressão' }),
      el('div', { cls: 'note', textContent: 'O jeito de ser fica salvo (humor). As ações mostram como a pessoa reage na cidade: rir, acenar, brigar…' }),
      el('h3', { textContent: 'Humor de sempre' }),
      slider('Triste ↔ Feliz', -1, 1, 0.01, person.spec.mood ?? 0, (v) => { person = { ...person, spec: { ...person.spec, mood: v } }; }),
      el('h3', { textContent: 'Ações' }),
      el('div', { cls: 'grid' }, ...MOODS.map(([emoji, label, act, p]) => {
        const t = el('button', { cls: `tile${act === activity && p === pose ? ' on' : ''}` }, el('span', { cls: 'glyph', textContent: emoji }), label);
        t.onclick = () => { activity = act; pose = p; render(); };
        return t;
      })),
    ],
  };

  // ---------------------------------------------------------------- the gallery and saving

  const gallery = el('div', { cls: 'gallery' });
  const toast = el('div', { cls: 'toast' });
  document.body.append(toast);
  let toastUntil = 0;
  function say(text: string): void { toast.textContent = text; toast.classList.add('on'); toastUntil = performance.now() + 2400; }

  const save = el('button', { cls: 'big save', textContent: '💾 Salvar pessoa' });
  const fresh = el('button', { cls: 'big alt', textContent: '＋ Nova' });
  const dice = el('button', { cls: 'big alt', textContent: '🎲 Sortear' });
  const revokeAt: [number, string][] = [];
  const exportBtn = el('button', { cls: 'big alt', textContent: '⬇ Exportar' });
  const importBtn = el('button', { cls: 'big alt', textContent: '⬆ Importar' });
  side.append(el('h2', { textContent: 'Minhas pessoas' }), save, el('div', { cls: 'pair' }, fresh, dice), gallery, el('div', { cls: 'pair' }, exportBtn, importBtn));


  /** The face, small, for the gallery. */
  function snapshot(): string {
    const keep = { pos: camera.position.clone(), target: controls.target.clone(), view };
    frame('face', true);
    controls.update();
    renderer.render(scene, camera);
    const src = renderer.domElement;
    const side0 = Math.min(src.width, src.height);
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    c.getContext('2d')!.drawImage(src, (src.width - side0) / 2, (src.height - side0) / 2, side0, side0, 0, 0, 160, 160);
    camera.position.copy(keep.pos); controls.target.copy(keep.target); view = keep.view;
    return c.toDataURL('image/webp', 0.8);
  }

  async function persist(): Promise<void> {
    const json = JSON.stringify(rosterOf(roster));
    try {
      localStorage.setItem('roadcraft.peopleLab.roster', json);
      localStorage.setItem('roadcraft.peopleLab.thumbs', JSON.stringify(thumbs));
    } catch (error) { console.warn('[people-lab] the browser refused to keep the roster', error); }
    // Into the project (`lab-reports/people-roster.json`) through the dev server, for the game to take in.
    try {
      const r = await fetch('/__lab/report', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stamp: 'people-roster', json: JSON.stringify(rosterOf(roster), null, 1), md: rosterMarkdown(roster) }) });
      if (!r.ok) throw new Error(String(r.status));
    } catch (error) { console.warn('[people-lab] the roster was kept in the browser only', error); }
  }

  function renderGallery(): void {
    gallery.replaceChildren(...roster.map((p) => {
      const card = el('div', { cls: `card${p.spec.id === person.spec.id ? ' on' : ''}` },
        el('img', { src: thumbs[p.spec.id] ?? '', alt: '' }), p.spec.name || 'Sem nome');
      const x = el('button', { cls: 'x', textContent: '×', title: 'Apagar' });
      x.onclick = (e) => {
        e.stopPropagation();
        if (!confirm(`Apagar ${p.spec.name || 'esta pessoa'}?`)) return;
        roster = roster.filter((q) => q.spec.id !== p.spec.id);
        delete thumbs[p.spec.id];
        void persist(); renderGallery();
      };
      card.append(x);
      card.onclick = () => { person = structuredClone(p); activity = undefined; pose = 'idle'; render(); rebuild(0); renderGallery(); };
      return card;
    }));
  }

  save.onclick = async () => {
    if (!person.spec.name.trim()) { nameInput.focus(); say('Dê um nome para a pessoa antes de salvar'); return; }
    const saved = effective(person);
    roster = [...roster.filter((p) => p.spec.id !== saved.spec.id), saved];
    thumbs[saved.spec.id] = snapshot();
    await persist();
    renderGallery();
    say(`${saved.spec.name} salva (${savedBytes(saved)} bytes)`);
  };
  fresh.onclick = () => { person = freshPerson(1); render(); rebuild(0); renderGallery(); };
  dice.onclick = () => { const keepName = person.spec.name; person = freshPerson(Math.floor(Math.random() * 1e6)); person = { ...person, spec: { ...person.spec, name: keepName } }; render(); rebuild(0); };
  exportBtn.onclick = () => {
    const blob = new Blob([JSON.stringify(rosterOf(roster), null, 1)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: 'roadcraft-people.json' });
    a.click();
    revokeAt.push([performance.now() + 1000, a.href]);
  };
  importBtn.onclick = () => {
    const input = el('input', { type: 'file', accept: '.json,application/json' });
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const people = readRoster(JSON.parse(await file.text()));
        roster = [...roster.filter((p) => !people.some((q) => q.spec.id === p.spec.id)), ...people];
        await persist(); renderGallery(); say(`${people.length} pessoas importadas`);
      } catch (error) { console.warn('[people-lab] the file is no roster', error); say('Arquivo inválido'); }
    };
    input.click();
  };

  /** The face set to the classical proportions (`proportions.ts`), the person's own look kept. */
  async function fitFace(): Promise<void> {
    const faces = await builder.proportions();
    person = { ...person, spec: faces.fit(person.spec) };
    render();
    rebuild(0);
  }

  // ---------------------------------------------------------------- the hair sculptor

  async function openSculptor(): Promise<void> {
    const cut = person.spec.look.hairCut;
    const item = await builder.hairItem(person);
    if (!item || !cut) { say('Escolha um cabelo primeiro'); return; }
    const body = await builder.sculptBody(person);
    const n = item.pack.refs.length / 3;
    const start = person.sculpt?.base === cut ? decodeSculpt(person.sculpt, n) : null;
    sculptor = new HairSculptor(item.pack, body, start, person.spec.look.hair, person.spec.look.skin);
    scene.add(sculptor.group);
    if (built) built.scene.visible = false;
    // The left button sculpts, never turns the view: the right one turns it, the wheel zooms.
    controls.mouseButtons = { LEFT: null, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.ROTATE };
    frame('face');
    render();
  }

  function closeSculptor(keep: boolean): void {
    const s = sculptor;
    if (!s) return;
    if (keep) person = { ...person, sculpt: encodeSculpt(person.spec.look.hairCut!, s.delta()) };
    scene.remove(s.group);
    s.dispose();
    sculptor = null;
    if (built) built.scene.visible = true;
    controls.enabled = true;
    controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    render();
    if (keep) rebuild(0);
  }

  const ndc = (e: PointerEvent): Vector2 => {
    const r = renderer.domElement.getBoundingClientRect();
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  let carving = false;
  // ---- shaping by hand: the part under the pointer, dragged
  const tip = el('div', { cls: 'tip' });
  stage.append(tip);
  const shapeTabs = new Set(['pessoa', 'rosto']);
  let shaping: { region: Region; x0: number; y0: number; fx: number; fy: number } | null = null;
  /** While dragging: each drag direction's morph weight, drawn every frame on top of the face (`loop`). */
  let dragWeights: Record<string, number> | null = null;
  /** How far each drag morph reaches, in slider units. */
  const DRAG_REACH = 0.6;
  /** The four drag morphs (each slider up and down) added to the person built now: the drag is seen at once, the rebuild comes on release. */
  async function prepareDrag(region: Region, fx: number, fy: number): Promise<void> {
    const b = built;
    if (b && await addDragMorphs(b, region, fx, fy, DRAG_REACH, (slider, to) => builder.shape({ ...person, spec: { ...person.spec, features: { ...person.spec.features, [slider]: to } } }), () => built === b)) dragWeights = {};
  }
  let lastPick = 0;
  const feature = (k: string): number => person.spec.features[k] ?? 0;
  const showTip = (e: PointerEvent, region: Region | null): void => {
    if (!region) { tip.classList.remove('on'); renderer.domElement.style.cursor = ''; return; }
    const r = stage.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left + 16}px`;
    tip.style.top = `${e.clientY - r.top + 12}px`;
    tip.innerHTML = `<b>${region.label}</b><br>↔ ${region.x.label} ${feature(region.x.slider).toFixed(2)} · ↕ ${region.y.label} ${feature(region.y.slider).toFixed(2)}`;
    tip.classList.add('on');
    renderer.domElement.style.cursor = shaping ? 'grabbing' : 'grab';
  };
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (sculptor || e.button !== 0 || !shaper || !shapeTabs.has(tab)) return;
    const region = shaper.pick(ndc(e), camera);
    if (!region) return;
    shaping = { region, x0: e.clientX, y0: e.clientY, fx: feature(region.x.slider), fy: feature(region.y.slider) };
    void prepareDrag(region, shaping.fx, shaping.fy);
    controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
    showTip(e, region);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (sculptor || !shaper || !shapeTabs.has(tab)) { tip.classList.remove('on'); return; }
    if (shaping) {
      const s = shaping;
      const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
      const vx = clamp(s.fx + (e.clientX - s.x0) / 180), vy = clamp(s.fy - (e.clientY - s.y0) / 180);
      person = { ...person, spec: { ...person.spec, features: { ...person.spec.features, [s.region.x.slider]: vx, [s.region.y.slider]: vy } } };
      if (dragWeights) {
        // Seen at once: each axis's morph towards the side it is dragged.
        const dx = (vx - s.fx) / DRAG_REACH, dy = (vy - s.fy) / DRAG_REACH;
        dragWeights = { 'drag:x+': Math.max(0, dx), 'drag:x-': Math.max(0, -dx), 'drag:y+': Math.max(0, dy), 'drag:y-': Math.max(0, -dy) };
      } else rebuild(120);
      showTip(e, s.region);
      return;
    }
    const now = performance.now();
    if (now - lastPick < 70) return;
    lastPick = now;
    showTip(e, shaper.pick(ndc(e), camera));
  });
  const endShape = (): void => {
    if (!shaping) return;
    shaping = null;
    controls.enabled = true;
    // The exact shape, built once the hand lets go; the drag morphs stay drawn until it is ready.
    rebuild(0);
    render();
  };
  renderer.domElement.addEventListener('pointerup', endShape);
  renderer.domElement.addEventListener('pointerleave', () => { if (!shaping) tip.classList.remove('on'); });
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (!sculptor || e.button !== 0) return;
    if (sculptor.begin(ndc(e), camera)) {
      carving = true;
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
    }
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (!sculptor) return;
    if (carving) sculptor.move(ndc(e), camera, e.shiftKey);
    else sculptor.hover(ndc(e), camera);
  });
  const stop = (): void => { if (!carving) return; carving = false; sculptor?.end(); controls.enabled = true; };
  renderer.domElement.addEventListener('pointerup', stop);
  renderer.domElement.addEventListener('pointercancel', stop);
  window.addEventListener('keydown', (e) => {
    if (!sculptor || !(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'z') { e.preventDefault(); sculptor.undoStep(); }
    if (e.key === 'y') { e.preventDefault(); sculptor.redoStep(); }
  });

  // ---------------------------------------------------------------- the loop

  const clock0 = performance.now();
  function loop(): void {
    const now = performance.now();
    const t = (now - clock0) / 1000;
    if (buildAt && now >= buildAt) { buildAt = 0; void runBuild(); }
    if (toastUntil && now >= toastUntil) { toastUntil = 0; toast.classList.remove('on'); }
    while (revokeAt.length && revokeAt[0]![0] <= now) URL.revokeObjectURL(revokeAt.shift()![1]);
    if (built) {
      poser?.apply(pose, t);
      const face = faceAt(person.spec.id, t, activity, person.spec.mood ?? 0);
      for (const m of built.meshes as SkinnedMesh[]) {
        if (m.morphTargetInfluences && m.morphTargetDictionary) {
          applyFace(m.morphTargetInfluences, m.morphTargetDictionary, face);
          if (dragWeights) for (const [name, w] of Object.entries(dragWeights)) {
            const i = m.morphTargetDictionary[name];
            if (i !== undefined) m.morphTargetInfluences[i] = w;
          }
        }
      }
    }
    controls.update();
    drainUploads(renderer);
    renderer.render(scene, camera);
    requestAnimationFrame(loop);
  }

  scene.background = null;
  renderer.setClearColor(new Color(0xffffff), 0);
  resize();
  render();
  renderGallery();
  rebuild(0);
  loop();
  // For checks from outside (the lab's screenshots): the person as it is now.
  (window as unknown as { peopleLab: unknown }).peopleLab = { get person() { return person; }, setHair, setStyle, frame, get built() { return built; },
    pick(tabId: string) { tab = tabId; render(); }, spec(patch: Partial<PersonSpec>) { setSpec(patch); }, fitFace, async measure() { return (await builder.proportions()).measure(person.spec); }, async sweep(slider: string) { const f = await builder.proportions(); return [-1, 0, 1].map((v) => f.measure({ ...person.spec, features: { ...person.spec.features, [slider]: v } })); }, look(patch: Record<string, unknown>) { setLook(patch as Partial<PersonLook>); },
    closeUp(dist = 0.5, x = 0) {
      const head = new Vector3();
      built?.scene.traverse((o) => { if (o.name === 'Bip01_Head') o.getWorldPosition(head); });
      controls.target.copy(head).add(new Vector3(0, 0.02, 0.05));
      camera.position.copy(controls.target).add(new Vector3(x, 0, dist));
    }, features(patch: Record<string, number>) { setSpec({ features: { ...person.spec.features, ...patch } }); }, openSculptor, closeSculptor, get sculptor() { return sculptor; }, act(a: string | undefined, p: PoseName) { activity = a; pose = p; render(); } };
}

startLab();
