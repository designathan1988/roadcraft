import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { buildDefaultTown } from '@world/defaultTown';
import { buildRoadElevation } from '@world/elevation';

/**
 * The renderer digests only the blocks a road that differs reaches
 * (`RoadElevation.differences`); every block of the map was digested twice
 * on every edit (docs/performance.md #10). It must find every block a full
 * sweep finds.
 */
const ground = (x: number, y: number): number => 2 * Math.sin(x / 90) + 1.5 * Math.cos(y / 70);

describe('the differences between two solves', () => {
  it('reach every block whose digest changed, over several edits of the default town', () => {
    const doc = new RoadDoc();
    buildDefaultTown(doc);
    const net = new Network(doc);
    net.rebuild();
    let elevation = buildRoadElevation(net, ground);
    const middles = [...doc.nodes.values()].filter((n) => n.incident.length === 2);
    for (let k = 0; k < 5; k++) {
      const before = elevation;
      const at = middles[(k * 53 + 3) % middles.length]!;
      doc.addSegment(at.id, doc.addNode({ x: at.x + 30 + 7 * k, y: at.y + 35 }).id, 1 + (k % 2));
      net.rebuild();
      elevation = buildRoadElevation(net, ground);
      const where = elevation.differences!(before);
      const full: string[] = [], found: string[] = [];
      for (let x = -2400; x < 2400; x += 160) for (let y = -2400; y < 2400; y += 160) {
        if (before.digest(x, y, x + 160, y + 160) === elevation.digest(x, y, x + 160, y + 160)) continue;
        full.push(`${x},${y}`);
        if (!where || where.some((r) => r.minX <= x + 160 && r.maxX >= x && r.minY <= y + 160 && r.maxY >= y)) found.push(`${x},${y}`);
      }
      expect(found).toEqual(full);
    }
  }, 240_000);
});
