import { BufferAttribute, BufferGeometry, type Material, type MeshStandardMaterial } from 'three';

/**
 * A geometry seen from both sides: its faces and a copy of them turned the
 * other way (winding and normals reversed). A railing is looked at from
 * behind across its own roof or balcony; its far version as faces to the
 * street only vanished there - the back of a terrace's railing was missing
 * (the player, 2026-10-13, "a grade não é mostrada na face de trás").
 */
export function twoSided(g: BufferGeometry): BufferGeometry {
  const flat = g.index ? g.toNonIndexed() : g;
  const position = flat.getAttribute('position'), normal = flat.getAttribute('normal');
  const n = position.count;
  const p = new Float32Array(n * 6), q = new Float32Array(n * 6);
  p.set(position.array as Float32Array);
  q.set(normal.array as Float32Array);
  for (let t = 0; t < n; t += 3) {
    // Each triangle again, its corners in the other order, its normal turned round.
    for (let k = 0; k < 3; k++) {
      const from = t + (k === 0 ? 0 : 3 - k), to = n + t + k;
      for (let c = 0; c < 3; c++) {
        p[to * 3 + c] = position.getComponent(from, c);
        q[to * 3 + c] = -normal.getComponent(from, c);
      }
    }
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(p, 3));
  out.setAttribute('normal', new BufferAttribute(q, 3));
  if (flat !== g) flat.dispose();
  g.dispose();
  return out;
}

/**
 * The thin parts' materials pre-filtered (see below), set once on the kit's
 * materials.
 */
export function prefilterThinParts<K extends string>(
  material: Readonly<Record<'frame' | 'railing' | 'roofRailing' | K, Material>>,
  /** Further thin parts: the kind, its bar's width (m) and the tone behind it. */
  more: readonly (readonly [K, number, number])[] = [],
): void {
  // Thin parts pre-filtered: a window frame's bar (5 cm) or a baluster
  // (2 cm) under a pixel wide is hit by some pixels and missed by the next,
  // and the skyline crawled with white dots in every move (the player,
  // 2026-10-13: "serrilhado", "embaçado"). Each fragment of it takes the
  // colour of what its pixel covers - the bar over the dark of the window
  // behind - in proportion to the bar's share of the pixel, as the relief is
  // faded out of the finishes (Toksvig, "Mipmapping Normal Maps"; the same
  // pre-filtering as `finishes.ts`). Full colour once the bar spans a pixel.
  const list: readonly (readonly [string, number, number])[] = [['frame', 0.05, 0.08], ['railing', 0.02, 0.16], ['roofRailing', 0.02, 0.16], ...more];
  for (const [kind, bar, behind] of list) {
    const thin = material[kind as 'frame'] as MeshStandardMaterial;
    thin.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vThinWorld;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  vThinWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vThinWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vThinWorld;')
        .replace('#include <color_fragment>', `#include <color_fragment>
  {
    // Metres a pixel spans here, and the bar's share of it.
    float metresPerPixel = max(length(fwidth(vThinWorld)) * 0.7071, 1e-4);
    float cover = clamp(${bar.toFixed(3)} / metresPerPixel, 0.0, 1.0);
    diffuseColor.rgb = mix(vec3(${behind.toFixed(3)}), diffuseColor.rgb, cover);
  }`);
    };
    thin.customProgramCacheKey = () => `thin-part-prefiltered-v1-${kind}`;
  }
}
