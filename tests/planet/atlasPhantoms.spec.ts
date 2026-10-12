import { describe, expect, it } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Group, LineSegments, Mesh } from 'three';
import { TILES_PER_SIDE } from '@core/planetTiles';
import { TILE_REACH, tileCentre } from '@world/planet/atlas';
import { atlasPhantoms } from '@render/planet/atlasPhantoms';
import { borderAlong } from './_border';
import { m } from '@world/units';

/**
 * THE F9 MONITOR'S CHECK FOR PHANTOMS ACROSS THE ATLAS
 * (`render/planet/atlasPhantoms.ts`; docs/PROBLEMAS.md PL2): a triangle or a
 * line with its ends in two cells of the atlas is flagged, by the object it
 * belongs to; geometry built on one piece's map, out to its reach over the
 * border, is not. Run with `vitest.planet.config.ts`.
 */

const chart = 2 * TILES_PER_SIDE * TILES_PER_SIDE + 5 * TILES_PER_SIDE + 5;
const c = tileCentre(chart);
const next = tileCentre(chart + 1);

/** Three's position of an atlas point (x, height, -y). */
const p = (x: number, y: number): number[] => [x, 0, -y];

describe('phantoms across the atlas', () => {
  it('flags a triangle and a wire with their ends on two pieces\' cells, by name', () => {
    const root = new Group();
    const wire = new LineSegments(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([...p(c.x, c.y), ...p(next.x, next.y)], 3)));
    wire.name = 'wires';
    const tri = new Mesh(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([...p(c.x, c.y), ...p(c.x + m(5), c.y), ...p(next.x, next.y + m(5))], 3)));
    tri.name = 'roads';
    root.add(wire, tri);
    expect(atlasPhantoms(root)).toEqual([{ name: 'wires', count: 1 }, { name: 'roads', count: 1 }]);
  });

  it('passes geometry out to a piece\'s reach past its border', () => {
    const root = new Group();
    // A road's band from the piece's middle to its reach over the east border.
    const edge = borderAlong(chart, 1, 0) + TILE_REACH * 0.95;
    const band = new Mesh(new BufferGeometry().setAttribute('position', new Float32BufferAttribute([
      ...p(c.x, c.y), ...p(c.x + edge, c.y), ...p(c.x + edge, c.y + m(8)),
      ...p(c.x, c.y), ...p(c.x + edge, c.y + m(8)), ...p(c.x, c.y + m(8)),
    ], 3)));
    band.name = 'roads';
    root.add(band);
    expect(atlasPhantoms(root)).toEqual([]);
  });
});
