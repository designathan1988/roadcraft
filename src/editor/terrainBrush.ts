import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import { scatter, type ElementBrush, type ElementKind } from '@world/elements';
import { oneTree, plantTrees, type TreeBrush, type TreeKind } from '@world/trees';
import type { TerrainMode } from '@world/terrain';
import type { GeologyKind, PaintKind } from '@world/terrainPaint';
import { UNITS_PER_METER, m } from '@world/units';

/**
 * THE TERRAIN BRUSH: what one dab does, for every brush of the land tool
 * (raise, lower, flatten, river, the landforms, ground paint, fog, gullies,
 * trees, elements), and the stroke that lays dabs along the pointer's path.
 *
 * A stroke is the "Space" stroke of a sculpting brush (Blender, Stroke:
 * dabs laid at a spacing that is a fraction of the radius, so a fast pointer
 * leaves no gaps), and a flatten held still keeps working, as an airbrush
 * does ("keeps applying while the button is held"). Every dab is rate
 * limited by what the last rebuild cost (`TerrainBrushHost.interval`): a dab
 * that moves the land re-solves the roads on it.
 */

/** Spacing between dabs along a stroke, a fraction of the radius. */
export const TERRAIN_SPACING = 0.2;
/** The shortest time between dabs, ms. */
export const TERRAIN_MIN_MS = 45;
/** How often a held flatten levels a little further, ms. */
export const TERRAIN_REPEAT_MS = 110;

/** A landform: a shape and its rock in one tool (`main.ts` LANDFORMS). */
export interface Landform {
  readonly mode: 'raise' | 'lower';
  readonly rock: GeologyKind;
  readonly profile?: 'dome';
}

/** Everything a dab reads of the brush in hand, read once per dab. */
export interface DabSettings {
  /** The brush (`main.ts` BrushMode): a land mode, a landform, or paint/fog/gully/trees/elements. */
  readonly mode: string;
  readonly radius: number;
  readonly strength: number;
  /** 0..95: how hard the raise/lower edge is (0 the smooth dome). */
  readonly hardness: number;
  readonly landform: Landform | undefined;
  readonly element: { readonly mode: string; readonly kind: ElementKind; readonly brush: ElementBrush };
  readonly tree: { readonly mode: string; readonly kind: TreeKind; readonly brush: TreeBrush };
  /** 0..100. */
  readonly gully: { readonly strength: number; readonly erase: boolean };
  /** Strength 0..100; height and speed in metres. */
  readonly fog: { readonly strength: number; readonly height: number; readonly speed: number; readonly erase: boolean };
  readonly paint: PaintKind;
  readonly random: () => number;
}

/**
 * How far a dab may be from its stroke's noise origin (`TerrainStamp.ox`)
 * before the stroke takes a new one: kept within the reach a piece's map has
 * past its border, so the origin is always read on the dab's own map.
 */
const NOISE_ORIGIN_REACH = m(120);

/** A stroke's noise origin for a dab at `at`, on `at`'s map (moved on to `at` when it has gone too far). */
function noiseOrigin(stroke: { origin: Vec2 } | null, at: Vec2): Vec2 | null {
  if (!stroke) return null;
  const o = stroke.origin;
  if (Math.hypot(o.x - at.x, o.y - at.y) <= NOISE_ORIGIN_REACH) return o;
  stroke.origin = { x: at.x, y: at.y };
  return stroke.origin;
}

/**
 * One dab at `at`, with no spacing or rate checks of its own; `level` the
 * flatten's target, `stroke` the stroke's id, `origin` its noise origin on
 * `at`'s map (`TerrainStamp.ox`; null: a dab of its own).
 */
export function stampTerrain(doc: RoadDoc, at: Vec2, level: number, stroke: number | null, s: DabSettings, origin: Vec2 | null = null): void {
  if (s.mode === 'elements') {
    // Elements move no height: a dab lays instances (or takes them away).
    if (s.element.mode !== 'lay') {
      doc.removeElements(at.x, at.y, s.radius, s.element.mode === 'eraseKind' ? s.element.kind : null);
      return;
    }
    const { kind, brush } = s.element;
    const reach = s.radius + brush.spacing * UNITS_PER_METER;
    const nearby = doc.elements.filter((e) => e.kind === kind && Math.abs(e.x - at.x) < reach && Math.abs(e.y - at.y) < reach);
    doc.addElements(scatter(kind, brush, at.x, at.y, s.radius, UNITS_PER_METER, s.random, nearby));
    return;
  }
  if (s.mode === 'trees') {
    // Trees move no height: a dab plants a stand (or one tree), or cuts the
    // trees away there - the woods' own too (`world/trees.ts`).
    if (s.tree.mode === 'cut') {
      doc.cutTrees(at.x, at.y, s.radius);
      return;
    }
    const { kind, brush } = s.tree;
    const reach = s.radius + brush.spacing * UNITS_PER_METER;
    const nearby = doc.trees.filter((t) => Math.abs(t.x - at.x) < reach && Math.abs(t.y - at.y) < reach);
    if (s.tree.mode === 'one') {
      const spacing = brush.spacing * UNITS_PER_METER;
      if (nearby.every((t) => Math.hypot(t.x - at.x, t.y - at.y) >= spacing)) doc.plantTrees([oneTree(kind, brush, at.x, at.y, UNITS_PER_METER, s.random)]);
      return;
    }
    doc.plantTrees(plantTrees(kind, brush, at.x, at.y, s.radius, UNITS_PER_METER, s.random, nearby));
    return;
  }
  if (s.mode === 'gully') {
    // Gullies move no height the roads read: the relief the light reads is
    // cut there (or wiped), `render/terrainRelief.ts`.
    doc.addGullyDab({
      x: at.x, y: at.y, radius: s.radius,
      strength: Math.max(0.05, Math.min(1, s.gully.strength / 100)),
      ...(s.gully.erase ? { erase: true } : {}),
    });
    return;
  }
  if (s.mode === 'fog') {
    // Fog moves no height either: a dab of mist laid, or taken away. The
    // brush's own settings go with the dab.
    doc.addFogDab({
      x: at.x, y: at.y, radius: s.radius,
      strength: Math.max(0.02, Math.min(1, s.fog.strength / 100)),
      height: s.fog.height * UNITS_PER_METER,
      speed: s.fog.speed * UNITS_PER_METER,
      ...(s.fog.erase ? { erase: true } : {}),
    });
    return;
  }
  if (s.mode === 'paint') {
    // Painting moves no height: a dab of the chosen ground, nothing re-solved.
    doc.addPaintDab({
      kind: s.paint, x: at.x, y: at.y, radius: s.radius,
      strength: Math.max(0.05, Math.min(1, s.strength / 80)),
    });
    return;
  }
  const landform = s.landform;
  const mode: TerrainMode = landform ? landform.mode : s.mode as TerrainMode;
  doc.addTerrainStamp({
    x: at.x,
    y: at.y,
    radius: s.radius,
    strength: s.strength,
    mode,
    ...(mode === 'flatten' ? { level } : {}),
    ...(stroke !== null && mode !== 'flatten' ? { stroke } : {}),
    ...(mode === 'raise' || mode === 'lower' || mode === 'river' ? { rough: true, ...(origin ? { ox: origin.x, oy: origin.y } : {}) } : {}),
    ...(s.hardness > 0 && !landform?.profile && (mode === 'raise' || mode === 'lower') ? { hardness: s.hardness / 100 } : {}),
    ...(landform?.profile ? { profile: landform.profile } : {}),
  });
  // The landform's rock, under the whole dab: a little wider than the dab,
  // so the rock reaches the foot of its cliff.
  if (landform) doc.addPaintDab({ kind: landform.rock, x: at.x, y: at.y, radius: s.radius * 1.15, strength: 1 });
}

/** What the stroke reads of the game and does to it. */
export interface TerrainBrushHost {
  readonly doc: RoadDoc;
  /** The brush in hand, read at each dab. */
  settings(): DabSettings;
  /** The ground's height under a point (the flatten's target). */
  heightAt(at: Vec2): number;
  /** The shortest time between dabs now, ms: what the last rebuild cost, during a stroke or not. */
  interval(stroking: boolean): number;
  /** The document as it is, kept for undo, at the start of a stroke. */
  record(): void;
  redraw(): void;
}

/** A stroke being painted. */
interface Stroke {
  readonly pointer: number;
  last: Vec2;
  at: Vec2;
  readonly level: number;
  /** Wall time of the last dab, for the rate limit. */
  applied: number;
  /** The id its dabs carry, so they move the ground as one stroke (`TerrainStamp.stroke`). */
  readonly id: number;
  /** Where its dabs' noise is measured from (`TerrainStamp.ox`): its first dab, until a dab goes far from it. */
  origin: Vec2;
}

export class TerrainBrush {
  private stroke: Stroke | null = null;
  /** Drives the held-still repeat of a flatten. */
  private repeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly host: TerrainBrushHost) {}

  /** The pointer of the stroke being painted, or null. */
  get pointer(): number | null {
    return this.stroke?.pointer ?? null;
  }

  get stroking(): boolean {
    return this.stroke !== null;
  }

  /** Where the stroke's pointer is, and the level a flatten keeps (the brush ring is drawn there). */
  get at(): Vec2 | null {
    return this.stroke?.at ?? null;
  }

  get level(): number | null {
    return this.stroke?.level ?? null;
  }

  /** Starts a stroke, capturing the level target and arming the held repeat. */
  begin(pointer: number, at: Vec2): void {
    const { host } = this;
    host.record();
    let id = 1;
    for (const stamp of host.doc.terrainStamps) if (stamp.stroke !== undefined && stamp.stroke >= id) id = stamp.stroke + 1;
    this.stroke = { pointer, last: at, at, level: host.heightAt(at), applied: 0, id, origin: { x: at.x, y: at.y } };
    this.paint(at, true);
    this.disarm();
    // Only a flatten works on by being held: it levels a little further with
    // every dab. A raise, a lower or a river stroke moves the ground by its
    // strength and no more however long it is held (its dabs are one stroke),
    // so repeating them would only spend the map's dab budget.
    if (host.settings().mode === 'flatten') this.repeat = setInterval(() => {
      const stroke = this.stroke;
      if (!stroke) return;
      if (performance.now() - stroke.applied < host.interval(true)) return;
      stampTerrain(host.doc, stroke.at, stroke.level, stroke.id, host.settings(), noiseOrigin(stroke, stroke.at));
      stroke.applied = performance.now();
      host.redraw();
    }, TERRAIN_REPEAT_MS);
  }

  /**
   * Paints from the last dab to `at`, laying dabs along the way: a pointer
   * sample can jump a hundred units at speed, and dabbing only where the
   * samples landed left gaps a river ran straight through. With no stroke,
   * one dab where the pointer is.
   * @perInput Runs once a pointer move: nothing it reaches may walk the map.
   */
  paint(at: Vec2, force = false): void {
    const { host } = this;
    const stroke = this.stroke;
    const settings = host.settings();
    if (!stroke) {
      stampTerrain(host.doc, at, host.heightAt(at), null, settings);
      host.redraw();
      return;
    }
    stroke.at = at;
    const now = performance.now();
    if (!force) {
      if (now - stroke.applied < host.interval(true)) return;
      const moved = Math.hypot(at.x - stroke.last.x, at.y - stroke.last.y);
      if (moved < settings.radius * TERRAIN_SPACING) return;
    }
    const spacing = Math.max(m(1.6), settings.radius * TERRAIN_SPACING);
    const dx = at.x - stroke.last.x;
    const dy = at.y - stroke.last.y;
    const distance = Math.hypot(dx, dy);
    // Bounded, because a pointer that re-enters the canvas from far away must
    // not lay two hundred dabs in one event.
    const steps = force ? 1 : Math.min(12, Math.max(1, Math.round(distance / spacing)));
    for (let i = 1; i <= steps; i++) {
      const t = steps === 1 && force ? 1 : i / steps;
      const dab = { x: stroke.last.x + dx * t, y: stroke.last.y + dy * t };
      stampTerrain(host.doc, dab, stroke.level, stroke.id, settings, noiseOrigin(stroke, dab));
    }
    stroke.last = at;
    stroke.applied = now;
    host.redraw();
  }

  /** Ends the stroke; true when one was being painted. */
  end(): boolean {
    const was = this.stroke !== null;
    this.stroke = null;
    this.disarm();
    return was;
  }

  private disarm(): void {
    if (this.repeat !== null) {
      clearInterval(this.repeat);
      this.repeat = null;
    }
  }
}
