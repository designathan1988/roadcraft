import { m } from '@world/units';
import type { PartKind } from './chunk';

/** THE SHELL'S PARTS: THE LOTS' AND ELEMENTS' BOXES, DRAWN INSTANCED WITH THE SHELL'S OWN LOOK */
// A gate's bars, a fence's posts and rails, a bin, a crate: a box each, once laid in the shell face by face (24 vertices,
// ~1 KB), now one instance of a unit model (88 bytes) drawn by the shell's material (`finishes.ts`), which lays on it what
// the shell laid on each vertex (`buildingMesh.ts` `Shell.face`): the planar uv of its finish, the tone and the grime.

/** The kinds drawn by the shell's material: a box (sides and top), a fence's rail (sides, top and bottom), a paving (a box whose sides stand in). */
export type ShellPartKind = 'lotBox' | 'lotRail' | 'lotSlab';
export const SHELL_PART_KINDS: readonly ShellPartKind[] = Object.freeze(['lotBox', 'lotRail', 'lotSlab']);
export const SHELL_PARTS: ReadonlySet<PartKind> = Object.freeze(new Set<PartKind>(SHELL_PART_KINDS));

/** Numbers an instance of a shell part carries besides its matrix and colour: its finish id, its wear and the ground its walls darken towards. */
export const LOOK_FLOATS = 3;

/** The screen error of a shell part's top-only level, model units, from an instance's scales [x, y, z] at `o`: the smaller side of the largest face its sides lose. A wall (long, tall, thin) leaves out its wall face, so its height; a post (thin across) leaves out a face no wider than the post, so its width. DO NOT use the height alone: a fence's posts are a metre tall and a tenth wide, and stayed at ten triangles each for a face a fraction of a pixel across. */
export function shellPartError(scale: ArrayLike<number>, o: number): number {
  const sx = scale[o]!, sy = scale[o + 1]!, sz = scale[o + 2]!;
  return 0.5 * Math.min(sy, Math.max(sx, sz));
}
/** The attribute of the ground a shell part's walls darken towards (`GRIME_REACH`), per instance. */
export const GROUND_ATTRIBUTE = 'shellGround';
/** A ground so far down no wall darkens: what a part of a building with no ground floor takes (`Shell.ground` NaN). */
export const NO_GROUND = -1e30;

/** World units over which a facade's tone drifts. */
export const MACRO_SCALE = m(12);
/** How far above the ground floor a wall's weathering at the base reaches. */
export const GRIME_REACH = m(1.2);
/** How far a paving's sides stand in from its top's edge (`Emitter.slab`): a wall or a gate on that edge keeps the face there. */
export const COVER_INSET = m(0.006);

/** The lattice value of `macroNoiseInto` from a corner's three terms (`Math.imul(i | 0, 0x27d4eb2d)`, the j's and the k's), 0..1: integers in, so no number is boxed out of a call for it. */
function lattice(ti: number, tj: number, tk: number): number {
  let h = ti ^ tj ^ tk;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return ((h ^ (h >>> 13)) >>> 0) / 4_294_967_296;
}

/** Smooth 3D value noise, 0..1, for tone that drifts over a whole facade: the point read from `io[0..2]`, the noise written in `io[3]`. */
/** DO NOT pass the point as numbers or return the noise: a double into or out of a call not inlined is boxed (three a vertex of every shell). */
/** DO NOT hash each of a cell's eight corners from its coordinates: each axis's two terms once (the same integers as each corner hashed alone, the xor in any order the same). */
export function macroNoiseInto(io: Float64Array): void {
  const x = io[0]!, y = io[1]!, z = io[2]!;
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  let fx = x - x0, fy = y - y0, fz = z - z0;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const i0 = Math.imul(x0 | 0, 0x27d4eb2d), i1 = Math.imul((x0 + 1) | 0, 0x27d4eb2d);
  const j0 = Math.imul(y0 | 0, 0x165667b1), j1 = Math.imul((y0 + 1) | 0, 0x165667b1);
  const k0 = Math.imul(z0 | 0, 0x3c6ef372), k1 = Math.imul((z0 + 1) | 0, 0x3c6ef372);
  const p0a = lattice(i0, j0, k0), p0b = lattice(i1, j0, k0), p0c = lattice(i0, j1, k0), p0d = lattice(i1, j1, k0);
  const p1a = lattice(i0, j0, k1), p1b = lattice(i1, j0, k1), p1c = lattice(i0, j1, k1), p1d = lattice(i1, j1, k1);
  const ab0 = p0a + (p0b - p0a) * fx, cd0 = p0c + (p0d - p0c) * fx;
  const ab1 = p1a + (p1b - p1a) * fx, cd1 = p1c + (p1d - p1c) * fx;
  const plane0 = ab0 + (cd0 - ab0) * fy, plane1 = ab1 + (cd1 - ab1) * fy;
  io[3] = plane0 + (plane1 - plane0) * fz;
}

/** A shell vertex's planar uv, metres along its face and up it, from its place and its face's normal in three's axes (x, y up, -z north): `SHELL_UV_GLSL` to the formula, as `Shell.face` once laid it. */
export function shellUv(px: number, py: number, pz: number, nx: number, ny: number, nz: number): [number, number] {
  // The map's axes: x, y north, z up.
  const x = px, y = -pz, z = py;
  const length = Math.hypot(nx, ny, nz) || 1;
  const wx = nx / length, wy = -nz / length, wz = ny / length;
  const flat = Math.hypot(wx, wy);
  const tx = flat > 1e-6 ? -wy / flat : 1;
  const ty = flat > 1e-6 ? wx / flat : 0;
  // n x t: straight up on a wall, up the slope on a roof, +y on a flat.
  const bx = -wz * ty, by = wz * tx, bz = wx * ty - wy * tx;
  return [x * tx + y * ty, x * bx + y * by + z * bz];
}

/** GLSL: `shellUv`, from the vertex in the world and its normal there (three's axes). */
export const SHELL_UV_GLSL = `
vec2 shellPlanarUv(vec3 at, vec3 facing) {
  vec3 p = vec3(at.x, -at.z, at.y);
  vec3 n = vec3(facing.x, -facing.z, facing.y);
  float across = length(n.xy);
  vec2 t = across > 1e-6 ? vec2(-n.y, n.x) / across : vec2(1.0, 0.0);
  vec3 b = vec3(-n.z * t.y, n.z * t.x, n.x * t.y - n.y * t.x);
  return vec2(dot(p.xy, t), dot(p, b));
}`;

/** A point of a shell part's model in its own plan: along (u, the building's x), across (v, its y) and up (w), each -0.5..0.5. */
type Unit = readonly [number, number, number];

/** A face of a shell part's model, as `Emitter.box` (or `emitFence`) laid it: its corners in order and its normal; `inset`: a paving's side (`COVER_INSET`). */
export interface ShellPartFace {
  readonly points: readonly Unit[];
  readonly n: Unit;
  readonly inset: boolean;
}

const H = 0.5;
/** `Emitter.box`'s faces from (-0.5, -0.5, -0.5) to (0.5, 0.5, 0.5), in its order: the four sides, then the top (the bottom is never seen). */
const BOX: readonly Omit<ShellPartFace, 'inset'>[] = [
  { points: [[-H, -H, -H], [H, -H, -H], [H, -H, H], [-H, -H, H]], n: [0, -1, 0] },
  { points: [[H, H, -H], [-H, H, -H], [-H, H, H], [H, H, H]], n: [0, 1, 0] },
  { points: [[H, -H, -H], [H, H, -H], [H, H, H], [H, -H, H]], n: [1, 0, 0] },
  { points: [[-H, H, -H], [-H, -H, -H], [-H, -H, H], [-H, H, H]], n: [-1, 0, 0] },
  { points: [[-H, -H, H], [H, -H, H], [H, H, H], [-H, H, H]], n: [0, 0, 1] },
];

/** Each shell part's model, face by face: the box; the rail of `emitFence` (its two sides, top and bottom, along u, no ends); the paving of `Emitter.slab`. */
export const SHELL_PART_FACES: Readonly<Record<ShellPartKind, readonly ShellPartFace[]>> = Object.freeze({
  lotBox: BOX.map((f) => ({ ...f, inset: false })),
  lotRail: [
    { points: [[-H, -H, -H], [H, -H, -H], [H, -H, H], [-H, -H, H]], n: [0, -1, 0], inset: false },
    { points: [[H, H, -H], [-H, H, -H], [-H, H, H], [H, H, H]], n: [0, 1, 0], inset: false },
    { points: [[-H, -H, H], [H, -H, H], [H, H, H], [-H, H, H]], n: [0, 0, 1], inset: false },
    { points: [[-H, H, -H], [H, H, -H], [H, -H, -H], [-H, -H, -H]], n: [0, 0, -1], inset: false },
  ],
  lotSlab: BOX.map((f) => ({ ...f, inset: f.n[2] === 0 })),
});

/** A number as a GLSL float literal. */
const glsl = (x: number): string => x.toFixed(6);

/** GLSL of the shell's vertex shader drawn instanced (`finishes.ts`): `macroNoiseInto` to the bit (Math.imul is a uint product, >>> a uint shift). */
export const SHELL_PART_PARS = `
#ifdef USE_INSTANCING
attribute float ${GROUND_ATTRIBUTE};
// An int's two's complement bits as a uint, without converting a negative int (whose conversion GLSL ES leaves to the driver).
uint shellBits(int i) { return i >= 0 ? uint(i) : uint(i + 2147483647) + 2147483649u; }
float shellNoiseHash(ivec3 c) {
  uint h = (shellBits(c.x) * 0x27d4eb2du) ^ (shellBits(c.y) * 0x165667b1u) ^ (shellBits(c.z) * 0x3c6ef372u);
  h = (h ^ (h >> 15u)) * 0x85ebca6bu;
  return float(h ^ (h >> 13u)) / 4294967296.0;
}
float shellMacroNoise(vec3 p) {
  vec3 c = floor(p);
  vec3 f = p - c;
  f = f * f * (3.0 - 2.0 * f);
  ivec3 i = ivec3(c);
  float p0a = shellNoiseHash(i), p0b = shellNoiseHash(i + ivec3(1, 0, 0)), p0c = shellNoiseHash(i + ivec3(0, 1, 0)), p0d = shellNoiseHash(i + ivec3(1, 1, 0));
  float p1a = shellNoiseHash(i + ivec3(0, 0, 1)), p1b = shellNoiseHash(i + ivec3(1, 0, 1)), p1c = shellNoiseHash(i + ivec3(0, 1, 1)), p1d = shellNoiseHash(i + ivec3(1, 1, 1));
  float ab0 = p0a + (p0b - p0a) * f.x, cd0 = p0c + (p0d - p0c) * f.x;
  float ab1 = p1a + (p1b - p1a) * f.x, cd1 = p1c + (p1d - p1c) * f.x;
  float plane0 = ab0 + (cd0 - ab0) * f.y, plane1 = ab1 + (cd1 - ab1) * f.y;
  return plane0 + (plane1 - plane0) * f.z;
}
#endif`;

/** GLSL after `begin_vertex`: a paving's sides stand `COVER_INSET` in from its top's edge whatever its size (its model's uv.x marks them). */
export const SHELL_PART_BEGIN = `
#ifdef USE_INSTANCING
if (uv.x > 0.5) {
  vec2 shellSize = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[2].xyz));
  transformed.xz = sign(transformed.xz) * max(vec2(0.5) - ${glsl(COVER_INSET)} / shellSize, vec2(0.0));
}
#endif`;

/** GLSL after `worldpos_vertex`: what `Shell.face` lays on each vertex, from the vertex in the world: the finish's planar uv (along the face, up it), the tone, the grime at a wall's foot; `rows`: a finish's rows in the look table (`finishes.ts`). */
export const shellPartVertex = (rows: number): string => `
#ifdef USE_INSTANCING
{
  vec3 shellAt = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
  vec3 shellOut = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
  vShellUv = shellPlanarUv(shellAt, shellOut) * shellLooks[vShellFinish * ${rows}].x;
  // The map's axes: x, y north, z up (three's x, -z, y).
  vec3 p = vec3(shellAt.x, -shellAt.z, shellAt.y);
  float tone = 0.97 + shellMacroNoise(p / ${glsl(MACRO_SCALE)}) * 0.06;
  if (abs(shellOut.y) < 0.5) {
    float g = clamp((p.z - ${GROUND_ATTRIBUTE}) / ${glsl(GRIME_REACH)}, 0.0, 1.0);
    tone *= 0.8 + 0.2 * g * g * (3.0 - 2.0 * g);
  }
  vColor.rgb *= tone;
}
#endif`;
