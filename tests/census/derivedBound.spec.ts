import { describe, expect, it } from 'vitest';

import { buildLargeCityMap, buildSmallCityMap } from '@editor/smallCityMap';
import { createCoverIndex } from '@render/buildings/layerCells';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import type { SerializedDoc } from '@world/doc';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';

/**
 * WHAT IS DERIVED FROM THE MAP IS HELD ROUND THE VIEW, NOT FOR THE MAP (`viewCells.ts`): the small city and the large one (six times its
 * buildings) seen by the same camera at their centre hold about the same bytes of derived data on the CPU, the road surfaces' rings
 * (`roadSurfaceInputs.ts` `InputResidency`) and the plants' cover of the buildings (`layerCells.ts` `createCoverIndex`); and an edit
 * makes again a handful of cells, never the map. Seconds, no GPU, no browser.
 */

/** How far round the eye the view's work reaches here: the roads a build near the camera visits, the plants a cull asks about. */
const VIEW = m(400);

interface Held {
  readonly buildings: number;
  readonly roadBytes: number;
  readonly roadCells: number;
  readonly coverBytes: number;
  readonly coverCells: number;
  readonly doc: RoadDoc;
  readonly net: Network;
  readonly inputs: SurfaceInputs;
  readonly cover: ReturnType<typeof createCoverIndex>;
  readonly eye: { readonly x: number; readonly y: number };
}

/** A city with its derived data made round one camera at its centre, as a build and a plant cull near the camera ask for it. */
function heldRound(data: SerializedDoc): Held {
  const doc = RoadDoc.fromJSON(data);
  const net = new Network(doc);
  net.rebuild();
  let sx = 0, sy = 0;
  for (const node of doc.nodes.values()) { sx += node.x; sy += node.y; }
  const eye = { x: sx / doc.nodes.size, y: sy / doc.nodes.size };
  const inputs = new SurfaceInputs(null, { cpuBudget: 8 * 1048576, reach: VIEW });
  inputs.refresh(net);
  // A build near the camera: the tiles within the view visited (their rings read), the rest left as they are.
  for (const { id } of inputs.passList()) {
    for (const key of inputs.tileKeys(id)) {
      const ix = Math.floor(key / 0x1_0000) - 32768, iy = (key % 0x1_0000) - 32768;
      const cx = (ix + 0.5) * m(76.8), cy = (iy + 0.5) * m(76.8);
      if (Math.hypot(cx - eye.x, cy - eye.y) > VIEW) continue;
      inputs.wakeTile(key);
      if (inputs.hasTile(id, key)) inputs.reachOf(id, key);
    }
  }
  inputs.keepNear(eye);
  // A plant cull round the camera: every 8 m within the view asked whether a building covers it.
  const cover = createCoverIndex();
  cover.follow(doc);
  for (let x = eye.x - VIEW; x <= eye.x + VIEW; x += m(8)) for (let y = eye.y - VIEW; y <= eye.y + VIEW; y += m(8)) cover.covers(x, y);
  cover.look(eye.x, eye.y, Infinity);
  return {
    buildings: doc.buildings.size, roadBytes: inputs.residentBytes, roadCells: inputs.cells!.size,
    coverBytes: cover.cells.cpuBytes, coverCells: cover.cells.size, doc, net, inputs, cover, eye,
  };
}

describe('derived data held round the view', () => {
  it('holds about the same bytes for the small city and for the large one, and an edit makes few cells again', () => {
    const small = heldRound(buildSmallCityMap(7));
    const large = heldRound(buildLargeCityMap(7));
    console.log(JSON.stringify({
      small: { buildings: small.buildings, roadBytes: small.roadBytes, roadCells: small.roadCells, coverBytes: small.coverBytes, coverCells: small.coverCells },
      large: { buildings: large.buildings, roadBytes: large.roadBytes, roadCells: large.roadCells, coverBytes: large.coverBytes, coverCells: large.coverCells },
    }));
    expect(large.buildings).toBeGreaterThan(small.buildings * 4);
    const smallBytes = small.roadBytes + small.coverBytes, largeBytes = large.roadBytes + large.coverBytes;
    expect(smallBytes).toBeGreaterThan(0);
    // The map six times larger, the bytes the same view holds within a third of each other.
    expect(largeBytes / smallBytes).toBeGreaterThan(0.67);
    expect(largeBytes / smallBytes).toBeLessThan(1.5);

    // A building beside the eye moved a little: the cover cells it reached dropped, nothing else.
    const { doc, cover, inputs, net, eye } = large;
    const b = doc.buildings.near(eye.x - m(50), eye.y - m(50), eye.x + m(50), eye.y + m(50))[0]!;
    const before = cover.cells.work.invalidated;
    doc.buildings.put({ ...b, x: b.x + m(0.5) });
    cover.follow(doc);
    const dropped = cover.cells.work.invalidated - before;
    expect(dropped).toBeGreaterThan(0);
    expect(dropped).toBeLessThanOrEqual(9);

    // A road laid beside the eye: the tiles it made dirty visited, the cells they derive a handful.
    const derivedBefore = inputs.cells!.work.derived;
    const a = doc.addNode({ x: eye.x + m(30), y: eye.y + m(30) });
    const c = doc.addNode({ x: eye.x + m(90), y: eye.y + m(45) });
    doc.addSegment(a.id, c.id, 1);
    net.rebuild();
    inputs.refresh(net);
    for (const { id } of inputs.passList()) {
      for (const key of inputs.dirtyOf(id)?.keys ?? []) { inputs.wakeTile(key); if (inputs.hasTile(id, key)) inputs.reachOf(id, key); }
    }
    inputs.keepNear(eye);
    expect(inputs.cells!.work.derived - derivedBefore).toBeLessThanOrEqual(9);
  }, 60_000);
});
