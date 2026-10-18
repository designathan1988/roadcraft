import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import { scatter, type ElementBrush, type ElementKind } from '@world/elements';
import { oneTree, plantTrees, type TreeBrush, type TreeKind } from '@world/trees';
import type { TerrainMode } from '@world/terrain';
import type { GeologyKind, PaintKind } from '@world/terrainPaint';
import { UNITS_PER_METER, m } from '@world/units';
import { editRandom } from './editStream';

/** THE TERRAIN BRUSH: what one dab does, for every brush of the land tool */

/** Spacing between dabs along a stroke, a fraction of the radius. */
const TERRAIN_SPACING = 0.2;
/** The shortest time between dabs, ms. */
export const TERRAIN_MIN_MS = 45;
/** Where the terrain stamps' allocator stands in `RoadDoc.allocatorMarks`. */
const TERRAIN_STAMP_MARK = 6;
/** How often a held flatten levels a little further, ms. */

/** A landform: a shape and its rock in one tool (`main.ts` LANDFORMS). */
interface Landform {
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
}

/** How far a dab may be from its stroke's noise origin (`TerrainStamp.ox`) before the stroke takes a new one */
const NOISE_ORIGIN_REACH = m(120);

/** A stroke's noise origin for a dab at `at`, on `at`'s map (moved on to `at` when it has gone too far). */
function noiseOrigin(stroke: { origin: Vec2 } | null, at: Vec2): Vec2 | null {
  if (!stroke) return null;
  const o = stroke.origin;
  if (Math.hypot(o.x - at.x, o.y - at.y) <= NOISE_ORIGIN_REACH) return o;
  stroke.origin = { x: at.x, y: at.y };
  return stroke.origin;
}

/** One dab at `at`, with no spacing or rate checks of its own */
/** False: the dab's tile holds as many of its kind as it may (decision 5.1): nothing laid, the player told by the caller. */
function stampTerrain(doc: RoadDoc, at: Vec2, level: number, stroke: number | null, s: DabSettings, origin: Vec2 | null = null): boolean {
  if (s.mode === 'elements') {
    // Elements move no height: a dab lays instances (or takes them away).
    if (s.element.mode !== 'lay') {
      doc.removeElements(at.x, at.y, s.radius, s.element.mode === 'eraseKind' ? s.element.kind : null);
      return true;
    }
    const { kind, brush } = s.element;
    const reach = s.radius + brush.spacing * UNITS_PER_METER;
    // DO NOT filter `doc.elements`: every dab of a stroke walked every element of the map.
    const nearby = doc.elementsIn([at.x - reach, at.y - reach, at.x + reach, at.y + reach])
      .filter((e) => e.kind === kind && Math.abs(e.x - at.x) < reach && Math.abs(e.y - at.y) < reach);
    // By chance seeded by the document and the dab (`editStream.ts`), never `Math.random`.
    const laid = scatter(kind, brush, at.x, at.y, s.radius, UNITS_PER_METER, editRandom(doc, at.x, at.y), nearby);
    return doc.addElements(laid) === laid.length;
  }
  if (s.mode === 'trees') {
    // Trees move no height: a dab plants a stand (or one tree), or cuts the trees away there - the woods' own too
    if (s.tree.mode === 'cut') {
      return doc.cutTrees(at.x, at.y, s.radius);
    }
    const { kind, brush } = s.tree;
    const reach = s.radius + brush.spacing * UNITS_PER_METER;
    // The trees round the dab only (`RoadDoc.treesIn`), never every tree of the map.
    const nearby = doc.treesIn([at.x - reach, at.y - reach, at.x + reach, at.y + reach])
      .filter((t) => Math.abs(t.x - at.x) < reach && Math.abs(t.y - at.y) < reach);
    if (s.tree.mode === 'one') {
      const spacing = brush.spacing * UNITS_PER_METER;
      if (nearby.every((t) => Math.hypot(t.x - at.x, t.y - at.y) >= spacing)) return doc.plantTrees([oneTree(kind, brush, at.x, at.y, UNITS_PER_METER, editRandom(doc, at.x, at.y))]) === 1;
      return true;
    }
    const stand = plantTrees(kind, brush, at.x, at.y, s.radius, UNITS_PER_METER, editRandom(doc, at.x, at.y), nearby);
    return doc.plantTrees(stand) === stand.length;
  }
  if (s.mode === 'gully') {
    // Gullies move no height the roads read: the relief the light reads is cut there (or wiped), `render/terrainRelief.ts`.
    return doc.addGullyDab({
      x: at.x, y: at.y, radius: s.radius,
      strength: Math.max(0.05, Math.min(1, s.gully.strength / 100)),
      ...(s.gully.erase ? { erase: true } : {}),
    });
  }
  if (s.mode === 'fog') {
    // Fog moves no height either: a dab of mist laid, or taken away.
    return doc.addFogDab({
      x: at.x, y: at.y, radius: s.radius,
      strength: Math.max(0.02, Math.min(1, s.fog.strength / 100)),
      height: s.fog.height * UNITS_PER_METER,
      speed: s.fog.speed * UNITS_PER_METER,
      ...(s.fog.erase ? { erase: true } : {}),
    });
  }
  if (s.mode === 'paint') {
    // Painting moves no height: a dab of the chosen ground, nothing re-solved.
    return doc.addPaintDab({
      kind: s.paint, x: at.x, y: at.y, radius: s.radius,
      strength: Math.max(0.05, Math.min(1, s.strength / 80)),
    });
  }
  const landform = s.landform;
  const mode: TerrainMode = landform ? landform.mode : s.mode as TerrainMode;
  const stamp = doc.addTerrainStamp({
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
  // The landform's rock, under the whole dab: a little wider than the dab, so the rock reaches the foot of its cliff.
  if (!stamp) return false;
  // A river's water fills its whole reach: the trees standing there go with the ground it carves (a clearing, the woods' own trees too).
  if (mode === 'river') doc.cutTrees(at.x, at.y, s.radius);
  if (landform) doc.addPaintDab({ kind: landform.rock, x: at.x, y: at.y, radius: s.radius * 1.15, strength: 1 });
  return true;
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
  /** A dab refused: its tile holds as many of its kind as it may (decision 5.1). */
  refused?(): void;
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
  /** A flatten held: it levels on at every frame its interval allows (`tick`). */
  private repeat = false;

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
    // DO NOT find the next id by walking every stamp of the map at each press.
    const id = host.doc.allocatorMarks()[TERRAIN_STAMP_MARK]!;
    this.stroke = { pointer, last: at, at, level: host.heightAt(at), applied: 0, id, origin: { x: at.x, y: at.y } };
    this.paint(at, true);
    this.disarm();
    // Only a flatten works on by being held: it levels a little further with every dab.
    this.repeat = host.settings().mode === 'flatten';
  }

  /** Run from the frame (`main.ts` frame), as the game's other timed work */
  tick(now: number): boolean {
    const stroke = this.stroke;
    if (!this.repeat || !stroke) return false;
    const { host } = this;
    if (now - stroke.applied >= host.interval(true)) {
      if (!stampTerrain(host.doc, stroke.at, stroke.level, stroke.id, host.settings(), noiseOrigin(stroke, stroke.at))) host.refused?.();
      stroke.applied = now;
      host.redraw();
    }
    return true;
  }

  /** @perInput Paints from the last dab to `at`, laying dabs along the way */
  paint(at: Vec2, force = false): void {
    const { host } = this;
    const stroke = this.stroke;
    const settings = host.settings();
    if (!stroke) {
      if (!stampTerrain(host.doc, at, host.heightAt(at), null, settings)) host.refused?.();
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
    // Bounded, because a pointer that re-enters the canvas from far away must not lay two hundred dabs in one event.
    const steps = force ? 1 : Math.min(12, Math.max(1, Math.round(distance / spacing)));
    for (let i = 1; i <= steps; i++) {
      const t = steps === 1 && force ? 1 : i / steps;
      const dab = { x: stroke.last.x + dx * t, y: stroke.last.y + dy * t };
      if (!stampTerrain(host.doc, dab, stroke.level, stroke.id, settings, noiseOrigin(stroke, dab))) host.refused?.();
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
    this.repeat = false;
  }
}
