import { LEVELS, LEVEL_TRIANGLES, type PieceRole } from './crowdLod';

/** The kind of piece a procedural person is drawn in (`proceduralCrowd.ts` kindOf): skin, a garment, hair, brows and lashes. */
export type Kind = 'skin' | 'cloth' | 'hair' | 'face';

/** What a program draws: the kind of piece (or the far mesh), its level, and whether its cards are widened. */
export interface Variant {
  readonly kind: Kind | 'far';
  readonly level: number;
  readonly widen: boolean;
  readonly grown: boolean;
  readonly lash: boolean;
}

/** A piece's program, as three keys it (`customProgramCacheKey`): pieces of the same variant share it whatever their class. */
export function personProgramKey(v: Variant): string {
  if (v.kind === 'far') return 'procedural-person-far';
  return `procedural-person-${v.kind}-L${v.level}${v.widen ? '-w' : ''}${v.grown ? '-grown' : ''}${v.lash ? '-lash' : ''}`;
}

/** A piece's shadow depth program (`customProgramCacheKey`). */
export function personDepthKey(v: Variant): string {
  return `procedural-person-depth-${v.kind}-L${v.level}${v.widen ? '-w' : ''}`;
}

/** Whether a piece casts a real shadow at `level`: close up only, cast by the next level's triangles; not the brows', lashes' or mouth's. */
export function castsAt(kind: Kind, role: PieceRole, level: number): boolean {
  return level <= 1 && kind !== 'face' && role !== 'mouth';
}

/** The roles an item of each kind can have (`proceduralCrowd.ts` kindOf and roleOf): a transparent item is hair, teeth a mouth. */
const ROLES: Readonly<Record<Kind, readonly PieceRole[]>> = {
  skin: ['skin'],
  face: ['brows', 'lashes'],
  hair: ['hair', 'mouth'],
  cloth: ['outfit', 'garment', 'shoes', 'accessory', 'mouth'],
};

/** Whether a piece of `role` is drawn at `level`: its triangle budget keeps some there (`LEVEL_TRIANGLES`). */
const drawnAt = (role: PieceRole, level: number): boolean => level < LEVELS && LEVEL_TRIANGLES[role][level]! > 0;

/** Every variant a person can be drawn with, and those cast into the shadow: the closed set compiled at load */
function allVariants(): { readonly lit: readonly Variant[]; readonly shadow: readonly Variant[] } {
  const lit = new Map<string, Variant>();
  const shadow = new Map<string, Variant>();
  for (const kind of Object.keys(ROLES) as Kind[]) {
    // Only hair has cards to widen (`lodPlan`) or is grown strand by strand (`hair:` items); only brows and lashes are lashes.
    const widens = kind === 'hair' ? [false, true] : [false];
    const grows = kind === 'hair' ? [false, true] : [false];
    const lashes = kind === 'face' ? [false, true] : [false];
    for (const role of ROLES[kind]) {
      for (let level = 0; level < LEVELS; level++) {
        if (!drawnAt(role, level)) continue;
        for (const widen of widens) for (const grown of grows) for (const lash of lashes) {
          const v: Variant = { kind, level, widen, grown, lash };
          lit.set(personProgramKey(v), v);
          if (castsAt(kind, role, level) && drawnAt(role, level + 1) && !shadow.has(personDepthKey(v))) shadow.set(personDepthKey(v), v);
        }
      }
    }
  }
  const far: Variant = { kind: 'far', level: 3, widen: false, grown: false, lash: false };
  lit.set(personProgramKey(far), far);
  return { lit: [...lit.values()], shadow: [...shadow.values()] };
}

const VARIANTS = allVariants();
/** Every program a procedural person's pieces can be drawn with (`personProgramKey`), the far mesh's too. */
export const PERSON_VARIANTS: readonly Variant[] = VARIANTS.lit;
/** Every shadow depth program they can be cast with (`personDepthKey`). */
export const PERSON_SHADOW_VARIANTS: readonly Variant[] = VARIANTS.shadow;
