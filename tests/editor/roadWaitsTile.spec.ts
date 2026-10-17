import { describe, expect, it } from 'vitest';
import { RoadDoc, type TileRecords } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { generateBody } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { tileIdBase, tileKey } from '@world/tiles';
import { clearBuildingsAfterEdit } from '@editor/buildings';
import { prepareTile, preparedRecords } from '@editor/tileStore';
import { RoadTool, type RoadToolHost } from '@editor/roadTool';

/** A ROAD OVER A TILE STILL COMING IN WAITS FOR IT (conf60: "the road demolished 3 buildings", the left tile's left standing under the road, before and after a reload) */

const empty = (key: number): TileRecords => ({
  key, version: 1, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings: [], lots: [],
  lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
  next: { node: tileIdBase(key), segment: tileIdBase(key), pole: tileIdBase(key), span: tileIdBase(key), building: tileIdBase(key), lot: tileIdBase(key), landscape: tileIdBase(key), barrier: tileIdBase(key) },
});

describe('a road let go over a tile not yet in the document', () => {
  it('is laid once the tile is in, and clears the buildings under it there: on the page and in the tile written', () => {
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    const key = tileKey(0, 0);
    const hints: string[] = [];
    const host: RoadToolHost = {
      doc, net, zoom: () => 1, px: (n) => n,
      settings: () => ({ typeIndex: 1, lanes: null, alignment: 'straight', heightOffset: 0, parking: undefined, width: null, grid: false }),
      setHeight: () => {}, worldAtScreen: (x, y) => ({ x, y }), naturalHeightAt: () => 0, offerElevation: () => {},
      flash: () => {}, hint: (k) => hints.push(k), redraw: () => {},
      // As the game's: the road's edit, then the buildings it meets demolished (`buildingsWiring.ts` afterRoadEdit).
      mutate: (fn) => {
        const before = net.state;
        fn();
        net.rebuild();
        clearBuildingsAfterEdit({ doc, net, groundAt: null }, before);
      },
      // A streamed world: the tile is in once the document holds it.
      tilesIn: () => doc.hasTile(key),
    };
    const tool = new RoadTool(host);
    const at = (x: number): { x: number; y: number } => ({ x: m(x), y: m(500) });
    tool.draft = {
      start: { kind: 'free', at: at(100) }, startHeightOffset: 0, chained: false, pressedAt: at(100),
      snap: { at: at(600), guide: null, angleDeg: 0, length: m(500) } as never,
      samples: [{ at: at(100), heightOffset: 0 }, { at: at(350), heightOffset: 0 }], heightOffset: 0,
    };
    // Let go while the tile is still coming in: nothing laid yet, the player told.
    tool.up(() => at(600), true);
    expect(doc.segments.size).toBe(0);
    expect(hints).toContain('hint.road.waitTiles');
    expect(tool.preview(true)).not.toBeNull();
    // The tile comes in as the store hands it, a building of its across the road's line.
    const house = { ...generateBody('residential', m(20), m(20), 2), id: tileIdBase(key) + 1, x: m(350), y: m(500), rotation: 0 } as unknown as Building;
    doc.loadTile(preparedRecords(prepareTile({ ...empty(key), buildings: [house] }, false)));
    expect(doc.buildings.get(house.id)).toBeDefined();
    // The next frame lays it: the building under it demolished, and gone from the tile as it is written.
    (tool as unknown as { layHeld?(): boolean }).layHeld?.();
    expect(doc.segments.size).toBeGreaterThan(0);
    expect(doc.buildings.get(house.id)).toBeUndefined();
    expect(doc.tileRecords(key, 1).buildings.map((b) => (b as Building).id)).not.toContain(house.id);
  });
});
