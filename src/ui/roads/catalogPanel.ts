import { pricePerUnit } from '@world/economy';
import { type CatalogCategory, CATALOG_CATEGORIES, type CatalogRoad, catalogRoads } from '@world/roads/catalog';
import { profileRoad, profileWidth } from '@world/roads/profile';
import type { RoadTemplate } from '@world/roads/templates';
import { UNITS_PER_METER } from '@world/units';
import { t } from '../i18n';
import { metresText } from './crossSection';
import { profileSwatch } from './profileSwatch';
import { type DrawProfile, drawProfile, setDrawProfile } from './drawProfile';
import { formatMoney } from './money';
import { openProfileEditor, profileEditorOpen, closeProfileEditor } from './profileEditor';
import { savedTemplates } from './templates';
import './roads.css';

/**
 * THE ROAD CATALOGUE in the road tool's drawer (the player's order of
 * 2026-10-09): the main way to choose a road, as in Cities: Skylines' roads
 * menu - tabs by category (streets, avenues, highways, special, the player's
 * own), a large card for each road with its cross-section drawn
 * (`crossSection.ts`), its name, its total width and its price a metre; a
 * click picks it and the tool draws with it at once; the picked one stands
 * out, and carries "Customise...", which opens the profile editor docked
 * above the drawer, never over it. Saving a profile there puts it under
 * "My roads".
 */
export interface CatalogHost {
  /** The class the road tool has in hand (when no catalogue road is picked, its own card is the picked one). */
  readonly classIndex: () => number;
  /** Puts a class in the road tool's hand (its colours and rules while drawing). */
  readonly pickClass: (index: number) => void;
  /** Redraws the drawer. */
  readonly refresh: () => void;
}

let category: CatalogCategory | null = null;

const nameOf = (r: RoadTemplate): string => (r.nameKey ? t(r.nameKey) : r.name ?? r.id);
const sameRoad = (a: { type: number; profile: unknown }, b: { type: number; profile: unknown }): boolean =>
  a.type === b.type && JSON.stringify(a.profile) === JSON.stringify(b.profile);

/** Every road the catalogue offers, the player's own under "mine". */
export function allCatalogRoads(): CatalogRoad[] {
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
export function pickRoad(road: RoadTemplate, host: CatalogHost): void {
  host.pickClass(road.type);
  const profile: DrawProfile | null = road.id.startsWith('class:') ? null : { name: nameOf(road), type: road.type, profile: road.profile };
  setDrawProfile(profile);
}

export function catalogStrip(host: CatalogHost): HTMLElement {
  const root = document.createElement('div');
  root.className = 'rc-catalog';
  const picked = pickedRoad(host);
  const roads = allCatalogRoads();
  category ??= picked?.category ?? 'streets';

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
    b.onclick = () => { category = c; host.refresh(); };
    tabs.append(b);
  }
  root.append(tabs);

  const grid = document.createElement('div');
  grid.className = 'rc-cards';
  const shown = roads.filter((r) => r.category === category);
  // A profile in hand that no card is (an edited one, or one picked from a
  // road with the eyedropper, V8): its own card first, picked, on every tab.
  const loose = drawProfile();
  const looseRoad: CatalogRoad | null = loose && !picked
    ? { id: 'drawProfile', name: loose.name, category, type: loose.type, profile: loose.profile } : null;
  if (looseRoad) shown.unshift(looseRoad);
  // One scale for every tile: the widest road offered.
  const span = Math.max(...roads.map((r) => r.profile.elements.reduce((sum, e) => sum + e.width, 0)));
  if (!shown.length) {
    const empty = document.createElement('div');
    empty.className = 'rc-empty';
    empty.textContent = t(category === 'mine' ? 'catalog.mineEmpty' : 'catalog.empty');
    grid.append(empty);
  }
  for (const road of shown) {
    const on = picked?.id === road.id || road === looseRoad;
    const rt = profileRoad(road.profile, road.type);
    const card = document.createElement('div');
    card.className = `rc-card${on ? ' on' : ''}`;
    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'rc-card-main';
    main.dataset['road'] = road.id;
    main.setAttribute('aria-pressed', String(on));
    const lanes = road.profile.elements.filter((e) => e.kind === 'lane').length;
    const oneWay = !road.profile.elements.some((e) => e.kind === 'lane' && e.dir === 'backward') ||
      !road.profile.elements.some((e) => e.kind === 'lane' && e.dir === 'forward');
    main.title = t('catalog.tip', {
      name: nameOf(road), lanes, way: t(oneWay ? 'catalog.oneWay' : 'catalog.twoWay'), speed: road.profile.speedKmh,
    });
    main.innerHTML = '<img class="rc-art" alt="" draggable="false"><span class="rc-name"></span><span class="rc-meta"></span>';
    (main.querySelector('.rc-art') as HTMLImageElement).src = profileSwatch(road.profile, span, 124, 64);
    main.querySelector('.rc-name')!.textContent = nameOf(road);
    main.querySelector('.rc-meta')!.textContent = t('catalog.meta', {
      width: metresText(profileWidth(road.profile)),
      price: formatMoney(Math.round(pricePerUnit(rt) * UNITS_PER_METER)),
    });
    main.onclick = () => {
      pickRoad(road, host);
      if (profileEditorOpen()) closeProfileEditor();
      host.refresh();
    };
    card.append(main);
    if (on) {
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
          drawWith: (name, profile, type) => { host.pickClass(type); setDrawProfile({ name, profile, type }); host.refresh(); },
          onSaved: () => { category = 'mine'; host.refresh(); },
        });
      };
      card.append(custom);
    }
    grid.append(card);
  }
  root.append(grid);
  return root;
}
