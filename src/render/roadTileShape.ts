import { difference, intersection, opened, union, type MultiPoly, type Poly } from '@core/clipper';
import { m } from '@world/units';
import { type SurfaceShape, type TileRect, clipToRect, surfaceShape } from './mesh/tileShape';

/**
 * THE SHAPES OF ONE TILE OF THE ROADS' SURFACES (`roadSurfaces.ts`): the bands
 * cut from the rings that reach it - verge, footway, kerb, asphalt, kerb ramps,
 * medians, paint - each clipped to the tile and triangulated (`tileShape.ts`).
 * Read off x and y alone: made by a worker (`roadTile.worker.ts`) or on the
 * page, the same shapes; the page reads each vertex's height and frame after.
 * Pure: no three, no DOM.
 */

/** A band thinner than twice this is a sliver of two outlines nearly meeting, not a surface. */
const SLIVER = m(0.002);

/** What each surface of a tile is made from. */
export type TileSource =
  | { readonly kind: 'band'; readonly band: 'verge' | 'footway' | 'kerb' | 'asphalt' | 'curbRamp' }
  | { readonly kind: 'median'; readonly part: 'kerb' | 'planting' | 'paved' }
  | { readonly kind: 'paint'; readonly color: string };

/** One surface of a tile, as its shape is made: its name, source, finest edge and whether it hangs skirts. */
export interface TileSpec {
  readonly name: string;
  readonly source: TileSource;
  readonly maxEdge: number;
  readonly skirts: boolean;
}

/** The rings that reach a tile, by kind, in input order. */
export interface TilePolys {
  readonly levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', readonly Poly[]>;
  readonly medians: Record<'kerb' | 'planting' | 'paved', readonly Poly[]>;
  readonly ramps: readonly Poly[];
  readonly ribbons: readonly Poly[];
  readonly quads: ReadonlyMap<string, readonly Poly[]>;
}

/** Each surface's shape on the tile, in the order of `specs`; a surface with nothing on the tile left out. */
export function tileShapes(
  into: {
    readonly levels: Record<'casing' | 'sidewalk' | 'curb' | 'asphalt', readonly Poly[]>;
    readonly medians: Record<'kerb' | 'planting' | 'paved', readonly Poly[]>;
    readonly ramps: readonly Poly[];
    readonly ribbons: readonly Poly[];
    readonly quads: ReadonlyMap<string, readonly Poly[]>;
  },
  rect: TileRect,
  specs: readonly TileSpec[],
): Map<string, SurfaceShape> {
  const merged = (list: readonly Poly[]): MultiPoly => list.length > 0 ? union([...list]) : [];
  const casing = merged(into.levels.casing);
  const sidewalk = merged(into.levels.sidewalk);
  const curb = merged(into.levels.curb);
  const asphalt = merged(into.levels.asphalt);
  const footway = difference(sidewalk, curb);
  const kerb = difference(curb, asphalt);
  // The dropped kerbs take their piece out of the footway and the kerb and
  // are a surface of their own, sloping (`world/curbRamps.ts`).
  const ramps = merged(into.ramps);
  // Each band a difference of two outlines that meet edge to edge: where they
  // nearly do (a leg drawn in a pass of its own, its kerb's end a fraction of
  // a millimetre off its carriageway's), a sliver joined two strips across
  // the road and was triangulated over it (AT2): opened (`core/clipper.ts`).
  const bands: Record<'verge' | 'footway' | 'kerb' | 'asphalt' | 'curbRamp', MultiPoly> = {
    verge: opened(difference(casing, sidewalk), SLIVER),
    footway: opened(ramps.length > 0 ? difference(footway, ramps) : footway, SLIVER),
    kerb: opened(ramps.length > 0 ? difference(kerb, ramps) : kerb, SLIVER),
    asphalt,
    curbRamp: ramps.length > 0 ? opened(intersection(difference(sidewalk, asphalt), ramps), SLIVER) : [],
  };
  let ribbonsOnly: MultiPoly | null = null;
  const bundle = new Map<string, SurfaceShape>();
  for (const spec of specs) {
    const source = spec.source;
    let polygons: MultiPoly;
    if (source.kind === 'band') polygons = bands[source.band];
    else if (source.kind === 'median') {
      const list = into.medians[source.part];
      polygons = list.length > 0 ? intersection(merged(list), asphalt) : [];
    } else {
      const list = into.quads.get(source.color) ?? [];
      if (list.length === 0) polygons = [];
      else {
        ribbonsOnly ??= merged(into.ribbons);
        polygons = intersection(merged(list), ribbonsOnly);
      }
    }
    const inside = polygons.length > 0 ? clipToRect(polygons, rect) : [];
    if (inside.length > 0) bundle.set(spec.name, surfaceShape(inside, spec.maxEdge, spec.skirts, rect));
  }
  return bundle;
}
