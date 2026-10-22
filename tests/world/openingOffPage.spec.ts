import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { preparedCity } from '@editor/preparedCity';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { tableIn } from '@world/buildings/recordTable';
import { Network } from '@world/network';
import { networkWork } from '@world/rebuildWork';
import { rampsMeeting, rampsOfNode, walkingRise } from '@world/curbRamps';
import { bakeNetwork } from '../../src/networkBake.worker';
import { networkLines } from './support/roadDigest';

/**
 * A CITY'S OPENING OFF THE PAGE (`networkBake.worker.ts`, `curbRamps.ts`): the cooked small city's network solved as a job worker
 * solves it while the curtain is up, its bake cloned as a message clones it, and the page's own build taking it - every junction and
 * ribbon the same, number for number, as the page solving it alone (`networkLines`: every level of every junction, every ribbon's
 * centrelines and outlines), almost none solved again. And the dropped kerbs worked out region by region as they are asked (a
 * walker's point, a cell's rectangle): the same ramps and the same walking heights as every ramp of the map worked out first.
 */

function opened(): { doc: RoadDoc; data: SerializedDoc; table: ArrayBufferLike } {
  const dir = new URL('../../cooked/cities/', import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(new URL('small-7.json.gz', dir))).toString('utf8')) as SerializedDoc;
  const bytes = gunzipSync(readFileSync(new URL('small-7.table.gz', dir)));
  const table = tableIn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const doc = new RoadDoc();
  const city = preparedCity(data, table);
  doc.replaceFromJSON(city.data, { repair: false, buildingTable: table, whole: true });
  return { doc, data: city.data, table };
}

describe('a city opened off the page', () => {
  it("takes the network a worker solved, the same as the page's own", () => {
    const { doc, data, table } = opened();
    const alone = new Network(doc);
    alone.rebuild({ full: true });
    const bake = structuredClone(bakeNetwork({ data, table, generated: true }));
    const taken = new Network(doc);
    taken.offerBake(bake);
    const before = { ...networkWork };
    taken.rebuild({ full: true });
    expect(networkLines(taken)).toEqual(networkLines(alone));
    // Every junction taken as solved there, none built again on the page.
    expect(networkWork.taken - before.taken).toBeGreaterThan(0);
    expect(networkWork.built - before.built).toBe(0);
  });

  it('works the dropped kerbs out region by region, the same as all at once', () => {
    const { doc } = opened();
    const whole = new Network(doc);
    whole.rebuild();
    const ramps = [...doc.nodes.keys()].flatMap((id) => [...rampsOfNode(whole, id)]);
    expect(ramps.length).toBeGreaterThan(100);
    const lazy = new Network(doc);
    lazy.rebuild();
    for (const r of ramps) {
      expect(walkingRise(lazy, r.x + r.tx * 0.3, r.y + r.ty * 0.3, true, r.structure)).toBe(walkingRise(whole, r.x + r.tx * 0.3, r.y + r.ty * 0.3, true, r.structure));
      expect(walkingRise(lazy, r.x, r.y, false, r.structure)).toBe(walkingRise(whole, r.x, r.y, false, r.structure));
    }
    const near = (net: Network): number[] => ramps.map((r) => rampsMeeting(net, [r.x - 1, r.y - 1, r.x + 1, r.y + 1]).size);
    const fresh = new Network(doc);
    fresh.rebuild();
    expect(near(fresh)).toEqual(near(whole));
  });
});
