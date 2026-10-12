import type { Vec2 } from '@core/vec2';
import type { RoadDoc } from '@world/doc';
import type { Network } from '@world/network';
import { buildWalkways, type WalkGraph } from '@world/walkways';
import {
  ALONG_ROAD, JOIN, type TransitData, longestOnRoad, type TransitMode, addLine, addStop, addTrack, nearestTrack, removeLine, removeStop, removeTrack,
  setLineVehicles, setTerminal,
} from '@world/transit';
import { m } from '@world/units';
import { volumeCorners } from '@world/buildings/geometry';
import { pointInPolygon } from '@core/polygon';
import { layRun, onChartOf } from '@world/planet/charts';
import { PLANET_MAX_PIECE } from './planetFrame';

export { onCarriageway } from '@world/carriageway';
import { onCarriageway } from '@world/carriageway';

/**
 * The public transport tool (`world/transit.ts`), as Cities: Skylines II lays
 * it out: stops and stations first, tracks, then lines.
 *
 * - STOP: a click by a street puts a bus stop on its footway;
 * - TERMINAL: a click on a bus stop makes it a terminal (or not);
 * - TRACK (train or metro): clicks put the points of a run down; a double
 *   click or Enter ends it, Backspace takes the last point back, Esc drops it;
 *   an end near another track's point joins it;
 * - STATION (train or metro): a click on a track puts a station there;
 * - LINE: clicks on stops (or stations) in order; Enter or a double click
 *   makes the line, of the mode of its first stop.
 *
 * Shift-click takes away what is under the pointer: a stop, a station, a track.
 */
export type TransitToolKind = 'stop' | 'terminal' | 'track' | 'station' | 'line';

export interface TransitToolDeps {
  readonly doc: () => RoadDoc;
  readonly net: () => Network;
  /** The transport replaced, as one undo step. */
  readonly edit: (next: TransitData) => void;
  readonly hint: (key: string) => void;
  readonly redraw: () => void;
}

/** How near a click must be to a stop or a track to pick it, u. */
const PICK = m(8);
/** How near a street a bus stop can be put. */
const STOP_REACH = m(18);

export class TransitTool {
  kind: TransitToolKind = 'stop';
  rail: 'train' | 'metro' = 'train';
  /** The run of a track being laid. */
  points: Vec2[] = [];
  /** The stops of a line being made. */
  lineStops: number[] = [];
  cursor: Vec2 | null = null;
  private walkways: WalkGraph | null = null;
  private walkwaysFor = -1;

  constructor(private readonly deps: TransitToolDeps) {}

  setKind(kind: TransitToolKind, rail?: 'train' | 'metro'): void {
    this.kind = kind;
    if (rail) this.rail = rail;
    this.points = [];
    this.lineStops = [];
    this.deps.redraw();
  }

  private get data(): TransitData { return this.deps.doc().transit; }

  /** Whether a point is inside a building (a block built out over its footway). */
  private built(p: Vec2): boolean {
    // Every volume, upper floors too: a block may overhang its footway, and the way down would be under it.
    // Each on its building's chart (on the planet, `world/planet/charts.ts`).
    for (const b of this.deps.doc().buildings.all()) {
      const q = onChartOf(p, b);
      for (const v of b.volumes) if (!v.open && pointInPolygon(q, volumeCorners(b, v, m(1)))) return true;
    }
    return false;
  }

  /** The footway point by a street nearest `p`, and its road. */
  private footwayAt(p: Vec2, reach = STOP_REACH, clear = false): { x: number; y: number; segment: number } | null {
    const net = this.deps.net();
    if (!this.walkways || this.walkwaysFor !== net.revision) { this.walkways = buildWalkways(net); this.walkwaysFor = net.revision; }
    let best: { x: number; y: number; segment: number; d: number } | null = null;
    for (const way of this.walkways.ways) {
      if (way.kind !== 'footway' || way.segment === undefined) continue;
      // On the footway's chart, its segment's (on the planet).
      const hit = way.path.closestPoint(onChartOf(p, { x: way.path.xy[0]!, y: way.path.xy[1]! }));
      if (clear && this.built(hit.point)) continue;
      if (hit.distance < reach && (!best || hit.distance < best.d)) best = { x: hit.point.x, y: hit.point.y, segment: way.segment, d: hit.distance };
    }
    return best;
  }

  /** Whether a point is on a road's carriageway. */
  onRoad(p: Vec2): boolean { return onCarriageway(this.deps.net(), p); }

  /** The stop or station nearest a point within reach, of a mode if given. */
  stopAt(p: Vec2, mode?: TransitMode): number | null {
    let best: number | null = null, bestD = PICK;
    for (const s of this.data.stops) {
      if (mode && s.mode !== mode) continue;
      const q = onChartOf(p, s);
      const d = Math.hypot(s.x - q.x, s.y - q.y);
      if (d < bestD) { bestD = d; best = s.id; }
    }
    return best;
  }

  /** A track point (an end or a corner) within joining reach, or the point itself. */
  private snapTrack(p: Vec2): Vec2 {
    for (const t of this.data.tracks) {
      if (t.mode !== this.rail) continue;
      for (const q of t.points) {
        const at = onChartOf(p, q);
        if (Math.hypot(q.x - at.x, q.y - at.y) < JOIN * 2) return { x: q.x, y: q.y };
      }
    }
    const on = nearestTrack(this.data, p, JOIN * 2, this.rail);
    return on ? { x: on.x, y: on.y } : p;
  }

  click(p: Vec2, shift: boolean, double: boolean): void {
    const data = this.data;
    if (shift) {
      const stop = this.stopAt(p);
      if (stop !== null) { this.deps.edit(removeStop(data, stop)); this.deps.hint('hint.transit.removed'); return; }
      const track = nearestTrack(data, p, PICK);
      if (track) { this.deps.edit(removeTrack(data, track.track)); this.deps.hint('hint.transit.removed'); }
      return;
    }
    switch (this.kind) {
      case 'stop': {
        const at = this.footwayAt(p);
        if (!at) { this.deps.hint('hint.transit.noStreet'); return; }
        if (this.stopAt(at, 'bus') !== null) { this.deps.hint('hint.transit.taken'); return; }
        this.deps.edit(addStop(data, { mode: 'bus', x: at.x, y: at.y, segment: at.segment as never }).data);
        return;
      }
      case 'terminal': {
        const stop = this.stopAt(p, 'bus');
        if (stop === null) { this.deps.hint('hint.transit.noStop'); return; }
        const s = data.stops.find((x) => x.id === stop)!;
        this.deps.edit(setTerminal(data, stop, !s.terminal));
        return;
      }
      case 'station': {
        const on = nearestTrack(data, p, PICK * 1.5, this.rail);
        if (!on) { this.deps.hint('hint.transit.noTrack'); return; }
        if (this.stopAt(on, this.rail) !== null) { this.deps.hint('hint.transit.taken'); return; }
        // The metro's way down opens on the footway nearest the station.
        const way = this.rail === 'metro' ? this.footwayAt(on, m(120), true) : null;
        this.deps.edit(addStop(data, { mode: this.rail, x: on.x, y: on.y, track: on.track,
          ...(way ? { entrance: { x: way.x, y: way.y } } : {}) }).data);
        return;
      }
      case 'track': {
        this.points.push(this.snapTrack(p));
        if (double) this.finishTrack();
        this.deps.redraw();
        return;
      }
      case 'line': {
        const first = this.lineStops[0];
        const mode = first !== undefined ? data.stops.find((s) => s.id === first)?.mode : undefined;
        const stop = this.stopAt(p, mode);
        if (stop === null) { this.deps.hint(double ? 'hint.transit.lineShort' : 'hint.transit.noStop'); if (double) this.finishLine(); return; }
        if (this.lineStops[this.lineStops.length - 1] !== stop) this.lineStops.push(stop);
        if (double) this.finishLine();
        this.deps.redraw();
        return;
      }
    }
  }

  move(p: Vec2): void { this.cursor = p; }

  /** Enter ends a run or a line, Backspace takes the last point back, Escape drops it. True when the key was taken. */
  key(key: string): boolean {
    const drafting = this.points.length > 0 || this.lineStops.length > 0;
    if (!drafting) return false;
    if (key === 'Enter') { if (this.kind === 'track') this.finishTrack(); else this.finishLine(); return true; }
    if (key === 'Backspace') { this.points.pop(); this.lineStops.pop(); this.deps.redraw(); return true; }
    if (key === 'Escape') { this.points = []; this.lineStops = []; this.deps.redraw(); return true; }
    return false;
  }

  private finishTrack(): void {
    const pts = layTrack(this.points.filter((p, i, all) => {
      if (i === 0) return true;
      const q = onChartOf(p, all[i - 1]!);
      return Math.hypot(q.x - all[i - 1]!.x, q.y - all[i - 1]!.y) > m(1);
    }));
    this.points = [];
    if (pts.length < 2) { this.deps.hint('hint.transit.trackShort'); this.deps.redraw(); return; }
    // A train track crosses streets; it does not run down one (the metro is under them).
    if (this.rail === 'train' && longestOnRoad(pts, (q) => this.onRoad(q)) > ALONG_ROAD) {
      this.deps.hint('hint.transit.trackOnRoad');
      this.deps.redraw();
      return;
    }
    this.deps.edit(addTrack(this.data, this.rail, pts).data);
  }

  private finishLine(): void {
    const stops = this.lineStops;
    this.lineStops = [];
    if (stops.length < 2) { this.deps.hint('hint.transit.lineShort'); this.deps.redraw(); return; }
    const mode = this.data.stops.find((s) => s.id === stops[0])!.mode;
    this.deps.edit(addLine(this.data, mode, stops).data);
    this.deps.hint('hint.transit.lineMade');
  }

  /** The run being laid, to the pointer, for the scene to build as track; null when none. */
  preview(): { mode: 'train' | 'metro'; points: Vec2[] } | null {
    if (!this.points.length) return null;
    return { mode: this.rail, points: [...this.points, ...(this.cursor ? [this.snapTrack(this.cursor)] : [])] };
  }

  /** The lines laid out, for the panel. */
  lines(): TransitData['lines'] { return this.data.lines; }

  setVehicles(line: number, n: number): void { this.deps.edit(setLineVehicles(this.data, line, n)); }
  removeLine(line: number): void { this.deps.edit(removeLine(this.data, line)); }

  /** The plan over the map: tracks, lines, stops and stations, and what is being laid. */
  draw(ctx: CanvasRenderingContext2D, at: (p: Vec2) => Vec2, active: boolean): void {
    const data = this.data;
    ctx.save();
    ctx.lineJoin = ctx.lineCap = 'round';
    // Tracks are drawn in the scene as they are built - the train's on its
    // ballast, the metro's in its bore seen through the ground
    // (`render/transit.ts`) - not as lines over the map.
    // Lines: their colour, from stop to stop.
    if (active) {
      for (const line of data.lines) {
        ctx.strokeStyle = line.colour;
        ctx.globalAlpha = 0.85;
        ctx.lineWidth = 3;
        ctx.beginPath();
        line.stops.forEach((id, i) => {
          const s = data.stops.find((x) => x.id === id);
          if (!s) return;
          const q = at(s);
          if (i === 0) ctx.moveTo(q.x, q.y); else ctx.lineTo(q.x, q.y);
        });
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    // Stops and stations.
    for (const s of data.stops) {
      const q = at(s);
      const colour = s.mode === 'bus' ? '#2f7de1' : s.mode === 'metro' ? '#8a5bd6' : '#3d3328';
      ctx.fillStyle = colour;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (s.terminal) ctx.rect(q.x - 7, q.y - 7, 14, 14); else ctx.arc(q.x, q.y, s.mode === 'bus' ? 6 : 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fff';
      ctx.font = '700 9px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.mode === 'bus' ? 'B' : s.mode === 'metro' ? 'M' : 'T', q.x, q.y + 0.5);
    }
    if (!active) { ctx.restore(); return; }
    // The run being laid is built in the scene as the real track
    // (`preview`); only its points are marked here.
    for (const p of this.points) {
      const s = at(p);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(s.x, s.y, 4, 0, Math.PI * 2); ctx.fill();
    }
    // The line being made: through its stops so far, on to the pointer.
    if (this.lineStops.length) {
      ctx.strokeStyle = '#ffd34d';
      ctx.lineWidth = 4;
      ctx.beginPath();
      const pts = this.lineStops.map((id) => data.stops.find((s) => s.id === id)).filter((s): s is NonNullable<typeof s> => !!s);
      [...pts, ...(this.cursor ? [this.cursor] : [])].forEach((p, i) => { const s = at(p); if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y); });
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** A run of track as it is kept (`world/planet/charts.ts` layRun, `world/transit.ts`). */
export const layTrack = (points: readonly Vec2[]): Vec2[] => layRun(points, PLANET_MAX_PIECE);

let current: TransitTool | null = null;
/** The tool, for the game's panel (`ui/v2/shell.ts`). */
export function transitTool(): TransitTool | null { return current; }
export function setTransitTool(tool: TransitTool): void { current = tool; }
