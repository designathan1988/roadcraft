import {
  ACESFilmicToneMapping, BufferAttribute, CylinderGeometry, Vector2, type Texture, CircleGeometry, Color, DirectionalLight, HemisphereLight, Mesh, MeshStandardMaterial, PCFSoftShadowMap,
  PMREMGenerator, PerspectiveCamera, Scene, ShadowMaterial, SRGBColorSpace, Vector3, WebGLRenderer, type Object3D, type SkinnedMesh,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ageFromYears, yearsFromAge, type MacroParams } from '@people/body/macro';
import type { HairStyle } from '@people/hair/procedural';
import { randomPerson, type PersonLook, type PersonSpec } from '@people/spec';
import { communityItem, type WardrobeItem } from '@people/wardrobe';
import type { CartoonStyle } from '@render/people/cartoon';
import { applyFace, faceAt } from '@render/people/faceExpression';
import { createPersonLayers, releaseSkinAppearance, type SkinAppearance } from '@render/people/skinAppearance';
import { drainUploads } from '@render/uploads';
import { LabBuilder, type BuiltPerson } from './build';
import { PoseEditor } from './posing';
import { posePanel, timeline } from './posePanel';
import { setupNavigation } from './navigation';
import { ClipPlayer, Poser, spreadArms, uprightHead, type PoseName } from './pose';
import { loadRocketboxClips, type LibraryClipName } from '@render/citizenWalk';
import { variedFace } from './presets';
import { HandShaper, REGION_IDS, addDragMorphs, type Region } from './direct';
import { measureBody } from './proportions';
import { fitBody } from './bodyFit';
import { dressPerson } from './dress';
import { regionGlow } from './polish';
import { Thumbs } from './thumbs';
import { makePanels } from './panels';
import { HairSculptor, decodeSculpt, encodeSculpt } from './sculpt';
import { HairStudio } from './hairStudio';
import { hairPanel } from './hairPanel';
import { Atelier } from './atelier';
import { atelierPanel } from './atelierPanel';
import { sculptPanel } from './sculptPanel';
import { ATELIER, GROOM, PROC_PREFIX, loadRoster, loadThumbs, readRoster, rosterMarkdown, rosterOf, savedBytes, type LabPerson } from './record';
import { CLOTH, HAIR_CATALOGUE, HAIR_COLOURS, NICE_HAIR, READY_POSES, ROADCRAFT } from './choices';
import { el, widgets } from './widgets';
import { icon } from './icons';

/** THE PERSON CREATOR LAB (`people-lab.html`): people made one by one, saved for the game; the game's own build, nothing of the game changed */

/** The whole page: its state lives here, owned by the lab, not loose in the module. */
function startLab(): void {
  // ---------------------------------------------------------------- state

  const first = randomPerson(1, 11, { body: { age: ageFromYears(26), gender: 0.06 } });
  // The first person shows a face: no glasses over the eyes.
  let person: LabPerson = { spec: { ...first, name: '', body: { ...first.body, weight: 0.4, muscle: 0.4, proportions: 1 }, features: variedFace('female', () => 0.5), look: { ...first.look, makeup: 0, hairCut: 'long01', hairStyle: 'long', outfit: 'female_elegantsuit01', outfitTint: 0x3b6fd1, footwear: 'elvs_flatshoe_pointy1', brows: 'eyebrow010', extras: (first.look.extras ?? []).filter((x) => communityItem(x)?.kind !== 'glasses') } }, style: ROADCRAFT };
  let activity: string | undefined;
  let pose: PoseName = 'idle';
  let built: BuiltPerson | null = null;
  let poser: Poser | null = null;
  /** The captured clip the body plays (`ClipPlayer`), and the player on the person built now. */
  let clipName: LibraryClipName = 'idle';
  /** A ready pose: the clip held at this moment, kept across rebuilds. */
  let heldAt: number | null = null;
  let player: ClipPlayer | null = null;
  let tab = 'pessoa';
  /** The group open in each category. */
  const subOf: Record<string, string> = {};
  let showAll = false;
  let roster: LabPerson[] = loadRoster();
  const thumbs: Record<string, string> = loadThumbs();
  /** The hair sculptor while it is open, the person hidden. */
  let sculptor: HairSculptor | null = null;
  /** The hair studio while it is open. */
  let studio: HairStudio | null = null;
  /** The atelier while it is open. */
  let atelier: Atelier | null = null;
  /** The editor taking the pointer: the sculptor or the hair studio. */
  const editor = (): HairSculptor | HairStudio | Atelier | null => sculptor ?? studio ?? atelier;
  /** Click-and-drag shaping of the person built now. */
  let shaper: HandShaper | null = null;

  function freshPerson(seed: number): LabPerson {
    const id = Math.floor(Math.random() * 2 ** 30);
    const spec = randomPerson(id, seed + id);
    const hairs = NICE_HAIR[spec.body.gender < 0.5 ? 'female' : 'male'];
    const hairCut = hairs[Math.floor(Math.random() * hairs.length)]!;
    return { spec: { ...spec, name: '', features: variedFace(spec.body.gender < 0.5 ? 'female' : 'male', Math.random), look: { ...spec.look, makeup: 0, hairCut, ...(spec.body.gender < 0.5 ? { brows: 'eyebrow010' } : {}) } }, style: ROADCRAFT };
  }

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
  // Drawn at twice the screen's pixels at least (supersampled): eyes and brows read sharp on a 1x screen.
  renderer.setPixelRatio(Math.min(3, Math.max(2, devicePixelRatio)));
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
  const pedestal = new Mesh(new CircleGeometry(0.75, 64), new MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.85 }));
  pedestal.rotation.x = -Math.PI / 2;
  pedestal.receiveShadow = true;
  scene.add(pedestal);
  const shadowCatcher = new Mesh(new CircleGeometry(4, 32), new ShadowMaterial({ opacity: 0.18 }));
  shadowCatcher.rotation.x = -Math.PI / 2;
  shadowCatcher.position.y = -0.001;
  shadowCatcher.receiveShadow = true;
  scene.add(shadowCatcher);

  // A stool for the seated clips: the capture sits on a chair the clip does not carry.
  const stool = new Mesh(new CylinderGeometry(0.2, 0.18, 0.44, 32), new MeshStandardMaterial({ color: 0xc9a27a, roughness: 0.6 }));
  stool.position.set(0, 0.22, -0.16);
  stool.castShadow = stool.receiveShadow = true;
  stool.visible = false;
  scene.add(stool);
  const camera = new PerspectiveCamera(30, 1, 0.05, 50);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 0.4;
  controls.maxDistance = 6;
  controls.maxPolarAngle = Math.PI * 0.55;
  // Navigation as editors do it (`navigation.ts`): right orbits, middle pans, wheel zooms to the cursor, Alt with any button, F frames.
  setupNavigation(controls, camera, renderer.domElement, {
    targets: () => [built?.scene, sculptor?.group, studio?.group, atelier?.group, tab === 'pose' ? posing.helpers : null].filter((o): o is Object3D => !!o),
    frame: () => frame(view),
  });
  const posing = new PoseEditor(camera, renderer.domElement, scene, controls);
  posing.onChange = () => { person = { ...person, motion: posing.motion() }; };
  let view: 'face' | 'body' = 'body';
  let height = 1.7;

  function frame(which: 'face' | 'body', instant = false): void {
    view = which;
    const head = new Vector3(0, height * 0.92, 0);
    built?.scene.traverse((o) => { if (o.name === 'head' || o.name === 'Bip01_Head') o.getWorldPosition(head); });
    const target = which === 'face' ? head.clone().add(new Vector3(0, 0.06, 0)) : new Vector3(0, height * 0.52, 0);
    const dist = which === 'face' ? (editor() ? 1.25 : 1.15) : height * 2.3;
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
  /** Pictures of the choices (`thumbs.ts`). */
  const paintedSkins = new WeakMap<Texture, Texture>();
  /** The region lit under the pointer (`regionGlow`). */
  const glow = { hover: { value: 0 }, time: { value: 0 } };
  const pictures = new Thumbs(builder, paintedSkins);
  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown'] as const) window.addEventListener(type, () => { pictures.touched = performance.now(); }, { passive: true });
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
    pictures.paused = true;
    const started = performance.now();
    try {
      const next = await builder.build(effective(person));
      if (mine !== generation) { dispose(next.scene); return; }
      if (built) { scene.remove(built.scene); dispose(built.scene); }
      built = next;
      // The game's second step (`riggedCitizens.ts`): skin, irises, hair strands and fabrics drawn from their textures.
      // The parts the hand can shape, known before the materials are made: each vertex's region, for the glow.
      const faces = await builder.proportions();
      const spec = person.spec;
      const nextShaper = next.meshes[0] ? new HandShaper(next.meshes[0], (slider) => faces.influenceOf(slider, spec)) : null;
      if (nextShaper) next.meshes[0]!.geometry.setAttribute('labRegion', new BufferAttribute(nextShaper.regionAttribute(), 1));
      const skin = await dressPerson(next, effective(person).spec, layers, paintedSkins, !!person.sculpts?.some((x) => x.base === person.spec.look.outfit), person.garment?.colour ?? null);
      for (const m of next.meshes) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) if (m.geometry.hasAttribute('labRegion')) regionGlow(mat as MeshStandardMaterial, glow);
      if (mine !== generation) { releaseSkinAppearance(skin); dispose(next.scene); return; }
      if (appearance) releaseSkinAppearance(appearance);
      appearance = skin;
      for (const m of next.meshes) { m.castShadow = true; m.frustumCulled = false; }
      scene.add(next.scene);
      poser = new Poser(next.scene);
      posing.setRoot(next.scene);
      player = null;
      const sexNow = sexName();
      void loadRocketboxClips(sexNow).then((clips) => {
        if (built !== next || !next.meshes[0]) return;
        player = new ClipPlayer(next.scene, next.meshes[0], clips);
        player.play(clipName, (performance.now() - clock0) / 1000);
        player.hold = heldAt;
      }, (error: unknown) => { console.warn('[people-lab] the motion library could not be loaded; the lab poses instead', error); });
      if (!shaping) dragWeights = null;
      shaper = nextShaper;
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
      if (mine === generation) { busy.classList.remove('on'); pictures.paused = !!shaping; }
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


  // ---------------------------------------------------------------- the panels

  const TABS: readonly (readonly [string, string, string])[] = [
    ['pessoa', 'body', 'Corpo'], ['rosto', 'face', 'Rosto'], ['estilo', 'style', 'Estilo'], ['cabelo', 'hair', 'Cabelo'],
    ['roupas', 'cloth', 'Roupas'], ['expressao', 'drama', 'Ações'], ['pose', 'bones', 'Rig e animação'],
  ];
  for (const [id, ico, label] of TABS) {
    const b = el('button', {}, icon(ico, 20), el('span', { cls: 'tip-label', textContent: label }));
    b.dataset['tab'] = id;
    b.onclick = () => { tab = id; render(); if (id === 'rosto' || id === 'cabelo' || id === 'expressao') frame('face'); };
    rail.append(b);
  }

  function render(): void {
    for (const b of rail.querySelectorAll('button')) b.classList.toggle('on', (b as HTMLElement).dataset['tab'] === tab);
    nameInput.value = person.spec.name;
    const scroll = panel.scrollTop;
    pictures.clearQueue();
    posing.show(tab === 'pose' && !editor());
    if (tab !== 'pose') tl?.classList.remove('on');
    if (sculptor) panel.replaceChildren(...sculptPanel(sculptor, { slider, render, close: closeSculptor }));
    else if (atelier) panel.replaceChildren(...atelierPanel(atelier, { ui: { slider, swatches, seg, tiles }, render, close: closeAtelier, colours: CLOTH }));
    else if (studio) panel.replaceChildren(...hairPanel(studio, { ui: { slider, swatches, seg, tiles }, render, close: closeHairStudio, colours: HAIR_COLOURS }));
    else if (tab === 'pose') panel.replaceChildren(...posePanelNodes());
    else {
      // The category's groups along the top (Create-a-Sim's sub tabs), the chosen one below.
      const groups = PANELS[tab]!;
      const current = groups.find(([id]) => id === subOf[tab]) ?? groups[0]!;
      const bar = el('div', { cls: 'subtabs' }, ...groups.map(([id, label]) => {
        const g = el('button', { textContent: label, cls: id === current[0] ? 'on' : '' });
        g.onclick = () => { subOf[tab] = id; panel.scrollTop = 0; render(); };
        return g;
      }));
      panel.replaceChildren(groups.length > 1 ? bar : el('span'), ...current[2]());
    }
    panel.scrollTop = scroll;
  }

  const PANELS = makePanels({
    get person() { return person; }, get showAll() { return showAll; }, get activity() { return activity; }, get pose() { return pose; }, get clip() { return clipName; },
    ui: { slider, swatches, seg, tiles }, pictures,
    setSpec, setLook: (patch) => setLook(patch as Loose<PersonLook>), setBody, setFeature,
    // The Roadcraft style is the fitted one: picking it refits the body (the head to ~6.3 heads tall).
    setStyle: (st) => { setStyle(st); if (st === ROADCRAFT) void fitFace(); },
    setMood: (v) => { person = { ...person, spec: { ...person.spec, mood: v } }; },
    setShowAll: (v) => { showAll = v; render(); },
    act: (a, p, clip) => { activity = a; pose = p; clipName = clip; stool.visible = clip === 'sitIdle'; heldAt = null; if (player) player.hold = null; player?.play(clip, (performance.now() - clock0) / 1000); render(); },
    render, openSculptor: (item) => { void openSculptor(item); }, fitFace: () => { void fitFace(); },
    dropPiece: (item) => { person = { ...person, sculpts: (person.sculpts ?? []).filter((x) => x.base !== item) }; rebuild(0); render(); },
    dropSculpt: () => { const { sculpt: _s, ...rest } = person; void _s; person = rest; rebuild(0); render(); },
    extraOf, setExtra, sex: sexName,
    openHairStudio: () => { void openHairStudio(); }, openAtelier: () => { void openAtelier(); },
    setSex: (v) => {
      // The hair and the outfit go with the sex unless they suit both.
      const look = person.spec.look;
      const fits = (n: string | undefined): boolean => !n || n === 'none' || (HAIR_CATALOGUE[v] as readonly string[]).includes(n) || communityItem(n)?.sex === 'any';
      const outfitSex = look.outfit ? (communityItem(look.outfit)?.sex ?? (look.outfit.startsWith('female') ? 'female' : 'male')) : 'any';
      setSpec({ body: { ...person.spec.body, gender: v === 'female' ? 0.06 : 0.92 }, features: variedFace(v, () => 0.5),
        look: { ...look, hairCut: fits(look.hairCut) ? look.hairCut! : NICE_HAIR[v][0], ...(outfitSex === 'any' || outfitSex === v ? {} : { outfit: v === 'female' ? 'female_elegantsuit01' : 'male_casualsuit02', footwear: v === 'female' ? 'elvs_flatshoe_pointy1' : 'shoes02' }) } });
      void fitFace();
    },
  });


  // ---------------------------------------------------------------- the gallery and saving

  const gallery = el('div', { cls: 'gallery' });
  const toast = el('div', { cls: 'toast' });
  document.body.append(toast);
  let toastUntil = 0;
  function say(text: string): void { toast.textContent = text; toast.classList.add('on'); toastUntil = performance.now() + 2400; }

  const save = el('button', { cls: 'big save' }, icon('save', 16), 'Salvar');
  const fresh = el('button', { cls: 'big alt' }, icon('plus', 16), 'Nova');
  const dice = el('button', { cls: 'big alt' }, icon('shuffle', 16), 'Sortear');
  const revokeAt: [number, string][] = [];
  const exportBtn = el('button', { cls: 'big alt' }, icon('download', 16), 'Exportar');
  const importBtn = el('button', { cls: 'big alt' }, icon('upload', 16), 'Importar');
  side.append(el('h2', { textContent: 'Pessoas' }), save, el('div', { cls: 'pair' }, fresh, dice), gallery, el('div', { cls: 'pair' }, exportBtn, importBtn));


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
      card.onclick = () => { person = structuredClone(p); posing.load(person.motion); activity = undefined; pose = 'idle'; render(); rebuild(0); renderGallery(); };
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
  fresh.onclick = () => { person = freshPerson(1); render(); void fitFace(); renderGallery(); };
  dice.onclick = () => { const keepName = person.spec.name; person = freshPerson(Math.floor(Math.random() * 1e6)); person = { ...person, spec: { ...person.spec, name: keepName } }; render(); void fitFace(); };
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
  /** The body set to the measured canon (`bodyFit.ts`); the face stays the approved one. */
  async function fitFace(): Promise<void> {
    person = await fitBody(person, builder);
    render();
    rebuild(0);
  }

  /** The rig and animation tab (`posePanel.ts`), and its timeline under the view. */
  let poseGroup = 'pose';
  let tl: (HTMLElement & { draw?: () => void }) | null = null;
  function posePanelNodes(): Node[] {
    const now = (): number => (performance.now() - clock0) / 1000;
    if (!tl) { tl = timeline(posing, render); stage.append(tl); }
    tl.classList.toggle('on', poseGroup === 'anim');
    tl.draw?.();
    return posePanel(posing, {
      ui: { slider, swatches, seg, tiles }, render, now, group: poseGroup, setGroup: (g) => { poseGroup = g; },
      poses: READY_POSES.map(([label, clip, at]) => [label, () => {
        clipName = clip; stool.visible = clip === 'sitIdle';
        heldAt = at;
        if (player) { player.play(clip, now()); player.hold = at; }
      }, clipName === clip && heldAt === at] as const),
    });
  }

  // ---------------------------------------------------------------- the hair studio

  async function openHairStudio(): Promise<void> {
    const body = await builder.studioBody(person);
    studio = new HairStudio(body, person.spec.look.hairCut === GROOM ? person.groom ?? null : null, person.spec.look.hair, person.spec.look.skin);
    if (!studio.count) studio.preset('bob');
    scene.add(studio.group);
    if (built) built.scene.visible = false;
    frame('face');
    render();
  }

  function closeHairStudio(keep: boolean): void {
    const s = studio;
    if (!s) return;
    if (keep && s.count) person = { ...person, groom: s.record(), spec: { ...person.spec, look: { ...person.spec.look, hairCut: GROOM, hairStyle: 'long' } } };
    scene.remove(s.group);
    s.dispose();
    studio = null;
    if (built) built.scene.visible = true;
    controls.enabled = true;
    render();
    if (keep) rebuild(0);
  }

  // ---------------------------------------------------------------- the atelier

  async function openAtelier(): Promise<void> {
    const body = await builder.studioBody(person);
    atelier = new Atelier(body, person.spec.look.extras?.includes(ATELIER) ? person.garment ?? null : null, person.spec.look.skin);
    scene.add(atelier.group);
    if (built) built.scene.visible = false;
    frame('body');
    render();
  }

  function closeAtelier(keep: boolean): void {
    const a = atelier;
    if (!a) return;
    if (keep) person = { ...person, garment: a.record(), spec: { ...person.spec, look: { ...person.spec.look, extras: [...(person.spec.look.extras ?? []).filter((x) => x !== ATELIER), ATELIER] } } };
    scene.remove(a.group);
    a.dispose();
    atelier = null;
    if (built) built.scene.visible = true;
    controls.enabled = true;
    render();
    if (keep) rebuild(0);
  }

  // ---------------------------------------------------------------- the hair sculptor

  /** The item the sculptor has open: the hair, or any worn piece by name. */
  let sculpting = '';
  async function openSculptor(name = person.spec.look.hairCut ?? ''): Promise<void> {
    const cut = name;
    const item = cut && cut !== 'none' ? await builder.item(person, cut) : null;
    if (!item) { say('Escolha uma peça primeiro'); return; }
    const body = await builder.sculptBody(person);
    const n = item.pack.refs.length / 3;
    const hair = cut === person.spec.look.hairCut;
    const prior = hair ? (person.sculpt?.base === cut ? person.sculpt : undefined) : person.sculpts?.find((x) => x.base === cut);
    const start = prior ? decodeSculpt(prior, n) : null;
    sculpting = cut;
    sculptor = new HairSculptor(item.pack, body, start, hair ? person.spec.look.hair : (person.spec.look.outfitTint ?? 0x8a96a3), person.spec.look.skin, item.texture);
    scene.add(sculptor.group);
    if (built) built.scene.visible = false;
    frame(hair ? 'face' : 'body');
    render();
  }

  function closeSculptor(keep: boolean): void {
    const s = sculptor;
    if (!s) return;
    if (keep) {
      const piece = encodeSculpt(sculpting, s.delta());
      person = sculpting === person.spec.look.hairCut ? { ...person, sculpt: piece }
        : { ...person, sculpts: [...(person.sculpts ?? []).filter((x) => x.base !== sculpting), piece] };
    }
    scene.remove(s.group);
    s.dispose();
    sculptor = null;
    if (built) built.scene.visible = true;
    controls.enabled = true;
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
  const FACE_REGIONS = new Set(['head', 'forehead', 'brows', 'eyes', 'nose', 'cheeks', 'mouth', 'jaw', 'ears']);
  let lastPick = 0;
  const feature = (k: string): number => person.spec.features[k] ?? 0;
  const showTip = (e: PointerEvent, region: Region | null): void => {
    glow.hover.value = region ? REGION_IDS.indexOf(region.id) + 1 : 0;
    if (!region) { tip.classList.remove('on'); renderer.domElement.style.cursor = ''; return; }
    const r = stage.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left + 16}px`;
    tip.style.top = `${e.clientY - r.top + 12}px`;
    tip.innerHTML = `<b>${region.label}</b><br>${region.x.label} ${feature(region.x.slider).toFixed(2)} · ${region.y.label} ${feature(region.y.slider).toFixed(2)}`;
    tip.classList.add('on');
    renderer.domElement.style.cursor = shaping ? 'grabbing' : 'grab';
  };
  renderer.domElement.addEventListener('pointerdown', (e) => {
    if (tab === 'pose' && e.button === 0 && !e.altKey && !editor()) { if (posing.pick(ndc(e), camera)) render(); return; }
    if (editor() || e.button !== 0 || !shaper || !shapeTabs.has(tab)) return;
    const region = shaper.pick(ndc(e), camera);
    if (!region) return;
    shaping = { region, x0: e.clientX, y0: e.clientY, fx: feature(region.x.slider), fy: feature(region.y.slider) };
    // The instant preview only on the face: a body slider (a length, a girth) moves skin the hair, eyes and garments do not follow in a morph.
    if (FACE_REGIONS.has(region.id)) void prepareDrag(region, shaping.fx, shaping.fy);
    controls.enabled = false;
    renderer.domElement.setPointerCapture(e.pointerId);
    showTip(e, region);
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    if (editor() || !shaper || !shapeTabs.has(tab)) { tip.classList.remove('on'); return; }
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
  renderer.domElement.addEventListener('pointerleave', () => { if (!shaping) { tip.classList.remove('on'); glow.hover.value = 0; } });
  renderer.domElement.addEventListener('pointerdown', (e) => {
    const ed = editor();
    if (!ed || e.button !== 0 || e.altKey) return;
    if (ed instanceof HairStudio ? ed.begin(ndc(e), camera, e.shiftKey) : ed.begin(ndc(e), camera)) {
      carving = true;
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
    }
  });
  renderer.domElement.addEventListener('pointermove', (e) => {
    const ed = editor();
    if (!ed) return;
    if (carving) ed.move(ndc(e), camera, e.shiftKey);
    else ed.hover(ndc(e), camera);
  });
  const stop = (): void => { if (!carving) return; carving = false; editor()?.end(); controls.enabled = true; if (studio) render(); };
  renderer.domElement.addEventListener('pointerup', stop);
  renderer.domElement.addEventListener('pointercancel', stop);
  window.addEventListener('keydown', (e) => {
    const ed = editor();
    if (!ed || !(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'z') { e.preventDefault(); ed.undoStep(); }
    if (e.key === 'y') { e.preventDefault(); ed.redoStep(); }
  });

  // ---------------------------------------------------------------- the loop

  const clock0 = performance.now();
  let lastTick = clock0;
  /** How much stronger the lab draws a feeling than the street. */
  const EXPRESSIVE = 1.6;
  const CALM = new Set(['faceBlink', 'lookLeft', 'lookRight']);
  function loop(): void {
    const now = performance.now();
    const t = (now - clock0) / 1000;
    studio?.tick(Math.min(0.05, (now - lastTick) / 1000));
    atelier?.tick(Math.min(0.05, (now - lastTick) / 1000));
    lastTick = now;
    glow.time.value = t;
    if (buildAt && now >= buildAt) { buildAt = 0; void runBuild(); }
    if (toastUntil && now >= toastUntil) { toastUntil = 0; toast.classList.remove('on'); }
    while (revokeAt.length && revokeAt[0]![0] <= now) URL.revokeObjectURL(revokeAt.shift()![1]);
    if (built) {
      if (player?.playing) player.apply(t); else poser?.apply(pose, t);
      posing.apply(t);
      if (posing.playing) tl?.draw?.();
      // Arms clear of the body in the standing clips (not when they reach for something).
      if (['idle', 'talk', 'listen', 'look', 'nervous', 'laugh', 'walkStroll', 'walkCool'].includes(clipName)) { spreadArms(built.scene, 0.14); uprightHead(built.scene); }
      if (stool.visible) {
        // Under the pelvis wherever the clip puts it, its top just below the seat.
        built.scene.traverse((o) => { if (o.name === 'Bip01_Pelvis') { o.updateWorldMatrix(true, false); const at = o.getWorldPosition(new Vector3()); stool.scale.y = Math.max(0.2, (at.y - 0.1) / 0.44); stool.position.set(at.x, stool.scale.y * 0.22, at.z - 0.04); } });
      }
      // Close up the street's faces read faint: the lab shows each feeling half as strong again (blinks and gaze as they are).
      // The face set in the rig tab or keyed in the animation wins over the face's own life.
      const face = posing.faceNow() ?? faceAt(person.spec.id, t, activity, person.spec.mood ?? 0);
      for (const m of built.meshes as SkinnedMesh[]) {
        if (m.morphTargetInfluences && m.morphTargetDictionary) {
          applyFace(m.morphTargetInfluences, m.morphTargetDictionary, face);
          // Past the game's cap of 1 (three.js blends any weight): blinks and gaze kept as they are.
          if (activity) for (const [name, i] of Object.entries(m.morphTargetDictionary)) if (!CALM.has(name) && !name.startsWith('drag:')) m.morphTargetInfluences[i] = m.morphTargetInfluences[i]! * EXPRESSIVE;
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
  void fitFace();
  loop();
  // For checks from outside (the lab's screenshots): the person as it is now.
  (window as unknown as { peopleLab: unknown }).peopleLab = { get person() { return person; }, setHair, setStyle, frame, get built() { return built; },
    pick(tabId: string) { tab = tabId; render(); }, posing, async bakePictures() {
      // Every panel of both sexes asked once, each picture drawn on the mannequin; the bake script writes them as files.
      pictures.baking = true;
      const keep = person;
      for (const sex of ['female', 'male'] as const) {
        person = { ...person, spec: { ...person.spec, body: { ...person.spec.body, gender: sex === 'female' ? 0.06 : 0.92 } } };
        for (const t of ['pessoa', 'rosto', 'estilo', 'cabelo', 'roupas']) { tab = t; for (const [, , show] of PANELS[t]!) panel.replaceChildren(...show()); }
      }
      const out = await pictures.drained();
      person = keep; pictures.baking = false; tab = 'pessoa'; render();
      return out;
    }, sideView() { const d = camera.position.distanceTo(controls.target); camera.position.copy(controls.target).add(new Vector3(d, 0, 0)); }, pictures, withLook(patch: Partial<PersonLook>) { return { ...person, spec: { ...person.spec, look: { ...person.spec.look, ...patch } } }; }, spec(patch: Partial<PersonSpec>) { setSpec(patch); }, fitFace, async measure() { return (await builder.proportions()).measure(person.spec); }, async body() { return measureBody((await builder.setup()).assets, await builder.shape(person)); }, async sweep(slider: string) { const f = await builder.proportions(); return [-1, 0, 1].map((v) => f.measure({ ...person.spec, features: { ...person.spec.features, [slider]: v } })); }, look(patch: Record<string, unknown>) { setLook(patch as Partial<PersonLook>); },
    closeUp(dist = 0.5, x = 0) {
      const head = new Vector3();
      built?.scene.traverse((o) => { if (o.name === 'Bip01_Head') o.getWorldPosition(head); });
      controls.target.copy(head).add(new Vector3(0, 0.02, 0.05));
      camera.position.copy(controls.target).add(new Vector3(x, 0, dist));
    }, features(patch: Record<string, number>) { setSpec({ features: { ...person.spec.features, ...patch } }); }, openSculptor, closeSculptor, get sculptor() { return sculptor; }, openHairStudio, closeHairStudio, get studio() { return studio; }, openAtelier, closeAtelier, get atelier() { return atelier; }, act(a: string | undefined, p: PoseName) { activity = a; pose = p; render(); } };
}

startLab();
