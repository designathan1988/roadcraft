import { DEFAULT_BRUSH, type ElementBrush, type ElementKind } from '@world/elements';
import { LANDSCAPE_KINDS, type LandscapeKind, type SignType } from '@world/landscape';
import { POLE_LAMP_MODES, type PoleLampMode } from '@world/utilities';
import { PAINT_KINDS, type PaintKind } from '@world/terrainPaint';
import { DEFAULT_TREE_BRUSH, type TreeBrush, type TreeKind } from '@world/trees';

/**
 * What the player has chosen in the tools' panels and the game reads when
 * the tool acts: the landscaping item the next click places, and the street
 * lights a new run of wire poles carries. Kept for the session, like the road
 * tool's parking.
 */

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const raw = typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
    if (raw && (allowed as readonly string[]).includes(raw)) return raw as T;
  } catch {
    // Not kept: the default stands.
  }
  return fallback;
}

function keep(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
  } catch {
    // Not kept between sessions; it still applies now.
  }
}

const KIND_KEY = 'roadcraft.streetscapeKind';
let kind: LandscapeKind = stored(KIND_KEY, LANDSCAPE_KINDS, 'tree');

export function streetscapeKind(): LandscapeKind {
  return kind;
}

export function setStreetscapeKind(next: LandscapeKind): void {
  kind = next;
  keep(KIND_KEY, next);
}

const LAMP_KEY = 'roadcraft.poleLamps';
let lamps: PoleLampMode = stored(LAMP_KEY, POLE_LAMP_MODES, 'alternate');

export function poleLampMode(): PoleLampMode {
  return lamps;
}

export function setPoleLampMode(next: PoleLampMode): void {
  lamps = next;
  keep(LAMP_KEY, next);
}

/** What a click of the pole tool does: build a run, or remove the pole under it. */
export const POLE_TOOL_MODES = ['build', 'remove'] as const;
export type PoleToolMode = (typeof POLE_TOOL_MODES)[number];
let poleMode: PoleToolMode = 'build';

export function poleToolMode(): PoleToolMode {
  return poleMode;
}

/** Not kept between sessions: the tool always opens building. */
export function setPoleToolMode(next: PoleToolMode): void {
  poleMode = next;
}

/** The fog brush (Paisagem > Terreno > Neblina): laying fog, or taking it away. Not kept between sessions. */
let fogErasing = false;
export function fogErase(): boolean {
  return fogErasing;
}
export function setFogErase(next: boolean): void {
  fogErasing = next;
}

/**
 * The tree brush (Paisagem > Terreno > Árvores, `world/trees.ts`): which
 * trees it plants, whether it plants a stand, one tree a click, or cuts trees
 * away, and its settings (kept between sessions).
 */
export const TREE_MODES = ['plant', 'one', 'cut'] as const;
export type TreeMode = (typeof TREE_MODES)[number];
let treeModeNow: TreeMode = 'plant';
let treeKindNow: TreeKind = 'mixed';
const TREE_BRUSH_KEY = 'roadcraft.treeBrush';
let treeBrushNow: TreeBrush = (() => {
  try { return { ...DEFAULT_TREE_BRUSH, ...((JSON.parse(localStorage.getItem(TREE_BRUSH_KEY) ?? '{}') ?? {}) as Partial<TreeBrush>) }; } catch { return DEFAULT_TREE_BRUSH; }
})();
export function treeMode(): TreeMode { return treeModeNow; }
export function setTreeMode(next: TreeMode): void { treeModeNow = next; }
export function treeKind(): TreeKind { return treeKindNow; }
export function setTreeKind(next: TreeKind): void { treeKindNow = next; }
export function treeBrush(): TreeBrush { return treeBrushNow; }
export function setTreeBrush(change: Partial<TreeBrush>): void {
  treeBrushNow = { ...treeBrushNow, ...change };
  try { localStorage.setItem(TREE_BRUSH_KEY, JSON.stringify(treeBrushNow)); } catch { /* not kept */ }
}

/** The gully brush (Paisagem > Terreno > Ravinas, `world/gullies.ts`): cutting gullies, or wiping them away. Not kept between sessions. */
let gullyErasing = false;
export function gullyErase(): boolean {
  return gullyErasing;
}
export function setGullyErase(next: boolean): void {
  gullyErasing = next;
}

/**
 * The element brush (Paisagem > Terreno > Elementos, `world/elements.ts`):
 * which kind it lays, whether it lays or erases (this kind, or every kind),
 * and each kind's own settings - a stone's brush is not a blade of grass's -
 * kept between sessions.
 */
export type ElementBrushMode = 'lay' | 'eraseKind' | 'eraseAll';
let elementKindNow: ElementKind = 'stones';
let elementModeNow: ElementBrushMode = 'lay';
const ELEMENT_BRUSH_KEY = 'roadcraft.elementBrush';
let elementBrushes: Partial<Record<ElementKind, ElementBrush>> = (() => {
  try { return (JSON.parse(localStorage.getItem(ELEMENT_BRUSH_KEY) ?? '{}') ?? {}) as Partial<Record<ElementKind, ElementBrush>>; } catch { return {}; }
})();
export function elementKind(): ElementKind { return elementKindNow; }
export function elementMode(): ElementBrushMode { return elementModeNow; }
export function setElementMode(next: ElementBrushMode): void { elementModeNow = next; }
export function elementBrush(kind: ElementKind = elementKindNow): ElementBrush {
  return { ...DEFAULT_BRUSH[kind], ...(elementBrushes[kind] ?? {}) };
}
export function setElementBrush(change: Partial<ElementBrush>): void {
  elementBrushes = { ...elementBrushes, [elementKindNow]: { ...elementBrush(), ...change } };
  try { localStorage.setItem(ELEMENT_BRUSH_KEY, JSON.stringify(elementBrushes)); } catch { /* not kept */ }
}
export function setElementKind(next: ElementKind): void {
  elementKindNow = next;
}

/** The cloud tool (Paisagem > Terreno > Nuvens): what a click does. Not kept between sessions. */
export const CLOUD_MODES = ['add', 'move', 'edit', 'remove'] as const;
export type CloudMode = (typeof CLOUD_MODES)[number];
let cloudModeNow: CloudMode = 'add';
export function cloudMode(): CloudMode {
  return cloudModeNow;
}
export function setCloudMode(next: CloudMode): void {
  cloudModeNow = next;
}
/** The next cloud's size (m), base height (m) and density (%). Kept between sessions. */
export interface CloudBrush {
  readonly size: number;
  readonly height: number;
  readonly density: number;
}
const CLOUD_BRUSH_KEY = 'roadcraft.cloudBrush';
let cloudBrushNow: CloudBrush = (() => {
  const fallback: CloudBrush = { size: 150, height: 180, density: 80 };
  try {
    const saved = JSON.parse(localStorage.getItem(CLOUD_BRUSH_KEY) ?? 'null') as Partial<CloudBrush> | null;
    if (!saved) return fallback;
    const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return { size: n(saved.size, fallback.size), height: n(saved.height, fallback.height), density: n(saved.density, fallback.density) };
  } catch { return fallback; }
})();
export function cloudBrush(): CloudBrush {
  return cloudBrushNow;
}
export function setCloudBrush(next: Partial<CloudBrush>): void {
  cloudBrushNow = { ...cloudBrushNow, ...next };
  try { localStorage.setItem(CLOUD_BRUSH_KEY, JSON.stringify(cloudBrushNow)); } catch { /* not kept */ }
}

/** The fog brush's settings: strength (%), height (m), speed (m/s). Kept between sessions. */
export interface FogBrush {
  readonly strength: number;
  readonly height: number;
  readonly speed: number;
}
const FOG_BRUSH_KEY = 'roadcraft.fogBrush';
let fogBrushNow: FogBrush = (() => {
  const fallback: FogBrush = { strength: 40, height: 24, speed: 6 };
  try {
    const saved = JSON.parse(localStorage.getItem(FOG_BRUSH_KEY) ?? 'null') as Partial<FogBrush> | null;
    if (!saved) return fallback;
    const n = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    return { strength: n(saved.strength, fallback.strength), height: n(saved.height, fallback.height), speed: n(saved.speed, fallback.speed) };
  } catch { return fallback; }
})();
export function fogBrush(): FogBrush {
  return fogBrushNow;
}
export function setFogBrush(next: Partial<FogBrush>): void {
  fogBrushNow = { ...fogBrushNow, ...next };
  try { localStorage.setItem(FOG_BRUSH_KEY, JSON.stringify(fogBrushNow)); } catch { /* not kept */ }
}

const PAINT_KEY = 'roadcraft.paintKind';
let paint: PaintKind = stored(PAINT_KEY, PAINT_KINDS, 'sand');

/** The ground the terrain brush paints in its Paint mode. */
export function paintKind(): PaintKind {
  return paint;
}

export function setPaintKind(next: PaintKind): void {
  paint = next;
  keep(PAINT_KEY, next);
}

/** Total width of the roads the road tool lays, whole metres (the 1 m subgrid), or null for the class's own. */
let width: number | null = null;
export const ROAD_WIDTH_RANGE = [6, 60] as const;

export function roadWidth(): number | null {
  return width;
}

export function setRoadWidth(next: number | null): void {
  width = next === null ? null : Math.max(ROAD_WIDTH_RANGE[0], Math.min(ROAD_WIDTH_RANGE[1], Math.round(next)));
}

/**
 * The block grid the road tool lays in one click (`editor/blocks.ts`):
 * columns, rows, centreline spacing in whole metres, and whether the next
 * click places it.
 */
export const blockGridChoice = { cols: 3, rows: 2, blockMetres: 100, angle: 0, armed: false };

/** What the sign tool puts down next: its kind and its words; and the next street name. */
export const signChoice: { type: SignType; text: string; streetName: string } = { type: 'stop', text: '', streetName: '' };

/** The demolish tool: knock a building down at once, or strike it (and streets) with a chosen force. */
export const strikeChoice: { mode: 'demolish' | 'strike' | 'shoot'; strength: number } = { mode: 'demolish', strength: 5 };

const ZONE_COLOUR_KEY = 'roadcraft.zoneColours';
let zoneColours = stored(ZONE_COLOUR_KEY, ['on', 'off'] as const, 'on') === 'on';
/** Whether zoned land is tinted with its use's colour outside the Zoning tool. */
export function zoneColoursShown(): boolean { return zoneColours; }
export function setZoneColoursShown(on: boolean): void { zoneColours = on; keep(ZONE_COLOUR_KEY, on ? 'on' : 'off'); }

const ROAD_GRID_KEY = 'roadcraft.roadGrid';
let roadGrid = stored(ROAD_GRID_KEY, ['on', 'off'] as const, 'off') === 'on';
const gridListeners = new Set<() => void>();
/**
 * Whether the universal grid (`world/grid.ts`) is drawn over the whole map,
 * with any tool (the top bar's toggle, and the road panel's Grid); the road
 * snap lands in its cells while it is.
 */
export function roadGridShown(): boolean { return roadGrid; }
export function setRoadGridShown(on: boolean): void {
  roadGrid = on;
  keep(ROAD_GRID_KEY, on ? 'on' : 'off');
  for (const listener of gridListeners) listener();
}
/** Called whenever the grid is shown or hidden (the map redrawn). */
export function onRoadGridChange(listener: () => void): void { gridListeners.add(listener); }
