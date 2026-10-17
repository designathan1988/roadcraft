import type { Object3D } from 'three';
import type { PoleId, SpanId } from '@world/ids';
import { POLE_HEIGHT } from '@world/utilities';
import { m } from '@world/units';
import type { NearBaker, NearProduct } from './nearTileBake';
import { type PartShape, type PoleBake, type PoleSource, bakePoles, partShape, poleBakeBuffers } from './poleBake';
import { PoleLayer } from './poleLayer';
import type { SceneryKit } from './scenery';
import { WIRE_FADE, WIRE_WIDTH, poleGroundAt, polePartSpecs } from './utilities';

/** A TILE'S POLES AND WIRES AS A NEAR PRODUCT (`nearTiles.ts`): baked in a worker from the tile and its neighbours (`bakePoles`, the same placing as the page's layer), drawn as a layer of its own (`PoleLayer.fromBake`) */

/** What a pole bake reads from the page: each part's box (`partShape`, the catalogue's shapes). */
export interface PoleExtra {
  readonly shapes: readonly PartShape[];
}

/** THE TILE'S OWN POLES PLACED, ITS OWN SPANS STRUNG: a span's end on a neighbour's pole framed by every span there (the 3 x 3 read), its parts drawn by that neighbour's bake; each pole and span in one tile's records, so two tiles side by side never draw one twice nor leave one out */
export const poleBaker: NearBaker<PoleBake | null, PoleExtra> = {
  parts: ['roads', 'rest'],
  around: true,
  // A pole stands on the footway or the ground under it; its lamp's pool lies on the street beside it.
  groundReach: m(16),
  bake(area, extra) {
    const tile = area.tile;
    if (!tile.poles.length && !tile.poleSpans.length) return null;
    const doc = area.doc();
    const net = area.net();
    const groundAt = poleGroundAt(area.elevation(), area.groundAt, net);
    const own = new Set<PoleId>(tile.poles.map((p) => p.id as PoleId));
    const strung = new Set<SpanId>(tile.poleSpans.map((s) => s.id as SpanId));
    const source: PoleSource = {
      poles: doc.poles, spans: doc.poleSpans, spansAt: (id) => doc.spansAt(id),
      draws: (pole) => own.has(pole.id),
      stands: (pole) => own.has(pole.id) || doc.spansAt(pole.id).some((s) => strung.has(s.id)),
      strings: (span) => strung.has(span.id),
    };
    // DO NOT file a tile's poles in the world's cells of 256 m: sixteen cells of twelve meshes each, ~200 objects a tile walked by three's render and its shadow passes every frame (conf25's move, 2026-10-17); one cell, one mesh a part, a tile.
    const bake = bakePoles(net, groundAt, source, extra.shapes, () => area.key);
    return bake.cells.length ? bake : null;
  },
  buffers: (bake) => (bake ? poleBakeBuffers(bake) : []),
};

/** A tile's poles as the page draws them: each tile's layer under `parent`, viewed by its own cells. */
export function poleProduct(kit: SceneryKit, parent: Object3D): NearProduct<PoleBake> {
  const specs = polePartSpecs(kit);
  const shapes = specs.map((spec) => partShape(spec.geometry));
  const mast = shapes[0] ? [...shapes[0]].sort((p, q) => q - p) : [POLE_HEIGHT, m(0.36)];
  return {
    kind: 'poles',
    // As far as a mast or a wire shows: a mast while it covers a pixel (`PartStore.view`), a wire until it fades (`wireLevel`).
    cover: Math.max(mast[0]! * mast[1]!, (WIRE_WIDTH / WIRE_FADE[1]) ** 2),
    top: POLE_HEIGHT,
    extra: (): PoleExtra => ({ shapes }),
    land(bake) {
      const layer = PoleLayer.fromBake(kit, bake);
      return {
        put: () => parent.add(layer.group),
        remove: () => { parent.remove(layer.group); layer.dispose(); },
      };
    },
  };
}
