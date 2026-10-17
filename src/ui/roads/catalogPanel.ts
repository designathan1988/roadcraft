import { pricePerUnit } from '@world/economy';
import { type CatalogCategory, CATALOG_CATEGORIES, type CatalogRoad, catalogRoads } from '@world/roads/catalog';
import { type RoadProfileSpec, profileRoad, profileWidth, sameProfile } from '@world/roads/profile';
import type { RoadTemplate } from '@world/roads/templates';
import { UNITS_PER_METER } from '@world/units';
import { language, plural, t } from '../i18n';
import { metresText } from './crossSection';
import { profileSwatch } from './profileSwatch';
import { type DrawProfile, drawProfile, setDrawProfile } from './drawProfile';
import { formatMoney } from './money';
import { openProfileEditor, profileEditorOpen, closeProfileEditor } from './profileEditor';
import { savedTemplates } from './templates';
import './roads.css';

/** THE ROAD CATALOGUE in the road tool's drawer (the player's order of 2026-10-09) */
export interface CatalogHost {
  /** The class the road tool has in hand (when no catalogue road is picked, its own card is the picked one). */
  readonly classIndex: () => number;
  /** Puts a class in the road tool's hand (its colours and rules while drawing). */
  readonly pickClass: (index: number) => void;
  /** Redraws the drawer. */
  readonly refresh: () => void;
}

/** The tab shown and the strip last built. */
const strip: { category: CatalogCategory | null; built: BuiltStrip | null } = { category: null, built: null };

const nameOf = (r: RoadTemplate): string => (r.nameKey ? t(r.nameKey) : r.name ?? r.id);
const sameRoad = (a: { type: number; profile: RoadProfileSpec }, b: { type: number; profile: RoadProfileSpec }): boolean =>
  a.type === b.type && sameProfile(a.profile, b.profile);

/** Every road the catalogue offers, the player's own under "mine". */
function allCatalogRoads(): CatalogRoad[] {
  return [...catalogRoads(), ...savedTemplates().map((r) => ({ ...r, category: 'mine' as const }))];
}

/** The road the tool draws with now: the picked catalogue road, or the class in hand's own. */
export function pickedRoad(host: Pick<CatalogHost, 'classIndex'>): CatalogRoad | null {
  const chosen = drawProfile();
  const roads = allCatalogRoads();
  if (chosen) return roads.find((r) => sameRoad(r, chosen)) ?? null;
  return roads.find((r) => r.id.startsWith('class:') && r.type === host.classIndex()) ?? null;
}

/** Picks a road: the class first (colours, rules), then its profile, unless it is the class's own. */
function pickRoad(road: RoadTemplate, host: CatalogHost): void {
  host.pickClass(road.type);
  const profile: DrawProfile | null = road.id.startsWith('class:') ? null : { name: nameOf(road), type: road.type, profile: road.profile };
  setDrawProfile(profile);
}

/** The strip as last built and what it was built from: the same inputs keep it, only the picked card changes. */
interface BuiltStrip {
  readonly root: HTMLElement;
  readonly language: string;
  readonly category: CatalogCategory;
  readonly saved: readonly RoadTemplate[];
  readonly loose: DrawProfile | null;
  readonly cards: readonly { readonly id: string; readonly card: HTMLElement; readonly main: HTMLButtonElement; readonly road: CatalogRoad }[];
  /** Each shown card's plan-view picture, by profile and scale: only the cards shown now are kept. */
  readonly swatches: ReadonlyMap<string, string>;
  host: CatalogHost;
}

export function catalogStrip(host: CatalogHost): HTMLElement {
  const picked = pickedRoad(host);
  const saved = savedTemplates();
  strip.category ??= picked?.category ?? 'streets';
  const category = strip.category;
  // A profile in hand that no card is (an edited one, or one picked from a road with the eyedropper, V8)
  const loose = picked ? null : drawProfile();
  const kept = strip.built;
  if (kept && kept.language === language() && kept.category === category && kept.saved === saved && kept.loose === loose) {
    kept.host = host;
    markPicked(kept, loose ? 'drawProfile' : picked?.id ?? null);
    return kept.root;
  }
  const roads = allCatalogRoads();
  const root = document.createElement('div');
  root.className = 'rc-catalog';

  const tabs = document.createElement('div');
  tabs.className = 'rc-tabs';
  tabs.setAttribute('role', 'tablist');
  for (const c of CATALOG_CATEGORIES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `rc-tab${c === category ? ' on' : ''}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(c === category));
    b.dataset['category'] = c;
    const count = roads.filter((r) => r.category === c).length;
    b.innerHTML = '<span></span><em></em>';
    b.querySelector('span')!.textContent = t(`catalog.cat.${c}`);
    b.querySelector('em')!.textContent = String(count);
    b.onclick = () => { strip.category = c; built.host.refresh(); };
    tabs.append(b);
  }
  root.append(tabs);

  const grid = document.createElement('div');
  grid.className = 'rc-cards';
  const shown = roads.filter((r) => r.category === category);
  if (loose) shown.unshift({ id: 'drawProfile', name: loose.name, category, type: loose.type, profile: loose.profile });
  // One scale for every tile: the widest road offered.
  const span = Math.max(...roads.map((r) => r.profile.elements.reduce((sum, e) => sum + e.width, 0)));
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'rc-empty';
    empty.textContent = t(category === 'mine' ? 'catalog.mineEmpty' : 'catalog.empty');
    grid.append(empty);
  }
  const swatches = new Map<string, string>();
  const cards: BuiltStrip['cards'][number][] = [];
  for (const road of shown) {
    const rt = profileRoad(road.profile, road.type);
    const card = document.createElement('div');
    card.className = 'rc-card';
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'rc-card-main';
    main.dataset['road'] = road.id;
    const lanes = road.profile.elements.filter((e) => e.kind === 'lane').length;
    const oneWay = !road.profile.elements.some((e) => e.kind === 'lane' && e.dir === 'backward') ||
      !road.profile.elements.some((e) => e.kind === 'lane' && e.dir === 'forward');
    main.title = t('catalog.tip', {
      name: nameOf(road), lanes: plural('palette.lanes.count', lanes), way: t(oneWay ? 'catalog.oneWay' : 'catalog.twoWay'), speed: road.profile.speedKmh,
    });
    main.innerHTML = '<img class="rc-art" alt="" draggable="false"><span class="rc-name"></span><span class="rc-meta"></span>';
    const swatchKey = `${JSON.stringify(road.profile)}|${span}`;
    const swatch = swatches.get(swatchKey) ?? kept?.swatches.get(swatchKey) ?? profileSwatch(road.profile, span, 124, 64);
    swatches.set(swatchKey, swatch);
    (main.querySelector('.rc-art') as HTMLImageElement).src = swatch;
    main.querySelector('.rc-name')!.textContent = nameOf(road);
    main.querySelector('.rc-meta')!.textContent = t('catalog.meta', {
      width: metresText(profileWidth(road.profile)),
      price: formatMoney(Math.round(pricePerUnit(rt) * UNITS_PER_METER)),
    });
    main.onclick = () => {
      pickRoad(road, built.host);
      if (profileEditorOpen()) closeProfileEditor();
      built.host.refresh();
    };
    card.append(main);
    grid.append(card);
    cards.push({ id: road.id, card, main, road });
  }
  root.append(grid);
  const built: BuiltStrip = { root, language: language(), category, saved, loose, cards, swatches, host };
  strip.built = built;
  markPicked(built, loose ? 'drawProfile' : picked?.id ?? null);
  return root;
}

/** Marks the picked card (and gives it "Customise..."), the others plain: the strip is not built again for a pick. */
function markPicked(built: BuiltStrip, id: string | null): void {
  for (const { id: cardId, card, main, road } of built.cards) {
    const on = cardId === id;
    card.classList.toggle('on', on);
    main.setAttribute('aria-pressed', String(on));
    const custom = card.querySelector('.rc-custom');
    if (on && !custom) card.append(customButton(built, road));
    else if (!on) custom?.remove();
  }
}

function customButton(built: BuiltStrip, road: CatalogRoad): HTMLButtonElement {
  const custom = document.createElement('button');
  custom.type = 'button';
  custom.className = 'rc-custom';
  custom.dataset['action'] = 'customise';
  custom.title = t('catalog.customise');
  custom.setAttribute('aria-label', t('catalog.customise'));
  custom.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 11.5V13h1.5l6.9-6.9-1.5-1.5L3 11.5zm9.7-6.2a.8.8 0 000-1.1l-.9-.9a.8.8 0 00-1.1 0l-.8.8 1.5 1.5.8-.8z" fill="currentColor"/></svg>';
  custom.onclick = () => {
    openProfileEditor({
      title: t('profileEditor.newRoads'),
      profile: road.profile,
      type: road.type,
      docked: true,
      drawWith: (name, profile, type) => { built.host.pickClass(type); setDrawProfile({ name, profile, type }); built.host.refresh(); },
      onSaved: () => { strip.category = 'mine'; built.host.refresh(); },
    });
  };
  return custom;
}
