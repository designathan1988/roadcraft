/** Flags: a generic, customizable flag flown from a mast (a spire, a lantern's mast, a flagpole). */
export const FLAG_PATTERNS = [
  'solid', 'bicolourH', 'bicolourV', 'tricolourH', 'tricolourV', 'cross', 'nordic',
  'diagonal', 'saltire', 'canton', 'stripes', 'border', 'disc', 'chevron',
] as const;
type FlagPattern = (typeof FLAG_PATTERNS)[number];

export interface FlagDesign {
  readonly pattern: FlagPattern;
  /** Field, second and third colours (0xrrggbb). */
  readonly colours: readonly [number, number, number];
}

const isFlagPattern = (v: unknown): v is FlagPattern => (FLAG_PATTERNS as readonly unknown[]).includes(v);

/** The colours a flag's fields are picked from in the Builder. */
export const FLAG_COLOURS: readonly number[] = [
  0xffffff, 0x111418, 0xc8102e, 0xe5533d, 0xf2a900, 0xffd100, 0x009b3a, 0x00843d,
  0x0b5ea8, 0x002776, 0x6cace4, 0x5b2a86, 0x8a1538, 0x7b4a2a, 0x9aa0a6, 0xf28ab2,
];

export const DEFAULT_FLAG: FlagDesign = { pattern: 'tricolourV', colours: [0x0b5ea8, 0xffffff, 0xc8102e] };

/** The designs of the first, fixed flags, kept so old maps fly the same flags. */
export function legacyFlag(flag: 'plain' | 'saoPaulo' | 'saoPauloState'): FlagDesign {
  if (flag === 'saoPaulo') return { pattern: 'cross', colours: [0xffffff, 0xc8102e, 0xc8102e] };
  if (flag === 'saoPauloState') return { pattern: 'stripes', colours: [0xffffff, 0x111418, 0xc8102e] };
  return { pattern: 'solid', colours: [0x3f688d, 0x3f688d, 0x3f688d] };
}

/** A design read from a save, or null if it is not one. */
export function migrateFlagDesign(raw: unknown): FlagDesign | null {
  if (!raw || typeof raw !== 'object') return null;
  const v = raw as { pattern?: unknown; colours?: unknown };
  if (!isFlagPattern(v.pattern) || !Array.isArray(v.colours) || v.colours.length !== 3) return null;
  const colours = v.colours.map((c) => (Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 0xffffff ? (c as number) : 0xffffff));
  return { pattern: v.pattern, colours: [colours[0]!, colours[1]!, colours[2]!] };
}
