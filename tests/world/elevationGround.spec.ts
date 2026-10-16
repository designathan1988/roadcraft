import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildRoadElevation, roadsToRead } from '@world/elevation';

/** THE ROADS ON GROUND THAT MOVED (`elevation.ts` groundMoved): after a stroke of the terrain, the roads there solved again and the others kept give the heights a whole solve on the new ground gives */

const before = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);
/** A stroke raised the land in one box. */
const box: [number, number, number, number] = [-300, -300, 300, 300];
const inBox = (x: number, y: number): boolean => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
const after = (x: number, y: number): number => before(x, y) + (inBox(x, y) ? 4 + Math.sin(x / 30) : 0);
const fixture = (): RoadDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);

describe('the roads on ground that moved', () => {
  it('are solved again there, the rest kept, as a whole solve on the new ground', () => {
    const net = new Network(fixture());
    net.rebuild();
    const previous = buildRoadElevation(net, before);
    const moved = buildRoadElevation(net, after, previous, undefined, [box]);
    const whole = buildRoadElevation(net, after);
    for (const id of net.ribbons.keys()) {
      const line = net.ribbons.get(id)!.full;
      for (let s = 0; s <= line.length; s += 5) {
        const p = line.sampleAt(s).p;
        expect(moved.onSegment(id, p.x, p.y)).toBeCloseTo(whole.onSegment(id, p.x, p.y), 9);
      }
    }
    // Only the roads under the stroke have their ground read again.
    const read = roadsToRead(net, after, previous, [box]);
    expect(read.length).toBeGreaterThan(0);
    expect(read.length).toBeLessThan(net.ribbons.size);
    expect(roadsToRead(net, after, previous, null)).toEqual([]);
  });
});
