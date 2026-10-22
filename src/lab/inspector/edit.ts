import { Color, type BufferGeometry, type Material, type Object3D, type Texture, Vector3 } from 'three';
import { el, fold, kv } from './dom';
import { FILTERS, SIDES, type TextureInfo, editableUniforms, instanceMatrix } from './describe';
import { gameProbe, toMap } from './entity';
import { INSPECTOR_OWN } from './raycast';
import type { InspectorState, SetOptions } from './state';

/** THE LIVE EDITS: every field of the selected object, its materials, their textures and uniforms and its geometry's draw range, set from the panel to try a change
 *  without touching the code. Each goes through the edit log (`state.ts`): undone alone or all together, and told to the recorder (`edit.<kind>`).
 *  A field that changes what three compiles (a map on or off, flat shading, the side) sets `material.needsUpdate` (three docs, "How to update things");
 *  a texture's filters are sent with the texture again (`texture.needsUpdate`), only where its image is still on the CPU. */

type Holder = Record<string, unknown>;

/** A checkbox bound to `holder[key]`. */
function check(state: InspectorState, holder: object, key: string, options: SetOptions): HTMLElement {
  const label = el('label', 'insp-field');
  const input = el('input');
  input.type = 'checkbox';
  input.checked = Boolean((holder as Holder)[key]);
  input.onchange = () => state.edits.set(holder, key, input.checked, options);
  label.append(input, el('span', '', key));
  return label;
}

/** A number: a slider over `min`-`max` and a field for any value. */
function numberField(state: InspectorState, holder: object, key: string, options: SetOptions, range?: readonly [number, number, number]): HTMLElement {
  const row = el('label', 'insp-field insp-num');
  const value = Number((holder as Holder)[key]);
  const field = el('input');
  field.type = 'number';
  field.step = 'any';
  field.value = String(value);
  row.appendChild(el('span', 'insp-field-name', key));
  if (range) {
    const slider = el('input');
    slider.type = 'range';
    [slider.min, slider.max, slider.step] = range.map(String) as [string, string, string];
    slider.value = String(value);
    slider.oninput = () => { field.value = slider.value; state.edits.set(holder, key, Number(slider.value), options); };
    field.onchange = () => { slider.value = field.value; state.edits.set(holder, key, Number(field.value), options); };
    row.append(slider, field);
  } else {
    field.onchange = () => state.edits.set(holder, key, Number(field.value), options);
    row.appendChild(field);
  }
  return row;
}

/** A range guessed from a value: 0-1 for a share, 0 to four times it otherwise. */
function rangeOf(v: number): readonly [number, number, number] {
  if (v >= 0 && v <= 1) return [0, 1, 0.001];
  if (v < 0 && v >= -1) return [-1, 1, 0.001];
  const top = Math.max(1, Math.abs(v) * 4);
  return [v < 0 ? -top : 0, top, top / 1000];
}

/** A colour (`Color`) edited with the browser's colour input. */
function colourField(state: InspectorState, holder: object, key: string, options: SetOptions): HTMLElement {
  const row = el('label', 'insp-field');
  const input = el('input');
  input.type = 'color';
  const c = (holder as Holder)[key] as Color;
  input.value = `#${c.getHexString()}`;
  input.oninput = () => state.edits.set(holder, key, new Color(input.value), options);
  row.append(el('span', 'insp-field-name', key), input, el('span', 'lab-muted', `#${c.getHexString()}`));
  input.addEventListener('change', () => { (row.lastChild as HTMLElement).textContent = input.value; });
  return row;
}

/** A vector's components, each a number field (the whole vector set again on a change). */
function vectorField(state: InspectorState, holder: object, key: string, options: SetOptions): HTMLElement {
  const row = el('div', 'insp-field insp-vec');
  row.appendChild(el('span', 'insp-field-name', key));
  const v = (holder as Holder)[key] as { toArray(): number[]; clone(): { fromArray(a: number[]): unknown } };
  const values = v.toArray();
  values.forEach((n, i) => {
    const field = el('input');
    field.type = 'number';
    field.step = 'any';
    field.value = String(Math.round(n * 1e5) / 1e5);
    field.onchange = () => {
      const now = ((holder as Holder)[key] as { toArray(): number[] }).toArray();
      now[i] = Number(field.value);
      state.edits.set(holder, key, v.clone().fromArray(now), options);
    };
    row.appendChild(field);
  });
  return row;
}

/** A select of named numbers (a side, a filter). */
function selectField(state: InspectorState, holder: object, key: string, table: Readonly<Record<number, string>>, options: SetOptions): HTMLElement {
  const row = el('label', 'insp-field');
  const select = el('select');
  for (const [v, name] of Object.entries(table)) select.appendChild(new Option(name, v));
  select.value = String((holder as Holder)[key]);
  select.onchange = () => state.edits.set(holder, key, Number(select.value), options);
  row.append(el('span', 'insp-field-name', key), select);
  return row;
}

const objectLabel = (o: Object3D): string => `${o.type} "${o.name || '—'}"`;

/** The object's own fields, and the buttons that hide it, hide everything else, or bring the camera to it. */
export function objectEditor(state: InspectorState, object: Object3D, instanceId: number | null, batchId: number | null): HTMLElement {
  const target = objectLabel(object);
  const opts: SetOptions = { kind: 'object', target, after: () => object.updateMatrixWorld(true) };
  const box = el('div', 'insp-edit');
  const flags = el('div', 'lab-row');
  for (const key of ['visible', 'castShadow', 'receiveShadow', 'frustumCulled', 'matrixAutoUpdate']) flags.appendChild(check(state, object, key, opts));
  box.appendChild(flags);
  box.appendChild(numberField(state, object, 'renderOrder', opts));
  box.appendChild(vectorField(state, object, 'position', opts));
  box.appendChild(vectorField(state, object, 'scale', opts));
  const actions = el('div', 'lab-row');
  const hide = el('button', '', 'Ocultar');
  hide.type = 'button';
  hide.title = 'Esconde o objeto (visible = false); desfaça pela lista de edições';
  hide.onclick = () => state.edits.set(object, 'visible', false, opts);
  const isolate = el('button', '', 'Isolar');
  isolate.type = 'button';
  isolate.title = 'Esconde tudo o mais na cena (as luzes ficam): o objeto sozinho';
  isolate.onclick = () => isolateObject(state, object);
  const focus = el('button', '', 'Focar a câmera');
  focus.type = 'button';
  focus.title = 'Centra a câmera do jogo no objeto (__roadcraft.lookAt)';
  const game = gameProbe();
  focus.disabled = !game?.lookAt;
  focus.onclick = () => {
    const m4 = instanceMatrix(object, instanceId, batchId) ?? object.matrixWorld;
    const p = toMap(new Vector3().setFromMatrixPosition(m4));
    game?.lookAt?.(p.x, p.y);
    state.ctx.emit('inspector.focus', `câmera em (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`);
  };
  actions.append(hide, isolate, focus);
  box.appendChild(actions);
  return box;
}

/** Everything but the object hidden (each sibling on its way up to the scene), the lights and the inspector's own kept; one undo shows them again. */
export function isolateObject(state: InspectorState, object: Object3D): void {
  const hidden: Object3D[] = [];
  for (let o: Object3D | null = object; o && o.parent; o = o.parent) {
    for (const sibling of o.parent.children) {
      if (sibling === o || !sibling.visible || sibling.userData[INSPECTOR_OWN] || (sibling as { isLight?: boolean }).isLight) continue;
      sibling.visible = false;
      hidden.push(sibling);
    }
  }
  if (!object.visible) { object.visible = true; }
  state.edits.record('object', objectLabel(object), 'isolar', `${hidden.length} objetos ocultos`, () => {
    for (const o of hidden) o.visible = true;
    state.ctx.emit('edit.undo', `isolar ${objectLabel(object)} desfeito`);
  });
}

/** Material fields worth a control, by kind: colours, shares 0-1, other numbers, switches. */
const COLOURS = ['color', 'emissive', 'specular', 'sheenColor', 'attenuationColor'];
const SHARES = ['roughness', 'metalness', 'opacity', 'alphaTest', 'clearcoat', 'clearcoatRoughness', 'transmission', 'sheen', 'reflectivity', 'ior', 'aoMapIntensity'];
const NUMBERS = ['emissiveIntensity', 'envMapIntensity', 'lightMapIntensity', 'bumpScale', 'displacementScale', 'size', 'linewidth', 'polygonOffsetFactor', 'polygonOffsetUnits'];
const SWITCHES = ['visible', 'transparent', 'wireframe', 'depthWrite', 'depthTest', 'flatShading', 'vertexColors', 'fog', 'toneMapped', 'dithering', 'polygonOffset', 'alphaToCoverage', 'colorWrite', 'premultipliedAlpha', 'sizeAttenuation'];
const TEXTURE_SLOTS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap', 'alphaMap', 'bumpMap', 'displacementMap', 'envMap', 'lightMap', 'specularMap', 'clearcoatNormalMap', 'gradientMap', 'matcap'];

export function materialEditor(state: InspectorState, material: Material, textures: readonly TextureInfo[], compiled: Record<string, { value: unknown }> | null): HTMLElement {
  const target = `material ${material.type} "${material.name || '—'}"`;
  const opts: SetOptions = { kind: 'material', target, after: () => { material.needsUpdate = true; } };
  const m = material as unknown as Holder;
  const box = el('div', 'insp-edit');
  const colours = el('div', 'insp-fields');
  for (const key of COLOURS) if ((m[key] as Color | undefined)?.isColor) colours.appendChild(colourField(state, material, key, opts));
  box.appendChild(colours);
  const numbers = el('div', 'insp-fields');
  for (const key of SHARES) if (typeof m[key] === 'number') numbers.appendChild(numberField(state, material, key, opts, key === 'ior' ? [1, 2.333, 0.001] : [0, 1, 0.001]));
  for (const key of NUMBERS) if (typeof m[key] === 'number') numbers.appendChild(numberField(state, material, key, opts, rangeOf(m[key] as number)));
  if (typeof m['side'] === 'number') numbers.appendChild(selectField(state, material, 'side', SIDES, opts));
  box.appendChild(numbers);
  const switches = el('div', 'lab-row');
  for (const key of SWITCHES) if (typeof m[key] === 'boolean') switches.appendChild(check(state, material, key, opts));
  box.appendChild(switches);

  // The texture slots: each on or off (the texture kept to put back), and the textures' own settings.
  const slots = el('div', 'insp-fields');
  for (const slot of TEXTURE_SLOTS) {
    if (!(slot in m)) continue;
    const held = m[slot] as Texture | null;
    const original = textures.find((t) => t.slot === slot)?.texture ?? held;
    if (!original) continue;
    const label = el('label', 'insp-field');
    const input = el('input');
    input.type = 'checkbox';
    input.checked = !!held;
    input.onchange = () => state.edits.set(material, slot, input.checked ? original : null, opts);
    label.append(input, el('span', '', `${slot} (${original.name || original.uuid.slice(0, 8)})`));
    slots.appendChild(label);
  }
  if (slots.childElementCount) box.append(el('div', 'insp-sub', 'Mapas (desligar e religar)'), slots);
  for (const info of textures) box.appendChild(textureEditor(state, info));

  const uniforms = editableUniforms(material, compiled);
  const names = Object.keys(uniforms);
  if (names.length) {
    const list = el('div', 'insp-fields');
    for (const name of names) {
      const u = uniforms[name]!;
      const field = uniformField(state, u, name, { kind: 'uniform', target: `${target} uniform ${name}` });
      if (field) list.appendChild(field);
    }
    box.appendChild(fold(`Uniforms editáveis (${names.length})`, names.length <= 24, list));
  }
  return box;
}

/** One uniform's control by the type of its value; null for what cannot be edited here (a texture, an array). */
function uniformField(state: InspectorState, u: { value: unknown }, name: string, options: SetOptions): HTMLElement | null {
  const v = u.value as { isColor?: boolean; isVector2?: boolean; isVector3?: boolean; isVector4?: boolean; isTexture?: boolean } | number | boolean | null;
  const wrap = (field: HTMLElement): HTMLElement => {
    const n = field.querySelector('.insp-field-name') ?? field.querySelector('span');
    if (n) n.textContent = name;
    return field;
  };
  if (typeof v === 'number') return wrap(numberField(state, u, 'value', options, rangeOf(v)));
  if (typeof v === 'boolean') return wrap(check(state, u, 'value', options));
  if (v && typeof v === 'object' && v.isColor) return wrap(colourField(state, u, 'value', options));
  if (v && typeof v === 'object' && (v.isVector2 || v.isVector3 || v.isVector4)) return wrap(vectorField(state, u, 'value', options));
  const row = el('div', 'insp-field');
  row.append(el('span', 'insp-field-name', name), el('span', 'lab-muted', v && typeof v === 'object' && v.isTexture ? 'textura (veja Texturas)' : Array.isArray(v) ? `array(${v.length})` : String(v)));
  return row;
}

/** A texture's anisotropy and filters, sent again with the texture (`needsUpdate`) where its image is still on the CPU. */
function textureEditor(state: InspectorState, info: TextureInfo): HTMLElement {
  const t = info.texture;
  const target = `textura ${info.slot} "${t.name || t.uuid.slice(0, 8)}"`;
  const opts: SetOptions = { kind: 'texture', target, after: () => { if (info.reuploadable) t.needsUpdate = true; } };
  const box = el('div', 'insp-fields insp-texture');
  box.appendChild(el('div', 'insp-sub', `${info.slot}: ${info.size}${info.reuploadable ? '' : ' (imagem liberada da CPU: filtros não reenviáveis)'}`));
  const max = state.ctx.scene.gl.capabilities.getMaxAnisotropy();
  const aniso = numberField(state, t, 'anisotropy', opts, [1, Math.max(1, max), 1]);
  const filters = [selectField(state, t, 'minFilter', FILTERS, opts), selectField(state, t, 'magFilter', FILTERS, opts)];
  for (const field of [aniso, ...filters]) {
    if (!info.reuploadable) for (const input of field.querySelectorAll('input, select')) (input as HTMLInputElement).disabled = true;
    box.appendChild(field);
  }
  return box;
}

/** The geometry's draw range: how much of it is drawn. */
export function geometryEditor(state: InspectorState, geometry: BufferGeometry): HTMLElement {
  const opts: SetOptions = { kind: 'geometry', target: `geometria "${geometry.name || geometry.uuid.slice(0, 8)}"` };
  const box = el('div', 'insp-fields');
  const total = geometry.index ? geometry.index.count : geometry.getAttribute('position')?.count ?? 0;
  box.appendChild(numberField(state, geometry.drawRange, 'start', opts, [0, Math.max(1, total), 3]));
  const count = Number.isFinite(geometry.drawRange.count) ? geometry.drawRange.count : total;
  const field = numberField(state, geometry.drawRange, 'count', opts, [0, Math.max(1, total), 3]);
  for (const input of field.querySelectorAll('input')) input.value = String(count);
  box.appendChild(field);
  box.appendChild(kv([['vértices/índices', total]]));
  return box;
}
