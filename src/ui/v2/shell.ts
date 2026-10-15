/**
 * Roadcraft's interface, redesigned (2026-10-04).
 *
 * A new layout, not the old panels restyled:
 * - a HUD across the top: the city (clock, sky, residents, traffic) on the
 *   left, the speed in the centre, menu / camera / history / help on the right;
 * - a dock of categories at the bottom centre, icon and name, as Cities:
 *   Skylines II lays its toolbar;
 * - above it, the tool's drawer: its modes as tabs, its options in a column,
 *   its catalogue as a strip of big cards (one picture per thing, a row with a
 *   name per verb);
 * - the selection on the right.
 *
 * It reads the game's state and calls the game's commands, nothing else: the
 * tool in hand, the speed, the history and every tool's setting come from
 * the game's state (`core/gameState.ts`, `watch`ed: told once a frame what
 * changed - Nystrom, "Observer"); the city's numbers and the game's answers
 * are handed to it as they are computed (`onStatus`, `onHint`); and each
 * control calls the command `main.ts` hands it (`ShellDeps`), the Builder
 * through its actions. It once read and clicked a second, hidden interface
 * four times a second (docs/source/PLANO.md 5g).
 */
import { furnitureChosen, setFurnitureChosen } from '../roads/furnitureChoice';
import { FURNITURE_SETS } from '@world/roads/furnitureSets';
import { EFFECT_KINDS, type ElementKind } from '@world/elements';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import { LOT_NAMES, lotKey } from '@world/buildings/lotLibrary';
import { CITY_BUILDINGS } from '@world/buildings/cityBuildings';
import { FINISHES, STYLES } from '@world/buildings/materials';
import { FACADE_PATTERNS } from '@world/buildings/types';
import {
  BUILDER_TAB_SPECS,
  DRAW_ACTIONS,
  DRAW_SHAPES,
  FACADE_SCOPES,
  TIER_SHAPES,
  type BuilderCategoryId,
  type BuilderSection,
  type BuilderToolSpec,
} from '../builder/catalog';
import type { TransitLine } from '@world/transit';
import { blockGridChoice, roadGridShown, roadWidth, setRoadGridShown, setRoadWidth, setZoneColoursShown, signChoice, strikeChoice, zoneColoursShown } from '../toolChoices';
import { SIGN_HAS_TEXT, SIGN_TEXT_MAX, SIGN_TYPES } from '@world/landscape';
import { CLOUD_MODES, POLE_TOOL_MODES, cloudMode, setCloudMode, gullyErase, setGullyErase, TREE_MODES, treeMode, setTreeMode, treeKind, setTreeKind, elementKind, elementMode, setElementKind, setElementMode, fogErase, paintKind, poleLampMode, poleToolMode, setFogErase, setPaintKind, setPoleLampMode, setPoleToolMode, setStreetscapeKind, streetscapeKind } from '../toolChoices';
import { PAINT_KINDS, type PaintKind } from '@world/terrainPaint';

/** The colour of each paintable ground, for its button. */
const PAINT_SWATCH: Readonly<Record<PaintKind, string>> = {
  sand: '#ccb380', soil: '#7a5a3c', meadow: '#7d8f3a', snow: '#eef1f6', gravel: '#8b8a84', asphalt: '#2d2e32', concrete: '#a8a69f', grass: '#4f7a36', forest: '#2c4f26',
  scrub: '#4c6a2c', flowers: '#c86a8e', rocks: '#7d776c', granite: '#8d8a84', sandstone: '#c27a44', basalt: '#3b3836',
  cerrado: '#b8933e', atlantic: '#2f6b34', amazon: '#1b4f27', caatinga: '#a08b68', pampa: '#86ad4c', pantanal: '#4e8f7c',
};
/** The biomes, painted or chosen for the whole map (`world/ecology.ts`). */
const BIOME_SWATCHES = ['cerrado', 'atlantic', 'amazon', 'caatinga', 'pampa', 'pantanal'] as const;
import { LANDSCAPE_KINDS } from '@world/landscape';
import { BARRIER_KINDS } from '@world/barriers';
import { POLE_LAMP_MODES } from '@world/utilities';
import { builderIconSvg } from '../builder/icons';
import { SNAP_MODES, type BuilderState, type BuilderWorkspace } from '../builder/workspace';
import { t, plural, onLanguageChange, LANGUAGES, language, setLanguage, formatDecimal } from '../i18n';
import { nodeCountLabel, roadCountLabel } from '../labels';
import { UNITS_PER_METER } from '@world/units';
import { balanceTip, formatMoney } from '../roads/money';
import { drawProfile } from '../roads/drawProfile';
import { catalogStrip } from '../roads/catalogPanel';
import { transitLineRow } from './transitLine';
import { closeRoadKeys, openRoadKeys, roadKeysOpen } from '../roads/keysPanel';
import { cutWallsChosen, setCutWalls } from '../roads/cutWalls';
import { keyLabel, onRoadKeysChange, roadKey } from '../roads/keys';
import { materialSwatch } from '../materialSwatch';
import { planSwatch } from '../planSwatch';
import './shell.css';
import { TREE_KINDS } from '@world/trees';

type Category = 'roads' | 'zones' | 'build' | 'landscape' | 'transit' | 'people' | 'demolish' | 'info';

const SWATCHES: readonly number[] = [
  0xf2efe8, 0xe6d8bd, 0xd8c297, 0xc98f5a, 0xa4563f, 0x72412f, 0x9c6b43,
  0xbdbcb4, 0x8f9ba5, 0x55585c, 0x2f3134, 0x7d8c6a, 0x5d7a8f, 0x9fb8c4,
];
const hexOf = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

const ICON: Record<string, string> = {
  player: '<circle cx="12" cy="5" r="2.2"/><path d="M12 8v6m0 0-3 6m3-6 3 6M8 11l4-2 4 2"/>',
  roads: '<path d="M7 21 10 3h4l3 18"/><path d="M12 6v2m0 3v2m0 3v2"/>',
  zones: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
  build: '<path d="M4 21V9l6-4v16"/><path d="M10 21V3h10v18"/><path d="M2 21h20"/><path d="M13 7h1m3 0h1m-5 4h1m3 0h1m-5 4h1m3 0h1"/>',
  landscape: '<path d="m2 19 7-11 4 6 3-4 6 9Z"/><circle cx="17" cy="5" r="2"/>',
  transit: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M5 11h14M8 18v2M16 18v2"/><circle cx="8.5" cy="14.5" r="1"/><circle cx="15.5" cy="14.5" r="1"/>',
  tr_stop: '<path d="M7 21V4"/><rect x="7" y="4" width="10" height="7" rx="1"/><path d="M10 7.5h4"/><path d="M4 21h8"/>',
  tr_terminal: '<rect x="3" y="9" width="18" height="10" rx="1"/><path d="M3 9l9-5 9 5M8 19v-5h8v5"/>',
  tr_bay: '<path d="M2 8h5l3 4h4l3-4h5M2 18h20"/><rect x="9" y="13" width="6" height="3" rx="1"/>',
  tr_track: '<path d="M8 3 6 21M16 3l2 18M6.5 7h11M6 12h12M5.5 17h13"/>',
  tr_metro: '<path d="M4 20h16"/><rect x="6" y="5" width="12" height="11" rx="4"/><path d="M6 11h12M9 16l-2 3m8-3 2 3"/><circle cx="12" cy="8" r="1"/>',
  tr_station: '<path d="M3 20h18M5 20V9h14v11M3 9l9-5 9 5"/><path d="M9 13h6"/>',
  tr_line: '<circle cx="5" cy="17" r="2"/><circle cx="12" cy="7" r="2"/><circle cx="19" cy="17" r="2"/><path d="M6.4 15.6 10.6 8.4M13.4 8.4l4.2 7.2"/>',
  people: '<circle cx="12" cy="6" r="3"/><path d="M6 21v-5a6 6 0 0 1 12 0v5"/>',
  actions: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  bomb: '<circle cx="11" cy="14" r="7"/><path d="M15 8l2-2M17 6l1.5-1.5M19 3l1 1M20 6l1 0"/>',
  demolish: '<path d="m5 9 8-5 5 8-8 5Z"/><path d="m7 15 5 5m4-8 3 5"/>',
  info: '<circle cx="11" cy="11" r="6"/><path d="m16 16 5 5"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  camera: '<path d="M3 8h4l2-3h6l2 3h4v11H3Z"/><circle cx="12" cy="13" r="3.5"/>',
  sim: '<path d="M4 18 9 9l4 5 3-4 4 8"/><path d="M4 18h16"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5"/><path d="M12 17.5v.5"/>',
  undo: '<path d="M9 7 4 12l5 5"/><path d="M5 12h8a6 6 0 0 1 6 6"/>',
  redo: '<path d="m15 7 5 5-5 5"/><path d="M19 12h-8a6 6 0 0 0-6 6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  raise: '<path d="M3 20h18"/><path d="m5 20 7-12 7 12"/><path d="M12 3v3"/>',
  lower: '<path d="M3 6h18"/><path d="m5 6 7 12 7-12"/>',
  flatten: '<path d="M3 15h18"/><path d="M6 11h12"/>',
  river: '<path d="M3 8c3-3 6 3 9 0s6 3 9 0"/><path d="M3 15c3-3 6 3 9 0s6 3 9 0"/>',
  paint: '<path d="M4 20c2 0 4-1 4-4 0-2 2-3 4-3"/><path d="M12 13l7-7a2 2 0 0 0-3-3l-7 7"/><path d="M9 10l3 3"/>',
  cloud: '<path d="M7 18h10a4 4 0 0 0 0-8 6 6 0 0 0-11.3 1.7A3.2 3.2 0 0 0 7 18Z"/>',
  storm: '<path d="M7 15h9a4 4 0 0 0 0-8 6 6 0 0 0-11.3 1.7A3.2 3.2 0 0 0 7 15Z"/><path d="m12 15-2 4h3l-2 4"/>',
  fog: '<path d="M3 9h13"/><path d="M6 13h15"/><path d="M3 17h13"/><path d="M19 9h2M3 13h1M18 17h3"/>',
  mesa: '<path d="M2 20h20"/><path d="M4 20 7 9h10l3 11"/><path d="M7.6 13h8.8M6.6 16.5h10.8"/>',
  canyon: '<path d="M2 6h6l2 13h4l2-13h6"/><path d="M8.6 10h-6M15.4 10h6M9.3 14.5h-7M14.7 14.5h7"/>',
  escarpment: '<path d="M2 20h20"/><path d="M3 20V8h9l1 12"/><path d="M5 8v12M7.5 8v12M10 8v12"/><path d="M13 20c3-1 5-2 9-2"/>',
  sugarloaf: '<path d="M2 20h20"/><path d="M5 20c0-9 2-14 6-14s6 5 6 14"/><path d="M9 9c0 3 0 7 .5 11M13 9c.3 3 .4 7 .2 11"/>',
  brush: '<path d="M14 4 20 10 10 20H4v-6Z"/>',
  fill: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 3 3 5-6"/>',
  eraser: '<path d="m8 20-5-5L14 4l7 7-9 9Z"/><path d="M8 20h12"/>',
  frame: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
  grid: '<path d="M3 3h18v18H3zM3 9h18M3 15h18M9 3v18M15 3v18"/>',
  hide: '<path d="M3 3l18 18"/><path d="M10.6 6.2A9 9 0 0 1 21 12a14 14 0 0 1-2.4 3.2M6.3 6.6A14 14 0 0 0 3 12s3 6 9 6a8.8 8.8 0 0 0 4.3-1.1"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  car: '<path d="M4 16V12l2-5h12l2 5v4Z"/><path d="M4 12h16"/><circle cx="7.5" cy="16.5" r="1.8"/><circle cx="16.5" cy="16.5" r="1.8"/>',
  crowd: '<circle cx="9" cy="7" r="3"/><path d="M3 21v-2a6 6 0 0 1 12 0v2"/><circle cx="17" cy="8" r="2.5"/><path d="M16 13a5 5 0 0 1 6 4.5V21"/>',
  demand: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  heat: '<path d="M3 17c4-1 5-6 9-6s5 5 9 6"/><path d="M3 12c4-1 5-6 9-6s5 5 9 6" stroke-dasharray="2 2"/><circle cx="12" cy="11" r="1.5" fill="currentColor"/>',
  // Road modes
  draw: '<path d="M4 20 15 9l3 3L7 23H4Z" transform="translate(0 -3)"/><path d="m15 6 3-3 3 3-3 3"/>',
  upgrade: '<path d="M12 20V6"/><path d="m6 11 6-6 6 6"/><path d="M5 21h14"/>',
  move: '<path d="M12 3v18M3 12h18"/><path d="m9 6 3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
  join: '<rect x="3" y="6" width="8" height="12" rx="1"/><rect x="13" y="6" width="8" height="12" rx="1"/><path d="M9 12h6"/>',
  lotPolygon: '<path d="M5 18 3 9l8-6 9 5-2 10Z"/><circle cx="5" cy="18" r="1.6"/><circle cx="3" cy="9" r="1.6"/><circle cx="11" cy="3" r="1.6"/>',
  lotCurve: '<path d="M4 20V8"/><path d="M4 8Q12 2 20 8"/><path d="M20 8v12H4"/>',
  lotEdit: '<path d="M4 4h16v16H4Z"/><circle cx="4" cy="4" r="2"/><circle cx="20" cy="20" r="2"/>',
  lotDelete: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="m8 8 8 8M16 8l-8 8"/>',
  lotFront: '<rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="2 2"/><path d="M4 20h16" stroke-width="3"/><path d="m12 9 0 7M9 13l3 3 3-3"/>',
  split: '<circle cx="6" cy="7" r="2.5"/><circle cx="6" cy="17" r="2.5"/><path d="M8 8.5 20 17M8 15.5 20 7"/>',
  control: '<rect x="8" y="2" width="8" height="17" rx="2"/><circle cx="12" cy="6" r="1.4"/><circle cx="12" cy="10.5" r="1.4"/><circle cx="12" cy="15" r="1.4"/><path d="M12 19v3"/>',
  roundabout: '<circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="8.5"/><path d="M12 1v2.5M12 20.5V23M1 12h2.5M20.5 12H23"/>',
  // Alignment
  straight: '<path d="M4 20 20 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>',
  curve: '<path d="M4 20C6 8 14 6 20 4"/><circle cx="4" cy="20" r="1.6"/><circle cx="20" cy="4" r="1.6"/>',
  free: '<path d="M3 19c3-1 3-6 6-6s2 5 5 5 3-9 7-12"/>',
  // Snapping
  magnet: '<path d="M6 3v8a6 6 0 0 0 12 0V3"/><path d="M6 7h4M14 7h4"/><path d="M10 3v8a2 2 0 0 0 4 0V3"/>',
  angle: '<path d="M4 20h16"/><path d="M4 20 16 6"/><path d="M10 20a6 6 0 0 0-1.8-4.3"/>',
  cells: '<path d="M3 15h18v5H3z"/><path d="M8 15v5M13 15v5M18 15v5"/><path d="M3 5h18M3 9h18" stroke-dasharray="2 2"/>',
  // Parking: the carriageway from above, bays along its kerbs
  'park-none': '<path d="M5 3v18M19 3v18"/><path d="M12 4v3m0 3v4m0 3v3"/>',
  'park-parallel': '<path d="M3 3v18M21 3v18"/><path d="M7 3v18M17 3v18"/><path d="M3 9h4M3 15h4M17 9h4M17 15h4"/>',
  'park-parallelRight': '<path d="M4 3v18M21 3v18"/><path d="M17 3v18"/><path d="M17 9h4M17 15h4"/><path d="M10.5 4v3m0 3v4m0 3v3"/>',
  'park-parallelLeft': '<path d="M3 3v18M20 3v18"/><path d="M7 3v18"/><path d="M3 9h4M3 15h4"/><path d="M13.5 4v3m0 3v4m0 3v3"/>',
  'park-cycle': '<path d="M3 3v18M21 3v18M7 3v18M17 3v18"/><circle cx="5" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>',
  'park-cycleParking': '<path d="M3 3v18M21 3v18M7 3v18M17 3v18"/><path d="M3 9h4M3 15h4"/><circle cx="19" cy="12" r="1.2"/>',
  // Lanes: the carriageway seen from above
  lanes2: '<path d="M7 3v18M17 3v18"/><path d="M12 4v3m0 3v4m0 3v3" />',
  lanes4: '<path d="M4 3v18M20 3v18"/><path d="M12 3v18"/><path d="M8 5v2m0 4v2m0 4v2M16 5v2m0 4v2m0 4v2"/>',
  lanes6: '<path d="M3 3v18M21 3v18M12 3v18"/><path d="M6 5v2m0 4v2m0 4v2M9 5v2m0 4v2m0 4v2M15 5v2m0 4v2m0 4v2M18 5v2m0 4v2m0 4v2"/>',
  median: '<path d="M3 3v18M21 3v18"/><path d="M10.5 3v18M13.5 3v18"/><path d="M7 5v2m0 4v2m0 4v2M17 5v2m0 4v2m0 4v2"/>',
  // Density: how tall
  low: '<path d="M4 20h16"/><rect x="5" y="14" width="14" height="6" rx="1"/>',
  medium: '<path d="M4 20h16"/><rect x="6" y="9" width="12" height="11" rx="1"/><path d="M9 13h2m2 0h2M9 16h2m2 0h2"/>',
  high: '<path d="M4 20h16"/><rect x="8" y="3" width="8" height="17" rx="1"/><path d="M10.5 7h3M10.5 10h3M10.5 13h3M10.5 16h3"/>',
  // Landscape tabs
  terrain: '<path d="m2 19 7-11 4 6 3-4 6 9Z"/>',
  walls: '<path d="M3 20V9h18v11"/><path d="M3 13h18M3 17h18M8 9v4M14 9v4M11 13v4M17 13v4M6 17v3M14 17v3"/>',
  radius: '<circle cx="12" cy="12" r="8"/><path d="M12 12h8"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/>',
  strength: '<path d="M4 20h16"/><path d="M6 20v-4M10 20v-7M14 20v-10M18 20v-14"/>',
  // Where a facade change applies: a facade of 3 x 3 bays, the part lit.
  scope_bay: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/><rect x="9.3" y="9.3" width="5.4" height="5.4" fill="currentColor" fill-opacity=".55" stroke="none"/>',
  scope_zone: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/><rect x="9.3" y="4" width="10.7" height="10.7" fill="currentColor" fill-opacity=".55" stroke="none"/><rect x="9.3" y="4" width="10.7" height="10.7" stroke-dasharray="2 1.5"/>',
  scope_row: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/><rect x="4.8" y="10.1" width="3.7" height="3.8" fill="currentColor" fill-opacity=".55" stroke="none"/><rect x="10.1" y="10.1" width="3.8" height="3.8" fill="currentColor" fill-opacity=".55" stroke="none"/><rect x="15.5" y="10.1" width="3.7" height="3.8" fill="currentColor" fill-opacity=".55" stroke="none"/>',
  scope_column: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/><rect x="9.3" y="4" width="5.4" height="16" fill="currentColor" fill-opacity=".55" stroke="none"/>',
  scope_storey: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/><rect x="2" y="9.3" width="20" height="5.4" fill="currentColor" fill-opacity=".55" stroke="none"/>',
  scope_side: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16"/><rect x="4" y="4" width="16" height="16" fill="currentColor" fill-opacity=".55" stroke="none"/>',
  scope_volume: '<path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z"/><path d="M4 7.5 12 12l8-4.5M12 12v9"/><path d="M12 3 20 7.5 12 12 4 7.5Z" fill="currentColor" fill-opacity=".55" stroke="none"/>',
  // Roofs: which way the ridge runs, which side the slope falls to
  ridge_x: '<path d="M3 12h18"/><path d="m7 8-4 4 4 4M17 8l4 4-4 4"/>',
  ridge_y: '<path d="M12 3v18"/><path d="m8 7 4-4 4 4M8 17l4 4 4-4"/>',
  fall_front: '<path d="M12 4v15"/><path d="m6 13 6 6 6-6"/>',
  fall_right: '<path d="M4 12h15"/><path d="m13 6 6 6-6 6"/>',
  fall_back: '<path d="M12 20V5"/><path d="m6 11 6-6 6 6"/>',
  fall_left: '<path d="M20 12H5"/><path d="m11 6-6 6 6 6"/>',
  advanced: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  poles: '<path d="M12 22V3"/><path d="M6 6h12"/><path d="M7 6v2M17 6v2"/><path d="M6 6c3 3 9 3 12 0" stroke-dasharray="2 2"/>',
  // Landscaping: what goes on a footway
  streetscape: '<path d="M12 21v-6"/><circle cx="12" cy="9" r="5"/><path d="M4 21h16"/>',
  ls_tree: '<path d="M12 21v-7"/><circle cx="12" cy="9" r="6"/><path d="M8 21h8"/>',
  ls_shrub: '<path d="M4 19c0-4 3-7 8-7s8 3 8 7Z"/><path d="M8 13c0-3 2-5 4-5s4 2 4 5"/><path d="M3 21h18"/>',
  ls_bench: '<path d="M4 11h16"/><path d="M4 15h16"/><path d="M6 15v5M18 15v5M6 11V7h12v4"/>',
  ls_bin: '<path d="M6 7h12l-1 14H7Z"/><path d="M5 7h14M10 4h4"/><path d="M10 11v6M14 11v6"/>',
  ls_lamp: '<path d="M7 21V5h7"/><path d="M12 5h5l1 2h-6Z"/><path d="M15 9l-1 3M17 9l1 3" stroke-dasharray="1.5 1.5"/><path d="M4 21h6"/>',
  ls_hydrant: '<path d="M8 21V10h8v11Z"/><path d="M8 10a4 4 0 0 1 8 0"/><path d="M5 14h3M16 14h3M12 4v2"/><path d="M6 21h12"/>',
  ls_postbox: '<rect x="6" y="5" width="12" height="11" rx="5"/><path d="M9 9h6"/><path d="M12 16v5M8 21h8"/>',
  ls_phone: '<path d="M7 11a5 6 0 0 1 10 0v2H7Z"/><path d="M12 13v8M9 21h6"/><path d="M11 9h2v3h-2Z"/>',
  ls_meadow: '<path d="M4 20c1-4 2-7 1-10M8 20c0-5 1-8 3-11M12 20c0-4-1-8-3-12M16 20c0-5 2-8 4-10M20 20c-1-3-1-6 0-8"/>',
  ls_sign: '<path d="M12 22V11"/><path d="M8 3h8l3 4-3 4H8L5 7Z"/>',
  ls_streetname: '<path d="M12 22V8"/><rect x="3" y="3" width="18" height="5" rx="1"/><path d="M6 5.5h12" stroke-dasharray="2 1.5"/>',
  ls_drain: '<path d="M3 9h18"/><path d="M3 9v3h18V9"/><path d="M5 15h14v4H5Z"/><path d="M8 15v4M11 15v4M14 15v4M17 15v4"/>',
  guardrail: '<path d="M5 18v-8M12 18v-8M19 18v-8"/><path d="M3 9h18v4H3Z"/><path d="M3 11h18"/>',
  railing: '<path d="M4 20V6M20 20V6"/><path d="M4 7h16M4 18h16"/><path d="M8 7v11M12 7v11M16 7v11"/>',
  // The pole tool's two verbs: string a line, take a pole down
  pole_build: '<path d="M6 21V4M18 21V4"/><path d="M3 7h6M15 7h6"/><path d="M6 8c4 3 8 3 12 0"/><path d="M12 14v6M9 17h6"/>',
  pole_remove: '<path d="M10 21V4"/><path d="M6 7h8"/><path d="M15 13l5 5M20 13l-5 5"/>',
  // Street lights on the wire poles: none, every other, all
  pl_none: '<path d="M8 21V4"/><path d="M4 7h8"/><path d="M15 9l5 5M20 9l-5 5"/>',
  pl_alternate: '<path d="M6 21V5h4M18 21V5"/><path d="M9 5l1 2H8Z"/><path d="M9 9l-.5 2" stroke-dasharray="1.5 1.5"/>',
  pl_all: '<path d="M6 21V5h4M18 21V5h-4"/><path d="M9 5l1 2H8ZM15 5l-1 2h2Z"/><path d="M9 9l-.5 2M15 9l.5 2" stroke-dasharray="1.5 1.5"/>',
  // Gullies: channels running down a slope (the canyon icon is the landform's).
  gully: '<path d="M3 4h18"/><path d="M6 4c1 4-2 7 0 11s0 4 1 5M12 4c2 5-1 8 1 12M18 4c1 3-2 6 0 10"/>',
  warn: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4"/><path d="M12 17v.5"/>',
  // A grid of blocks in one click: streets crossing.
  blocks: '<path d="M2 8.5h20M2 15.5h20M8.5 2v20M15.5 2v20" stroke-width="2.6"/>',
  // The map's layers (grid, zone colours, congestion, inside the buildings).
  layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  cycle: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  // How a lot is cut: across its front, front from back, along a line.
  split_vertical: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16" stroke-dasharray="2 2"/><path d="M4 20h16" stroke-width="3"/>',
  split_horizontal: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M4 12h16" stroke-dasharray="2 2"/><path d="M4 20h16" stroke-width="3"/>',
  split_line: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M6 18 18 6" stroke-dasharray="2 2"/><circle cx="6" cy="18" r="1.4"/><circle cx="18" cy="6" r="1.4"/>',
  // What the element brush lays: ground, plants, effects.
  el_stones: '<path d="M3 18c0-3 2.5-5.5 5.5-5.5S14 15 14 18Z"/><path d="M12.5 18c0-2.4 1.8-4.2 4.2-4.2S21 15.6 21 18Z"/><path d="M2 18h20"/>',
  el_pebbles: '<ellipse cx="7" cy="16" rx="3" ry="2"/><ellipse cx="15" cy="17" rx="2.5" ry="1.6"/><ellipse cx="12" cy="11.5" rx="2" ry="1.4"/><ellipse cx="18" cy="11.5" rx="1.6" ry="1.1"/>',
  el_gravel: '<circle cx="6" cy="16" r="1"/><circle cx="10" cy="18" r="1"/><circle cx="14" cy="15" r="1"/><circle cx="18" cy="18" r="1"/><circle cx="8" cy="12" r="1"/><circle cx="16" cy="11" r="1"/><circle cx="12" cy="9" r="1"/><path d="M3 21h18"/>',
  el_leaves: '<path d="M5 19C5 10 11 5 19 5c0 8-5 14-14 14Z"/><path d="M5 19 14 10"/>',
  el_grass: '<path d="M4 20c1-4 2-7 1-10M8 20c0-5 1-8 3-11M12 20c0-4-1-8-3-12M16 20c0-5 2-8 4-10M20 20c-1-3-1-6 0-8"/>',
  el_tallGrass: '<path d="M6 21c0-7-1-12-3-17M10 21c0-8 1-13 3-18M14 21c0-6 2-11 6-15M18 21c0-5-1-9-3-12"/>',
  el_scrub: '<path d="M4 19c0-4 3-7 8-7s8 3 8 7Z"/><path d="M8 13c0-3 2-5 4-5s4 2 4 5"/><path d="M3 21h18"/>',
  el_fern: '<path d="M12 21V5"/><path d="M12 7 7 5M12 7l5-2M12 11 6 9M12 11l6-2M12 15l-5-2M12 15l5-2"/>',
  el_clover: '<circle cx="9" cy="9" r="3"/><circle cx="15" cy="9" r="3"/><circle cx="12" cy="14" r="3"/><path d="M12 17v4"/>',
  el_flowers: '<circle cx="12" cy="7" r="3"/><circle cx="12" cy="7" r="1" fill="currentColor"/><path d="M12 10v11M12 15c-2-2-4-2-6-1M12 17c2-2 4-2 6-1"/>',
  el_mushrooms: '<path d="M4 12a8 6 0 0 1 16 0Z"/><path d="M10 12v7a2 2 0 0 0 4 0v-7"/>',
  el_smoke: '<path d="M7 19a4 4 0 0 1 1-7 5 5 0 0 1 9 1 3 3 0 0 1 0 6Z"/><path d="M11 9c0-2 1-3 3-4"/>',
  el_fire: '<path d="M12 21c-4 0-6-3-6-6 0-4 4-6 4-10 3 2 4 5 4 7 1-1 2-2 2-4 2 2 2 4 2 7 0 3-2 6-6 6Z"/>',
  el_steam: '<path d="M8 20c-2-2 0-4-1-6s-2-3 0-5M12 20c-2-2 0-4-1-6s-2-3 0-5M16 20c-2-2 0-4-1-6s-2-3 0-5"/>',
  el_dust: '<path d="M3 17c4 0 5-4 9-4s5 4 9 4"/><circle cx="7" cy="9" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="17" cy="9" r="1"/><circle cx="10" cy="4" r=".8"/>',
  el_soot: '<circle cx="8" cy="10" r="2.5" fill="currentColor" fill-opacity=".5"/><circle cx="15" cy="8" r="2" fill="currentColor" fill-opacity=".5"/><circle cx="14" cy="15" r="3" fill="currentColor" fill-opacity=".5"/><path d="M3 21h18"/>',
  el_sparks: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8"/>',
  el_spray: '<path d="M12 21v-4"/><path d="M12 17c-3 0-5-2-5-5M12 17c3 0 5-2 5-5"/><circle cx="7" cy="7" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="17" cy="7" r="1"/>',
  // The trees the tree brush plants.
  tk_mixed: '<circle cx="8" cy="10" r="4"/><path d="M8 14v6"/><path d="M16 4l4 10h-8Z"/><path d="M16 14v6"/><path d="M3 21h18"/>',
  tk_oak: '<circle cx="12" cy="10" r="6"/><path d="M12 16v5M9 13l3 3 3-3"/>',
  tk_cypress: '<path d="M12 2c3 4 4 9 3 15H9C8 11 9 6 12 2Z"/><path d="M12 17v4"/>',
  tk_palm: '<path d="M12 21c0-5 1-9 0-12"/><path d="M12 9C9 6 5 6 3 8M12 9c3-3 7-3 9-1M12 9c-1-3-4-5-7-5M12 9c1-3 4-5 7-5"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 15h10l1-15"/><path d="M10 10v7M14 10v7"/>',
  scatter: '<path d="M5 12h7a3 3 0 0 0 0-6 4 4 0 0 0-7.5 1.2A2.4 2.4 0 0 0 5 12Z"/><path d="M13 19h6a2.5 2.5 0 0 0 0-5 3.5 3.5 0 0 0-6.4 1A2 2 0 0 0 13 19Z"/>',
  // The menu's rows.
  m_new: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><path d="M12 11v6m-3-3h6"/>',
  m_open: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  m_save: '<path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/>',
  m_about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.5"/>',
  m_quality: '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7a5 5 0 1 0 5 5"/><path d="M12 12h9"/>',
  m_language: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/>',
  // A road's cross-section: the bands across it (the profile editor, docs/source/VIAS.md V2).
  profile: '<path d="M3 7h18M3 17h18"/><path d="M7 7v10M12 9v2m0 2v2M17 7v10"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M9.5 10h1M13 10h1M16.5 10h1M7 14h10"/>',
};
const svg = (name: string, size = 22): string =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name] ?? ''}</svg>`;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const button = (className: string, label: string, run: () => void, icon?: string): HTMLButtonElement => {
  const b = el('button', className);
  b.type = 'button';
  b.innerHTML = icon ? `${icon}<span></span>` : '<span></span>';
  (b.querySelector('span') as HTMLElement).textContent = label;
  b.title = label;
  b.onclick = run;
  return b;
};

/** What the public transport tool is set to and does, as the panel shows it (`editor/transitTools.ts`). */
type TransitToolKind = 'stop' | 'terminal' | 'bay' | 'track' | 'station' | 'line';
interface ShellTransitTool {
  /** The kind in hand: one of the tabs below, or another the editor has (a mode without a tab of its own). */
  readonly kind: string;
  readonly rail: 'train' | 'metro';
  setKind(kind: TransitToolKind, rail?: 'train' | 'metro'): void;
  lines(): readonly TransitLine[];
  setVehicles(line: number, n: number): void;
  removeLine(line: number): void;
}

/**
 * What the shell needs from the rest of the game. The tools' own settings -
 * the road snaps, the parking a road is laid with, the transit tool - are
 * the editor's, which the interface layer may not import (CLAUDE.md, Layers):
 * `main.ts`, which wires the layers together, hands them over here.
 */
/**
 * The game's state as the shell reads it (`main.ts` `gameState`): the values
 * now, and `watch` to be told, once a frame, that some of them changed.
 */
interface ShellGameValues {
  readonly tool: string;
  readonly paused: boolean;
  readonly speed: number;
  readonly quality: string;
  readonly roadTypeIndex: number;
  readonly alignment: string;
  readonly roadHeightOffset: number;
  readonly roadLanePreset: number | null;
  readonly roundaboutRadius: number;
  readonly terrainMode: string;
  readonly terrainRadius: number;
  readonly terrainStrength: number;
  readonly terrainHardness: number;
  readonly barrierKind: string;
  readonly zoneUse: string;
  readonly zoneDensity: string;
  readonly zoneEraser: boolean;
  readonly zoneMode: string;
  readonly lotSplitKind: string;
  readonly lotSplitParts: number;
  readonly congestionOverlay: boolean;
  readonly perspective: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly sky: string;
  readonly inspectorOpen: boolean;
}
interface ShellGame {
  readonly values: Readonly<ShellGameValues>;
  watch(keys: readonly (keyof ShellGameValues)[], fn: () => void): () => void;
}
/** A number the player sets with a slider: its range, and how the game reads and takes it. */
export interface ShellSlider {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  get(): number;
  set(value: number): void;
  /** The drag ended (one undo step a drag, for the map's own numbers). */
  end?(): void;
}
/** The city's numbers, as `main.ts` computes them for the top bar and the simulation menu. */
export interface ShellStatus {
  readonly clock: string;
  readonly vehicles: string;
  readonly people: string;
  readonly trips: string;
  readonly lost: string;
  readonly meanSpeed: string;
  readonly queued: string;
  /** Junctions that cannot be built (`Network.impossible`). */
  readonly impossible: number;
  /** The money in hand (`world/economy.ts`). */
  readonly balance: number;
}
/**
 * The map's own numbers the old status bar showed (`main.ts`): its roads and
 * nodes, the zoom (pixels a unit, times 100) and the world point in the
 * middle of the view.
 */
interface ShellReadouts {
  readonly roads: number;
  readonly nodes: number;
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}
/** What a lot or zone setting is changed to (`main.ts` `setZone`). */
export interface ShellZonePatch {
  readonly mode?: string;
  readonly use?: string;
  readonly density?: string;
  readonly eraser?: boolean;
  readonly splitKind?: string;
  readonly splitParts?: number;
}
/** A road class, as the upgrade tool shows it. */
export interface ShellRoadClass {
  readonly index: number;
  readonly name: string;
  readonly title: string;
  readonly picture: string;
  /** Its total width in whole metres, which the width stepper starts from. */
  readonly widthM: number;
}

export interface ShellDeps {
  readonly workspace: BuilderWorkspace;
  readonly game: ShellGame;
  /** The road inspector's panel (`ui/inspector.ts`), shown in the selection column. */
  readonly inspectorPanel: HTMLElement | null;
  /** Picks a tool, or puts it down when it is already in hand (`main.ts` `pickTool`). */
  pickTool(tool: string): void;
  /** Takes a tool in hand (`main.ts` `setTool`). */
  setTool(tool: string): void;
  /** Puts everything down: no tool, nothing picked. */
  putDown(): void;
  setSpeed(speed: number): void;
  undo(): void;
  redo(): void;
  newMap(): void;
  openMap(): void;
  saveMap(): void;
  about(): void;
  readonly qualityLevels: readonly string[];
  setQuality(level: string): void;
  markingStyle(): string;
  setMarkingStyle(style: string): void;
  setSky(mode: string): void;
  toggleCongestion(): void;
  /** A camera command: turnLeft, turnRight, tiltUp, tiltDown, north, perspective, reset. */
  camera(command: string): void;
  /** Whether the camera turns at all (the flat view does not). */
  readonly cameraTurns: boolean;
  // The road tool.
  readonly roundabout: boolean;
  roadClasses(): readonly ShellRoadClass[];
  selectRoadType(index: number): void;
  setAlignment(alignment: string): void;
  stepRoadHeight(direction: number): void;
  laneChoices(): readonly { readonly id: string; readonly label: string; readonly on: boolean }[];
  setLanes(id: string): void;
  // Zoning, the land, the walls.
  setZone(patch: ShellZonePatch): void;
  setTerrainMode(mode: string): void;
  setBarrierKind(kind: string): void;
  mapBiome(): string;
  setMapBiome(key: string): void;
  /** An action on the whole map, asking first: clearTerrain, clearGullies, clearFog, clearTrees, clearElements, scatterClouds, clearClouds. */
  mapAction(name: string): void;
  // The simulation.
  demand(): number;
  setDemand(value: number): void;
  /** Every slider the panels show, by name (`main.ts` `SLIDERS`). */
  readonly sliders: Readonly<Record<string, ShellSlider>>;
  /** Told the city's numbers whenever the game computes them (a few times a second while it runs). */
  onStatus(listen: (status: ShellStatus) => void): void;
  /** Told the tool's hint, and each answer of the game (saved, refused, undone...) as a flash. */
  onHint(listen: (text: string, flash: boolean) => void): void;
  roadSnap(): { readonly on: boolean; readonly angles: boolean; readonly grid: boolean };
  setRoadSnap(patch: Partial<{ on: boolean; angles: boolean; grid: boolean }>): void;
  readonly parkingPresets: readonly string[];
  roadParkingPreset(): string;
  setRoadParkingPreset(preset: string): void;
  transitTool(): ShellTransitTool | null;
  /** Takes the camera and the inspector to the first junction that cannot be built. */
  showImpossible(): void;
  /**
   * The map's numbers (`ShellReadouts`), read while the Simulation or the
   * Camera menu is open: the old status bar's roads, nodes, zoom and centre.
   * Absent, those rows are not shown.
   */
  readouts?(): ShellReadouts;
}

/** What the game asks of the shell. */
export interface ShellHandle {
  /** Opens a tool's panel with that tool in hand (the road inspector's eyedropper). */
  openTool(tool: string): void;
  /**
   * A tool's key was pressed (`editor/gameKeys.ts`), after the tool machine
   * took it or put it down: the drawer opens on the tool in hand, closes when
   * the key put it down (as the dock's second click), and I opens Information.
   */
  toolKeyed(tool: string): void;
  /** Puts a control of the game's own in the top bar, before Help (F9's button, `ui/healthPanel.ts`). */
  addToBar(control: HTMLElement): void;
}

export function mountShell(deps: ShellDeps): ShellHandle {
  const { workspace, roadSnap, setRoadSnap, roadParkingPreset, setRoadParkingPreset, transitTool } = deps;
  const ROAD_PARKING_PRESETS = deps.parkingPresets;
  const actions = workspace.actions;
  const game = deps.game.values;
  document.documentElement.classList.add('v2-shell');
  const root = el('div', 'v2');
  document.getElementById('app')?.appendChild(root);

  // ================================================================ HUD
  const hud = el('header', 'v2-hud');
  const city = el('div', 'v2-city');
  // The sky: always day, always night, or the residents' clock - the three
  // side by side, the one in use lit (it was one button naming the current
  // sky, the others unseen until clicked through).
  const SKY_MODES_HUD = [['day', 'sun'], ['night', 'moon'], ['cycle', 'cycle']] as const;
  const sky = el('div', 'v2-seg v2-sky');
  sky.setAttribute('role', 'group');
  const skyButtons = SKY_MODES_HUD.map(([mode, icon]) => {
    const b = button('v2-seg-b', t(`sky.${mode}`), () => deps.setSky(mode), svg(icon, 16));
    b.dataset['sky'] = mode;
    sky.appendChild(b);
    return b;
  });
  const syncSky = (): void => {
    for (const b of skyButtons) {
      const on = game.sky === b.dataset['sky'];
      if (b.classList.contains('on') !== on) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
    }
  };
  // The clock and the counts change every second: their text nodes are
  // rewritten in place, not replaced (no node churn under the HUD).
  const clock = el('strong', 'v2-clock');
  const clockText = clock.appendChild(document.createTextNode(''));
  const stats = el('div', 'v2-stats');
  const statsText = stats.appendChild(document.createTextNode(''));
  // Junctions that cannot be built (legs meeting under 25°): a warning with
  // their count, a click away from the first one. It was computed and never shown.
  const impossibleB = button('v2-warn', '', () => {
    open = true;
    deps.showImpossible();
    render();
  }, svg('warn', 16));
  const impossibleN = el('b');
  impossibleB.appendChild(impossibleN);
  impossibleB.hidden = true;
  let impossibleShown = -1;
  const syncImpossible = (n: number): void => {
    if (n === impossibleShown) return;
    impossibleShown = n;
    impossibleB.hidden = n === 0;
    impossibleN.textContent = String(n);
    impossibleB.title = plural('status.impossible', n);
  };
  // The money in hand (docs/source/VIAS.md V0): roads are paid from it.
  const money = el('strong', 'v2-money');
  const moneyText = money.appendChild(document.createTextNode(''));
  let moneyShown = NaN;
  const syncMoney = (value: number): void => {
    if (value === moneyShown) return;
    moneyShown = value;
    moneyText.data = formatMoney(value);
    money.title = balanceTip();
  };
  city.append(sky, clock, money, impossibleB, stats);

  const speed = el('div', 'v2-speed');
  speed.setAttribute('role', 'group');
  const speedButtons: HTMLButtonElement[] = [];
  for (const s of ['0', '1', '2', '4']) {
    const b = el('button', 'v2-speed-b');
    b.type = 'button';
    b.dataset['speed'] = s;
    b.innerHTML = s === '0' ? svg('pause', 16) : `${s}×`;
    b.title = s === '0' ? t('sim.pause') : `${t('sim.speed')} ${s}×`;
    b.onclick = () => deps.setSpeed(Number(s));
    speedButtons.push(b);
    speed.appendChild(b);
  }

  const actionsBar = el('div', 'v2-actions');
  const undo = button('v2-icon', t('action.undo'), () => deps.undo(), svg('undo', 18));
  const redo = button('v2-icon', t('action.redo'), () => deps.redo(), svg('redo', 18));
  const menuB = button('v2-pill', t('builder.menu.app'), () => toggle('menu', menuB), svg('menu', 18));
  // Sliders, not the mountain-like chart line, which read as the Landscape icon.
  const simB = button('v2-pill', t('builder.menu.simulation'), () => toggle('sim', simB), svg('advanced', 18));
  const camB = button('v2-pill', t('camera.label'), () => toggle('camera', camB), svg('camera', 18));
  const helpB = button('v2-icon', t('builder.help'), () => toggle('help', helpB), svg('help', 18));
  // What the map shows over itself - the grid, the zones' colours, the
  // congestion, the inside of the buildings - in one menu of switches, as
  // Cities: Skylines II gathers its info views. They were a grid button
  // here, a show/hide pair in the zoning panel and a switch in the
  // simulation menu.
  const layersB = button('v2-pill', t('v2.layers'), () => toggle('layers', layersB), svg('layers', 18));
  // See inside the buildings (the Builder's command, `buildingsWiring.ts`):
  // its switch is a layer; while it is on, the floor and a step down and up
  // stay in the bar. A building opened by a click on the map is told here too.
  let inside = workspace.inside();
  const seeInside = (command: 'toggle' | 'up' | 'down'): void => { inside = actions.seeInside(command); syncInside(); };
  const insideDownB = button('v2-icon', t('inside.down'), () => seeInside('down'), builderIconSvg('floorDown', 16));
  const insideUpB = button('v2-icon', t('inside.up'), () => seeInside('up'), builderIconSvg('floorUp', 16));
  const insideLevelEl = el('span', 'v2-inside-level');
  const insideOff = button('v2-icon on', t('inside.toggle'), () => seeInside('toggle'), builderIconSvg('interiorView', 18));
  const insideBar = el('div', 'v2-inside');
  insideBar.append(insideOff, insideDownB, insideLevelEl, insideUpB);
  /** The layers and whether each is on. */
  const LAYERS: readonly { key: string; tip: string; icon: string; on: () => boolean; flip: () => void }[] = [
    { key: 'v2.layer.grid', tip: 'v2.grid.toggle', icon: svg('grid', 18), on: roadGridShown, flip: () => setRoadGridShown(!roadGridShown()) },
    { key: 'zone.colours', tip: 'zone.colours', icon: svg('zones', 18), on: zoneColoursShown, flip: () => setZoneColoursShown(!zoneColoursShown()) },
    { key: 'sim.congestionLabel', tip: 'sim.congestion', icon: svg('heat', 18), on: () => game.congestionOverlay, flip: () => deps.toggleCongestion() },
    { key: 'v2.layer.inside', tip: 'inside.toggle', icon: builderIconSvg('interiorView', 18), on: () => inside.on, flip: () => seeInside('toggle') },
  ];
  const syncInside = (): void => {
    if (insideBar.hidden === inside.on) insideBar.hidden = !inside.on;
    const level = inside.level === 0 ? t('inside.ground') : `${inside.level + 1}º`;
    if (insideLevelEl.textContent !== level) insideLevelEl.textContent = level;
  };
  syncInside();
  workspace.onInside((now) => { inside = now; syncInside(); });
  actionsBar.append(insideBar, layersB, simB, camB, undo, redo, helpB, menuB);
  hud.append(city, speed, actionsBar);

  // ================================================================ popovers
  const pop = el('div', 'v2-pop');
  pop.hidden = true;
  let popId: string | null = null;
  let popAnchor: HTMLElement | null = null;
  const closePop = (): void => {
    pop.hidden = true;
    popId = null;
    popAnchor = null;
    stopReadouts();
    tipCheck();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!popId) return;
    const target = e.target as Node;
    if (!pop.contains(target) && !popAnchor?.contains(target)) closePop();
  }, true);
  const toggle = (id: string, anchor: HTMLElement): void => {
    if (popId === id) return closePop();
    popId = id;
    popAnchor = anchor;
    fillPop(id);
    pop.hidden = false;
    const r = anchor.getBoundingClientRect();
    if (r.top > window.innerHeight / 2) {
      // From the dock at the bottom: opened above its button.
      pop.style.top = 'auto';
      pop.style.bottom = `${Math.round(window.innerHeight - r.top + 8)}px`;
      pop.style.right = 'auto';
      pop.style.left = `${Math.max(12, Math.round(r.left + r.width / 2 - 140))}px`;
    } else {
      pop.style.bottom = 'auto';
      pop.style.left = 'auto';
      pop.style.top = `${Math.round(r.bottom + 8)}px`;
      pop.style.right = `${Math.max(12, Math.round(window.innerWidth - r.right))}px`;
    }
  };
  const row = (label: string, run: () => void, icon = ''): HTMLButtonElement => {
    const b = button('v2-row', label, () => { run(); closePop(); }, icon);
    return b;
  };
  /** A choice among a few, as a row of segments (all in view); the menu redrawn with the new one lit. */
  const seg = (label: string, items: readonly (readonly [value: string, label: string])[], value: string, pick: (v: string) => void): HTMLElement =>
    orow(label, choices(items.map(([v, name]) => ({
      label: name,
      on: v === value,
      run: () => { pick(v); if (popId) fillPop(popId); },
    }))));
  /** The city's numbers as last computed (`onStatus`). */
  let status: ShellStatus | null = null;
  /** The simulation's numbers, kept current while its menu is open. */
  let metricsBox: HTMLElement | null = null;
  const METRICS = [['sim.metric.trips', 'trips'], ['sim.metric.lost', 'lost'], ['sim.metric.speed', 'meanSpeed'], ['sim.metric.queued', 'queued']] as const;
  const syncMetrics = (): void => {
    if (!metricsBox || !status) return;
    const now = status;
    metricsBox.querySelectorAll('dd').forEach((dd, i) => {
      const key = METRICS[i]?.[1];
      const v = key ? now[key] : '';
      if (dd.textContent !== v) dd.textContent = v;
    });
  };
  /** The map's numbers shown in the open menu (`readouts`), and the timer keeping them current. */
  let readoutBox: HTMLElement | null = null;
  let readoutTimer: number | undefined;
  const readoutValue = (key: 'network' | 'zoom' | 'centre'): HTMLElement => {
    const dd = el('dd', '', '—');
    dd.dataset['readout'] = key;
    return dd;
  };
  const syncReadouts = (): void => {
    if (!readoutBox || !deps.readouts) return;
    const r = deps.readouts();
    for (const dd of readoutBox.querySelectorAll<HTMLElement>('dd[data-readout]')) {
      const key = dd.dataset['readout'];
      const v = key === 'network' ? `${roadCountLabel(r.roads)} · ${nodeCountLabel(r.nodes)}`
        : key === 'zoom' ? `${formatDecimal(r.zoom * 100, 0)} %`
          : `X ${formatDecimal(r.x, 0)} · Y ${formatDecimal(r.y, 0)}`;
      if (dd.textContent !== v) dd.textContent = v;
    }
  };
  function stopReadouts(): void {
    if (readoutTimer !== undefined) window.clearInterval(readoutTimer);
    readoutTimer = undefined;
  }
  /** The camera's buttons: each its command, its name and its icon. */
  const CAMERA_BUTTONS = [
    ['turnLeft', 'camera.turnLeft', '<path d="M4 12a8 8 0 1 0 2.3-5.7"/><path d="M4 4v4h4"/>'],
    ['tiltDown', 'camera.tiltDown', '<path d="M3 20h18"/><path d="M5 20 20 13"/><path d="m16.2 11.9 3.8 1.1-2.2 3.2"/>'],
    ['north', 'camera.north', '<path d="M12 3 15 12H9Z" fill="currentColor"/><path d="M12 21 9 12h6Z"/>'],
    ['tiltUp', 'camera.tiltUp', '<path d="M3 20h18"/><path d="M7 20 14 4"/><path d="m10.6 6.4 3.4-2.4 1.1 4"/>'],
    ['turnRight', 'camera.turnRight', '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v4h-4"/>'],
    ['perspective', 'camera.perspective', '<path d="M4 7 12 3l8 4v10l-8 4-8-4Z"/><path d="M12 11v10"/><path d="m4 7 8 4 8-4"/>'],
    ['reset', 'action.resetView', '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><circle cx="12" cy="12" r="2.5"/>'],
  ] as const;
  /** The keys of each tool, as `main.ts` lists them for its help card. */
  const TOOL_KEYS: Readonly<Record<string, readonly (readonly [string, string])[]>> = {
    bulldoze: [['help.key.click', 'help.do.remove'], ['help.key.undo', 'help.do.undo']],
    pole: [['help.key.click', 'help.do.pole'], ['help.key.shiftClick', 'help.do.removePole'], ['help.key.esc', 'help.do.endLine']],
    streetscape: [['help.key.click', 'help.do.streetscape'], ['help.key.shiftClick', 'help.do.streetscapeRemove']],
    barrier: [['help.key.click', 'help.do.barrierPoint'], ['help.key.doubleClickEnter', 'help.do.barrierEnd'], ['help.key.backspace', 'help.do.barrierBack'], ['help.key.shiftClick', 'help.do.barrierRemove'], ['help.key.esc', 'help.do.barrierCancel']],
    inspect: [['help.key.click', 'help.do.pick'], ['help.key.pageUpDown', 'help.do.nodeHeight'], ['help.key.esc', 'help.do.close']],
    road: [['v2.key.drag', 'v2.do.road'], ['help.key.pageUpDown', 'palette.height'], ['v2.key.digits', 'palette.kind']],
  };
  const CAMERA_KEYS = [['help.key.orbitDrag', 'help.do.orbit'], ['help.key.panDrag', 'help.do.pan'], ['help.key.wheel', 'help.do.zoom'], ['help.key.qe', 'help.do.turn'], ['help.key.home', 'help.do.resetView']] as const;
  const GLOBAL_KEYS = [['v2.key.tools', 'v2.do.tools'], ['help.key.undo', 'v2.do.undo'], ['v2.key.redo', 'v2.do.redo'], ['v2.key.space', 'v2.do.pause'], ['v2.key.f9', 'v2.do.health']] as const;
  const keyList = (title: string, rows: readonly (readonly [string, string])[]): HTMLElement => {
    const box = el('div', 'v2-keys');
    box.appendChild(el('div', 'v2-subhead', title));
    const dl = el('dl');
    for (const [k, d] of rows) {
      const dt = el('dt');
      dt.appendChild(el('kbd', '', t(k)));
      dl.append(dt, el('dd', '', t(d)));
    }
    box.appendChild(dl);
    return box;
  };
  /** Each panel says what it is: its name over its rows (the menu's rows name themselves). */
  const POP_TITLE: Readonly<Record<string, string>> = { layers: 'v2.layers', sim: 'builder.menu.simulation', camera: 'camera.label', help: 'builder.help' };
  function fillPop(id: string): void {
    const key = POP_TITLE[id];
    stopReadouts();
    pop.replaceChildren(...(key ? [el('div', 'v2-pop-title', t(key))] : []), popBody(id));
    // The map's numbers under the camera's buttons (the camera's own body is a row of icons).
    if (id === 'camera' && deps.readouts) {
      readoutBox = el('dl', 'v2-metrics');
      readoutBox.append(el('dt', '', t('camera.zoom')), readoutValue('zoom'), el('dt', '', t('camera.centre')), readoutValue('centre'));
      pop.appendChild(readoutBox);
    }
    if (readoutBox) {
      syncReadouts();
      // Kept current while open (the view moves without the city's numbers
      // being told), written only when a number changes.
      readoutTimer = window.setInterval(syncReadouts, 250);
    }
    tipCheck();
  }
  function popBody(id: string): HTMLElement {
    const body = el('div', 'v2-pop-body');
    metricsBox = null;
    readoutBox = null;
    if (id === 'menu') {
      body.append(
        row(t('action.newMap'), () => deps.newMap(), svg('m_new', 18)),
        row(t('action.openMap'), () => deps.openMap(), svg('m_open', 18)),
        row(t('action.saveMap'), () => deps.saveMap(), svg('m_save', 18)),
        el('hr'),
        seg(t('menu.quality'), deps.qualityLevels.map((q) => [q, t(`quality.${q}`)] as const), game.quality, (v) => deps.setQuality(v)),
        seg(t('menu.language'), LANGUAGES.map((l) => [l.code, l.label] as const), language(), (v) => { if (v === 'en' || v === 'pt-BR') setLanguage(v); }),
        seg(t('menu.paint'), (['br', 'us', 'eu', 'classic'] as const).map((p) => [p, t(`paint.${p}`)] as const), deps.markingStyle(), (v) => deps.setMarkingStyle(v)),
        el('hr'),
        row(t('action.about'), () => deps.about(), svg('m_about', 18)),
      );
    } else if (id === 'layers') {
      // Each layer a row: its icon, its name, a switch.
      for (const layer of LAYERS) {
        const on = layer.on();
        const b = button(`v2-row v2-switch${on ? ' on' : ''}`, t(layer.key), () => {
          layer.flip();
          syncInside();
          const now = layer.on();
          b.classList.toggle('on', now);
          b.setAttribute('aria-checked', String(now));
          requestAnimationFrame(render);
        }, layer.icon);
        b.setAttribute('role', 'switch');
        b.setAttribute('aria-checked', String(on));
        b.title = t(layer.tip);
        body.appendChild(b);
      }
    } else if (id === 'sim') {
      const demands = [['0.55', 'sim.demand.low'], ['1', 'sim.demand.normal'], ['1.55', 'sim.demand.peak']] as const;
      body.append(range('sim.traffic', 'trafficIntensity'), range('sim.people', 'pedIntensity'),
        seg(t('sim.demand'), demands.map(([v, key]) => [v, t(key)] as const), String(deps.demand()), (v) => deps.setDemand(Number(v))));
      metricsBox = el('dl', 'v2-metrics');
      for (const [key] of METRICS) metricsBox.append(el('dt', '', t(key)), el('dd', '', '—'));
      body.appendChild(metricsBox);
      syncMetrics();
      // The map's roads and nodes, the old status bar's.
      if (deps.readouts) {
        readoutBox = el('dl', 'v2-metrics');
        readoutBox.append(el('dt', '', t('sim.metric.network')), readoutValue('network'));
        body.appendChild(readoutBox);
      }
    } else if (id === 'camera') {
      // A row of icons, as a camera bar: the name in the tooltip.
      body.classList.add('icons');
      for (const [command, key, icon] of CAMERA_BUTTONS) {
        if (!deps.cameraTurns && command !== 'reset') continue;
        const label = t(key).replace(/\s*[(·].*$/, '');
        const b = button(`v2-icon${command === 'perspective' && game.perspective ? ' on' : ''}`, label, () => {
          deps.camera(command);
          if (command === 'perspective') fillPop('camera');
        }, svg('', 18).replace('</svg>', `${icon}</svg>`));
        if (command === 'perspective') b.setAttribute('aria-pressed', String(game.perspective));
        body.appendChild(b);
      }
    } else if (id === 'help') {
      // The keys of the tool in hand, the camera's and the game's: keys and
      // what they do, in two columns. It held only the Builder's paragraphs.
      body.classList.add('help');
      const current = tool();
      const own = TOOL_KEYS[categoryOf(current) === 'roads' ? 'road' : current];
      if (own) body.appendChild(keyList(t('help.section.tool'), own));
      if (current === 'building') {
        // The Builder's own help, one line a subject; the full text on demand.
        const more = el('details', 'v2-more');
        more.appendChild(el('summary', '', t('v2.help.builder')));
        for (const [title, text] of [
          ['builder.help.select', 'builder.help.select.text'],
          ['builder.help.gizmo', 'builder.help.gizmo.text'],
          ['builder.help.numeric', 'builder.help.numeric.text'],
          ['builder.help.keys', 'builder.help.keys.text'],
          ['builder.help.cancel', 'builder.help.cancel.text'],
        ] as const) {
          const block = el('div', 'v2-help');
          block.append(el('strong', '', t(title)), el('p', '', t(text)));
          more.appendChild(block);
        }
        body.appendChild(more);
      }
      body.append(keyList(t('help.section.camera'), CAMERA_KEYS), keyList(t('v2.help.global'), GLOBAL_KEYS));
    }
    return body;
  }

  // ================================================================ dock
  const dock = el('nav', 'v2-dock');
  // Each tool named under its icon (a short word; the full name and the key
  // in the tooltip): icons alone made the player hover each one to find a tool.
  const CATS: readonly { id: Category; tool: string; key: string; label: () => string }[] = [
    { id: 'roads', tool: 'road', key: '1', label: () => t('tool.road') },
    { id: 'zones', tool: 'zone', key: 'Z', label: () => t('tool.zone') },
    { id: 'build', tool: 'building', key: 'H', label: () => t('tool.building') },
    { id: 'landscape', tool: 'terrain', key: 'T', label: () => t('v2.cat.landscape') },
    { id: 'transit', tool: 'transit', key: 'O', label: () => t('tool.transit') },
    { id: 'demolish', tool: 'bulldoze', key: 'B', label: () => t('tool.bulldoze') },
    { id: 'info', tool: 'inspect', key: 'I', label: () => t('v2.cat.info') },
  ];
  const dockName = (id: Category): string => t(`v2.dock.${id}`);
  const catButtons = new Map<Category, HTMLButtonElement>();
  for (const c of CATS) {
    const b = el('button', 'v2-cat' + (c.id === 'demolish' ? ' danger' : ''));
    b.type = 'button';
    b.dataset['cat'] = c.id;
    b.innerHTML = `${svg(c.id, 26)}<span class="v2-cat-name"></span><kbd>${c.key}</kbd>`;
    b.onclick = () => {
      if (categoryOf(tool()) === c.id && open) {
        // A second click puts the tool down: the free hand.
        deps.putDown();
        open = false;
        render();
        return;
      }
      open = true;
      // The tool in hand is not put away by its own button pressed again.
      if (categoryOf(tool()) !== c.id || c.id === 'info') deps.pickTool(c.tool);
      render();
    };
    catButtons.set(c.id, b);
    dock.appendChild(b);
  }

  // ================================================================ drawer
  const drawer = el('section', 'v2-drawer');
  const head = el('div', 'v2-drawer-head');
  const title = el('h2', 'v2-title');
  const tabs = el('div', 'v2-tabs');
  tabs.setAttribute('role', 'tablist');
  const tools = el('div', 'v2-head-tools');
  const close = button('v2-icon', t('v2.close'), () => {
    deps.putDown();
    open = false;
    render();
  }, svg('close', 18));
  head.append(title, tabs);
  const hint = el('p', 'v2-hint');
  // The canvas is described by it (`index.html`, aria-describedby).
  hint.id = 'v2Hint';
  const body = el('div', 'v2-drawer-body');
  const options = el('div', 'v2-options');
  const strip = el('div', 'v2-strip');
  body.append(strip);
  /**
   * A row that scrolls sideways - the strip, a catalog's row of cards - fades
   * out at the side with more in it (`shell.css`, MDN mask-image): the card at
   * the edge reads as the next of many, not as a name cut in half.
   */
  const fadeEdges = (box: HTMLElement): void => {
    const more = box.scrollWidth - box.clientWidth;
    const left = more > 1 && box.scrollLeft > 1;
    const right = more > 1 && box.scrollLeft < more - 1;
    const v = left && right ? 'both' : left ? 'left' : right ? 'right' : '';
    if ((box.dataset['more'] ?? '') !== v) { if (v) box.dataset['more'] = v; else delete box.dataset['more']; }
  };
  /** The rows of cards a catalog draws in the strip (`roads/catalogPanel.ts`). */
  const cardRows = (): HTMLElement[] => [...strip.querySelectorAll<HTMLElement>('.rc-cards')];
  const fadeAll = (): void => {
    fadeEdges(strip);
    for (const row of cardRows()) fadeEdges(row);
  };
  // A scroll does not bubble: caught on its way down to the row that scrolled.
  strip.addEventListener('scroll', (e) => { if (e.target instanceof HTMLElement) fadeEdges(e.target); }, { passive: true, capture: true });
  // A catalog redraws its own cards (another group of roads): the panel's
  // width and the fades follow, once a frame at most.
  let refit = 0;
  new MutationObserver(() => {
    if (!refit) refit = requestAnimationFrame(() => { refit = 0; fitDrawer(); });
  }).observe(strip, { childList: true, subtree: true });
  // The tool's options stand on their own at the bottom left, as Cities:
  // Skylines II lays its tool options: modes, elevation, snapping, as icons.
  const toolOptions = el('section', 'v2-toolopts');
  toolOptions.append(options, tools);
  // One row: the modes, the options, the things, the pointer's switches, close.
  drawer.append(head, hint, body, close);
  // A wheel over the strip scrolls it sideways.
  strip.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      strip.scrollLeft += e.deltaY;
      e.preventDefault();
    }
  }, { passive: false });


  // The selection on the right: the road inspector lives here.
  const side = el('aside', 'v2-side');
  if (deps.inspectorPanel) {
    const panel = deps.inspectorPanel;
    side.appendChild(panel);
    /**
     * The inspector scrolls inside the panel and fades out at the end with
     * more past it (`shell.css`): the row under the edge was cut in half with
     * nothing saying the panel went on ("Altura inicial", 1280 x 720).
     */
    const fadeEnds = (): void => {
      const more = panel.scrollHeight - panel.clientHeight;
      const top = more > 1 && panel.scrollTop > 1;
      const bottom = more > 1 && panel.scrollTop < more - 1;
      const v = top && bottom ? 'both' : top ? 'top' : bottom ? 'bottom' : '';
      if ((panel.dataset['moreY'] ?? '') !== v) { if (v) panel.dataset['moreY'] = v; else delete panel.dataset['moreY']; }
    };
    panel.addEventListener('scroll', fadeEnds, { passive: true });
    let fading = 0;
    const later = (): void => { if (!fading) fading = requestAnimationFrame(() => { fading = 0; fadeEnds(); }); };
    new MutationObserver(later).observe(panel, { childList: true, subtree: true, characterData: true });
    new ResizeObserver(later).observe(side);
  }
  /** The Builder's selection panel (`workspace.ts`): the drawer gives way to it too. */
  const builderInspector = workspace.root.querySelector<HTMLElement>('.bw-inspector');

  root.append(hud, pop, drawer, toolOptions, side, dock);

  // The interface's own tooltip: every control is an icon and its name shows
  // here on hover - the browser's tooltip is slow and out of style. A control's
  // `title` is moved to `data-tip` the first time it is pointed at.
  const tip = el('div', 'v2-tip');
  /**
   * Whether a control's name is on screen: an icon's button keeps its name in
   * a span clipped to nothing (for screen readers), which `innerText` still
   * reads.
   */
  const nameShown = (control: HTMLElement): boolean => {
    for (const part of control.querySelectorAll<HTMLElement>('span')) {
      const r = part.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
    }
    return true;
  };
  /** Whether a control's own text is cut short (an ellipsis): its tip then says it whole. */
  const cutShort = (control: HTMLElement): boolean => {
    if (control.scrollWidth > control.clientWidth + 1) return true;
    for (const part of control.querySelectorAll<HTMLElement>('span')) if (part.scrollWidth > part.clientWidth + 1) return true;
    return false;
  };
  tip.hidden = true;
  root.appendChild(tip);
  let tipFor: HTMLElement | null = null;
  root.addEventListener('pointerover', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[title], [data-tip]');
    if (!target || !root.contains(target)) return;
    if (target.title) {
      target.dataset['tip'] = target.title;
      target.removeAttribute('title');
    }
    const text = target.dataset['tip'] ?? '';
    if (!text) return;
    // A control that already shows its whole name: the tip would only say it
    // again, over the controls beside it (the menu's "English" over the
    // Graphics row's "Low", 2026-10-11). Shown when the name is cut short.
    if (nameShown(target) && target.innerText.trim() === text && !cutShort(target)) return;
    tipFor = target;
    tip.textContent = text;
    tip.hidden = false;
    const r = target.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    // Above the control; below it when that would leave the screen.
    const above = r.top - h - 8 >= 4;
    tip.style.left = `${Math.round(Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2)))}px`;
    tip.style.top = `${Math.round(above ? r.top - h - 8 : r.bottom + 8)}px`;
  });
  root.addEventListener('pointerout', (e) => {
    if (!tipFor) return;
    const to = e.relatedTarget as Node | null;
    if (to && tipFor.contains(to)) return;
    tipFor = null;
    tip.hidden = true;
  });
  root.addEventListener('pointerdown', () => { tip.hidden = true; });
  // A control rebuilt or removed under the pointer takes its tooltip with it.
  // Checked after each redraw of the panels, the only thing that removes them.
  const tipCheck = (): void => {
    if (tipFor && (!tipFor.isConnected || tipFor.getBoundingClientRect().width === 0)) {
      tipFor = null;
      tip.hidden = true;
    }
  };

  // ================================================================ state
  let open = false;
  let builder: BuilderState | null = null;

  /**
   * A list of choices in the theme, in place of the browser's white `select`:
   * a button naming the choice, and under it (above it, near the bottom of the
   * screen) the list. Escape or a click elsewhere closes it.
   */
  let ddOpen: { list: HTMLElement; anchor: HTMLElement } | null = null;
  /** A render asked for while a list was open: done when it closes. */
  let renderHeld = false;
  const closeDropdown = (): void => {
    if (!ddOpen) return;
    ddOpen.list.remove();
    ddOpen.anchor.setAttribute('aria-expanded', 'false');
    ddOpen = null;
    if (renderHeld) { renderHeld = false; queueMicrotask(render); }
  };
  document.addEventListener('pointerdown', (e) => {
    const target = e.target as Node;
    if (ddOpen && !ddOpen.list.contains(target) && !ddOpen.anchor.contains(target)) closeDropdown();
  }, true);
  // The keys of a select (WAI-ARIA APG, select-only combobox): the arrows,
  // Home and End move between the choices, Escape closes and gives the focus
  // back to the button. They stop here: the camera's keys must not move too.
  // own key listener: the open list's keys (WAI-ARIA select), held before the game sees them.
  window.addEventListener('keydown', (e) => {
    if (!ddOpen) return;
    const { list, anchor } = ddOpen;
    if (e.key === 'Escape') { closeDropdown(); anchor.focus(); e.stopPropagation(); e.preventDefault(); return; }
    const opts = [...list.querySelectorAll<HTMLButtonElement>('.v2-dd-opt')];
    const at = opts.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowDown' ? Math.min(opts.length - 1, at + 1) : e.key === 'ArrowUp' ? Math.max(0, at - 1)
      : e.key === 'Home' ? 0 : e.key === 'End' ? opts.length - 1 : -1;
    if (to < 0) return;
    opts[to]?.focus();
    e.stopPropagation();
    e.preventDefault();
  }, true);
  const dropdown = (label: string, items: readonly { value: string; label: string }[], value: string, pick: (v: string) => void, prefix = ''): HTMLButtonElement => {
    const b = el('button', 'v2-dd');
    b.type = 'button';
    b.title = label;
    b.setAttribute('aria-haspopup', 'listbox');
    b.setAttribute('aria-expanded', 'false');
    const name = el('span', 'v2-dd-value', `${prefix}${items.find((i) => i.value === value)?.label ?? ''}`);
    b.appendChild(name);
    b.insertAdjacentHTML('beforeend', '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>');
    b.onclick = () => {
      if (ddOpen?.anchor === b) return closeDropdown();
      closeDropdown();
      const list = el('div', 'v2-dd-list');
      list.setAttribute('role', 'listbox');
      list.setAttribute('aria-label', label);
      for (const item of items) {
        const o = el('button', `v2-dd-opt${item.value === value ? ' on' : ''}`, item.label);
        o.type = 'button';
        o.setAttribute('role', 'option');
        o.setAttribute('aria-selected', String(item.value === value));
        o.onclick = () => { closeDropdown(); b.focus(); pick(item.value); };
        list.appendChild(o);
      }
      root.appendChild(list);
      const r = b.getBoundingClientRect();
      list.style.minWidth = `${Math.round(r.width)}px`;
      list.style.left = `${Math.round(Math.min(r.left, window.innerWidth - list.offsetWidth - 8))}px`;
      if (r.top > window.innerHeight / 2) list.style.bottom = `${Math.round(window.innerHeight - r.top + 4)}px`;
      else list.style.top = `${Math.round(r.bottom + 4)}px`;
      ddOpen = { list, anchor: b };
      b.setAttribute('aria-expanded', 'true');
      const chosen = list.querySelector<HTMLElement>('.on') ?? list.querySelector<HTMLElement>('.v2-dd-opt');
      chosen?.scrollIntoView({ block: 'nearest' });
      chosen?.focus({ preventScroll: true });
    };
    // Down on the closed button opens the list, as a select does.
    b.onkeydown = (e) => {
      if (e.key === 'ArrowDown' && !ddOpen) { e.preventDefault(); e.stopPropagation(); b.click(); }
    };
    return b;
  };

  let modelQuery = '';
  let modelCat = 'all';
  let advanced = false;
  try { advanced = window.localStorage.getItem('roadcraft.builder.advanced') === '1'; } catch { /* off */ }
  const requested = new Set<string>();

  const tool = (): string => game.tool;
  const categoryOf = (current: string): Category | null => {
    if (['road', 'upgrade', 'move', 'split', 'control', 'roundabout'].includes(current)) return 'roads';
    if (current === 'zone') return 'zones';
    if (current === 'building') return 'build';
    if (['terrain', 'barrier', 'pole', 'streetscape'].includes(current)) return 'landscape';
    if (current === 'transit') return 'transit';
    if (current === 'bulldoze') return 'demolish';
    if (current === 'inspect') return 'info';
    return null;
  };

  // ------------------------------------------------------------ helpers
  /** A mode of the tool: its icon, its name in the tooltip. */
  const tab = (label: string, on: boolean, run: () => void, disabled = false, icon?: string): HTMLButtonElement => {
    const b = button('v2-tab' + (on ? ' on' : '') + (icon ? ' icon' : ''), label, run, icon);
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(on));
    b.disabled = disabled;
    return b;
  };
  /** A cluster of controls in the row; its name is the tooltip, not a heading. */
  const group = (label: string): HTMLElement => {
    const g = el('div', 'v2-group');
    g.title = label;
    g.setAttribute('role', 'group');
    g.setAttribute('aria-label', label);
    return g;
  };
  const choices = (items: readonly { label: string; on: boolean; run: () => void; disabled?: boolean; icon?: string }[], cols = 3): HTMLElement => {
    const wrap = el('div', 'v2-choices');
    wrap.style.setProperty('--cols', String(cols));
    for (const item of items) {
      const b = button('v2-choice' + (item.on ? ' on' : '') + (item.icon ? ' icon' : ''), item.label, item.run, item.icon);
      b.disabled = item.disabled ?? false;
      b.setAttribute('aria-pressed', String(item.on));
      wrap.appendChild(b);
    }
    return wrap;
  };
  /** A thing: its picture, its name. */
  const card = (label: string, on: boolean, run: () => void, picture?: string, iconHtml?: string, extra = '', shortName?: string): HTMLButtonElement => {
    const b = el('button', `v2-card${on ? ' on' : ''}${extra ? ` ${extra}` : ''}`);
    b.type = 'button';
    b.title = label;
    const art = picture ? `<img class="v2-card-art" src="${picture}" alt="" />` : `<span class="v2-card-art glyph">${iconHtml ?? ''}</span>`;
    b.innerHTML = `${art}<span class="v2-card-name"></span>`;
    // The name under the picture, its aside in brackets left to the tooltip.
    // A short name under the picture when the full one does not fit two lines.
    (b.querySelector('.v2-card-name') as HTMLElement).textContent = shortName ?? label.replace(/\s*\([^)]*\)\s*$/, '');
    b.setAttribute('aria-label', label);
    b.onclick = run;
    return b;
  };
  /** A verb: an icon and its name, in a row. */
  const verb = (label: string, on: boolean, run: () => void, iconHtml: string, danger = false): HTMLButtonElement => {
    const b = button(`v2-verb${on ? ' on' : ''}${danger ? ' danger' : ''}`, label, run, iconHtml);
    return b;
  };
  const section = (label: string, kind: 'cards' | 'verbs' = 'cards'): { box: HTMLElement; items: HTMLElement } => {
    const box = el('div', `v2-section ${kind}`);
    box.appendChild(el('div', 'v2-section-title', label));
    const items = el('div', 'v2-section-items');
    box.appendChild(items);
    strip.appendChild(box);
    return { box, items };
  };
  /** What a tool does: in the tooltip of its drawer, never as a paragraph. */
  const note = (text: string): void => {
    drawer.setAttribute('aria-description', text);
  };
  /**
   * One row of the tool options: a short name at the left, its controls at the
   * right - the name beside what it names (proximity), never a heading over a
   * column, so a tool's options fit the screen without scrolling.
   */
  const orow = (label: string, ...controls: (HTMLElement | null | undefined)[]): HTMLElement => namedRow(label, label, ...controls);
  /** A row whose short name stands at the left and whose whole name is its tooltip and its accessible name. */
  function namedRow(short: string, label: string, ...controls: (HTMLElement | null | undefined)[]): HTMLElement {
    const r = el('div', 'v2-orow');
    r.setAttribute('role', 'group');
    r.setAttribute('aria-label', label);
    const name = el('span', 'v2-orow-name', short);
    name.title = label;
    const box = el('div', 'v2-orow-ctrls');
    for (const c of controls) if (c) box.appendChild(c);
    r.append(name, box);
    return r;
  }
  /** A divider naming what follows: the settings of the whole map, after the brush's. */
  const subhead = (label: string): HTMLElement => el('div', 'v2-subhead', label);
  /** A stepper: less, the value, more. */
  const stepper = (label: string, value: string, run: (d: number) => void): HTMLElement => {
    const s = el('div', 'v2-stepper');
    s.title = label;
    s.append(
      button('v2-icon', `${label} −`, () => { run(-1); render(); }, svg('minus', 14)),
      el('output', 'v2-stepper-value', value),
      button('v2-icon', `${label} +`, () => { run(1); render(); }, svg('plus', 14)),
    );
    return s;
  };
  /**
   * A slider row driving one of the game's own inputs: its name (the unit in
   * the dictionary's brackets moves to the number), the bar, the value.
   */
  /** A slider's number in the interface's language, with at most the decimals of its step. */
  const numberFormats = new Map<string, Intl.NumberFormat>();
  const numberText = (value: number, step: number): string => {
    const digits = Math.min(3, (String(step).split('.')[1] ?? '').length);
    const key = `${language()}:${digits}`;
    let format = numberFormats.get(key);
    if (!format) numberFormats.set(key, format = new Intl.NumberFormat(language(), { maximumFractionDigits: digits }));
    return format.format(value);
  };
  /** The sliders on screen, by name: shown again when their number changes elsewhere (a key, an undo). */
  const ranges = new Map<string, { input: HTMLInputElement; show: () => void }>();
  const range = (labelKey: string, name: string, shortKey?: string): HTMLElement => {
    const full = t(labelKey);
    const unitMatch = /\(([^)]{1,4})\)\s*$/.exec(full);
    const unit = unitMatch ? ` ${unitMatch[1]}` : '';
    // One word at the left; the full name (with its unit) in the tooltip.
    const shortName = shortKey ? t(shortKey) : full.replace(/\s*\([^)]*\)\s*$/, '');
    const slider = deps.sliders[name];
    const input = el('input', 'v2-range');
    input.type = 'range';
    input.setAttribute('aria-label', full);
    const out = el('output', 'v2-range-out');
    const show = (): void => {
      if (!slider) return;
      const now = slider.get();
      const value = String(now);
      if (input.value !== value) input.value = value;
      // In the language's own notation ("1,2 m/s"), as many decimals as the step has.
      const text = `${numberText(now, slider.step)}${unit}`;
      if (out.textContent !== text) out.textContent = text;
    };
    if (slider) {
      input.min = String(slider.min);
      input.max = String(slider.max);
      input.step = String(slider.step);
    }
    show();
    input.oninput = () => {
      slider?.set(Number(input.value));
      show();
    };
    input.onchange = () => slider?.end?.();
    ranges.set(name, { input, show });
    const r = orow(shortName, input, out);
    r.title = full;
    r.classList.add('range');
    return r;
  };
  /** Shows every slider on screen as the game has its number now (not the one being dragged). */
  const syncRanges = (): void => {
    for (const [name, r] of ranges) {
      if (!r.input.isConnected) ranges.delete(name);
      else if (document.activeElement !== r.input) r.show();
    }
  };
  /** An action on the whole map (clear every stroke of a brush), asking first as the game does. */
  const mapAction = (label: string, name: string, icon: string, danger = true): HTMLButtonElement =>
    button(`v2-act${danger ? ' danger' : ''}`, label, () => { deps.mapAction(name); render(); }, svg(icon, 16));

  // ------------------------------------------------------------ roads
  function renderRoads(current: string): void {
    title.textContent = t('tool.road');
    const modes: [string, string, string][] = [['road', t('tool.draw'), 'draw'], ['upgrade', t('tool.upgrade'), 'upgrade'], ['move', t('tool.move'), 'move'], ['split', t('tool.split'), 'split'], ['control', t('tool.control'), 'control']];
    if (deps.roundabout) modes.push(['roundabout', t('tool.roundabout'), 'roundabout']);
    for (const [id, label, icon] of modes) {
      tabs.appendChild(tab(label, current === id, () => {
        // Taken in hand, never picked: picking the road tool from one of its
        // own modes puts it away (`pickTool`), and Draw from Improve closed the panel.
        if (current !== id) deps.setTool(id);
        render();
      }, false, svg(icon, 18)));
    }
    if (current === 'road') {
      const g = blockGridChoice;
      // How the road is traced - straight, curved, free - or a whole grid of
      // blocks in one click, as Cities: Skylines II lists Grid among its
      // drawing modes (`editor/blocks.ts`). Picking a trace puts the grid down.
      const traces = (['straight', 'curve', 'free'] as const).map((a) => ({
        label: t(`palette.alignment.${a}`),
        on: !g.armed && game.alignment === a,
        run: () => { g.armed = false; deps.setAlignment(a); render(); },
        icon: svg(a, 18),
      }));
      traces.push({ label: t('palette.blocks'), on: g.armed, run: () => { g.armed = !g.armed; render(); }, icon: svg('blocks', 18) });
      options.appendChild(orow(t('palette.trace'), choices(traces)));
      // The grid's own numbers only while it is the trace in hand.
      if (g.armed) {
        options.appendChild(orow(t('v2.blocks.count'),
          stepper(t('palette.blocks.cols'), `${g.cols}`, (d) => { g.cols = Math.max(1, Math.min(12, g.cols + d)); }),
          stepper(t('palette.blocks.rows'), `${g.rows}`, (d) => { g.rows = Math.max(1, Math.min(12, g.rows + d)); })));
        options.appendChild(orow(t('v2.blocks.measure'),
          stepper(t('palette.blocks.size'), `${g.blockMetres} m`, (d) => { g.blockMetres = Math.max(30, Math.min(300, g.blockMetres + d * 10)); }),
          stepper(t('palette.blocks.angle'), `${Math.round((g.angle * 180) / Math.PI)}°`, (d) => { g.angle += (d * 15 * Math.PI) / 180; })));
      }
      // Snapping, as Cities: Skylines II offers it: all of it, then each kind.
      // The grid drawn on the ground is the top bar's (one switch, one place).
      const snap = roadSnap();
      options.appendChild(orow(t('v2.snap.title'), choices([
        { label: t('v2.snap.on'), on: snap.on, run: () => { setRoadSnap({ on: !snap.on }); render(); }, icon: svg('magnet', 18) },
        { label: t('v2.snap.angles'), on: snap.on && snap.angles, run: () => { setRoadSnap({ angles: !snap.angles }); render(); }, disabled: !snap.on, icon: svg('angle', 18) },
        { label: t('v2.snap.grid'), on: snap.on && snap.grid, run: () => { setRoadSnap({ grid: !snap.grid }); render(); }, disabled: !snap.on, icon: svg('cells', 18) },
      ])));
      // Lanes, width and parking tune a class's own road; a road picked from
      // the catalogue carries its own (its card's "Customise..." changes them).
      const fromCatalog = drawProfile() !== null;
      // Lanes: the count the next road is laid with.
      if (!fromCatalog) options.appendChild(orow(t('v2.row.lanes'), choices(deps.laneChoices().map((c) => ({
        label: c.label,
        on: c.on,
        run: () => { deps.setLanes(c.id); render(); },
        icon: svg(c.id === 'median' ? 'median' : `lanes${c.id}`, 18),
      })))));
      // Total width, on the 1 m subgrid of the 10 m zoning grid; the class's own until stepped.
      const w = roadWidth();
      const classWidth = deps.roadClasses().find((c) => c.index === game.roadTypeIndex)?.widthM ?? 10;
      if (!fromCatalog) options.appendChild(orow(t('v2.row.width'),
        stepper(t('palette.width'), w === null ? t('palette.width.auto') : `${w} m`, (d) => { setRoadWidth((roadWidth() ?? classWidth) + d); }),
        w === null ? null : button('v2-icon', t('palette.width.auto'), () => { setRoadWidth(null); render(); }, svg('undo', 14))));
      // Height over the ground: a bridge above, a cutting or tunnel below.
      const offset = game.roadHeightOffset;
      const metres = offset / UNITS_PER_METER;
      const heightText = `${Math.abs(metres - Math.round(metres)) < 1e-6 ? Math.round(metres) : formatDecimal(metres, 1)} m`;
      const heightRow = orow(t('v2.row.height'), stepper(t('palette.height'), heightText, (d) => deps.stepRoadHeight(d)));
      heightRow.title = `${t('palette.height')}: ${t(offset > 1e-6 ? 'palette.height.above' : offset < -1e-6 ? 'palette.height.below' : 'palette.height.ground')}`;
      options.appendChild(heightRow);
      // The sides of a cutting: a batter, or retaining walls (docs/source/VIAS.md V3).
      const walls = cutWallsChosen();
      const cutRow = el('div', 'v2-seg');
      for (const on of [false, true]) {
        const b = button(`v2-seg-b rp-seg-text${walls === on ? ' on' : ''}`, t(on ? 'cutSides.walls' : 'cutSides.batter'), () => { setCutWalls(on); render(); });
        b.setAttribute('aria-pressed', String(walls === on));
        b.dataset['cutWalls'] = String(on);
        cutRow.appendChild(b);
      }
      options.appendChild(orow(t('cutSides.row'), cutRow));
      // The furniture the new road is built with (docs/source/VIAS.md V7).
      const furnitureNow = furnitureChosen();
      const furnitureRow = el('div', 'v2-seg rp-seg-tight');
      for (const set of FURNITURE_SETS) {
        const b = button(`v2-seg-b rp-seg-text${furnitureNow === set ? ' on' : ''}`, t(`roadFurniture.${set}`), () => { setFurnitureChosen(set); render(); });
        b.setAttribute('aria-pressed', String(furnitureNow === set));
        b.dataset['furniture'] = set;
        furnitureRow.appendChild(b);
      }
      const furnitureLine = orow(t('roadFurniture.row'), furnitureRow);
      furnitureLine.title = t('roadFurniture.tip');
      options.appendChild(furnitureLine);
      // The tool's keys, rebindable (docs/source/VIAS.md V3).
      const keysB = button('v2-pill rp-open', `${keyLabel(roadKey('heightUp'), true)} · ${keyLabel(roadKey('heightDown'), true)} · ${keyLabel(roadKey('alignment'), true)}`,
        () => (roadKeysOpen() ? closeRoadKeys() : openRoadKeys(keysB)), svg('keyboard', 16));
      options.appendChild(orow(t('roadKeys.row'), keysB));
      // Parking the new road is drawn with (`editor/roadParking.ts`).
      const parkingNow = roadParkingPreset();
      if (!fromCatalog) options.appendChild(orow(t('v2.row.parking'), choices(ROAD_PARKING_PRESETS.map((preset) => ({
        label: t(`parking.preset.${preset}`),
        on: parkingNow === preset,
        run: () => { setRoadParkingPreset(preset); render(); },
        icon: svg(`park-${preset}`, 18),
      })))));
    }
    if (current === 'road') {
      // The road catalogue (the player's order of 2026-10-09): tabs by
      // category, a large card for each ready road; the main way to choose.
      strip.appendChild(catalogStrip({
        classIndex: () => game.roadTypeIndex,
        pickClass: (index) => deps.selectRoadType(index),
        refresh: () => render(),
      }));
    } else if (current === 'upgrade') {
      const { items } = section(t('palette.kind'));
      for (const c of deps.roadClasses()) {
        const b = card(c.name, c.index === game.roadTypeIndex, () => { deps.selectRoadType(c.index); render(); }, c.picture, undefined, 'wide');
        b.title = c.title;
        items.appendChild(b);
      }
    } else if (current === 'roundabout') {
      options.appendChild(range('v2.roundabout.radius', 'roundaboutRadius'));
      note(t('hint.roundabout'));
    } else {
      note(t(`hint.${current}`));
    }
  }

  // ------------------------------------------------------------ zones
  /**
   * Zoning in two tabs, one per job: paint a use on the lots, or make and
   * shape the lots (`world/lots.ts`). Each lot verb is a card of its own, so
   * the rectangle and the polygon are two cards, not a tool and a shape option.
   */
  let lastLotMode = 'add';
  function renderZones(): void {
    title.textContent = t('tool.zone');
    const modeNow = game.zoneMode;
    const painting = modeNow === 'brush';
    if (!painting) lastLotMode = modeNow;
    tabs.append(
      tab(t('v2.zone.paint'), painting, () => { deps.setZone({ mode: 'brush' }); render(); }, false, svg('brush', 18)),
      tab(t('zone.lots'), !painting, () => { deps.setZone({ mode: lastLotMode }); render(); }, false, svg('lotEdit', 18)),
    );
    if (painting) {
      // The use painted on the lots, or the eraser that takes it off.
      const erasing = game.zoneEraser;
      const use = section(t('v2.zone.use')).items;
      for (const [key, colour] of [['residential', '#58c26f'], ['commercial', '#4aa3e8'], ['industrial', '#e6b84a']] as const) {
        use.appendChild(card(t(`zone.${key}`), !erasing && game.zoneUse === key, () => { deps.setZone({ eraser: false, use: key }); render(); }, undefined, `<i class="v2-zone-swatch" style="--zone:${colour}"></i>`));
      }
      use.appendChild(card(t('zone.remove'), erasing, () => { deps.setZone({ eraser: true }); render(); }, undefined, svg('eraser', 30), 'danger'));
      options.appendChild(orow(t('v2.zone.density'), choices((['low', 'medium', 'high'] as const).map((key) => ({
        label: `${t('v2.zone.density')}: ${t(`zone.${key}`)}`, on: game.zoneDensity === key, run: () => { deps.setZone({ density: key }); render(); }, icon: svg(key, 18),
      })))));
      note(t('hint.zone'));
      return;
    }
    const lots = section(t('zone.lots')).items;
    for (const [mode, key, icon] of [['add', 'zone.lot.shape.rect', 'plus'], ['polygon', 'zone.lot.shape.polygon', 'lotPolygon'], ['edit', 'zone.lot.edit', 'lotEdit'], ['curve', 'zone.lot.curve', 'lotCurve'],
      ['front', 'zone.lot.front', 'lotFront'], ['split', 'zone.lot.split', 'split'], ['join', 'zone.lot.join', 'join'], ['delete', 'zone.lot.delete', 'lotDelete']] as const) {
      lots.appendChild(card(t(key), modeNow === mode, () => { deps.setZone({ mode }); render(); }, undefined, svg(icon, 30), mode === 'delete' ? 'danger' : '',
        mode === 'delete' ? t('zone.lot.delete.short') : undefined));
    }
    // How the split tool cuts, and into how many - shown while it is chosen.
    if (modeNow === 'split') {
      options.appendChild(orow(t('v2.row.cut'), choices((['vertical', 'horizontal', 'line'] as const).map((kind) => ({
        label: t(`zone.split.${kind}`), on: game.lotSplitKind === kind, run: () => { deps.setZone({ splitKind: kind }); render(); }, icon: svg(`split_${kind}`, 18),
      })))));
      if (game.lotSplitKind !== 'line') {
        options.appendChild(orow(t('v2.row.parts'), choices([2, 3, 4, 5, 6].map((n) => ({
          label: `${t('zone.split.into')} ${n}`, on: game.lotSplitParts === n, run: () => { deps.setZone({ splitParts: n }); render(); }, icon: `<b class="v2-num">${n}</b>`,
        })))));
      }
    }
    note(t('zone.lots.help'));
  }

  // ------------------------------------------------------------ landscape
  /**
   * Landscape, by what the player is making - as Cities: Skylines II splits
   * its Landscaping into terraforming, vegetation and paths: the land's shape,
   * its ground, what grows on it, the sky, and what stands along the street.
   * Each tab's things are cards (a picture each, the name in the tooltip); the
   * brush of the one in hand is at the bottom left, and the whole map's
   * settings under it. The game's tools are unchanged: terrain modes, the
   * landscaping, wall and pole tools, driven through their own controls.
   */
  type LandTab = 'relief' | 'ground' | 'nature' | 'sky' | 'street';
  const RELIEF_MODES = [['raise', 'raise'], ['lower', 'lower'], ['flatten', 'flatten'], ['river', 'river'], ['gully', 'gully']] as const;
  const LANDFORMS = ['mesa', 'canyon', 'escarpment', 'sugarloaf'] as const;
  const SKY_MODES = [['cloud', 'cloud'], ['fog', 'fog'], ['weather', 'storm']] as const;
  const PROPS: readonly ElementKind[] = ['grass', 'tallGrass', 'scrub', 'fern', 'clover', 'flowers', 'mushrooms', 'stones', 'pebbles', 'gravel', 'leaves'];
  const BARRIER_ICON = (kind: string, size: number): string =>
    kind === 'guardrail' || kind === 'railing' ? svg(kind, size) : builderIconSvg(kind === 'hedge' ? 'hedge' : kind === 'wall' ? 'wallRun' : 'fenceRun', size);
  /** What each tab last had in hand, so going back to it picks that again. */
  const landLast: Record<LandTab, string> = { relief: 'raise', ground: 'paint', nature: 'trees', sky: 'cloud', street: 'streetscape' };
  const terrainModeNow = (): string => game.terrainMode;
  const isEffect = (kind: string): boolean => (EFFECT_KINDS as readonly string[]).includes(kind);
  const landTabOf = (current: string): LandTab => {
    if (current === 'streetscape' || current === 'barrier' || current === 'pole') return 'street';
    const mode = terrainModeNow();
    if (mode === 'paint') return 'ground';
    if (mode === 'trees') return 'nature';
    if (mode === 'elements') return isEffect(elementKind()) ? 'sky' : 'nature';
    if (SKY_MODES.some(([m]) => m === mode)) return 'sky';
    return 'relief';
  };
  /** The terrain tool in hand (picked only when it is not: picked again it is put away), then its mode. */
  const useTerrain = (mode: string): void => {
    if (tool() !== 'terrain') deps.pickTool('terrain');
    deps.setTerrainMode(mode);
  };
  const useTool = (id: string): void => {
    if (tool() !== id) deps.pickTool(id);
  };
  const useElement = (kind: ElementKind): void => {
    setElementKind(kind);
    useTerrain('elements');
  };
  const useBarrier = (kind: string): void => {
    useTool('barrier');
    deps.setBarrierKind(kind);
    render();
  };
  const openLandTab = (id: LandTab): void => {
    const last = landLast[id];
    if (id === 'street') return useTool(last);
    if (last.startsWith('el:')) return useElement(last.slice(3) as ElementKind);
    useTerrain(last);
  };
  const swatchArt = (colour: string): string => `<i class="v2-ground" style="--c:${colour}"></i>`;

  function renderLandscape(current: string): void {
    title.textContent = t('v2.cat.landscape');
    const now = landTabOf(current);
    const inTerrain = current === 'terrain';
    const mode = terrainModeNow();
    // Remember what this tab has in hand.
    landLast[now] = now === 'street' ? current : mode === 'elements' ? `el:${elementKind()}` : mode;
    for (const [id, key, icon] of [['relief', 'v2.land.relief', 'terrain'], ['ground', 'v2.land.ground', 'paint'], ['nature', 'v2.land.nature', 'ls_tree'], ['sky', 'v2.land.sky', 'cloud'], ['street', 'v2.land.street', 'ls_bench']] as const) {
      tabs.appendChild(tab(t(key), now === id, () => { openLandTab(id); render(); }, false, svg(icon, 18)));
    }
    const terrainCard = (m: string, icon: string): HTMLButtonElement => {
      const b = card(t(`terrain.${m}`), inTerrain && mode === m, () => { useTerrain(m); render(); }, undefined, svg(icon, 30));
      // The brush it takes, for the probes.
      b.dataset['terrainMode'] = m;
      return b;
    };
    const brushRows = (...extra: HTMLElement[]): void => { options.append(range('terrain.radius', 'terrainRadius'), ...extra); };
    if (now === 'relief') {
      const shape = section(t('v2.terrain.brush')).items;
      for (const [m, icon] of RELIEF_MODES) shape.appendChild(terrainCard(m, icon));
      const forms = section(t('v2.terrain.landforms')).items;
      for (const m of LANDFORMS) forms.appendChild(terrainCard(m, m));
      if (mode === 'gully') {
        // Cut gullies where wanted, or wipe them (the land's own too); and how much of the steep land carries them of itself.
        options.appendChild(orow(t('v2.row.brush'), choices([
          { label: t('gully.cut'), on: !gullyErase(), run: () => { setGullyErase(false); render(); }, icon: svg('brush', 18) },
          { label: t('gully.erase'), on: gullyErase(), run: () => { setGullyErase(true); render(); }, icon: svg('eraser', 18) },
        ])));
        brushRows(range('gully.strength', 'gullyStrength', 'terrain.strength'));
        options.append(subhead(t('v2.map')), range('gully.auto', 'gullyAuto', 'v2.s.gullyAuto'), orow(t('v2.row.clear'), mapAction(t('gully.clear'), 'clearGullies', 'trash')));
        return;
      }
      brushRows(range('terrain.strength', 'terrainStrength'), range('terrain.hardness', 'terrainHardness'));
      if (mode === 'river') {
        // The water of every river and lake: how rough, how much foam, how fast.
        options.append(subhead(t('water.title')), range('water.waves', 'waterWaves'), range('water.foam', 'waterFoam'), range('water.current', 'waterCurrent'));
      }
      options.append(subhead(t('v2.map')), orow(t('v2.row.clear'), mapAction(t('terrain.clear'), 'clearTerrain', 'flatten')));
    } else if (now === 'ground') {
      // The grounds, then the biomes - one swatch each (`world/terrainPaint.ts`).
      const painting = inTerrain && mode === 'paint';
      const ground = section(t('paint.kind')).items;
      const biomes = section(t('paint.biome')).items;
      for (const kind of PAINT_KINDS) {
        const isBiome = (BIOME_SWATCHES as readonly string[]).includes(kind);
        (isBiome ? biomes : ground).appendChild(card(t(`paint.kind.${kind}`), painting && paintKind() === kind, () => { setPaintKind(kind); useTerrain('paint'); render(); }, undefined, swatchArt(PAINT_SWATCH[kind])));
      }
      brushRows(range('terrain.strength', 'terrainStrength'), range('terrain.hardness', 'terrainHardness'));
      // The map's own biome - the ecosystem wherever nothing else is painted.
      const biomeNow = deps.mapBiome();
      options.append(subhead(t('v2.map')), orow(t('v2.row.biome'), choices(['none', ...BIOME_SWATCHES].map((key) => {
        return {
          label: `${t('terrain.mapBiome')}: ${key === 'none' ? t('terrain.mapBiome.none') : t(`paint.kind.${key}`)}`,
          on: biomeNow === key,
          run: () => { deps.setMapBiome(key); render(); },
          icon: key === 'none' ? '<i class="v2-ground none"></i>' : `<i class="v2-ground" style="--c:${PAINT_SWATCH[key as PaintKind]}"></i>`,
        };
      }))));
    } else if (now === 'nature') {
      // Trees (`world/trees.ts`), then the plants and ground the element brush lays (`world/elements.ts`).
      const trees = section(t('tree.kind')).items;
      for (const kind of TREE_KINDS) {
        trees.appendChild(card(t(`tree.kind.${kind}`), inTerrain && mode === 'trees' && treeKind() === kind, () => { setTreeKind(kind); useTerrain('trees'); render(); }, undefined, svg(`tk_${kind}`, 30)));
      }
      const plants = section(t('el.plants')).items;
      for (const kind of PROPS) {
        plants.appendChild(card(t(`el.kind.${kind}`), inTerrain && mode === 'elements' && elementKind() === kind, () => { useElement(kind); render(); }, undefined, svg(`el_${kind}`, 30)));
      }
      if (inTerrain && mode === 'trees') {
        const icons: Record<(typeof TREE_MODES)[number], string> = { plant: 'brush', one: 'plus', cut: 'eraser' };
        options.appendChild(orow(t('v2.row.brush'), choices(TREE_MODES.map((m) => ({
          label: t(`tree.mode.${m}`), on: treeMode() === m, run: () => { setTreeMode(m); render(); }, icon: svg(icons[m], 18),
        })))));
        brushRows(range('tree.density', 'treeDensity', 'v2.zone.density'), range('tree.height', 'treeHeight'), range('tree.variation', 'treeVariation', 'v2.s.variation'), range('tree.spacing', 'treeSpacing', 'v2.s.spacing'));
        options.append(subhead(t('v2.map')), orow(t('v2.row.clear'), mapAction(t('tree.clear'), 'clearTrees', 'trash')));
      } else if (inTerrain && mode === 'elements') {
        elementRows();
      }
    } else if (now === 'sky') {
      const weather = section(t('atmo.title')).items;
      for (const [m, icon] of SKY_MODES) weather.appendChild(terrainCard(m, icon));
      const effects = section(t('el.effects')).items;
      for (const kind of EFFECT_KINDS) {
        effects.appendChild(card(t(`el.kind.${kind}`), inTerrain && mode === 'elements' && elementKind() === kind, () => { useElement(kind); render(); }, undefined, svg(`el_${kind}`, 30)));
      }
      if (mode === 'cloud') {
        // Put clouds in the sky, move them, set them to the tool's size, height and density, or take them away (`world/clouds.ts`).
        const icons: Record<(typeof CLOUD_MODES)[number], string> = { add: 'plus', move: 'move', edit: 'draw', remove: 'eraser' };
        options.appendChild(orow(t('v2.row.brush'), choices(CLOUD_MODES.map((m) => ({
          label: t(`cloud.${m}`), on: cloudMode() === m, run: () => { setCloudMode(m); render(); }, icon: svg(icons[m], 18),
        })))));
        options.append(range('cloud.size', 'cloudSize'), range('cloud.height', 'cloudHeight', 'v2.s.base'), range('cloud.density', 'cloudDensity'));
        // Many at once over the whole sky, each then the tool's to move or take away.
        options.append(subhead(t('cloud.spread')), range('cloud.count', 'cloudCount'), range('cloud.variation', 'cloudVariation', 'v2.s.variation'),
          orow(t('v2.row.sky'), mapAction(t('cloud.scatter'), 'scatterClouds', 'scatter', false), mapAction(t('cloud.clear'), 'clearClouds', 'trash')));
      } else if (mode === 'fog') {
        // The fog brush lays or wipes banks, each keeping its own height and drift (`world/fogPaint.ts`).
        options.appendChild(orow(t('v2.row.brush'), choices([
          { label: t('fog.lay'), on: !fogErase(), run: () => { setFogErase(false); render(); }, icon: svg('brush', 18) },
          { label: t('fog.erase'), on: fogErase(), run: () => { setFogErase(true); render(); }, icon: svg('eraser', 18) },
        ])));
        brushRows(range('fog.strength', 'fogStrength', 'terrain.strength'), range('fog.height', 'fogHeight'), range('fog.speed', 'fogSpeed', 'v2.s.wind'));
        // The whole map's: every bank's thickness at once, and the haze over everything.
        options.append(subhead(t('v2.map')), range('fog.mapDensity', 'fogMapDensity', 'v2.s.fogAll'), range('atmo.fog', 'atmoFog'), range('atmo.fogHeight', 'atmoFogHeight', 'v2.s.mistHeight'),
          orow(t('v2.row.clear'), mapAction(t('fog.clear'), 'clearFog', 'trash')));
      } else if (mode === 'weather') {
        // Rain, wind, lightning and thunder over the whole map; a click calls a bolt down there (`world/weather.ts`).
        options.append(range('weather.rain', 'weatherRain'), range('weather.wind', 'weatherWind'), range('weather.windDirection', 'weatherWindDir', 'v2.s.direction'),
          subhead(t('weather.storm')), range('weather.lightning', 'weatherLightning', 'v2.s.lightning'), range('weather.thunder', 'weatherThunder', 'v2.s.thunder'));
      } else if (mode === 'elements') {
        elementRows();
      }
    } else {
      // What stands on the footway: the landscaping items, walls and fences, wire poles.
      const furniture = section(t('tool.streetscape')).items;
      const kindNow = streetscapeKind();
      for (const kind of LANDSCAPE_KINDS) {
        furniture.appendChild(card(t(`streetscape.${kind}`), current === 'streetscape' && kindNow === kind, () => { setStreetscapeKind(kind); useTool('streetscape'); render(); }, undefined, svg(`ls_${kind}`, 30)));
      }
      const walls = section(t('v2.land.walls')).items;
      const barrierNow = game.barrierKind;
      for (const kind of BARRIER_KINDS) {
        walls.appendChild(card(t(`barrier.kind.${kind}`), current === 'barrier' && barrierNow === kind, () => useBarrier(kind), undefined, BARRIER_ICON(kind, 30)));
      }
      const poles = section(t('tool.pole')).items;
      for (const next of POLE_TOOL_MODES) {
        poles.appendChild(card(t(`pole.mode.${next}`), current === 'pole' && poleToolMode() === next, () => { setPoleToolMode(next); useTool('pole'); render(); }, undefined, svg(`pole_${next}`, 30)));
      }
      if (current === 'streetscape' && kindNow === 'sign') {
        // Which sign, and the words on those that carry them.
        const type = dropdown(t('sign.type'), SIGN_TYPES.map((s) => ({ value: s, label: t(`sign.type.${s}`) })), signChoice.type,
          (v) => { signChoice.type = v as typeof signChoice.type; render(); });
        options.appendChild(orow(t('v2.row.sign'), type));
        if (SIGN_HAS_TEXT.has(signChoice.type)) options.appendChild(orow(t('v2.row.text'), textInput(t(signChoice.type === 'speed' ? 'sign.text.speed' : 'sign.text'), signChoice.text, (v) => { signChoice.text = v; })));
      } else if (current === 'streetscape' && kindNow === 'streetname') {
        options.appendChild(orow(t('v2.row.text'), textInput(t('sign.street.placeholder'), signChoice.streetName, (v) => { signChoice.streetName = v; })));
      } else if (current === 'pole' && poleToolMode() === 'build') {
        // Street lights on the poles of the next run.
        options.appendChild(orow(t('v2.row.lights'), choices(POLE_LAMP_MODES.map((m) => ({
          label: `${t('pole.lamps')}: ${t(`pole.lamps.${m}`)}`, on: poleLampMode() === m, run: () => { setPoleLampMode(m); render(); }, icon: svg(`pl_${m}`, 18),
        })))));
      }
      note(t(current === 'barrier' ? 'help.tool.barrier' : current === 'pole' ? (poleToolMode() === 'remove' ? 'help.tool.poleRemove' : 'help.tool.pole') : 'help.tool.streetscape'));
    }
  }
  /** The element brush's rows: lay or erase, its settings for the kind in hand, and clearing them all. */
  function elementRows(): void {
    const icons = { lay: 'brush', eraseKind: 'eraser', eraseAll: 'trash' } as const;
    options.appendChild(orow(t('v2.row.brush'), choices((['lay', 'eraseKind', 'eraseAll'] as const).map((m) => ({
      label: t(`el.mode.${m}`), on: elementMode() === m, run: () => { setElementMode(m); render(); }, icon: svg(icons[m], 18),
    })))));
    options.append(range('terrain.radius', 'terrainRadius'), range('el.density', 'elDensity'), range('el.size', 'elSize'),
      range('el.variation', 'elVariation', 'v2.s.variation'), range('el.spacing', 'elSpacing', 'v2.s.spacing'), range('el.strength', 'elStrength', 'terrain.strength'));
    if (isEffect(elementKind())) options.appendChild(range('el.intensity', 'elIntensity', 'v2.s.effect'));
    options.append(subhead(t('v2.map')), orow(t('v2.row.clear'), mapAction(t('el.clear'), 'clearElements', 'trash')));
  }
  /** A text box in the options; the keys typed stay in it (the game's shortcuts do not see them). */
  function textInput(placeholder: string, value: string, set: (v: string) => void): HTMLInputElement {
    const input = el('input', 'v2-search');
    input.type = 'text';
    input.maxLength = SIGN_TEXT_MAX;
    input.placeholder = placeholder;
    input.value = value;
    input.oninput = () => set(input.value);
    input.onkeydown = (e) => e.stopPropagation();
    return input;
  }

  // ------------------------------------------------------------ public transport
  function renderTransit(): void {
    title.textContent = t('tool.transit');
    const tool2 = transitTool();
    if (!tool2) return;
    const kinds: [TransitToolKind, 'train' | 'metro' | undefined, string, string][] = [
      ['stop', undefined, t('transit.tool.stop'), 'tr_stop'],
      ['terminal', undefined, t('transit.tool.terminal'), 'tr_terminal'],
      // The bus bay is not in the transport tool yet (`editor/transitTools.ts`):
      // its tab showed the raw key "transit.tool.bay" and did nothing.
      ['track', 'train', t('transit.tool.trainTrack'), 'tr_track'],
      ['station', 'train', t('transit.tool.trainStation'), 'tr_station'],
      ['track', 'metro', t('transit.tool.metroTrack'), 'tr_metro'],
      ['station', 'metro', t('transit.tool.metroStation'), 'tr_station'],
      ['line', undefined, t('transit.tool.line'), 'tr_line'],
    ];
    for (const [kind, rail, label, icon] of kinds) {
      const on = tool2.kind === kind && (rail === undefined || tool2.rail === rail);
      tabs.appendChild(tab(label, on, () => { tool2.setKind(kind, rail); render(); }, false, svg(icon, 18)));
    }
    // The lines: their colour and name, how many vehicles, and away.
    const lines = tool2.lines();
    const { items } = section(t('transit.lines'));
    const noLines = lines.length === 0;
    for (const line of lines) {
      const row = transitLineRow(line);
      const less = button('v2-icon', t('transit.fewer'), () => { tool2.setVehicles(line.id, line.vehicles - 1); render(); }, '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 12h12"/></svg>');
      const count = el('span', 'v2-transit-count');
      count.textContent = String(line.vehicles);
      count.title = t('transit.vehicles');
      const more = button('v2-icon', t('transit.more'), () => { tool2.setVehicles(line.id, line.vehicles + 1); render(); }, '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M6 12h12M12 6v12"/></svg>');
      const drop = button('v2-icon danger', t('transit.remove'), () => { tool2.removeLine(line.id); render(); }, svg('demolish', 14));
      row.append(less, count, more, drop);
      items.appendChild(row);
    }
    // With no line yet, what to do first; else what this mode does.
    note(noLines && tool2.kind === 'line' ? t('transit.noLines') : t(`help.transit.${tool2.kind}`));
  }

  // ------------------------------------------------------------ simple tools
  function renderSimple(current: string): void {
    title.textContent = t(`tool.${current}`);
    if (current === 'bulldoze') {
      // One tool, three ways to bring things down: demolish at once, the
      // pistol, the bomb with a force (things breaking piece by piece). They
      // were a dock button and a menu of their own beside Demolish.
      for (const [mode, key, icon] of [['demolish', 'tool.bulldoze', 'demolish'], ['shoot', 'actions.pistol', 'actions'], ['strike', 'actions.bomb', 'bomb']] as const) {
        tabs.appendChild(tab(t(key), strikeChoice.mode === mode, () => { strikeChoice.mode = mode; render(); }, false, svg(icon, 18)));
      }
      if (strikeChoice.mode === 'strike') {
        const s = strikeChoice;
        options.appendChild(orow(t('strike.force'), stepper(t('strike.force'), `${s.strength}`, (d) => {
          s.strength = d < 0 ? Math.max(1, s.strength - (s.strength > 10 ? 5 : 1)) : Math.min(50, s.strength + (s.strength >= 10 ? 5 : 1));
        })));
      }
    }
    // The help of the way chosen: the bomb's panel said how to demolish.
    note(t(current === 'bulldoze' && strikeChoice.mode !== 'demolish' ? `help.strike.${strikeChoice.mode}` : `help.tool.${current}`));
  }

  // ------------------------------------------------------------ construction
  const picture = (id: string): string | undefined => {
    const shape = DRAW_SHAPES[id] ?? TIER_SHAPES[id];
    return workspace.thumbnail(id) ?? (shape ? planSwatch(shape) : undefined);
  };
  const ask = (ids: readonly string[]): void => {
    const wanted = ids.filter((id) => !requested.has(id) && !workspace.thumbnail(id));
    for (const id of wanted) requested.add(id);
    if (wanted.length) actions.requestThumbnails(wanted);
  };
  const THINGS = new Set<string>([...FACADE_PATTERNS, 'window', 'sashWindow', 'wideWindow', 'ribbon', 'bayWindow', 'frenchWindow',
    'door', 'doubleDoor', 'garageDoor', 'loadingDoor', 'balcony', 'shopfront', 'roofFlat', 'roofShed', 'roofGable', 'roofHip',
    'roofSawtooth', 'roofTerrace', 'solar', 'skylight', 'vent', 'chimney', 'waterTank', 'spire', 'lantern', 'stair', 'ramp', 'pillar',
    'canopy', 'wall', 'slab', 'wallRun', 'fenceRun', 'pavementRun', 'railing', 'stairRun', 'tree', 'shrub', 'hedge', 'flowers', 'rocks',
    'bench', 'planter', 'parking', 'ac', 'awning', 'clock']);

  function renderBuild(): void {
    title.textContent = t('tool.building');
    const state = builder;
    if (!state) return;
    const selected = state.selection !== null;


    const createTabs: BuilderCategoryId[] = ['models', 'draw'];
    const editTabs: BuilderCategoryId[] = ['mass', 'facade', 'roof', 'parts', 'interior', 'paint'];
    const visible = selected ? [...createTabs, ...editTabs] : [...createTabs, 'paint' as const];
    for (const id of visible) {
      const label = id === 'mass' ? t('v2.build.shape') : t(`builder.category.${id}`);
      const icon = ({ models: 'models', draw: 'draw', mass: 'mass', facade: 'face', roof: 'roof', parts: 'components', interior: 'interiorView', paint: 'paint' } as Record<string, string>)[id] ?? 'models';
      tabs.appendChild(tab(label, state.category === id, () => actions.setCategory(id), false, builderIconSvg(icon, 18)));
    }
    if (!selected) tabs.title = t('v2.build.selectToEdit');

    // The pointer's switches, in the head.
    if (selected) {
      const floors = Array.from({ length: Math.max(1, state.floor.total) }, (_, i) => ({ value: String(i), label: `${t('v2.build.floor')} ${i + 1}` }));
      tools.appendChild(dropdown(t('builder.floor.title'), floors, String(state.floor.active), (v) => actions.setFloor(Number(v))));
    }
    const snap = dropdown(t('builder.snap.label'), SNAP_MODES.map((s) => ({ value: s, label: t(`builder.snap.${s}`) })), state.snap,
      (v) => actions.setSnap(v), `${t('builder.snap.label')}: `);
    const grid = button('v2-icon' + (state.grid ? ' on' : ''), t('builder.grid'), () => actions.toggleGrid(), svg('grid', 17));
    const hide = button('v2-icon' + (state.hideOthers ? ' on' : ''), t('builder.hideOthers'), () => actions.toggleHideOthers(), svg('hide', 17));
    tools.append(snap, grid, hide);
    if (selected) tools.appendChild(button('v2-icon', t('builder.view.frame'), () => actions.view('frame'), svg('frame', 17)));

    if (state.planning) {
      options.appendChild(orow(t('v2.build.plan'), choices([
        { label: t('builder.plan.finish'), on: true, run: () => actions.planFinish(), disabled: state.planPoints < 3, icon: svg('check', 18) },
        { label: t('builder.plan.back'), on: false, run: () => actions.planBack(), icon: svg('undo', 18) },
        { label: t('builder.plan.cancel'), on: false, run: () => actions.planCancel(), icon: svg('close', 18) },
      ])));
    }

    const spec = BUILDER_TAB_SPECS.find((s) => s.id === state.category);
    if (!spec) return;
    if (spec.needsSelection && !selected) {
      note(t('builder.needsSelection'));
      return;
    }
    const sections = spec.sections.filter((s) => !s.advanced || advanced);
    const wantPictures: string[] = [];
    for (const s of sections) {
      for (const x of s.tools ?? []) wantPictures.push(x.id);
      if (s.shelf === 'models') wantPictures.push(...CITY_BUILDINGS.map((c) => `city:${c.fn}`), ...BLUEPRINTS.map((b) => b.key), ...state.userBlueprints.map((b) => b.key), ...LOT_NAMES.map(lotKey));
      if (s.shelf === 'patterns') wantPictures.push(...FACADE_PATTERNS);
    }
    ask(wantPictures);
    for (const s of sections) renderSection(s, state);
    if (spec.sections.some((s) => s.advanced)) {
      const count = spec.sections.filter((s) => s.advanced).reduce((n, s) => n + (s.tools?.length ?? 0), 0);
      const adv = group(advanced ? t('builder.advanced.on') : `${t('builder.advanced.off')} (${count})`);
      adv.appendChild(choices([{ label: advanced ? t('builder.advanced.on') : `${t('builder.advanced.off')} (${count})`, on: advanced, icon: svg('advanced', 18), run: () => {
        advanced = !advanced;
        try { window.localStorage.setItem('roadcraft.builder.advanced', advanced ? '1' : '0'); } catch { /* not kept */ }
        render();
      } }]));
      options.appendChild(adv);
    }
  }

  function renderSection(s: BuilderSection, state: BuilderState): void {
    const label = s.title ? t(`builder.section.${s.title}`) : '';
    if (s.shelf === 'models') return renderModels(state);
    // The Builder's settings as the other tools': one named row each.
    if (s.shelf === 'scope') {
      options.appendChild(orow(label, choices(FACADE_SCOPES.map((scope) => ({ label: t(`creator.dock.scope.${scope}`), on: state.scope === scope, run: () => actions.setScope(scope), icon: svg(`scope_${scope}`, 18) })))));
      return;
    }
    if (s.shelf === 'drawAction') {
      const drawIcon = { new: 'addVolume', ground: 'wing', top: 'stack', cut: 'cut' } as const;
      // Its name is a sentence: a word at the left, the sentence in the tooltip (it was cut to "A forma d...").
      options.appendChild(namedRow(t('builder.section.drawWhere.short'), label, choices(DRAW_ACTIONS.map((a) => ({ label: t(`builder.drawAction.${a}`), on: state.drawAction === a, run: () => actions.setDrawAction(a), disabled: a !== 'new' && !state.selection, icon: builderIconSvg(drawIcon[a], 18) })))));
      return;
    }
    if (s.shelf === 'roofParams') {
      const roof = state.roof;
      // The Builder republishes its state after the change; the panel follows it.
      options.appendChild(orow(t('builder.field.pitch'), stepper(t('builder.field.pitch'), `${roof?.pitch ?? 30}°`, (d) => actions.roofPitch(d * 5))));
      if (roof?.pitched) {
        options.appendChild(orow(t('builder.roof.ridge.label'), choices((['x', 'y'] as const).map((r) => ({ label: t(`builder.roof.ridge.${r}`), on: roof.ridge === r, run: () => actions.roofRidge(r), icon: svg(`ridge_${r}`, 18) })))));
        options.appendChild(orow(t('builder.roof.side.label'), choices(([[0, 'front'], [1, 'right'], [2, 'back'], [3, 'left']] as const).map(([side, key]) => ({ label: t(`builder.roof.side.${key}`), on: roof.fall === side, run: () => actions.roofFall(side), icon: svg(`fall_${key}`, 18) })))));
      }
      return;
    }
    if (s.shelf === 'patterns') {
      const { items } = section(label);
      for (const p of FACADE_PATTERNS) items.appendChild(card(t(`creator.pattern.${p}`), state.pattern === p, () => actions.choosePattern(p), workspace.thumbnail(p), builderIconSvg(p, 30)));
      return;
    }
    if (s.shelf === 'finishes') {
      const { items } = section(t('v2.build.material'));
      for (const f of FINISHES) items.appendChild(card(t(`building.finish.${f}`), state.material?.finish === f, () => actions.chooseFinish(f), materialSwatch(f), undefined, 'square'));
      const sw = el('div', 'v2-swatches');
      for (const c of SWATCHES) {
        const b = el('button', 'v2-swatch' + (state.material?.colour === c ? ' on' : ''));
        b.type = 'button';
        b.style.setProperty('--c', hexOf(c));
        b.setAttribute('aria-label', hexOf(c));
        b.onclick = () => actions.chooseColour(c);
        sw.appendChild(b);
      }
      const custom = el('input', 'v2-swatch custom');
      custom.type = 'color';
      custom.onchange = () => actions.chooseColour(parseInt(custom.value.slice(1), 16));
      sw.appendChild(custom);
      options.appendChild(orow(t('v2.build.colour'), sw));
      const st = section(t('builder.section.styles'));
      for (const style of STYLES) {
        const chips = [style.materials.wall.colour, style.materials.trim.colour, style.materials.roof.colour].map((c) => `<i style="background:${hexOf(c)}"></i>`).join('');
        st.items.appendChild(card(t(`building.style.${style.key}`), false, () => actions.chooseStyle(style.key), undefined, `<span class="v2-style">${chips}</span>`, 'square'));
      }
      return;
    }
    const list = s.tools ?? [];
    if (!list.length) return;
    const things = list.some((x) => THINGS.has(x.id) || DRAW_SHAPES[x.id] || TIER_SHAPES[x.id]);
    const { items } = section(label || title.textContent || '', things ? 'cards' : 'verbs');
    for (const x of list) items.appendChild(toolButton(x, state, things));
  }

  function toolButton(x: BuilderToolSpec, state: BuilderState, asCard: boolean): HTMLButtonElement {
    const on = x.kind === 'mode' && (state.tool === x.id || state.armed === x.id);
    const label = t(`builder.tool.${x.id}`);
    const run = (): void => actions.chooseTool(x.id);
    const b = asCard ? card(label, on, run, picture(x.id), builderIconSvg(x.id, 32)) : verb(label, on, run, builderIconSvg(x.id, 18), x.danger);
    b.disabled = !state.ready.has(x.id);
    b.dataset['builderTool'] = x.id;
    return b;
  }

  function renderModels(state: BuilderState): void {
    const g = group(t('builder.search'));
    const search = el('input', 'v2-search');
    search.type = 'search';
    search.placeholder = t('builder.search');
    search.value = modelQuery;
    search.onkeydown = (e) => e.stopPropagation();
    g.appendChild(search);
    const cats = ['all', 'homes', 'public', 'commerce', 'work', 'leisure', 'generic', 'lots', ...(state.userBlueprints.length ? ['mine'] : [])];
    // The kinds of building in one dropdown, not a row of names.
    const kind = dropdown(t('builder.category.models'), cats.map((c) => ({
      value: c, label: c === 'all' ? t('builder.city.all') : c === 'mine' ? t('builder.city.mine') : t(`builder.city.${c}`),
    })), modelCat, (v) => { modelCat = v; render(); });
    g.appendChild(kind);
    options.appendChild(g);
    const { items } = section(t('builder.category.models'));
    const names = new Set<string>();
    type Entry = { key: string; label: string; cat: string; run: () => void };
    const entries: Entry[] = [];
    for (const m of CITY_BUILDINGS) {
      const key = `city:${m.fn}`;
      const label = t(`building.fn.${m.fn}`);
      names.add(label.toLocaleLowerCase());
      entries.push({ key, label, cat: m.category, run: () => actions.choosePreset(key) });
    }
    for (const bp of BLUEPRINTS) {
      const label = bp.nameKey ? t(bp.nameKey) : bp.key;
      if (!names.has(label.toLocaleLowerCase())) entries.push({ key: bp.key, label, cat: 'generic', run: () => actions.choosePreset(bp.key) });
    }
    // The lots made in the lot lab, each with its own drawing (`world/buildings/lotLibrary.ts`).
    for (const name of LOT_NAMES) {
      const key = lotKey(name);
      entries.push({ key, label: t(`builder.lot.${name}`), cat: 'lots', run: () => actions.choosePreset(key) });
    }
    for (const bp of state.userBlueprints) entries.push({ key: bp.key, label: bp.name ?? bp.key, cat: 'mine', run: () => actions.chooseUserBlueprint(bp.key) });
    const fill = (): void => {
      items.innerHTML = '';
      const query = modelQuery.trim().toLocaleLowerCase();
      const shown = entries.filter((e) => (modelCat === 'all' || e.cat === modelCat) && (!query || e.label.toLocaleLowerCase().includes(query)));
      for (const e of shown) items.appendChild(card(e.label, false, e.run, workspace.thumbnail(e.key), builderIconSvg('models', 32), 'model'));
      if (!shown.length) items.appendChild(el('p', 'v2-muted', t('builder.search.none')));
    };
    search.oninput = () => { modelQuery = search.value; fill(); };
    fill();
  }

  // ================================================================ render
  let lastSignature = '';
  function render(): void {
    // Not while a list is open: the panel rebuilt under it (a picture
    // arriving, the Builder's state) took its button away and closed it
    // within a quarter of a second. Rendered as soon as it closes.
    if (ddOpen) { renderHeld = true; return; }
    const current = tool();
    const cat = categoryOf(current);
    for (const [id, b] of catButtons) {
      b.classList.toggle('on', id === cat && open && (current !== 'inspect' || id === 'info'));
      const c = CATS.find((x) => x.id === id);
      (b.querySelector('.v2-cat-name') as HTMLElement).textContent = dockName(id);
      // Only the icon shows: the name and the key are in the tooltip.
      b.dataset['tip'] = c ? `${c.label()}  ${c.key}` : '';
      b.setAttribute('aria-label', c?.label() ?? '');
    }
    const showDrawer = open && cat !== null;
    drawer.hidden = !showDrawer;
    toolOptions.hidden = !showDrawer;
    root.dataset['tool'] = current;
    // Whether the player has the Information tool open (not merely no tool in
    // hand, which is also 'inspect'): the game draws road gizmos only then.
    document.body.dataset['infoTool'] = open && cat === 'info' ? 'on' : 'off';
    syncSide();
    if (!showDrawer) { tipCheck(); return; }
    // Keep the search box focused across a rebuild.
    const focused = document.activeElement instanceof HTMLInputElement && document.activeElement.classList.contains('v2-search');
    const scroll = strip.scrollLeft;
    tabs.innerHTML = '';
    tools.innerHTML = '';
    options.innerHTML = '';
    strip.innerHTML = '';
    drawer.removeAttribute('aria-description');
    if (cat === 'roads') renderRoads(current);
    else if (cat === 'zones') renderZones();
    else if (cat === 'landscape') renderLandscape(current);
    else if (cat === 'transit') renderTransit();
    else if (cat === 'build') renderBuild();
    else renderSimple(current);
    options.hidden = options.childElementCount === 0;
    tabs.hidden = tabs.childElementCount === 0;
    // A tool with nothing to choose (demolish, inspect) opens no drawer: its
    // icon is lit in the dock and its help is in the tooltip.
    // Sections left with nothing in them are no content: with no transit line
    // yet the panel kept an empty band under its tabs, its words unshown.
    for (const box of [...strip.querySelectorAll(':scope > .v2-section')]) {
      if (box.querySelector('.v2-section-items')?.childElementCount === 0) box.remove();
    }
    drawer.hidden = tabs.hidden && strip.childElementCount === 0;
    // A mode with nothing to pick (move, split, no transit line yet, a
    // Builder tab that needs a building): what to do, said in the panel, not
    // left to a screen reader only.
    const help = drawer.getAttribute('aria-description');
    if (!drawer.hidden && strip.childElementCount === 0 && help) strip.appendChild(el('p', 'v2-note', help));
    toolOptions.hidden = options.hidden && tools.childElementCount === 0;
    // Many things: two rows of cards, more of them in view, rather than one
    // row whose end (the weather, the landforms) hid past the panel's edge.
    strip.classList.toggle('two-rows', strip.querySelectorAll('.v2-card').length > 10);
    if (lastSignature === `${cat}|${current}|${builder?.category ?? ''}`) strip.scrollLeft = scroll;
    lastSignature = `${cat}|${current}|${builder?.category ?? ''}`;
    if (focused) {
      const s = options.querySelector<HTMLInputElement>('.v2-search');
      s?.focus();
      s?.setSelectionRange(s.value.length, s.value.length);
    }
    updateHint();
    fitDrawer();
    tipCheck();
  }
  /**
   * The asset panel stands centred in the room between the tool options
   * (left) and the selection (right), never over either: its width is all of
   * that room, whatever the screen. With neither open it is the screen's
   * centre, over the dock.
   */
  function fitDrawer(): void {
    if (drawer.hidden) return;
    const vw = window.innerWidth;
    let left = 12;
    let right = vw - 12;
    if (!toolOptions.hidden) left = Math.max(left, toolOptions.getBoundingClientRect().right + 12);
    const sel = [side, builderInspector].filter((e): e is HTMLElement => !!e && !e.hidden && e.getBoundingClientRect().width > 0);
    for (const e of sel) {
      const r = e.getBoundingClientRect();
      // Only what reaches down to the panel's height matters.
      if (r.bottom > drawer.getBoundingClientRect().top - 4) right = Math.min(right, r.left - 12);
    }
    const room = Math.max(320, right - left);
    // A narrow screen pins the panel to both edges (`shell.css`, max-width: 780px).
    drawer.style.left = vw <= 780 ? '' : `${Math.round(right - left >= 320 ? (left + right) / 2 : vw / 2)}px`;
    // As wide as the room between the panels (its content sets its width, up
    // to that): held to 1100 px it kept half a 2560 screen empty while the
    // roads and the buildings scrolled out of sight.
    drawer.style.maxWidth = `${Math.floor(room)}px`;
    // A card whose name has a word wider than the card grows to the word: the
    // name's line clamp gives the card no width of its own, and the word was
    // cut at the card's edge (MDN scrollWidth: the content's whole width).
    for (const name of strip.querySelectorAll<HTMLElement>('.v2-card-name')) {
      const over = name.scrollWidth - name.clientWidth;
      const card = name.parentElement;
      if (over > 1 && card) card.style.width = `${Math.ceil(card.offsetWidth + over)}px`;
    }
    // A catalog's row of cards spans the panel's flexible track, which gives
    // the panel no width of its own (CSS Grid intrinsic sizing): the panel
    // takes the row's whole width, up to the room. A rule held it to 1100 px.
    const row = cardRows()[0];
    drawer.style.minWidth = row ? `${Math.floor(Math.min(room, row.scrollWidth + drawer.offsetWidth - row.clientWidth))}px` : '';
    fadeAll();
    // The modes keep their names while they fit; when they do not, only the
    // one in use keeps its name (the others show the icon, the name in the
    // tooltip); tighter still, none does. Past that the row scrolls: a mode
    // never hides under the close button (8 modes in 284 px, 2026-10-10).
    tabs.classList.remove('compact', 'tight');
    if (!tabs.hidden && tabs.scrollWidth > head.clientWidth - 8) tabs.classList.add('compact');
    if (!tabs.hidden && tabs.scrollWidth > head.clientWidth - 8) tabs.classList.add('tight');
  }
  window.addEventListener('resize', () => fitDrawer());

  /** The tool's hint as the game last said it (`onHint`); the Builder's own while it is in hand. */
  let gameHintText = '';
  function updateHint(): void {
    const text = tool() === 'building' ? builder?.hint ?? '' : gameHintText;
    if (hint.textContent !== text) hint.textContent = text;
  }

  // The HUD: the city's numbers as the game computes them (`updateStatus`,
  // a few times a second while the city runs), written only when they change.
  const showStatus = (now: ShellStatus): void => {
    status = now;
    if (clockText.data !== now.clock) clockText.data = now.clock;
    const line = [now.vehicles, now.people].filter(Boolean).join('  ·  ');
    if (statsText.data !== line) statsText.data = line;
    syncImpossible(now.impossible);
    syncMoney(now.balance);
    if (popId === 'sim') syncMetrics();
  };
  deps.onStatus(showStatus);
  const syncSpeed = (): void => {
    const active = game.paused ? 0 : game.speed;
    for (const b of speedButtons) {
      const on = Number(b.dataset['speed']) === active;
      if (b.classList.contains('on') !== on) b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    }
  };
  const syncHistory = (): void => {
    undo.disabled = !game.canUndo;
    redo.disabled = !game.canRedo;
  };
  // The game's answers - saved, refused, undone, a road that cannot be laid -
  // appear a moment above the dock, and a one-shot choice they end (the block
  // grid laid) is redrawn.
  const toast = el('div', 'v2-toast');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.hidden = true;
  root.appendChild(toast);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  deps.onHint((text, flash) => {
    if (!flash) {
      gameHintText = text;
      updateHint();
      return;
    }
    if (!text) return;
    toast.textContent = text;
    toast.hidden = false;
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; toastTimer = null; }, 2400);
    later();
  });
  function syncSide(): void {
    const roadSide = game.inspectorOpen;
    if (side.hidden === roadSide) side.hidden = !roadSide;
    const builderSide = !(builderInspector?.hidden ?? true);
    root.classList.toggle('has-side', roadSide || builderSide);
  }

  // Redrawn when the game's state changes (told once a frame, `gameState.flush`),
  // at the next frame, once however many changes came.
  let pending = false;
  const later = (): void => {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      render();
    });
  };
  deps.game.watch(['sky'], syncSky);
  deps.game.watch(['paused', 'speed'], syncSpeed);
  // An undo or a load changes the map's own numbers (the fog, the weather, the biome) under the panel.
  deps.game.watch(['canUndo', 'canRedo'], () => { syncHistory(); later(); });
  deps.game.watch(['inspectorOpen'], () => { syncSide(); later(); });
  // What the panels show: the tool in hand and each tool's settings.
  deps.game.watch(['tool', 'roadTypeIndex', 'alignment', 'roadHeightOffset', 'roadLanePreset', 'terrainMode', 'barrierKind',
    'zoneUse', 'zoneDensity', 'zoneEraser', 'zoneMode', 'lotSplitKind', 'lotSplitParts'], later);
  // The brush's numbers, stepped from the keyboard ([ ] { }) or by a mode's own hardness: the sliders follow, not rebuilt.
  deps.game.watch(['terrainRadius', 'terrainStrength', 'terrainHardness', 'roundaboutRadius'], syncRanges);
  deps.game.watch(['congestionOverlay', 'perspective', 'quality'], () => { if (popId) fillPop(popId); });
  syncSky();
  syncSpeed();
  syncHistory();
  // The Builder reports its state whenever it marks it changed - a hint, a
  // drag, a selection (`buildingsWiring.ts` refresh, `dirty`): the panel is
  // rebuilt only when what it shows has changed - it was rebuilt, fifty cards
  // and all, on every report. The same state handed again means its pictures arrived.
  let builderSig = '';
  const sigOf = (s: BuilderState): string => JSON.stringify([s.category, s.tool, s.armed, [...s.ready].sort().join(','), s.floor, s.snap, s.grid, s.hideOthers,
    s.selection, s.planning, s.planPoints, s.userBlueprints.map((b) => b.key), s.pattern, s.scope, s.roof, s.material, s.drawAction, s.inspectorOpen]);
  workspace.subscribe((state) => {
    const same = state === builder;
    builder = state;
    if (tool() !== 'building') return;
    const sig = sigOf(state);
    if (same || sig !== builderSig) {
      builderSig = sig;
      later();
    }
  });
  onLanguageChange(() => {
    impossibleShown = -1;
    moneyShown = NaN;
    if (status) showStatus(status);
    for (const [b, key] of [[undo, 'action.undo'], [redo, 'action.redo'], [menuB, 'builder.menu.app'], [simB, 'builder.menu.simulation'], [camB, 'camera.label'], [helpB, 'builder.help'], [layersB, 'v2.layers'],
      ...skyButtons.map((s) => [s, `sky.${s.dataset['sky'] ?? 'day'}`] as const)] as const) {
      const s = b.querySelector('span');
      if (s) s.textContent = t(key);
      b.title = t(key);
      delete b.dataset['tip'];
    }
    syncInside();
    if (popId) fillPop(popId);
    later();
  });
  // A road key rebound: the tool's options name it again.
  onRoadKeysChange(() => render());
  render();
  return {
    openTool(next) {
      open = true;
      if (tool() !== next) deps.pickTool(next);
      render();
    },
    toolKeyed(next) {
      open = next === 'inspect' || tool() !== 'inspect';
      later();
    },
    addToBar(control) {
      actionsBar.insertBefore(control, helpB);
    },
  };
}
