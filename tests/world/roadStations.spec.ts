import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { type StationHint, buildRoadElevation, roadStations, roadsToRead } from '@world/elevation';
import type { SegmentId } from '@world/ids';

/** THE GROUND UNDER THE ROADS READ OFF THE PAGE (`elevation.ts` roadStations, roadsToRead, the solve's hints): a solve with the roads' ground read elsewhere is the solve that reads it itself */

const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);
const fixture = (): RoadDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);

describe('the ground under the roads read off the page', () => {
  it('gives the same heights as the solve reading it, and only the roads an edit reaches are read again', () => {
    const doc = fixture();
    const net = new Network(doc);
    net.rebuild();
    const all = roadsToRead(net, ground, null);
    expect(all).toHaveLength(net.ribbons.size);
    // Read elsewhere (here, as the worker reads it), handed to the solve.
    const hints = new Map<SegmentId, StationHint>();
    for (const r of all) hints.set(r.id, { xy: r.xy, half: r.half, ...roadStations(r.xy, r.half, ground) });
    const hinted = buildRoadElevation(net, ground, null, hints);
    const own = buildRoadElevation(net, ground, null);
    for (const id of net.ribbons.keys()) {
      const line = net.ribbons.get(id)!.full;
      for (let s = 0; s <= line.length; s += 7) {
        const p = line.sampleAt(s).p;
        expect(hinted.onSegment(id, p.x, p.y)).toBe(own.onSegment(id, p.x, p.y));
      }
    }
    // Nothing changed: nothing to read again.
    expect(roadsToRead(net, ground, own)).toEqual([]);
    // A road added: it, and the roads of the node it starts from, read again.
    const first = [...doc.nodes.values()][0]!;
    const far = doc.addNode({ x: first.x + 40, y: first.y - 260 });
    doc.addSegment(first.id, far.id, 2);
    net.rebuild();
    const again = roadsToRead(net, ground, own);
    expect(again.length).toBeGreaterThan(0);
    expect(again.length).toBeLessThan(all.length);
    // A hint for another line is not taken: the solve reads that road itself.
    const wrong = new Map<SegmentId, StationHint>([[all[0]!.id, { ...hints.get(all[0]!.id)!, xy: new Float64Array(4) }]]);
    const safe = buildRoadElevation(net, ground, null, wrong);
    const fresh = buildRoadElevation(net, ground, null);
    const line = net.ribbons.get(all[0]!.id)!.full;
    const p = line.sampleAt(line.length / 2).p;
    expect(safe.onSegment(all[0]!.id, p.x, p.y)).toBe(fresh.onSegment(all[0]!.id, p.x, p.y));
  });
});
