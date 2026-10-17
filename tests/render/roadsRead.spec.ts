import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadsRead } from '@render/roadsRead';
import { RoadDoc } from '@world/doc';
import { roadsToRead } from '@world/elevation';
import { Network } from '@world/network';

/** The roads a waiting solve reads the ground under, worked out once a network revision (`roadsRead.ts`) */
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + Math.cos(y / 70);
const fixture = (): RoadDoc => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document);

describe('the roads to read, kept while the solve waits', () => {
  it('works them out once a revision, again once the network or the ground changed, never kept for a moved region', () => {
    const net = new Network(fixture());
    net.rebuild();
    let calls = 0;
    const read = new RoadsRead<ReturnType<typeof roadsToRead>>();
    const ask = (moved: [number, number, number, number][] | null) => read.of(moved ? null : [net.state, null], () => { calls++; return roadsToRead(net, ground, null, moved); });
    const first = ask(null);
    for (let frame = 0; frame < 30; frame++) expect(ask(null)).toBe(first);
    expect(calls).toBe(1);
    expect(first).toEqual(roadsToRead(net, ground, null));
    // A region of moved ground: asked each time, nothing kept.
    ask([[0, 0, 10, 10]]);
    ask(null);
    expect(calls).toBe(3);
    // The network changed: asked again.
    net.doc.removeSegment([...net.doc.segments.keys()][0]!);
    net.rebuild();
    ask(null);
    expect(calls).toBe(4);
  });
});
