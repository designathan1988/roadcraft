import { describe, expect, it } from 'vitest';
import { RoadDoc, type TileRecords } from '@world/doc';
import { Network } from '@world/network';
import { m } from '@world/units';
import { generateBody } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';
import { TILE, tileIdBase, tileKey } from '@world/tiles';
import { clearBuildingsAfterEdit } from '@editor/buildings';
import { prepareTile, preparedRecords } from '@editor/tileStore';
import { RoadTool, type RoadToolHost } from '@editor/roadTool';
import { HOLD_MOST, WorldStreamer } from '@/worldStreamer';
import { History } from '@editor/history';

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

  it('far from the camera (the map view): its tiles asked for, laid in a few frames, the buildings under it gone from the tile written', async () => {
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    // Four tiles east of the camera's, on the map: past its region and the ring kept round it.
    const far = tileKey(4, 0);
    const house = { ...generateBody('residential', m(20), m(20), 2), id: tileIdBase(far) + 1, x: 4 * TILE + m(350), y: m(500), rotation: 0 } as unknown as Building;
    const written: TileRecords[] = [];
    const streamer = new WorldStreamer(doc, {
      load: (k) => Promise.resolve(preparedRecords(prepareTile({ ...empty(k), buildings: k === far ? [house] : [] }, false))),
      write: (records) => { written.push(records); return Promise.resolve(records.version + 1); },
    });
    const host: RoadToolHost = {
      doc, net, zoom: () => 1, px: (n) => n,
      settings: () => ({ typeIndex: 1, lanes: null, alignment: 'straight', heightOffset: 0, parking: undefined, width: null, grid: false }),
      setHeight: () => {}, worldAtScreen: (x, y) => ({ x, y }), naturalHeightAt: () => 0, offerElevation: () => {},
      flash: () => {}, hint: () => {}, redraw: () => {},
      mutate: (fn) => { const before = net.state; fn(); net.rebuild(); clearBuildingsAfterEdit({ doc, net, groundAt: null }, before); },
      // As the game's (`main.ts`): the tiles the road reaches held by the streamer until it is laid.
      tilesIn: (rect) => {
        if (!rect) { streamer.hold([]); return true; }
        const keys: number[] = [];
        for (let i = Math.floor(rect[0] / TILE); i <= Math.floor(rect[2] / TILE); i++) for (let j = Math.floor(rect[1] / TILE); j <= Math.floor(rect[3] / TILE); j++) keys.push(tileKey(i, j));
        if (!streamer.hold(keys)) return 'tooFar';
        return keys.every((k) => doc.hasTile(k));
      },
    };
    const tool = new RoadTool(host);
    const at = (x: number): { x: number; y: number } => ({ x: 4 * TILE + m(x), y: m(500) });
    tool.draft = {
      start: { kind: 'free', at: at(100) }, startHeightOffset: 0, chained: false, pressedAt: at(100),
      snap: { at: at(600), guide: null, angleDeg: 0, length: m(500) } as never,
      samples: [{ at: at(100), heightOffset: 0 }, { at: at(350), heightOffset: 0 }], heightOffset: 0,
    };
    const frame = async (n: number): Promise<void> => {
      streamer.focus(0, 0);
      streamer.apply(n);
      (tool as unknown as { layHeld?(): boolean }).layHeld?.();
      await new Promise((r) => setTimeout(r, 0));
    };
    tool.up(() => at(600), true);
    let frames = 0;
    for (; frames < 40 && doc.segments.size === 0; frames++) await frame(frames);
    // Laid in a few frames, the camera never there.
    expect(doc.segments.size).toBeGreaterThan(0);
    expect(frames).toBeLessThan(40);
    expect(doc.buildings.get(house.id)).toBeUndefined();
    // Let go once laid: written as it stands now, the building gone from the store too.
    for (let k = 0; k < 40 && doc.hasTile(far); k++) await frame(100 + k);
    expect(doc.hasTile(far)).toBe(false);
    const last = written.filter((r) => r.key === far).at(-1);
    expect(last).toBeDefined();
    expect(last!.segments.length).toBeGreaterThan(0);
    expect(last!.buildings.map((b) => (b as Building).id)).not.toContain(house.id);
  });

  it(`laid in parts across eight tiles past the document, never more than ${HOLD_MOST} of them held, each written with its stretch, one undo step`, async () => {
    const doc = new RoadDoc();
    const net = new Network(doc);
    net.rebuild();
    const written = new Map<number, TileRecords>();
    const streamer = new WorldStreamer(doc, {
      load: (k) => Promise.resolve(written.get(k) ?? preparedRecords(prepareTile(empty(k), false))),
      write: (records) => { written.set(records.key, records); return Promise.resolve(records.version + 1); },
    });
    // The store's own count: four past the document held, a fifth refused.
    const row = (n: number): number[] => Array.from({ length: n }, (_, k) => tileKey(k - 4, 3));
    expect(streamer.hold(row(HOLD_MOST))).toBe(true);
    expect(streamer.hold(row(HOLD_MOST + 1))).toBe(false);
    streamer.hold([]);
    const history = new History();
    const groups: number[] = [];
    let mostHeld = 0;
    const keysIn = (rect: readonly number[]): number[] => {
      const keys: number[] = [];
      for (let i = Math.floor(rect[0]! / TILE); i <= Math.floor(rect[2]! / TILE); i++) for (let j = Math.floor(rect[1]! / TILE); j <= Math.floor(rect[3]! / TILE); j++) keys.push(tileKey(i, j));
      return keys;
    };
    const hints: string[] = [];
    const host: RoadToolHost = {
      doc, net, zoom: () => 1, px: (n) => n,
      settings: () => ({ typeIndex: 1, lanes: null, alignment: 'straight', heightOffset: 0, parking: undefined, width: null, grid: false }),
      setHeight: () => {}, worldAtScreen: (x, y) => ({ x, y }), naturalHeightAt: () => 0, offerElevation: () => {},
      flash: () => {}, hint: (k) => hints.push(k), redraw: () => {},
      mutate: (fn) => { history.begin(doc); fn(); net.rebuild(); history.end(doc); },
      // As the game's (`main.ts`): held by the streamer, cut into parts by what may come at once, one undo group.
      tilesIn: (rect) => {
        if (!rect) { streamer.hold([]); return true; }
        const keys = keysIn(rect);
        if (!streamer.hold(keys)) return 'tooFar';
        mostHeld = Math.max(mostHeld, keys.filter((k) => !doc.hasTile(k)).length);
        return keys.every((k) => doc.hasTile(k));
      },
      tilesFit: (rect) => streamer.fits(keysIn(rect)),
      undoGroup: (group) => { if (group !== null) groups.push(group); history.grouped(group); },
    };
    const tool = new RoadTool(host);
    // Across eight tiles of a row three north of the camera's, none of them in.
    const at = (x: number): { x: number; y: number } => ({ x, y: 3 * TILE + m(500) });
    tool.draft = {
      start: { kind: 'free', at: at(-4 * TILE + m(100)) }, startHeightOffset: 0, chained: false, pressedAt: at(-4 * TILE + m(100)),
      snap: { at: at(4 * TILE - m(100)), guide: null, angleDeg: 0, length: 8 * TILE } as never,
      samples: [{ at: at(-4 * TILE + m(100)), heightOffset: 0 }, { at: at(0), heightOffset: 0 }], heightOffset: 0,
    };
    tool.up(() => at(4 * TILE - m(100)), true);
    expect(hints).toContain('hint.road.waitTiles');
    let frames = 0;
    for (; frames < 400 && tool.preview(true)?.settling !== false && (tool as unknown as { held: unknown }).held; frames++) {
      streamer.focus(0, 0);
      streamer.apply(frames);
      tool.layHeld();
      await new Promise((r) => setTimeout(r, 0));
    }
    // Laid whole, in a finite time, never more than four tiles past the document held at once.
    expect((tool as unknown as { held: unknown }).held).toBeNull();
    expect(frames).toBeLessThan(400);
    expect(mostHeld).toBeLessThanOrEqual(HOLD_MOST);
    expect(hints).not.toContain('hint.road.tooFar');
    for (let k = 0; k < 40; k++) { streamer.focus(0, 0); streamer.apply(1_000 + k); await new Promise((r) => setTimeout(r, 0)); }
    // Each of the eight tiles holds its stretch, in the store or on the page.
    for (let i = -4; i < 4; i++) {
      const key = tileKey(i, 3);
      const segments = doc.hasTile(key) ? doc.tileRecords(key, 1).segments : written.get(key)?.segments ?? [];
      expect(segments.length, `tile ${i},3`).toBeGreaterThan(0);
    }
    // Its parts one undo group (`History.grouped`): one step for them all while their tiles are on the page.
    expect(new Set(groups).size).toBe(1);
  });
});
