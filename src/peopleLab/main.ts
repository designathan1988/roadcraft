import {
  ACESFilmicToneMapping, MOUSE, Vector2, CircleGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial, PCFSoftShadowMap,
  PMREMGenerator, PerspectiveCamera, Scene, ShadowMaterial, SRGBColorSpace, Vector3, WebGLRenderer, type Object3D, type SkinnedMesh,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ageFromYears, yearsFromAge, type MacroParams } from '@people/body/macro';
import { proxyUrl } from '@people/body/proxy';
import PROXY_FILES from 'virtual:model-urls/people/proxies?ext=json,bin,webp';
import { HAIR_STYLES, type HairStyle } from '@people/hair/procedural';
import { CLOTH_COLOURS, EYE_COLOURS, WARDROBE, randomPerson, type PersonLook, type PersonSpec } from '@people/spec';
import { communityItem, itemsOf, type WardrobeItem } from '@people/wardrobe';
import { PIXAR, REALISTIC, type CartoonStyle } from '@render/people/cartoon';
import { applyFace, faceAt } from '@render/people/faceExpression';
import { LabBuilder, type BuiltPerson } from './build';
import { Poser, type PoseName } from './pose';
import { HairSculptor, decodeSculpt, encodeSculpt, type BrushName } from './sculpt';
import { PROC_PREFIX, readRoster, rosterOf, savedBytes, type LabPerson } from './record';

/** THE PERSON CREATOR LAB (`people-lab.html`): people made one by one, saved for the game; the game's own build, nothing of the game changed */

// ---------------------------------------------------------------- choices

const SKIN = [0xf6dccb, 0xf0cdb2, 0xe5b898, 0xd9a47f, 0xc68b62, 0xb07349, 0x8f5b3a, 0x6f452b, 0x553220, 0x3d2417];
const HAIR_COLOURS = [0x1a1410, 0x2e2018, 0x4a3022, 0x6b4428, 0x8c5a2e, 0xa8743c, 0xc9a165, 0xe0c58f, 0x9a9a98, 0xdedcd8, 0x8a2f1f,
  0xc23b22, 0xe86aa6, 0x6a5acd, 0x2fa3c7, 0x3cb371];
const CLOTH = [...CLOTH_COLOURS, 0xe05a8a, 0x2f9d8f, 0x3b6fd1, 0xffd166, 0x9b5de5, 0x00bbf9];

const STYLE_PRESETS: readonly (readonly [string, CartoonStyle])[] = [
  ['Realista', REALISTIC],
  ['Desenho', { head: 1.2, eyes: 1.22, legs: 0.93, hands: 1.08, feet: 1.06 }],
  ['Pixar', PIXAR],
  ['Exagerado', { head: 1.65, eyes: 1.7, legs: 0.78, hands: 1.22, feet: 1.18 }],
];

const HAIR_NAMES: Record<string, string> = {
  longStraight: 'Longo liso', longWavy: 'Longo ondulado', midLayered: 'Médio repicado', bob: 'Chanel', bobFringe: 'Chanel com franja',
  ponytail: 'Rabo de cavalo', bun: 'Coque', ponytailFringe: 'Rabo com franja', longFringe: 'Longo com franja', longHeadband: 'Longo com tiara',
  shoulderBob: 'Chanel longo', fade: 'Degradê', buzz: 'Raspado', slickedBack: 'Para trás', quiff: 'Topete', manBun: 'Coque masculino',
  longMale: 'Longo masculino', curlyShort: 'Cacheado curto', afro: 'Black power', shortCrop: 'Curto', pigtails: 'Maria-chiquinha',
  braid: 'Trança', twinBraids: 'Duas tranças', curly: 'Cacheado', sideSwept: 'Jogado de lado', pixie: 'Joãozinho', topKnot: 'Coque alto',
  shortSide: 'Curto de lado',
};

const FACE: readonly (readonly [string, string, readonly (readonly [string, string])[]])[] = [
  ['Cabeça', '🙂', [['head-fat-decr-incr', 'Bochechuda'], ['head-scale-horiz-decr-incr', 'Largura'], ['head-scale-vert-decr-incr', 'Altura'],
    ['forehead-scale-vert-decr-incr', 'Testa']]],
  ['Olhos', '👁️', [['eye-scale-decr-incr', 'Tamanho'], ['eye-trans-in-out', 'Distância'], ['eye-corner1-down-up', 'Canto'],
    ['eye-height2-decr-incr', 'Abertura'], ['eyebrows-angle-down-up', 'Sobrancelha'], ['eyebrows-trans-down-up', 'Altura sobr.']]],
  ['Nariz', '👃', [['nose-scale-horiz-decr-incr', 'Largura'], ['nose-scale-vert-decr-incr', 'Comprimento'], ['nose-point-width-decr-incr', 'Ponta'],
    ['nose-point-down-up', 'Arrebitado'], ['nose-hump-decr-incr', 'Calombo'], ['nose-volume-decr-incr', 'Volume']]],
  ['Boca', '👄', [['mouth-scale-horiz-decr-incr', 'Largura'], ['mouth-upperlip-volume-decr-incr', 'Lábio sup.'], ['mouth-lowerlip-volume-decr-incr', 'Lábio inf.'],
    ['mouth-cupidsbow-decr-incr', 'Arco'], ['mouth-angles-down-up', 'Cantos'], ['mouth-laugh-lines-in-out', 'Covinhas']]],
  ['Queixo', '🧔', [['chin-width-decr-incr', 'Largura'], ['chin-prominent-decr-incr', 'Projeção'], ['chin-height-decr-incr', 'Altura'],
    ['chin-cleft-decr-incr', 'Furinho'], ['cheek-bones-decr-incr', 'Maçãs'], ['cheek-volume-decr-incr', 'Bochechas']]],
  ['Orelhas', '👂', [['ear-scale-decr-incr', 'Tamanho'], ['ear-lobe-decr-incr', 'Lóbulo'], ['ear-flap-decr-incr', 'Abano']]],
];
const HEAD_SHAPES: readonly (readonly [string, string])[] = [['head-oval', 'Oval'], ['head-round', 'Redonda'], ['head-square', 'Quadrada'],
  ['head-rectangular', 'Retangular'], ['head-diamond', 'Diamante'], ['head-triangular', 'Triangular'], ['head-invertedtriangular', 'Coração']];

const MOODS: readonly (readonly [string, string, string | undefined, PoseName])[] = [
  ['😐', 'Parado', undefined, 'idle'], ['💬', 'Conversando', 'talk', 'idle'], ['😂', 'Gargalhada', 'laugh', 'idle'],
  ['👋', 'Acenando', 'wave', 'wave'], ['🙌', 'Comemorando', 'cheer', 'cheer'], ['💃', 'Animado', 'dance', 'hips'],
  ['😠', 'Bravo', 'angry', 'hips'], ['🗯️', 'Discutindo', 'argue', 'idle'], ['😢', 'Chorando', 'cry', 'idle'], ['😱', 'Assustado', 'panic', 'idle'],
];

/** The whole page: its state lives here, owned by the lab, not loose in the module. */
function startLab(): void {
  // ---------------------------------------------------------------- state

  let person: LabPerson = { spec: { ...randomPerson(1, 11, { body: { age: ageFromYears(26), gender: 0.06 } }), name: '' }, style: PIXAR };
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

  function freshPerson(seed: number): LabPerson {
    const id = Math.floor(Math.random() * 2 ** 30);
    const spec = randomPerson(id, seed + id);
    return { spec: { ...spec, name: '' }, style: PIXAR };
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
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { cls?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] => {
    const e = document.createElement(tag);
    const { cls, ...rest } = props;
    if (cls) e.className = cls;
    Object.assign(e, rest);
    e.append(...kids);
    return e;
  };

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
      for (const m of next.meshes) { m.castShadow = true; m.frustumCulled = false; }
      scene.add(next.scene);
      poser = new Poser(next.scene);
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

  function slider(label: string, min: number, max: number, step: number, value: number, set: (v: number) => void, show: (v: number) => string = (v) => v.toFixed(2)): HTMLElement {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const out = el('output', { textContent: show(value) });
    input.addEventListener('input', () => { out.textContent = show(+input.value); set(+input.value); });
    return el('label', { cls: 'row' }, el('span', { textContent: label }), input, out);
  }

  function swatches(colours: readonly number[], current: number, set: (c: number) => void): HTMLElement {
    const box = el('div', { cls: 'swatches' });
    for (const c of colours) {
      const b = el('button', { title: `#${c.toString(16).padStart(6, '0')}` });
      b.style.background = `#${c.toString(16).padStart(6, '0')}`;
      if (c === current) b.classList.add('on');
      b.onclick = () => { set(c); render(); };
      box.append(b);
    }
    const free = el('input', { type: 'color', value: `#${current.toString(16).padStart(6, '0')}`, title: 'Qualquer cor' });
    free.addEventListener('change', () => { set(parseInt(free.value.slice(1), 16)); render(); });
    box.append(free);
    return box;
  }

  function seg<T extends string>(options: readonly (readonly [T, string])[], current: T, set: (v: T) => void): HTMLElement {
    const box = el('div', { cls: 'seg' });
    for (const [v, label] of options) {
      const b = el('button', { textContent: label });
      if (v === current) b.classList.add('on');
      b.onclick = () => { set(v); render(); };
      box.append(b);
    }
    return box;
  }

  const hasThumb = (name: string): boolean => `${name}-thumb.webp` in PROXY_FILES;
  function thumbOf(name: string): string | null {
    // Not every item ships a thumbnail: drawn as a glyph instead.
    return hasThumb(name) ? proxyUrl(`${name}-thumb.webp`) : null;
  }

  const pretty = (name: string): string => name.replace(/^(female|male)_/, '').replace(/^[a-z0-9]+_(?=[a-z])/i, (m) => (communityItem(name) ? '' : m))
    .replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 26);

  function tiles(names: readonly string[], current: string | undefined, set: (name: string) => void, none?: string): HTMLElement {
    const grid = el('div', { cls: 'grid' });
    const add = (name: string, label: string, glyph?: string): void => {
      const t = el('button', { cls: `tile${name === current ? ' on' : ''}`, title: name });
      const src = glyph ? null : thumbOf(name);
      t.append(src ? el('img', { src, loading: 'lazy', alt: '' }) : el('span', { cls: 'glyph', textContent: glyph ?? '•' }), label);
      t.onclick = () => { set(name); render(); };
      grid.append(t);
    };
    if (none) add('none', none, '∅');
    for (const n of names) add(n, pretty(n));
    return grid;
  }

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
    panel.replaceChildren(...(sculptor ? sculptPanel(sculptor) : PANELS[tab]!()));
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
        seg([['f', 'Feminino'], ['m', 'Masculino']] as const, female() ? 'f' : 'm', (v) => {
          const gender = v === 'f' ? 0.08 : 0.92;
          const keep = person.spec.look.outfit && (communityItem(person.spec.look.outfit)?.sex ?? (person.spec.look.outfit.startsWith('female') ? 'female' : 'male'));
          const outfit = keep === 'any' || keep === (v === 'f' ? 'female' : 'male') ? person.spec.look.outfit : v === 'f' ? 'female_casualsuit02' : 'male_casualsuit02';
          setSpec({ body: { ...b, gender }, look: { ...person.spec.look, ...(outfit ? { outfit } : {}) } });
        }),
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
      for (const [group, ico, sliders] of FACE) {
        out.push(el('h3', { textContent: `${ico} ${group}` }));
        for (const [k, label] of sliders) out.push(slider(label, -1, 1, 0.01, f[k] ?? 0, (v) => setFeature(k, v)));
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
        slider('Olhos', 0.8, 1.9, 0.01, s.eyes, (v) => set('eyes', v)),
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
        el('h2', { textContent: 'Roupas' }), all,
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

  function loadRoster(): LabPerson[] {
    try { return readRoster(JSON.parse(localStorage.getItem('roadcraft.peopleLab.roster') ?? 'null')); } catch (error) { console.warn('[people-lab] the saved roster could not be read', error); return []; }
  }
  function loadThumbs(): Record<string, string> {
    try { return JSON.parse(localStorage.getItem('roadcraft.peopleLab.thumbs') ?? '{}') as Record<string, string>; } catch (error) { console.warn('[people-lab] the saved thumbnails could not be read', error); return {}; }
  }

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

  function markdown(people: readonly LabPerson[]): string {
    return ['# Pessoas criadas no lab', '', `Formato \`roadcraft-people/1\`, ${people.length} pessoas.`, '',
      ...people.map((p) => `- **${p.spec.name || 'Sem nome'}** (id ${p.spec.id}): ${Math.round(yearsFromAge(p.spec.body.age))} anos, `
        + `${p.spec.body.gender < 0.5 ? 'feminino' : 'masculino'}, cabelo \`${p.spec.look.hairCut ?? 'none'}\`, roupa \`${p.spec.look.outfit ?? 'sob medida'}\`, `
        + `${savedBytes(p)} bytes`)].join('\n');
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
        body: JSON.stringify({ stamp: 'people-roster', json: JSON.stringify(rosterOf(roster), null, 1), md: markdown(roster) }) });
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
  fresh.onclick = () => { person = freshPerson(1); person = { ...person, spec: randomPerson(person.spec.id, 1) }; render(); rebuild(0); renderGallery(); };
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

  // ---------------------------------------------------------------- the hair sculptor

  const BRUSHES: readonly (readonly [BrushName, string, string])[] = [
    ['grab', '✋', 'Puxar'], ['inflate', '🎈', 'Volume'], ['smooth', '🪮', 'Alisar'],
    ['flatten', '🧱', 'Achatar'], ['pinch', '🤏', 'Apertar'], ['shorten', '✂️', 'Encurtar'],
  ];

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

  function sculptPanel(s: HairSculptor): Node[] {
    const undo = el('button', { cls: 'big alt', textContent: '↶ Desfazer' });
    undo.onclick = () => s.undoStep();
    const redo = el('button', { cls: 'big alt', textContent: '↷ Refazer' });
    redo.onclick = () => s.redoStep();
    const reset = el('button', { cls: 'big alt', textContent: 'Voltar ao original' });
    reset.onclick = () => s.reset();
    const done = el('button', { cls: 'big save', textContent: '✔ Concluir' });
    done.onclick = () => closeSculptor(true);
    const cancel = el('button', { cls: 'big alt', textContent: 'Cancelar' });
    cancel.onclick = () => closeSculptor(false);
    const mirror = el('label', { cls: 'check' }, el('input', { type: 'checkbox', checked: s.mirror }), 'Espelhar nos dois lados');
    mirror.querySelector('input')!.addEventListener('change', (e) => { s.mirror = (e.target as HTMLInputElement).checked; });
    return [
      el('h2', { textContent: 'Esculpir cabelo' }),
      el('div', { cls: 'note', textContent: 'Botão esquerdo esculpe; botão direito gira a vista; roda do mouse aproxima. Shift inverte o pincel. Ctrl+Z desfaz.' }),
      el('h3', { textContent: 'Pincel' }),
      el('div', { cls: 'grid' }, ...BRUSHES.map(([b, glyph, label]) => {
        const t = el('button', { cls: `tile${s.brush === b ? ' on' : ''}` }, el('span', { cls: 'glyph', textContent: glyph }), label);
        t.onclick = () => { s.brush = b; render(); };
        return t;
      })),
      el('h3', { textContent: 'Ajuste' }),
      slider('Tamanho', 1, 20, 0.5, s.radius * 10, (v) => { s.radius = v / 10; }, (v) => `${v} cm`),
      slider('Força', 0.05, 1, 0.01, s.strength, (v) => { s.strength = v; }),
      mirror,
      el('div', { cls: 'pair' }, undo, redo), reset,
      el('h3', { textContent: 'Pronto?' }), done, cancel,
    ];
  }

  const ndc = (e: PointerEvent): Vector2 => {
    const r = renderer.domElement.getBoundingClientRect();
    return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  };
  let carving = false;
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
        if (m.morphTargetInfluences && m.morphTargetDictionary) applyFace(m.morphTargetInfluences, m.morphTargetDictionary, face);
      }
    }
    controls.update();
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
    pick(tabId: string) { tab = tabId; render(); }, openSculptor, closeSculptor, get sculptor() { return sculptor; }, act(a: string | undefined, p: PoseName) { activity = a; pose = p; render(); } };
}

startLab();
