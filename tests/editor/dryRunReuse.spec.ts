import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { commitRoadPath, dryRunsReused } from '@editor/commit';
import type { RoadPathPiece } from '@editor/roadPath';
import type { Anchor } from '@editor/snap';
import { m } from '@world/units';

/** EDT-06: THE CLICK LAYS THE COPY THE DRAFT AT REST WAS JUDGED ON, when nothing moved since */

function world(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  doc.addTerrainStamp({ x: 700, y: 0, radius: 160, strength: 6, mode: 'raise' });
  // A road already there, crossed by the one drawn.
  const a = doc.addNode({ x: 300, y: -200 }, 0), b = doc.addNode({ x: 300, y: 200 }, 0);
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

const piece = (x0: number, h0: number, x1: number, h1: number): RoadPathPiece =>
  ({ start: { at: { x: x0, y: 0 }, heightOffset: h0 }, end: { at: { x: x1, y: 0 }, heightOffset: h1 }, curve: null });
const start: Anchor = { kind: 'free', at: { x: 0, y: 0 } };
const end: Anchor = { kind: 'free', at: { x: 1100, y: 0 } };
const pieces = [piece(0, 0, 500, 0), piece(500, 0, 1100, m(5))];

/** The map's forks counted: the work the click does over again. */
function counting(doc: RoadDoc): { readonly forks: number } {
  const count = { forks: 0 };
  const fork = doc.fork.bind(doc);
  doc.fork = () => { count.forks++; return fork(); };
  return count;
}

const lay = (doc: RoadDoc, net: Network, dryRun = false) =>
  commitRoadPath(doc, net, start, end, 1, pieces, null, undefined, undefined, { dryRun });

describe('the road laid at the click', () => {
  it('lays the dry run\'s copy without working it out again, the map the same as a road laid without one', () => {
    const judged = world(), direct = world();
    const forks = counting(judged.doc);
    const reused = dryRunsReused;
    expect(lay(judged.doc, judged.net, true)).toMatchObject({ committed: true });
    expect(forks.forks).toBe(1);
    const laid = lay(judged.doc, judged.net);
    expect(laid.committed).toBe(true);
    expect(forks.forks).toBe(1);
    expect(dryRunsReused).toBe(reused + 1);
    const other = lay(direct.doc, direct.net);
    expect(laid).toEqual(other);
    expect(judged.doc.toJSON()).toEqual(direct.doc.toJSON());
    expect(judged.doc.economy.balance).toBe(direct.doc.economy.balance);
    expect(judged.net.revision).toBe(direct.net.revision);
  });

  it('works it out again when the map moved since the dry run (the money, a road)', () => {
    for (const change of [
      (doc: RoadDoc) => doc.setBalance(doc.economy.balance - 1000, 'test'),
      (doc: RoadDoc) => { const p = doc.addNode({ x: -500, y: 500 }, 0), q = doc.addNode({ x: -400, y: 500 }, 0); doc.addSegment(p.id, q.id, 1); },
    ]) {
      const judged = world(), direct = world();
      expect(lay(judged.doc, judged.net, true)).toMatchObject({ committed: true });
      change(judged.doc);
      change(direct.doc);
      const forks = counting(judged.doc);
      const reused = dryRunsReused;
      lay(judged.doc, judged.net);
      expect(forks.forks).toBe(1);
      expect(dryRunsReused).toBe(reused);
      lay(direct.doc, direct.net);
      expect(judged.doc.toJSON()).toEqual(direct.doc.toJSON());
    }
  });

  it('works it out again for another road, or the same road on another solve of the ground', () => {
    const { doc, net } = world();
    expect(lay(doc, net, true).committed).toBe(true);
    const reused = dryRunsReused;
    const forks = counting(doc);
    commitRoadPath(doc, net, start, { kind: 'free', at: { x: 1000, y: 0 } }, 1, [piece(0, 0, 500, 0), piece(500, 0, 1000, m(5))]);
    expect(forks.forks).toBe(1);
    expect(dryRunsReused).toBe(reused);

    const again = world();
    commitRoadPath(again.doc, again.net, start, end, 1, pieces, null, undefined, undefined, { dryRun: true, groundSolve: null });
    const solve = {} as never;
    commitRoadPath(again.doc, again.net, start, end, 1, pieces, null, undefined, undefined, { groundSolve: solve });
    expect(dryRunsReused).toBe(reused);
  });

  it('lays the copy once: a second click works the road out again', () => {
    const { doc, net } = world();
    lay(doc, net, true);
    const reused = dryRunsReused;
    lay(doc, net);
    expect(dryRunsReused).toBe(reused + 1);
    lay(doc, net);
    expect(dryRunsReused).toBe(reused + 1);
  });
});
