import { type Object3D, type Ray, Vector3 } from 'three';
import { m } from '@core/units';
import type { VehicleView } from '@sim/host/simClient';
import type { LabContext } from '../labTypes';
import type { EntityRef, Hit } from './state';

/** THE GAME'S THING UNDER THE CURSOR: the vehicle or person nearest the line of sight (the simulation's views), the building the game's own pick finds
 *  (`BuildingTool.buildingAt`), the road or node (`findAnchor` through `__roadcraft.pickAtScreen`), the ground. The 3D object hit says which comes first.
 *  The game's records are read through the development probe (`window.__roadcraft`, `main.ts`): the lab is handed no document. */

/** What the inspector reads of the development probe (`main.ts` `__roadcraft`). */
export interface GameProbe {
  readonly doc?: {
    readonly buildings: { get(id: number): unknown };
    segment(id: number): unknown;
    node(id: number): unknown;
    lotsIn(rect: readonly [number, number, number, number]): readonly { readonly id: number; readonly building?: number; readonly use?: string; readonly density?: string; readonly corners: readonly { x: number; y: number }[] }[];
  };
  readonly buildings?: { buildingAt(screen: { x: number; y: number }): number | null };
  pickAtScreen?(x: number, y: number): { kind: 'node' | 'segment' | 'free'; at: { x: number; y: number }; node?: number; segment?: number; s?: number };
  lookAt?(x: number, y: number, zoom?: number): void;
  readonly camera?: { zoom: number };
}

export const gameProbe = (): GameProbe | null => (window as unknown as { __roadcraft?: GameProbe }).__roadcraft ?? null;

/** The top-level group under the scene an object hangs from (its layer), and the names on its way. */
export function namesUp(object: Object3D): string[] {
  const names: string[] = [];
  for (let o: Object3D | null = object; o && o.parent; o = o.parent) names.push(o.name || o.type);
  return names;
}

/** Three's world point (x, height, -y) as the map's (x, y, z up). */
export const toMap = (p: Vector3): { x: number; y: number; z: number } => ({ x: p.x, y: -p.z, z: p.y });

const pointRay = new Vector3();
/** How far a map point at height z lies from the ray, and how far along it. */
function offRay(ray: Ray, x: number, y: number, z: number): { off: number; along: number } {
  pointRay.set(x, z, -y);
  const along = pointRay.clone().sub(ray.origin).dot(ray.direction);
  return { off: Math.sqrt(ray.distanceSqToPoint(pointRay)), along };
}

/** The vehicle and the person nearest the line of sight, within their size, in front of what the ray met first (`before`). */
function agentsNear(ctx: LabContext, ray: Ray, before: number): EntityRef[] {
  const out: { ref: EntityRef; score: number }[] = [];
  const ground = (x: number, y: number): number => {
    try { return ctx.scene.surfaceHeightAt(x, y); } catch (error) { console.warn('lab inspector: no height', error); return 0; }
  };
  const vehicles: Iterable<VehicleView> = ctx.sim.vehicles.values();
  for (const v of vehicles) {
    const f = v.free ?? v.frames;
    const half = Math.max(m(1), (v.archetype?.length ?? m(4)) / 2);
    const { off, along } = offRay(ray, f.x, f.y, ground(f.x, f.y) + m(0.8));
    if (off < half && along > 0 && along < before + half) out.push({ ref: { kind: 'vehicle', id: v.id }, score: off / half });
  }
  for (const p of ctx.sim.pedViews) {
    const { off, along } = offRay(ray, p.x, p.y, ground(p.x, p.y) + m(0.9));
    if (off < m(0.7) && along > 0 && along < before + m(1)) out.push({ ref: { kind: 'person', id: p.id }, score: off / m(0.7) - 0.2 });
  }
  out.sort((a, b) => a.score - b.score);
  return out.slice(0, 3).map((o) => o.ref);
}

/** Every entity under a pixel, the first the one the selection takes: the layer of the 3D object hit first says which kind leads. */
export function entitiesAt(ctx: LabContext, px: number, py: number, ray: Ray | null, first: Hit | null): EntityRef[] {
  const game = gameProbe();
  const found: EntityRef[] = [];
  const agents = ray ? agentsNear(ctx, ray, first?.distance ?? Infinity) : [];
  let building: EntityRef | null = null;
  try {
    const id = game?.buildings?.buildingAt({ x: px, y: py }) ?? null;
    if (id !== null) building = { kind: 'building', id };
  } catch (error) {
    console.warn('lab inspector: buildingAt failed', error);
  }
  let road: EntityRef | null = null;
  try {
    const anchor = game?.pickAtScreen?.(px, py);
    if (anchor?.kind === 'segment' && anchor.segment !== undefined) road = { kind: 'segment', id: anchor.segment, ...(anchor.s !== undefined ? { s: anchor.s } : {}) };
    else if (anchor?.kind === 'node' && anchor.node !== undefined) road = { kind: 'node', id: anchor.node };
  } catch (error) {
    console.warn('lab inspector: pickAtScreen failed', error);
  }
  let ground: EntityRef;
  if (first?.point) { const p = toMap(first.point); ground = { kind: 'terrain', x: p.x, y: p.y }; }
  else {
    const rect = ctx.scene.gl.domElement.getBoundingClientRect();
    const p = ctx.scene.viewport.toWorld(px, py, rect.width, rect.height);
    ground = { kind: 'terrain', x: p.x, y: p.y };
  }
  const layer = first ? namesUp(first.object).join(' ') : '';
  const order: (EntityRef | null)[] = /agent-parts|procedural-people|vehicle|car-|bus|truck|bicycle|moto/.test(layer)
    ? [...agents, building, road]
    : /building/.test(layer) ? [building, ...agents, road]
      : /road-|roads-|asphalt|kerb|footway|markings|verge/.test(layer) ? [road, ...agents, building]
        : [...agents, building, road];
  for (const e of order) if (e && !found.some((f) => f.kind === e.kind && 'id' in f && 'id' in e && f.id === e.id)) found.push(e);
  if (ground) found.push(ground);
  return found;
}

/** An entity's title, its main fields and its whole record, and where it stands on the map. */
export interface EntityInfo {
  readonly title: string;
  readonly rows: readonly (readonly [string, string | number | boolean | null | undefined])[];
  readonly record: unknown;
  readonly extra?: Readonly<Record<string, unknown>>;
  readonly at: { readonly x: number; readonly y: number } | null;
}

const fixed = (v: number | undefined, d = 2): string | null => (v === undefined || !Number.isFinite(v) ? null : v.toFixed(d));

export function entityInfo(ctx: LabContext, ref: EntityRef): EntityInfo {
  const game = gameProbe();
  const doc = game?.doc;
  switch (ref.kind) {
    case 'building': {
      const b = doc?.buildings.get(ref.id) as (Record<string, unknown> & { x: number; y: number; volumes?: unknown[]; elements?: unknown[] }) | undefined;
      if (!b) return { title: `Building #${ref.id} (not found in the document)`, rows: [], record: null, at: null };
      const lots = doc?.lotsIn([b.x - m(60), b.y - m(60), b.x + m(60), b.y + m(60)]) ?? [];
      const lot = lots.find((l) => l.building === ref.id) ?? null;
      return {
        title: `Building #${ref.id}`,
        rows: [
          ['use', String(b['use'])], ['function', b['function'] ? JSON.stringify(b['function']) : null], ['position (x, y)', `${fixed(b.x)}, ${fixed(b.y)}`],
          ['rotation (rad)', fixed(b['rotation'] as number, 3)], ['volumes', b.volumes?.length ?? 0], ['elements', b.elements?.length ?? 0],
          ['ground floor / storey (m)', `${fixed(b['groundHeight'] as number)} / ${fixed(b['storeyHeight'] as number)}`], ['palette', b['palette'] as number],
          ['decay', fixed(b['decay'] as number | undefined)], ['built at (min)', b['builtAt'] as number | undefined],
          ['lot', lot ? `#${lot.id} ${lot.use ?? ''} ${lot.density ?? ''} (${lot.corners.length} corners)` : 'none'],
        ],
        record: b,
        extra: { finishes: b['materials'] ?? null, lot },
        at: { x: b.x, y: b.y },
      };
    }
    case 'segment': {
      const s = doc?.segment(ref.id) as (Record<string, unknown> & { a: number; b: number }) | undefined;
      if (!s) return { title: `Street #${ref.id} (not found)`, rows: [], record: null, at: null };
      const a = doc?.node(s.a) as { x: number; y: number } | undefined;
      const b = doc?.node(s.b) as { x: number; y: number } | undefined;
      let traffic: unknown = null;
      try { traffic = ctx.sim.segmentTraffic(ref.id as never); } catch (error) { console.warn('lab inspector: no traffic', error); }
      return {
        title: `Street (segment) #${ref.id}`,
        rows: [
          ['type', s['type'] as number], ['nodes a → b', `#${s.a} → #${s.b}`], ['direction', String(s['direction'])], ['lanes', s['lanes'] as number | null],
          ['structure', String(s['structure'])], ['curve', s['curve'] ? 'yes' : 'straight'], ['straight length', a && b ? fixed(Math.hypot(b.x - a.x, b.y - a.y)) : null],
          ['own section', s['section'] ? 'yes' : 'no'], ['parking', s['parking'] ? JSON.stringify(s['parking']) : 'none'], ['clicked position (s)', fixed(ref.s)],
        ],
        record: s,
        extra: { nodeA: a ?? null, nodeB: b ?? null, traffic },
        at: a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null,
      };
    }
    case 'node': {
      const n = doc?.node(ref.id) as (Record<string, unknown> & { x: number; y: number; incident: number[] }) | undefined;
      if (!n) return { title: `Node #${ref.id} (not found)`, rows: [], record: null, at: null };
      return {
        title: `Node #${ref.id}`,
        rows: [['position', `${fixed(n.x)}, ${fixed(n.y)}`], ['own height', fixed(n['heightOffset'] as number)], ['streets', n.incident.join(', ')], ['control', JSON.stringify(n['control'])], ['crossing', n['crossing'] ? JSON.stringify(n['crossing']) : 'no']],
        record: n,
        at: { x: n.x, y: n.y },
      };
    }
    case 'vehicle': {
      const v = ctx.sim.vehicles.get(ref.id);
      if (!v) return { title: `Vehicle #${ref.id} (left the simulation)`, rows: [], record: null, at: null };
      const f = v.free ?? v.frames;
      return {
        title: `Vehicle #${ref.id} (${v.archetype.id})`,
        rows: [
          ['type', `${v.archetype.shape}${v.archetype.style ? ` / ${v.archetype.style}` : ''}`], ['colour', v.color], ['speed', `${(v.v * 3.6).toFixed(1)} km/h`],
          ['position', `${fixed(f.x)}, ${fixed(f.y)}`], ['street', v.segment ?? '— (connector)'], ['parked', ctx.sim.isParked(v)], ['off the road', v.free ? `lot ${v.free.lot ?? '—'}` : 'no'],
          ['people', `${v.people.length} of ${v.seats}`], ['indicator', v.indicator], ['odometer', fixed(v.odometer, 0)], ['slain', v.slain],
        ],
        record: { ...v, archetype: v.archetype },
        at: { x: f.x, y: f.y },
      };
    }
    case 'person': {
      const p = ctx.sim.pedViews.find((q) => q.id === ref.id);
      if (!p) return { title: `Person #${ref.id} (left the view)`, rows: [], record: null, at: null };
      return {
        title: `Person #${ref.id}`,
        rows: [['position', `${fixed(p.x)}, ${fixed(p.y)}`], ['heading (rad)', fixed(p.heading, 3)], ['speed', `${(p.v * 3.6).toFixed(1)} km/h`], ['panic', !!p.panic], ['wound', p.wound ? `${p.wound.part}${p.wound.grave ? ' (severe)' : ''}` : 'no']],
        record: p,
        at: { x: p.x, y: p.y },
      };
    }
    case 'terrain': {
      const read = (f: () => number): string | null => { try { return fixed(f()); } catch (error) { console.warn('lab inspector: height failed', error); return null; } };
      const s = ctx.scene;
      return {
        title: `Terrain at (${ref.x.toFixed(1)}, ${ref.y.toFixed(1)})`,
        rows: [
          ['drawn terrain height', read(() => s.terrainHeightAt(ref.x, ref.y))], ['top of what is drawn', read(() => s.surfaceHeightAt(ref.x, ref.y))],
          ['ground of what is built', read(() => s.builtGroundAt(ref.x, ref.y))], ['pavement (NaN off the streets)', read(() => s.pavedHeightAt(ref.x, ref.y))],
          ['resolved road height', read(() => s.elevationAt(ref.x, ref.y))],
        ],
        record: { x: ref.x, y: ref.y },
        at: { x: ref.x, y: ref.y },
      };
    }
  }
}

/** An entity in one line (lists, the report). */
export function entityLabel(ref: EntityRef): string {
  switch (ref.kind) {
    case 'building': return `building #${ref.id}`;
    case 'segment': return `street #${ref.id}`;
    case 'node': return `node #${ref.id}`;
    case 'vehicle': return `vehicle #${ref.id}`;
    case 'person': return `person #${ref.id}`;
    case 'terrain': return `terrain (${ref.x.toFixed(1)}, ${ref.y.toFixed(1)})`;
  }
}
