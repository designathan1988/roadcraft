import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { RoadTop } from '@editor/roadTop';
import { m } from '@world/units';

/** The highest road of the map (`editor/roadTop.ts`) */
function town(): { doc: RoadDoc; net: Network; top: RoadTop; ids: number[] } {
  const doc = new RoadDoc();
  const net = new Network(doc);
  // Twelve short streets spread over a few kilometres: many cells apart.
  const ids: number[] = [];
  for (let k = 0; k < 12; k++) {
    const x = m(-3000 + k * 500), y = m(((k % 3) - 1) * 1500);
    const a = doc.addNode({ x, y }, m(k));
    const b = doc.addNode({ x: x + m(80), y }, m(k));
    doc.addSegment(a.id, b.id, 1);
    ids.push(a.id, b.id);
  }
  net.rebuild();
  // The solved height: the node's own authored height at that point.
  const heightAt = (x: number, y: number): number => {
    for (const node of doc.nodes.values()) if (node.x === x && node.y === y) return node.heightOffset;
    return 0;
  };
  return { doc, net, top: new RoadTop(doc, net, heightAt), ids };
}

/** The highest node on a road (a node left without roads is not drawn). */
const highest = (doc: RoadDoc): number => Math.ceil(Math.max(...[...doc.nodes.values()].filter((n) => n.incident.length > 0).map((n) => n.heightOffset)));

describe('the highest road', () => {
  it('is the highest node at first, and after each edit only the cells it reached are read', () => {
    const { doc, net, top, ids } = town();
    expect(top.height()).toBe(highest(doc));
    const cellsAtFirst = top.lastComputes;
    expect(cellsAtFirst).toBeGreaterThan(6);

    // A far, low node raised over everything.
    doc.setNodeHeightOffset(ids[0] as never, m(40));
    net.rebuild();
    expect(top.height()).toBe(highest(doc));
    expect(top.lastComputes).toBeLessThanOrEqual(4);

    // The highest street taken away: the top falls to the next.
    const highestSegment = doc.requireNode(ids[0] as never).incident[0]!;
    // (`pruneOrphanNodes` writes the whole map in the diary: not used here.)
    doc.removeSegment(highestSegment);
    net.rebuild();
    expect(top.height()).toBe(highest(doc));
    expect(top.lastComputes).toBeLessThanOrEqual(4);

    // Nothing changed: nothing read.
    expect(top.height()).toBe(highest(doc));
    expect(top.lastComputes).toBe(0);
  });

  it('starts again from the whole map when the document is replaced', () => {
    const { doc, net, top } = town();
    top.height();
    const fresh = new RoadDoc();
    const a = fresh.addNode({ x: 0, y: 0 }, m(3));
    const b = fresh.addNode({ x: m(50), y: 0 }, m(3));
    fresh.addSegment(a.id, b.id, 1);
    doc.replaceWith(fresh);
    net.rebuild();
    expect(top.height()).toBe(highest(doc));
  });
});
