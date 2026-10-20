import { BufferAttribute, BufferGeometry, type Material, type MeshStandardMaterial } from 'three';

/** A geometry seen from both sides: its faces and a copy of them turned the other way (winding and normals reversed), indexed (DO NOT `toNonIndexed` it first: each instance of a far railing or brise drew each corner once per triangle): its vertices once more with their normals turned, the back faces as indices in the other order. */
export function twoSided(g: BufferGeometry): BufferGeometry {
  const position = g.getAttribute('position'), normal = g.getAttribute('normal');
  const n = position.count;
  const source = g.index;
  const corners = source ? source.count : n;
  const p = new Float32Array(n * 6), q = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const v = position.getComponent(i, c), w = normal.getComponent(i, c);
      p[i * 3 + c] = v; p[(n + i) * 3 + c] = v;
      q[i * 3 + c] = w; q[(n + i) * 3 + c] = -w;
    }
  }
  const index = n * 2 > 0xffff ? new Uint32Array(corners * 2) : new Uint16Array(corners * 2);
  const at = (k: number): number => (source ? source.getX(k) : k);
  for (let k = 0; k + 2 < corners; k += 3) {
    const a = at(k), b = at(k + 1), c = at(k + 2);
    index[k] = a; index[k + 1] = b; index[k + 2] = c;
    // The same triangle seen from behind: its corners in the other order, on the turned copy.
    index[corners + k] = n + a; index[corners + k + 1] = n + c; index[corners + k + 2] = n + b;
  }
  const out = new BufferGeometry();
  out.setAttribute('position', new BufferAttribute(p, 3));
  out.setAttribute('normal', new BufferAttribute(q, 3));
  out.setIndex(new BufferAttribute(index, 1));
  g.dispose();
  return out;
}

/** A part's card (`kit.ts` cards): which pattern its single face draws, per vertex (0 on every other geometry: WebGL's default for a missing attribute). */
export const CARD_ATTRIBUTE = 'partCard';
/** The cards' patterns: a window frame, a roof's railing, a balcony railing's front and its sides. */
export const CARD = { frame: 1, roofRailing: 2, railingFront: 3, railingSide: 4 } as const;

/** GLSL: whether a card's point lies on one of its bars, each at least a pixel wide (`fw`, the coordinate a pixel spans): a bar thinner than a pixel is drawn a pixel wide and its colour mixed by its true share (`thinBar`), so it neither flickers nor brightens the wall. The coordinates are the model's (-0.5..0.5 across, 0..1 up for the railings), as `kit.ts` lays the full models. */
const CARD_GLSL = `
float cardBar(float x, float c, float w, float fw) { return step(abs(x - c), 0.5 * max(w, fw)); }
float cardEvery(float x, float pitch, float w, float fw) { return step(abs(fract(x / pitch + 0.5) - 0.5) * pitch, 0.5 * max(w, fw)); }
bool cardOn(int kind, vec3 p) {
  vec2 q = kind == 4 ? p.zy : p.xy;
  vec2 fw = fwidth(q);
  float on = 0.0;
  if (kind == 1) {
    const float t = 0.045;
    on = max(max(cardBar(q.x, -0.5 + t * 0.5, t, fw.x), cardBar(q.x, 0.5 - t * 0.5, t, fw.x)), max(cardBar(q.y, -0.5 + t * 0.5, t, fw.y), cardBar(q.y, 0.5 - t * 0.5, t, fw.y)));
    on = max(on, max(cardBar(q.x, 0.0, t * 0.8, fw.x), cardBar(q.y, 0.18, t * 0.8, fw.y)));
  } else if (kind == 2) {
    on = max(max(cardBar(q.y, 0.97, 0.06, fw.y), cardBar(q.y, 0.45, 0.04, fw.y)), cardEvery(q.x + 0.5, 0.25, 0.02, fw.x) * step(q.y, 1.0));
  } else {
    on = max(cardBar(q.y, 0.97, 0.06, fw.y), cardBar(q.y, 0.12, 0.04, fw.y));
    on = max(on, cardEvery(kind == 3 ? q.x + 0.5 : q.x, kind == 3 ? 0.1 : 0.25, 0.015, fw.x));
  }
  return on > 0.5;
}`;

/** The thin parts' materials pre-filtered (see below), set once on the kit's materials. */
export function prefilterThinParts<K extends string>(
  material: Readonly<Record<'frame' | 'railing' | 'roofRailing' | K, Material>>,
  /** Further thin parts: the kind, its bar's width (m) and the tone behind it. */
  more: readonly (readonly [K, number, number])[] = [],
): void {
  // Thin parts pre-filtered: a window frame's bar (5 cm) or a baluster
  const list: readonly (readonly [string, number, number])[] = [['frame', 0.05, 0.08], ['railing', 0.02, 0.16], ['roofRailing', 0.02, 0.16], ...more];
  for (const [kind, bar, behind] of list) {
    const thin = material[kind as 'frame'] as MeshStandardMaterial;
    // Its bar and the tone behind as uniforms, the numbers the source once spelled (`toFixed(3)`): DO NOT write them into the source, one program a kind (r186 shares a program between materials of one key, `WebGLRenderer.getProgram`).
    const thinBar = { value: Number(bar.toFixed(3)) }, thinBehind = { value: Number(behind.toFixed(3)) };
    thin.onBeforeCompile = (shader) => {
      shader.uniforms.thinBar = thinBar;
      shader.uniforms.thinBehind = thinBehind;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vThinWorld;\nattribute float ${CARD_ATTRIBUTE};\nvarying float vCard;\nvarying vec3 vCardPoint;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
vCard = ${CARD_ATTRIBUTE};
vCardPoint = position;
#ifdef USE_INSTANCING
  vThinWorld = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
#else
  vThinWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
#endif`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\nvarying vec3 vThinWorld;\nuniform float thinBar;\nuniform float thinBehind;\nvarying float vCard;\nvarying vec3 vCardPoint;\n${CARD_GLSL}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
  // A card: its face drawn on its bars only.
  if (vCard > 0.5 && !cardOn(int(vCard + 0.5), vCardPoint)) discard;
  {
    // Metres a pixel spans here, and the bar's share of it.
    float metresPerPixel = max(length(fwidth(vThinWorld)) * 0.7071, 1e-4);
    float cover = clamp(thinBar / metresPerPixel, 0.0, 1.0);
    diffuseColor.rgb = mix(vec3(thinBehind), diffuseColor.rgb, cover);
  }`);
    };
    thin.customProgramCacheKey = () => 'thin-part-prefiltered-v3-cards';
  }
}
