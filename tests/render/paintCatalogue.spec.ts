import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { PAINT_COLOURS } from '@render/markings';
import { SurfaceInputs } from '@render/roadSurfaceInputs';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { layCity } from '@editor/cityGenerator';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import type { MarkingStyleId } from '@world/roads/markingStyle';

/**
 * THE ROADS' PAINT, MADE AT LOAD (`paintCatalogue`): every colour the roads
 * are painted in is in the catalogue, in every regional standard, on a
 * generated city with its parking and on the fixture's junctions - so the
 * road surfaces read their paint and never make a material in a frame.
 */
describe('the paint catalogue', () => {
  const cities = [
    () => layCity(planCity({ ...DEFAULT_CITY, seed: 2, size: 'small' })),
    () => RoadDoc.fromJSON(JSON.parse(readFileSync('tests/fixtures/grid-and-bends.json', 'utf8')).document),
    () => RoadDoc.fromJSON(JSON.parse(readFileSync('maps/cidade-com-estacionamento.json', 'utf8'))),
  ];
  for (const style of ['classic', 'br', 'us', 'eu'] as MarkingStyleId[]) {
    it(`holds every colour painted in the ${style} standard`, () => {
      const seen = new Set<string>();
      for (const make of cities) {
        const doc = make();
        doc.setMarkingStyle(style);
        const net = new Network(doc);
        net.rebuild();
        // Every road's and junction's paint, as the road surfaces gather it (`roadSurfaceInputs.ts`).
        const inputs = new SurfaceInputs();
        inputs.refresh(net);
        for (const color of inputs.paintedColours()) seen.add(color);
      }
      expect(seen.size).toBeGreaterThan(1);
      expect([...seen].filter((c) => !PAINT_COLOURS.includes(c))).toEqual([]);
    });
  }

  it('is what the road surfaces read, made by the renderer at load', () => {
    const surfaces = readFileSync('src/render/roadSurfaces.ts', 'utf8');
    expect(surfaces).not.toMatch(/paintMaterial\(/);
    expect(readFileSync('src/render/renderer.ts', 'utf8')).toMatch(/paint: paintCatalogue\(\),/);
  });
});
