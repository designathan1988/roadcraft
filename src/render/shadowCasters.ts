import type { InstancedMesh, Mesh } from 'three';

/** CASTERS BY SIZE AND BY CASCADE: a mesh drawn into a sun cascade only when it holds instances and its widest thing reaches a texel there (`sunCascades.ts`). */

/** A mesh that casts as its maker says (`casts`), into the cascades where `radius` (world units, its widest thing drawn) is at least a texel: under that, its shadow is a smudge PCF spreads away, as a mover's (`sunCascades.ts` drawnIn). */
export interface SizedCaster {
  readonly mesh: Mesh;
  readonly casts: boolean;
  radius(): number;
  /** Texels its radius must span to cast (1 when none): a small thing's shadow narrower than that is a smudge PCF spreads away. */
  readonly texels?: number;
}

const casters = new Set<SizedCaster>();

/** The texel of the cascade being drawn (world units), 0 between the passes: a uniform for a depth material whose geometry merges parts of
 *  different sizes, each leaving the cascade where it would have as a mesh of its own (`signals.ts` frame). */
export const casterTexel = { value: 0 };

/** `caster` chosen at each cascade from now on; the function returned takes it off (its mesh disposed). */
export function castBySize(caster: SizedCaster): () => void {
  casters.add(caster);
  return () => { casters.delete(caster); };
}

/** Each caster's `castShadow` for a cascade of `texel` world units; null: back to what its maker set, between the shadow passes (what the programs compiled ahead look at, `uploads.ts` shadowStandIns). */
export function castCastersInto(texel: number | null): void {
  casterTexel.value = texel ?? 0;
  for (const c of casters) {
    if (texel === null) { c.mesh.castShadow = c.casts; continue; }
    const instanced = c.mesh as InstancedMesh;
    const holds = !instanced.isInstancedMesh || instanced.count > 0;
    c.mesh.castShadow = c.casts && holds && c.radius() >= texel * (c.texels ?? 1);
  }
}
