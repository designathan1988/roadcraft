import {
  MeshDepthMaterial, MeshStandardMaterial, RGBADepthPacking, ShaderChunk, ShaderLib, UniformsUtils,
  type Material, type WebGLProgramParametersWithUniforms, type WebGLRenderer,
} from 'three';
import { SUN_CASCADES } from '@render/sunCascades';

/** HOW MANY TEXTURE UNITS A MATERIAL'S PROGRAM TAKES: ANGLE on D3D11 has 16 a stage, and a morph variant of 18 did not link */
// three r186 hands units out from one counter per program for every active sampler of both stages (`WebGLUniforms` setValueT1, `WebGLTextures.allocateTextureUnit`, reset per `setProgram`), so a vertex-only sampler takes one too.
export const MAX_UNITS = 12;

/** How a draw of the game builds the program: instanced, the sky's PMREM, the sun's cascades casting, and maybe a face's morphs */
export interface Draw { readonly instanceColor: boolean; readonly morph: boolean; readonly instanced?: boolean }

/** three's `#include` resolved from its chunks, as `WebGLProgram` resolveIncludes does */
function resolveIncludes(source: string): string {
  return source.replace(/^[ \t]*#include +<([\w\d./]+)>/gm, (_, name: string) => {
    const chunk = (ShaderChunk as unknown as Record<string, string | undefined>)[name];
    if (chunk === undefined) throw new Error(`no chunk ${name}`);
    return resolveIncludes(chunk);
  });
}

/** A preprocessor `#if` expression's value: `defined`, numbers, macros, comparisons, `!`, `&&`, `||`, + and - */
function evaluate(expression: string, defines: ReadonlyMap<string, string>): number {
  const tokens = expression.match(/[A-Za-z_]\w*|\d+(?:\.\d+)?|&&|\|\||==|!=|>=|<=|[()!<>+-]/g) ?? [];
  let at = 0;
  const unary = (): number => {
    const token = tokens[at++];
    if (token === '(') { const value = or(); at++; return value; }
    if (token === '!') return unary() ? 0 : 1;
    if (token === '-') return -unary();
    if (token === 'defined') {
      const paren = tokens[at] === '(';
      if (paren) at++;
      const name = tokens[at++]!;
      if (paren) at++;
      return defines.has(name) ? 1 : 0;
    }
    if (token !== undefined && /^\d/.test(token)) return Number(token);
    const value = Number(defines.get(token ?? '') ?? 0);
    return Number.isFinite(value) ? value : 0;
  };
  const sum = (): number => {
    let value = unary();
    while (tokens[at] === '+' || tokens[at] === '-') value = tokens[at++] === '+' ? value + unary() : value - unary();
    return value;
  };
  const compare = (): number => {
    let value = sum();
    for (;;) {
      const op = tokens[at];
      if (op !== '==' && op !== '!=' && op !== '<' && op !== '>' && op !== '<=' && op !== '>=') return value;
      at++;
      const right = sum();
      value = Number(op === '==' ? value === right : op === '!=' ? value !== right : op === '<' ? value < right
        : op === '>' ? value > right : op === '<=' ? value <= right : value >= right);
    }
  };
  const and = (): number => {
    let value = compare();
    while (tokens[at] === '&&') { at++; const right = compare(); value = Number(value !== 0 && right !== 0); }
    return value;
  };
  const or = (): number => {
    let value = and();
    while (tokens[at] === '||') { at++; const right = and(); value = Number(value !== 0 || right !== 0); }
    return value;
  };
  return or();
}

/** The lines a GLSL preprocessor keeps of `source` under `defines` (which its own `#define`s add to) */
function preprocess(source: string, defines: Map<string, string>): string {
  const kept: string[] = [];
  const open: { parent: boolean; taken: boolean }[] = [];
  let active = true;
  for (const line of source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').split('\n')) {
    const directive = /^\s*#\s*(\w+)\s*(.*)$/.exec(line);
    if (!directive) { if (active) kept.push(line); continue; }
    const [, name, rest = ''] = directive;
    if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
      const holds = name === 'if' ? evaluate(rest, defines) !== 0 : defines.has(rest.trim().split(/\s+/)[0]!) === (name === 'ifdef');
      open.push({ parent: active, taken: active && holds });
      active = active && holds;
    } else if (name === 'elif') {
      const top = open[open.length - 1]!;
      active = top.parent && !top.taken && evaluate(rest, defines) !== 0;
      if (active) top.taken = true;
    } else if (name === 'else') {
      const top = open[open.length - 1]!;
      active = top.parent && !top.taken;
      top.taken = true;
    } else if (name === 'endif') {
      active = open.pop()!.parent;
    } else if (active && name === 'define') {
      const macro = /^(\w+)(\([^)]*\))?\s*(.*)$/.exec(rest);
      if (macro) defines.set(macro[1]!, macro[2] ? '' : macro[3]!.trim());
      // A function-like macro's body reads what it names wherever it is used (the cascades' `SUN_CASCADE_SHADOW` reads the shadow maps).
      if (macro?.[2]) kept.push(macro[3]!);
    } else if (active && name === 'undef') {
      defines.delete(rest.trim());
    }
  }
  return kept.join('\n');
}

const SAMPLER = /uniform\s+(?:(?:lowp|mediump|highp)\s+)?([iu]?sampler\w+)\s+(\w+)\s*(?:\[([^\]]+)\])?\s*;/g;

/** The texture units a material's program takes in a draw: its active samplers, each array element one */
export function textureUnits(material: Material, draw: Draw): Map<string, number> {
  const depth = (material as MeshDepthMaterial).isMeshDepthMaterial === true;
  const lib = depth ? ShaderLib.depth : ShaderLib.standard;
  const shader = { uniforms: UniformsUtils.clone(lib.uniforms), vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader,
    defines: material.defines ?? {} };
  material.onBeforeCompile(shader as unknown as WebGLProgramParametersWithUniforms, {} as WebGLRenderer);
  // What `WebGLProgram` and `WebGLPrograms` define for such a draw (r186 prefixVertex / prefixFragment, replaceLightNums).
  const base = new Map<string, string>(Object.entries(shader.defines).map(([key, value]) => [key, String(value)]));
  if (draw.instanced !== false) base.set('USE_INSTANCING', '');
  if (draw.instanceColor) { base.set('USE_INSTANCING_COLOR', ''); base.set('USE_COLOR', ''); }
  if ((material as MeshStandardMaterial).vertexColors) base.set('USE_COLOR', '');
  if (draw.morph) {
    base.set('USE_INSTANCING_MORPH', ''); base.set('USE_MORPHTARGETS', '');
    base.set('MORPHTARGETS_COUNT', '24'); base.set('MORPHTARGETS_TEXTURE_STRIDE', '1');
  }
  if ((material as MeshStandardMaterial).map) base.set('USE_MAP', '');
  if (material.alphaTest > 0) base.set('USE_ALPHATEST', '');
  if (depth) base.set('DEPTH_PACKING', String(RGBADepthPacking));
  else {
    base.set('USE_ENVMAP', ''); base.set('ENVMAP_TYPE_CUBE_UV', ''); base.set('ENVMAP_MODE_REFLECTION', '');
    base.set('USE_SHADOWMAP', ''); base.set('SHADOWMAP_TYPE_PCF', '');
    base.set('NUM_DIR_LIGHTS', String(SUN_CASCADES)); base.set('NUM_DIR_LIGHT_SHADOWS', String(SUN_CASCADES));
  }
  base.set('HAS_NORMAL', '');
  const prefix = '#ifdef USE_INSTANCING_MORPH\nuniform sampler2D morphTexture;\n#endif\n';
  const vertex = preprocess(prefix + resolveIncludes(shader.vertexShader), new Map(base));
  const fragment = preprocess(resolveIncludes(shader.fragmentShader), new Map(base));
  const declared = new Map<string, number>();
  for (const code of [vertex, fragment]) {
    for (const match of code.matchAll(SAMPLER)) declared.set(match[2]!, match[3] ? evaluate(match[3], base) : 1);
  }
  // Active: read somewhere besides its declaration (an unread sampler is dropped at link and takes no unit)
  const reads = `${vertex}\n${fragment}`.replace(SAMPLER, '');
  for (const name of [...declared.keys()]) if (!new RegExp(`\\b${name}\\b`).test(reads)) declared.delete(name);
  return declared;
}

export const total = (units: ReadonlyMap<string, number>): number => [...units.values()].reduce((a, b) => a + b, 0);
export const listed = (units: ReadonlyMap<string, number>): string => [...units].map(([name, n]) => (n > 1 ? `${name}[${n}]` : name)).join(' ');
