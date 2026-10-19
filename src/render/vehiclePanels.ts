import { BufferAttribute, BufferGeometry, type InstancedBufferAttribute, type MeshPhysicalMaterial, type TypedArray } from 'three';

/** A VEHICLE'S BODY AND ITS SECOND PANEL IN ONE DRAW (`agents.ts` drawCar): the shell and the roof (or a truck's box, its accent) are always drawn
 *  together, with the same instance matrix, in the same paint; only the panel's colour may differ (a black roof, the box's own colour). One mesh
 *  holds both, the panel's vertices marked (`panel` 1) and coloured by a second per-instance colour (`panelColor`).
 *  The vertices are the parts' own numbers, in the parts' own order, and the colour is picked, not mixed: every vertex is transformed and shaded
 *  exactly as it was in its own draw. */

/** The vertices and index of a body and panel joined: shared by every geometry drawn from them (`panelGeometry`). */
export interface JoinedPanels {
  readonly attributes: ReadonlyMap<string, BufferAttribute>;
  readonly index: BufferAttribute;
}

/** The attributes a body and its panel carry (`vehicleModels.ts`, `vehicleLevels.ts`): both must have the same ones to be joined. */
const NAMES = ['position', 'color', 'normal'] as const;

/** The parts' attribute `name` end to end, and the panel mark; undefined when neither has it, null when they cannot be joined. */
function joinAttribute(parts: readonly BufferGeometry[], name: string): BufferAttribute | null | undefined {
  const all = parts.map((g) => g.getAttribute(name) as BufferAttribute | undefined);
  if (all.every((a) => !a)) return undefined;
  const first = all[0];
  if (!first || !(first instanceof BufferAttribute)) return null;
  for (const a of all) {
    if (!a || !(a instanceof BufferAttribute) || a.itemSize !== first.itemSize || a.normalized !== first.normalized
      || a.array.constructor !== first.array.constructor) return null;
  }
  const size = all.reduce((n, a) => n + a!.count * a!.itemSize, 0);
  const array = new (first.array.constructor as new (n: number) => TypedArray)(size);
  let at = 0;
  for (const a of all) {
    const length = a!.count * a!.itemSize;
    array.set(a!.array.subarray(0, length), at);
    at += length;
  }
  return new BufferAttribute(array, first.itemSize, first.normalized);
}

/** A geometry's triangles as indices (its own, or 0..n-1 for one drawn unindexed), offset by `base`, into `out` at `at`. */
function indicesInto(geometry: BufferGeometry, base: number, out: Uint32Array, at: number): number {
  const index = geometry.getIndex();
  if (index) {
    for (let i = 0; i < index.count; i++) out[at + i] = index.getX(i) + base;
    return at + index.count;
  }
  const count = geometry.getAttribute('position').count;
  for (let i = 0; i < count; i++) out[at + i] = i + base;
  return at + count;
}


/** Joins bodies and panels, each pair once: the levels of a part share their vertices (`vehicleLevels.ts` shared), so do the joined ones. */
export function createPanelJoiner(): (body: BufferGeometry | null, panel: BufferGeometry | null) => JoinedPanels | null {
  const joinedVertices = new WeakMap<BufferAttribute, WeakMap<BufferAttribute, ReadonlyMap<string, BufferAttribute> | null>>();
  const joinedParts = new WeakMap<BufferGeometry, WeakMap<BufferGeometry, JoinedPanels | null>>();

  /** The body's vertices, then the panel's, end to end, and `panel` marking the panel's. */
  const verticesOf = (body: BufferGeometry, panel: BufferGeometry | null): ReadonlyMap<string, BufferAttribute> | null => {
    const parts = panel ? [body, panel] : [body];
    const key = body.getAttribute('position') as BufferAttribute;
    // A body alone is keyed by its own positions twice: no panel of it is that.
    const second = (panel?.getAttribute('position') as BufferAttribute | undefined) ?? key;
    let byPanel = joinedVertices.get(key);
    if (!byPanel) joinedVertices.set(key, (byPanel = new WeakMap()));
    const cached = byPanel.get(second);
    if (cached !== undefined) return cached;
    const attributes = new Map<string, BufferAttribute>();
    let joinable = true;
    for (const name of NAMES) {
      const joined = joinAttribute(parts, name);
      if (joined === null) { joinable = false; break; }
      if (joined) attributes.set(name, joined);
    }
    if (joinable) {
      const bodyCount = key.count, mark = new Float32Array(bodyCount + (panel ? second.count : 0));
      mark.fill(1, bodyCount);
      attributes.set('panel', new BufferAttribute(mark, 1));
    }
    const made = joinable && attributes.has('position') ? attributes : null;
    byPanel.set(second, made);
    return made;
  };

  /** `body` and `panel` (either may be null: nothing of it at that level) as one set of vertices and one index, the body's triangles first;
   *  null when there is nothing, or when their attributes differ (the parts are then drawn apart). The same pair gives the same object. */
  return (body, panel) => {
    const first = body ?? panel;
    if (!first) return null;
    const second = body ? panel : null;
    let byPanel = joinedParts.get(first);
    if (!byPanel) joinedParts.set(first, (byPanel = new WeakMap()));
    const cacheKey = second ?? first;
    const cached = byPanel.get(cacheKey);
    if (cached !== undefined) return cached;
    let made: JoinedPanels | null = null;
    const attributes = verticesOf(first, second);
    if (attributes) {
      const triangles = (g: BufferGeometry): number => g.getIndex()?.count ?? g.getAttribute('position').count;
      const index = new Uint32Array(triangles(first) + (second ? triangles(second) : 0));
      const at = indicesInto(first, 0, index, 0);
      if (second) indicesInto(second, first.getAttribute('position').count, index, at);
      // The panel alone (no body left at that level): every vertex of it is the panel's.
      if (!body) {
        const own = new Map(attributes);
        own.set('panel', new BufferAttribute(new Float32Array(first.getAttribute('position').count).fill(1), 1));
        made = { attributes: own, index: new BufferAttribute(index, 1) };
      } else made = { attributes, index: new BufferAttribute(index, 1) };
    }
    byPanel.set(cacheKey, made);
    return made;
  };
}

/** A geometry of its own over joined vertices (they are shared), with this mesh's panel colours (an instanced attribute is a mesh's own). */
export function panelGeometry(joined: JoinedPanels, panelColor: InstancedBufferAttribute): BufferGeometry {
  const geometry = new BufferGeometry();
  for (const [name, attribute] of joined.attributes) geometry.setAttribute(name, attribute);
  geometry.setIndex(joined.index);
  geometry.setAttribute('panelColor', panelColor);
  return geometry;
}

/** The body paint, its panel's vertices coloured by the instance's `panelColor` instead of `instanceColor`: the same material in every other number. */
export function panelPaint(paint: MeshPhysicalMaterial): MeshPhysicalMaterial {
  const material = paint.clone();
  material.name = 'vehicle-panel-paint';
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float panel;\nattribute vec3 panelColor;')
      // three's color_vertex for vertex colours and instance colours, the instance's colour picked by the mark
      .replace('#include <color_vertex>', [
        'vColor = vec4( 1.0 );',
        'vColor.rgb *= color;',
        'vColor.rgb *= panel > 0.5 ? panelColor : instanceColor.rgb;',
      ].join('\n'));
  };
  material.customProgramCacheKey = () => 'vehicle-panel-paint';
  return material;
}
