import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { getHeapStatistics, setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

import { preparedCity } from '@editor/preparedCity';
import { RoadDoc, type SerializedDoc } from '@world/doc';
import { tableIn } from '@world/buildings/recordTable';
import { Network } from '@world/network';
import { buildRoadElevation, FLAT_GROUND } from '@world/elevation';
import { rampsMeeting } from '@world/curbRamps';

/**
 * WHAT THE PAGE'S WORLD HOLDS A BUILDING (report "Arquitetura para cidades grandes", "A conta de memória"): the cooked small and large
 * cities opened as the page opens them (their buildings' table, `preparedCity`), then the network built whole, its dropped kerbs, the
 * roads' heights, the open lots and the buildings by place - the JS heap and the typed arrays' memory outside it measured after a full
 * collection, system by system. What grows from the small city to the large one, divided by the buildings it gained, is what each
 * building costs the page's world: 14.5 KB before the network's rings, junctions and cell indexes were kept as runs of numbers
 * (2026-10-21), 8.7 KB after; 4.9 KB once the junctions' outer levels and the roads' levels were made again from what is kept when
 * asked (`junction/levels.ts`, `ribbons.ts` LeanRibbon), a pass's junction solved again let go, the dropped kerbs worked out by
 * region (`curbRamps.ts`) and the street furniture filed by its cell alone (`pointFiling.ts`) (2026-10-22: the city of 70,000
 * buildings' world 613 MB before, 441 MB after; the network 3.2 KB a building before, 1.7 KB after; the kerbs 0.46 KB, 0.03 KB).
 */

setFlagsFromString('--expose_gc');
const collect = runInNewContext('gc') as () => void;
/** The memory held after a full collection, collected again until it stands: the JS heap and the typed arrays' buffers. */
const memory = async (): Promise<number> => {
  let was = Infinity;
  for (let round = 0; round < 8; round++) {
    await new Promise((done) => setTimeout(done, 0));
    collect();
    const now = getHeapStatistics().used_heap_size + process.memoryUsage().arrayBuffers;
    if (Math.abs(was - now) < 64 * 1024) return now;
    was = now;
  }
  return was;
};

function cooked(name: string): { data: SerializedDoc; table: ArrayBufferLike } {
  const dir = new URL('../../cooked/cities/', import.meta.url);
  const data = JSON.parse(gunzipSync(readFileSync(new URL(`${name}.json.gz`, dir))).toString('utf8')) as SerializedDoc;
  const bytes = gunzipSync(readFileSync(new URL(`${name}.table.gz`, dir)));
  return { data, table: tableIn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) };
}

/** A cooked city opened as the page opens it, its data let go. */
function opened(name: string): RoadDoc {
  const { data, table } = cooked(name);
  const doc = new RoadDoc();
  doc.replaceFromJSON(preparedCity(data, table).data, { repair: false, buildingTable: table, whole: true });
  return doc;
}

interface Held { readonly buildings: number; readonly total: number; readonly systems: Record<string, number> }

/** A cooked city opened and its world brought up system by system, the memory each adds; everything let go before it returns. */
async function heldBy(name: string): Promise<Held> {
  const systems: Record<string, number> = {};
  let last = await memory();
  const measure = async (system: string): Promise<void> => { const now = await memory(); systems[system] = now - last; last = now; };
  const doc = opened(name);
  await measure('doc');
  const net = new Network(doc);
  net.rebuild();
  await measure('network');
  rampsMeeting(net, [0, 0, 1, 1]);
  await measure('curbRamps');
  const elevation = buildRoadElevation(net, FLAT_GROUND);
  await measure('elevation');
  doc.openLots.count(new Set());
  await measure('openLots');
  doc.buildings.near(0, 0, 1, 1);
  await measure('buildingGrid');
  expect(elevation).toBeTruthy();
  expect(net.ribbons.size).toBe(doc.segments.size);
  return { buildings: doc.buildings.size, total: Object.values(systems).reduce((a, b) => a + b, 0), systems };
}

describe("the page's world memory", () => {
  it('grows by a bounded share a building, its network included', async () => {
    const small = await heldBy('small-7');
    const large = await heldBy('large-7');
    const gained = large.buildings - small.buildings;
    const growth = (large.total - small.total) / gained;
    const per = (held: Held): string => Object.entries(held.systems).map(([system, bytes]) => `${system} ${(bytes / held.buildings).toFixed(0)}`).join(', ');
    console.log(`[pageWorldMemory] small ${small.buildings} buildings ${(small.total / 1e6).toFixed(1)} MB (${per(small)}); large ${large.buildings} buildings ${(large.total / 1e6).toFixed(1)} MB (${per(large)}); ${(growth / 1024).toFixed(2)} KB a building gained`);
    expect(large.buildings).toBeGreaterThan(small.buildings * 4);
    // 4.9 KB measured (2026-10-22; 8.7 KB before, 14.5 KB before that): a regression of the compact forms passes 5.6 KB.
    expect(growth).toBeLessThan(5.6 * 1024);
    // The network alone: ~1.7 KB a building of the large city (3.4 KB with every level of every junction and road kept, 7.9 KB before its rings were runs of numbers).
    expect(large.systems['network']! / large.buildings).toBeLessThan(2.2 * 1024);
    // The dropped kerbs of one small rectangle: its region's alone (~0.2 KB a building; 1.2 KB when every ramp of the map was worked out at the first ask).
    expect(large.systems['curbRamps']! / large.buildings).toBeLessThan(0.5 * 1024);
  }, 120_000);
});
