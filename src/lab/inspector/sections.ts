import type { BufferGeometry, Material, Object3D } from 'three';
import { createLabTable } from '../table';
import { bytes, el, fold, heading, kv, num, valueTree } from './dom';
import {
  attributeRows, decomposed, geometrySummary, instanceMatrix, layerOf, materialProps, materialsOf, ownCompile, pathOf, programOf, texturesOf, trianglesUnder,
} from './describe';
import { geometryEditor, materialEditor, objectEditor } from './edit';
import { shaderPosed, testable } from './raycast';
import type { Hit, InspectorState, Selection } from './state';

/** THE INSPETOR'S 3D SECTIONS: the object (its path, flags, matrices, instance, the other objects under the cursor), its geometry and its materials - each with its live edits (`edit.ts`). */

/** The selection moved to another object (an ancestor, another hit), the game's entity kept. */
export function reselect(state: InspectorState, base: Selection, object: Object3D, hit?: Hit): void {
  state.select({
    ...base, object, instanceId: hit?.instanceId ?? null, batchId: hit?.batchId ?? null, point: hit?.point ?? base.point, exact: hit?.exact ?? false,
  });
}

export function objectSection(state: InspectorState, s: Selection, object: Object3D): HTMLElement {
  const box = el('div');
  box.appendChild(heading('Objeto 3D', 'boxes'));
  // The path: each ancestor a link that selects it.
  const path = el('div', 'insp-path');
  const chain: Object3D[] = [];
  for (let o: Object3D | null = object; o; o = o.parent) chain.unshift(o);
  chain.forEach((o, i) => {
    if (i) path.appendChild(el('span', 'lab-muted', ' › '));
    const a = el('button', 'insp-link', o.parent ? o.name || o.type : 'Scene');
    a.type = 'button';
    a.title = `${o.type} "${o.name}": selecionar`;
    a.onclick = () => reselect(state, s, o);
    path.appendChild(a);
  });
  box.appendChild(path);
  const layer = layerOf(object);
  const mesh = object as { isInstancedMesh?: boolean; isBatchedMesh?: boolean; count?: number; instanceCount?: number; maxInstanceCount?: number; isSkinnedMesh?: boolean };
  box.appendChild(kv([
    ['tipo', object.type], ['nome', object.name || '—'], ['uuid', object.uuid], ['id', object.id], ['camada (grupo do topo)', layer ? `${layer.type} "${layer.name}"` : '—'],
    ['visível', object.visible], ['sombra: projeta / recebe', `${object.castShadow} / ${object.receiveShadow}`], ['frustumCulled', object.frustumCulled], ['renderOrder', object.renderOrder],
    ['layers (máscara)', object.layers.mask], ['filhos', object.children.length], ['triângulos (subárvore)', trianglesUnder(object)],
    ['instâncias', mesh.isInstancedMesh ? mesh.count : mesh.isBatchedMesh ? `${mesh.instanceCount} de ${mesh.maxInstanceCount}` : null],
    ['escolhido por', s.object === object ? (s.exact ? 'triângulos (raycast do three)' : 'caixa (sem arrays na CPU ou posado no shader)') : 'árvore da cena'],
    ['raycast possível', testable(object) ? 'sim' : 'não: arrays liberados para a GPU (gpuOnly)'], ['posado no shader', shaderPosed(object) ? 'sim (onBeforeCompile, ShaderMaterial ou esqueleto)' : 'não'],
    ['userData', Object.keys(object.userData).length ? valueTree(object.userData) : null],
  ]));
  const local = decomposed(object.matrix);
  const world = decomposed(object.matrixWorld);
  const inst = s.object === object ? instanceMatrix(object, s.instanceId, s.batchId) : null;
  const rows: [string, string | null][] = [
    ['local: posição', local.position], ['local: rotação', local.rotation], ['local: escala', local.scale],
    ['mundo: posição', world.position], ['mundo: rotação', world.rotation], ['mundo: escala', world.scale],
  ];
  if (inst) { const d = decomposed(inst); rows.push([`instância ${s.instanceId ?? s.batchId}: posição`, d.position], ['instância: rotação', d.rotation], ['instância: escala', d.scale]); }
  if (s.object === object && s.point) rows.push(['ponto atingido (three)', `${s.point.x.toFixed(3)}, ${s.point.y.toFixed(3)}, ${s.point.z.toFixed(3)}`]);
  const sphere = (object as { boundingSphere?: { center: { x: number; y: number; z: number }; radius: number } | null }).boundingSphere;
  if (sphere) rows.push(['esfera limite (instâncias)', `centro ${sphere.center.x.toFixed(2)}, ${sphere.center.y.toFixed(2)}, ${sphere.center.z.toFixed(2)} · raio ${sphere.radius.toFixed(2)}`]);
  box.appendChild(fold('Matrizes e limites', false, kv(rows), el('pre', 'lab-code', `matrixWorld\n${object.matrixWorld.elements.map((v) => v.toFixed(3)).join(' ')}`)));
  if (s.object === object && (s.instanceId !== null || s.batchId !== null)) box.appendChild(instanceBlock(object, s.instanceId, s.batchId));
  box.appendChild(fold('Editar o objeto', true, objectEditor(state, object, s.object === object ? s.instanceId : null, s.object === object ? s.batchId : null)));
  if (s.hits.length > 1) box.appendChild(hitsBlock(state, s));
  return box;
}

/** One instance's own data: its colour, its batch's geometry. */
function instanceBlock(object: Object3D, instanceId: number | null, batchId: number | null): HTMLElement {
  const rows: [string, string | number | boolean | null][] = [];
  const inst = object as unknown as { isInstancedMesh?: boolean; instanceColor?: { getX(i: number): number; getY(i: number): number; getZ(i: number): number; array: ArrayLike<number> | null } | null; count: number };
  if (inst.isInstancedMesh && instanceId !== null) {
    rows.push(['instância', `${instanceId} de ${inst.count}`]);
    if (inst.instanceColor?.array) rows.push(['cor da instância', `${inst.instanceColor.getX(instanceId).toFixed(3)}, ${inst.instanceColor.getY(instanceId).toFixed(3)}, ${inst.instanceColor.getZ(instanceId).toFixed(3)}`]);
  }
  const batched = object as unknown as { isBatchedMesh?: boolean; getGeometryIdAt(i: number): number; getGeometryRangeAt(g: number): { vertexStart: number; vertexCount: number; indexStart: number; indexCount: number }; getVisibleAt(i: number): boolean };
  if (batched.isBatchedMesh && batchId !== null) {
    try {
      const g = batched.getGeometryIdAt(batchId);
      const range = batched.getGeometryRangeAt(g);
      rows.push(['item do lote', batchId], ['geometria do lote', g], ['visível', batched.getVisibleAt(batchId)], ['vértices', `${range.vertexStart} + ${range.vertexCount}`], ['índices', `${range.indexStart} + ${range.indexCount}`]);
    } catch (error) {
      console.warn('lab inspector: batch info failed', error);
    }
  }
  return fold('Instância', true, kv(rows));
}

/** Every object the ray met, nearest first: a click selects it. */
function hitsBlock(state: InspectorState, s: Selection): HTMLElement {
  const table = createLabTable<Hit>({
    columns: [
      { key: 'd', label: 'Distância', value: (h) => h.distance },
      { key: 'type', label: 'Tipo', value: (h) => h.object.type },
      { key: 'name', label: 'Nome', value: (h) => h.object.name || '—' },
      { key: 'inst', label: 'Instância', value: (h) => h.instanceId ?? h.batchId ?? null },
      { key: 'how', label: 'Por', value: (h) => (h.exact ? 'triângulos' : 'caixa') },
      { key: 'path', label: 'Caminho', value: (h) => pathOf(h.object) },
    ],
    rows: () => s.hits,
    sort: { key: 'd', desc: false },
    onRow: (h) => reselect(state, s, h.object, h),
    limit: 200,
  });
  table.refresh();
  return fold(`Sob o cursor (${s.hits.length})`, false, table.element);
}

export function geometrySection(state: InspectorState, geometry: BufferGeometry): HTMLElement {
  const box = el('div');
  box.appendChild(heading('Geometria', 'boxes'));
  const summary = geometrySummary(geometry);
  box.appendChild(kv(Object.entries(summary).map(([k, v]) => [k, k === 'bytes' ? bytes(v as number) : (v as string | number)])));
  const table = createLabTable({
    columns: [
      { key: 'name', label: 'Atributo', value: (r: ReturnType<typeof attributeRows>[number]) => r.name },
      { key: 'item', label: 'itemSize', value: (r) => r.itemSize },
      { key: 'count', label: 'count', value: (r) => r.count },
      { key: 'type', label: 'Array', value: (r) => r.type },
      { key: 'norm', label: 'Normalizado', value: (r) => (r.normalized ? 'sim' : 'não') },
      { key: 'bytes', label: 'Bytes', value: (r) => r.bytes, format: (v) => bytes(v), bar: true },
      { key: 'cpu', label: 'Na CPU', value: (r) => (r.onCpu ? 'sim' : 'liberado') },
      { key: 'inter', label: 'Intercalado', value: (r) => (r.interleaved ? 'sim' : 'não') },
    ],
    rows: () => attributeRows(geometry),
    sort: { key: 'bytes', desc: true },
  });
  table.refresh();
  box.appendChild(table.element);
  box.appendChild(fold('Editar: faixa desenhada (drawRange)', false, geometryEditor(state, geometry)));
  return box;
}

export function materialsSection(state: InspectorState, object: Object3D): HTMLElement {
  const box = el('div');
  const list = materialsOf(object);
  box.appendChild(heading(list.length > 1 ? `Materiais (${list.length})` : 'Material', 'sliders'));
  list.forEach((material, i) => box.appendChild(materialBlock(state, material, list.length > 1 ? i : null)));
  return box;
}

function materialBlock(state: InspectorState, material: Material, index: number | null): HTMLElement {
  const program = programOf(state.ctx.scene.gl, material);
  const textures = texturesOf(material, program?.uniforms ?? null);
  const card = el('div', 'lab-card');
  card.appendChild(el('strong', '', `${index !== null ? `[${index}] ` : ''}${material.type} "${material.name || '—'}"`));
  const defines = (material as { defines?: Record<string, unknown> }).defines;
  card.appendChild(kv([
    ['uuid', material.uuid], ['versão', material.version], ['onBeforeCompile próprio', ownCompile(material) ? 'sim (shader editado ao compilar)' : 'não'],
    ['customProgramCacheKey', ownCompile(material) || material.customProgramCacheKey !== Object.getPrototypeOf(material).customProgramCacheKey ? safeKey(material) : '—'],
    ['defines', defines && Object.keys(defines).length ? Object.entries(defines).map(([k, v]) => `${k}=${String(v)}`).join(' ') : '—'],
    ['programa', program ? `${program.name} #${program.id} (usado por ${program.usedTimes}, ${program.variants} variante(s))` : 'ainda não compilado'],
  ]));
  if (program?.cacheKey) card.appendChild(fold('Chave do programa (cacheKey)', false, el('pre', 'lab-code insp-wrap', program.cacheKey)));
  card.appendChild(fold('Editar o material', true, materialEditor(state, material, textures, program?.uniforms ?? null)));
  if (textures.length) {
    const table = createLabTable({
      columns: [
        { key: 'slot', label: 'Onde', value: (t: (typeof textures)[number]) => t.slot },
        { key: 'name', label: 'Nome', value: (t) => String(t.rows['nome']) },
        { key: 'kind', label: 'Tipo', value: (t) => String(t.rows['tipo']) },
        { key: 'size', label: 'Tamanho', value: (t) => t.size },
        { key: 'format', label: 'Formato', value: (t) => `${String(t.rows['formato'])} ${String(t.rows['tipoDeDado'])}` },
        { key: 'aniso', label: 'Aniso', value: (t) => t.texture.anisotropy },
        { key: 'min', label: 'min/mag', value: (t) => `${String(t.rows['minFilter'])} / ${String(t.rows['magFilter'])}` },
        { key: 'mips', label: 'Mips', value: (t) => Number(t.rows['mipmaps']) },
        { key: 'bytes', label: 'GPU', value: (t) => Number(t.rows['bytesGpu']), format: (v) => bytes(v), bar: true },
      ],
      rows: () => textures,
      sort: { key: 'bytes', desc: true },
    });
    table.refresh();
    card.appendChild(fold(`Texturas (${textures.length})`, true, table.element, ...textures.map((t) => fold(`${t.slot}: todos os campos`, false, kv(Object.entries(t.rows).map(([k, v]) => [k, k === 'bytesGpu' ? bytes(v as number) : v as string]))))));
  }
  const props = el('div');
  for (const [k, v] of materialProps(material)) props.appendChild(valueTree(v, k));
  card.appendChild(fold('Todas as propriedades', false, props));
  if (program?.uniforms) {
    const uniforms = el('div');
    for (const [k, u] of Object.entries(program.uniforms)) uniforms.appendChild(valueTree(u?.value, k));
    card.appendChild(fold(`Uniforms com que foi compilado (${Object.keys(program.uniforms).length})`, false, uniforms));
  }
  return card;
}

const safeKey = (material: Material): string => {
  try {
    return material.customProgramCacheKey();
  } catch (error) {
    console.warn('lab inspector: cache key failed', error);
    return String(error);
  }
};

/** A short line for lists: type, name, triangles. */
export const objectLine = (o: Object3D): string => `${o.type} "${o.name || '—'}" · ${num(trianglesUnder(o))} tri`;
