/** THE WARDROBE: every MakeHuman item a person can wear, the system pack (`spec.ts` WARDROBE) and the community packs */
import community from '../../public/models/people/proxies/community.json';
import selection from './wardrobeSelection.json';
import sexes from './wardrobeSex.json';

/** Whom each curated item is cut for, decided by looking at it (the player: no bizarre mixes). */
const SEX = sexes as Record<string, 'female' | 'male' | 'any'>;

/** The items reviewed for the street */
const SELECTED = new Set<string>(selection.names);

export type CommunityKind = 'top' | 'bottom' | 'skirt' | 'dress' | 'suit' | 'beard' | 'hat' | 'glasses' | 'gloves'
  | 'jewelry' | 'helmet' | 'mask' | 'horns' | 'underwear' | 'socks' | 'equipment';

export interface WardrobeItem {
  readonly name: string;
  readonly kind: CommunityKind | 'hair' | 'eyebrows' | 'eyelashes' | 'shoes';
  /** Who it is cut for, from the item's own tags and name. */
  readonly sex: 'female' | 'male' | 'any';
  /** Hair only: how long. */
  readonly length?: 'short' | 'long';
  readonly triangles: number;
  /** Light and ordinary enough for a passer-by. */
  readonly street: boolean;
  readonly license: string;
  readonly author: string;
}

/** Heaviest item a passer-by wears: the crowd draws hundreds of people. */
const STREET_TRIANGLES = 16000;

/** Items that look out of place on an ordinary street, by tag. */
const COSTUME = /fantasy|goddess|viking|medieval|renaissance|priest|monk|wizard|hero|superhero|comic|future|scifi|sci-fi|robe|armou?r|gown|disco|swimwear|toga|tunic/;

function sexOf(name: string, tags: readonly string[]): WardrobeItem['sex'] {
  // The item's own name, not its author's (`dressupdoc_...` is no dress).
  const own = /^(female|male)_/.test(name) ? name : name.replace(/^[^_]+_/, '');
  const text = `${own} ${tags.join(' ')}`.toLowerCase();
  // Mary Janes, heels, pumps and ballet flats are women's shoes (a man in Mary Janes, 2026-10-05).
  const female = /female|woman|women|ladies|lady|girl|dress|skirt|bra\b|bikini|mary.?jane|_mj_|heel|pump|ballet/.test(text);
  const male = /\bmale\b|_male|man\b|men\b|boy|beard|moustache/.test(text.replace(/female/g, ''));
  return female && !male ? 'female' : male && !female ? 'male' : 'any';
}

function lengthOf(name: string, tags: readonly string[]): 'short' | 'long' {
  const text = `${name} ${tags.join(' ')}`.toLowerCase();
  return /short|bob|pixie|buzz|crew|messy|comb|side_do|afro|updo|bun/.test(text) && !/long/.test(text) ? 'short' : 'long';
}

/** The curated hair, looked at one by one: its length and whom it suits. */
const HAIR: Record<string, { length: 'short' | 'long'; sex: WardrobeItem['sex'] }> = {
  cortu_short_messy_hair: { length: 'short', sex: 'male' },
  culturalibre_hair_02: { length: 'short', sex: 'male' },
  culturalibre_hair_05: { length: 'short', sex: 'male' },
  elvs_grump_hair: { length: 'short', sex: 'male' },
  elvs_maxwell_hair: { length: 'short', sex: 'male' },
  elvs_keylth_hair: { length: 'long', sex: 'male' },
  elvs_that_80s_babe_hair: { length: 'long', sex: 'male' },
  littleright_bobcut_hair: { length: 'short', sex: 'female' },
  toigo_blunt_bob: { length: 'short', sex: 'female' },
  toigo_blunt_bob_with_bangs: { length: 'short', sex: 'female' },
  toigo_inverted_bob: { length: 'short', sex: 'female' },
  elvs_50s_updo: { length: 'short', sex: 'female' },
  rehmanpolanski_hair_bun_brown: { length: 'short', sex: 'female' },
  elvs_ashley_may_hair: { length: 'short', sex: 'female' },
  elvs_inverted_curly_bob: { length: 'short', sex: 'female' },
  elvs_katherine_hair: { length: 'short', sex: 'female' },
  elvs_micky_afro: { length: 'short', sex: 'female' },
  elvs_short_daisy_hair: { length: 'short', sex: 'female' },
  elvs_wavy_bob: { length: 'short', sex: 'female' },
  o4saken_chinesebob01: { length: 'short', sex: 'female' },
  elvs_double_mh_braid: { length: 'long', sex: 'female' },
  elvs_french_braid_variation: { length: 'long', sex: 'female' },
  o4saken_long01: { length: 'long', sex: 'female' },
  elvs_adrienne_hair: { length: 'long', sex: 'female' },
  elvs_daisy_hair: { length: 'long', sex: 'female' },
  elvs_hazel_hair: { length: 'long', sex: 'female' },
  elvs_lady_hippy_hair: { length: 'long', sex: 'female' },
  punkduck_alpha7_long: { length: 'long', sex: 'female' },
  punkduck_alpha7_curly: { length: 'long', sex: 'female' },
};

interface CommunityEntry { name: string; kind: string; triangles: number; street: boolean; license: string; author: string; tags: string[] }

export const COMMUNITY: readonly WardrobeItem[] = (community.items as CommunityEntry[]).map((i) => {
  const kind = i.kind as WardrobeItem['kind'];
  const costume = COSTUME.test(`${i.name} ${i.tags.join(' ')}`.toLowerCase());
  return {
    name: i.name,
    kind,
    // A review that said "anybody" gives way to a name that says whom it is for.
    sex: HAIR[i.name]?.sex ?? (SEX[i.name] === 'any' ? null : SEX[i.name]) ?? sexOf(i.name, i.tags),
    ...(kind === 'hair' ? { length: HAIR[i.name]?.length ?? lengthOf(i.name, i.tags) } : {}),
    triangles: i.triangles,
    street: SELECTED.has(i.name) && i.street && !costume && i.triangles <= STREET_TRIANGLES,
    license: i.license,
    author: i.author,
  };
});

const BY_NAME = new Map(COMMUNITY.map((i) => [i.name, i]));
export const communityItem = (name: string): WardrobeItem | undefined => BY_NAME.get(name);

/** Whom a worn item is for: the community items as reviewed, the system outfits by their name. */
export function wornBy(name: string): WardrobeItem['sex'] {
  const item = BY_NAME.get(name);
  if (item) return item.sex;
  return /^female_/.test(name) ? 'female' : /^male_/.test(name) ? 'male' : 'any';
}

/** Community items of a kind; for the street, only the ones a passer-by may wear, suiting their sex. */
export function itemsOf(kind: WardrobeItem['kind'], options: { street?: boolean; sex?: 'female' | 'male' } = {}): readonly string[] {
  return COMMUNITY.filter((i) => i.kind === kind
    && (!options.street || i.street)
    && (!options.sex || i.sex === 'any' || i.sex === options.sex)).map((i) => i.name);
}
