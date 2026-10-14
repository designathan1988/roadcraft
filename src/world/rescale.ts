import type { SerializedDoc } from './doc';
import { METERS_PER_UNIT } from './units';

/**
 * A map saved under another world unit, brought to this build's
 * (docs/source/ESCALA.md). Until 2026-10-10 a world unit was 0.4 m and no map said
 * so: a document without `unit` is a 0.4 m map.
 *
 * Every length is multiplied by `factor` (old metres per unit over the new):
 * positions, widths, heights, radii, a building's every measure. Angles,
 * counts, ids, shares (0..1), times and money are left alone.
 *
 * Positions scale about the origin, the map's centre.
 */

/** The unit every map saved before the field existed was made in. */
export const LEGACY_METERS_PER_UNIT = 0.4;

/** What a stored length is worth in this build's units, for a map saved with `unit`. */
export const unitFactor = (unit: unknown): number =>
  (typeof unit === 'number' && Number.isFinite(unit) && unit > 0 ? unit : LEGACY_METERS_PER_UNIT) / METERS_PER_UNIT;

type Loose = Record<string, unknown>;
const isRecord = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Positions of the map: the transform a document's points go through. */
export type PlaceFn = (x: number, y: number) => { x: number; y: number };

/** A copy of `record` with the named fields times `factor` (those that are numbers). */
function lengths<T>(record: T, factor: number, keys: readonly string[]): T {
  if (!isRecord(record)) return record;
  const out: Loose = { ...record };
  for (const key of keys) if (finite(out[key])) out[key] = (out[key] as number) * factor;
  return out as T;
}

/** A copy of `record` with its `x`/`y` (or the named pair) moved by `place`. */
function placed<T>(record: T, place: PlaceFn, xKey = 'x', yKey = 'y'): T {
  if (!isRecord(record) || !finite(record[xKey]) || !finite(record[yKey])) return record;
  const p = place(record[xKey] as number, record[yKey] as number);
  return { ...record, [xKey]: p.x, [yKey]: p.y } as T;
}

const list = <T>(v: readonly T[] | undefined, f: (item: T) => T): T[] | undefined => (Array.isArray(v) ? v.map(f) : undefined);

/** A stored building (any schema) in the new unit: its place moved, its measures scaled. */
export function rescaleBuilding(raw: unknown, factor: number, place: PlaceFn | null): unknown {
  if (!isRecord(raw)) return raw;
  const b: Loose = place ? placed(raw, place) : { ...raw };
  for (const key of ['module', 'groundHeight', 'storeyHeight']) if (finite(b[key])) b[key] = (b[key] as number) * factor;
  if (Array.isArray(b.levels)) b.levels = b.levels.map((v) => (finite(v) ? v * factor : v));
  // Schema 1 measured its plan in cells of `module`: scaling the module scales it.
  const inUnits = finite(b.schema) && b.schema >= 2;
  const plan = inUnits ? factor : 1;
  if (Array.isArray(b.volumes)) {
    b.volumes = b.volumes.map((raw) => {
      if (!isRecord(raw)) return raw;
      const v = lengths(raw, plan, ['x', 'y', 'w', 'd']);
      // Terrace and lift are heights in world units in every schema that has them.
      for (const key of ['terrace', 'lift', 'ramp']) if (finite(v[key])) v[key] = (v[key] as number) * factor;
      if (Array.isArray(v.outline)) v.outline = v.outline.map((p) => lengths(p, plan, ['x', 'y']));
      if (Array.isArray(v.roofDetails)) v.roofDetails = v.roofDetails.map((d) => lengths(d, factor, ['x', 'y', 'w', 'd', 'h']));
      if (Array.isArray(v.reliefs)) v.reliefs = v.reliefs.map((r) => lengths(r, factor, ['depth']));
      if (isRecord(v.facadeGeometry)) {
        const g: Loose = {};
        for (const [face, value] of Object.entries(v.facadeGeometry)) g[face] = lengths(value, factor, ['sill', 'pierWidth', 'pierDepth']);
        v.facadeGeometry = g;
      }
      if (Array.isArray(v.storeys)) {
        v.storeys = v.storeys.map((s) => (isRecord(s) && Array.isArray(s.spaces)
          ? { ...s, spaces: s.spaces.map((space) => lengths(space, plan, ['x', 'y', 'w', 'd'])) } : s));
      }
      return v;
    });
  }
  if (Array.isArray(b.elements)) b.elements = b.elements.map((e) => lengths(e, factor, ['x', 'y', 'w', 'd', 'z', 'h']));
  if (Array.isArray(b.cores)) b.cores = b.cores.map((c) => lengths(c, plan, ['x', 'y']));
  if (isRecord(b.furnishing)) {
    const f: Loose = {};
    for (const [level, items] of Object.entries(b.furnishing)) f[level] = Array.isArray(items) ? items.map((it) => lengths(it, factor, ['x', 'y'])) : items;
    b.furnishing = f;
  }
  return b;
}

/**
 * A serialized document in this build's unit. Returns `data` itself when it
 * already is; otherwise a copy, every length scaled (see the file's comment).
 */
export function rescaleSerializedDoc(data: SerializedDoc): SerializedDoc {
  const factor = unitFactor((data as { unit?: unknown }).unit);
  if (factor === 1) return data;
  const place: PlaceFn = (x, y) => ({ x: x * factor, y: y * factor });
  const at = <T>(r: T): T => placed(r, place);
  const scale = <T>(keys: readonly string[]) => (r: T): T => lengths(at(r), factor, keys);
  const out: Loose = { ...data, unit: METERS_PER_UNIT };
  out.nodes = data.nodes.map((n) => lengths(at(n), factor, ['heightOffset']));
  out.segments = data.segments.map((s) => {
    const seg: Loose = { ...s };
    if (isRecord(s.curve)) seg.curve = lengths(s.curve, factor, ['h']);
    if (finite(s.dashOrigin)) seg.dashOrigin = s.dashOrigin * factor;
    if (isRecord(s.section)) seg.section = lengths(s.section, factor, ['laneWidth', 'sidewalk', 'sidewalkLeft', 'sidewalkRight', 'median']);
    return seg;
  });
  out.terrain = list(data.terrain, (stamp) => {
    // A stamp's strength is a height (raise, lower, river); a flatten's is a rate, read against a height too (`terrain.ts`).
    // Its noise's origin (`ox`, `oy`) is a place of the map, moved as the stamp is.
    return lengths(placed(at(stamp), place, 'ox', 'oy'), factor, ['radius', 'strength', 'level']);
  });
  out.paint = list(data.paint, scale(['radius']));
  if (isRecord(data.fog)) {
    out.fog = { ...data.fog, dabs: list((data.fog as { dabs?: unknown[] }).dabs, scale(['radius', 'height', 'speed'])) };
  }
  if (isRecord(data.gullies)) {
    out.gullies = { ...data.gullies, dabs: list((data.gullies as { dabs?: unknown[] }).dabs, scale(['radius'])) };
  }
  out.clouds = list(data.clouds, scale(['height', 'size']));
  out.elements = list(data.elements, scale(['size']));
  out.trees = list(data.trees, scale(['height']));
  out.treeClearings = list(data.treeClearings, scale(['radius']));
  out.poles = list(data.poles, at);
  out.landscape = list(data.landscape, at);
  out.barriers = list(data.barriers, (b) => (isRecord(b) && Array.isArray(b.points) ? { ...b, points: b.points.map(at) } : b));
  out.buildings = list(data.buildings as unknown[] | undefined, (b) => rescaleBuilding(b, factor, place)) as SerializedDoc['buildings'];
  out.zones = list(data.zones, (z) => {
    if (!isRecord(z) || ![z.x0, z.y0, z.x1, z.y1].every(finite)) return z;
    const a = place(z.x0 as number, z.y0 as number), b = place(z.x1 as number, z.y1 as number);
    return { ...z, x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  });
  out.zoneMarks = list(data.zoneMarks, at);
  out.lots = list(data.lots, (lot) => (isRecord(lot) && Array.isArray(lot.corners) ? { ...lot, corners: lot.corners.map(at) } : lot));
  if (isRecord(data.transit)) {
    const t = data.transit as Loose;
    out.transit = {
      ...t,
      stops: list(t.stops as unknown[] | undefined, (s) => {
        const stop = at(s);
        return isRecord(stop) && isRecord(stop.entrance) ? { ...stop, entrance: at(stop.entrance) } : stop;
      }),
      tracks: list(t.tracks as unknown[] | undefined, (k) => (isRecord(k) && Array.isArray(k.points) ? { ...k, points: k.points.map(at) } : k)),
    };
  }
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out as unknown as SerializedDoc;
}
