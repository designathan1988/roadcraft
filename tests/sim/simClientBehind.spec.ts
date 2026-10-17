import { describe, expect, it } from 'vitest';
import { SimClient } from '@sim/host/simClient';
import type { ToSim } from '@sim/host/protocol';
import { RoadDoc, type TileRecords } from '@world/doc';
import { tileIdBase, tileKey } from '@world/tiles';
import { m } from '@world/units';
import { BLUEPRINTS } from '@world/buildings/blueprints';
import type { Building } from '@world/buildings/types';

/** A TILE WHOSE STORE IS BEHIND THE PAGE IS NOT READ FROM THE STORE BY THE SIMULATION (`SimClient.loaded`, `SimHost.tileBuildings`) */

const tileWith = (key: number, buildings: readonly Building[]): TileRecords => {
  const base = tileIdBase(key);
  return {
    key, version: 3, nodes: [], borrowedNodes: [], segments: [], poles: [], borrowedPoles: [], poleSpans: [], buildings, lots: [],
    lotKeys: [], landscape: [], barriers: [], paint: [], trees: [], elements: [],
    next: { node: base, segment: base, pole: base, span: base, building: base + buildings.length, lot: base, landscape: base, barrier: base },
  };
};

describe('a tile loaded while its store is behind the page', () => {
  it('has its buildings sent from the page and is not read from the store; one the store holds is read there', () => {
    const key = tileKey(0, 0);
    const house = { ...JSON.parse(JSON.stringify(BLUEPRINTS[0]!.body)), id: tileIdBase(key), x: m(300), y: m(300), rotation: 0 } as Building;
    const doc = new RoadDoc();
    doc.loadTile(tileWith(key, [house]));
    const sent: ToSim[] = [];
    const client = new SimClient(doc);
    (client as unknown as { worker: { postMessage(message: ToSim): void } }).worker = { postMessage: (message) => sent.push(message) };
    client.tiles('map', 2);
    let behind = true;
    client.storeBehind = () => behind;
    sent.length = 0;
    client.tile('loaded', key);
    const delta = sent.find((x) => x.type === 'delta') as Extract<ToSim, { type: 'delta' }> | undefined;
    expect(delta?.buildings.map((b) => b.id)).toEqual([house.id]);
    expect(sent.find((x) => x.type === 'tile')).toMatchObject({ event: 'loaded', key, fromPage: true });
    // The store holding the tile: the worker reads it there, nothing sent from the page.
    behind = false;
    sent.length = 0;
    client.tile('loaded', key);
    expect(sent.some((x) => x.type === 'delta')).toBe(false);
    expect(sent.find((x) => x.type === 'tile')).not.toHaveProperty('fromPage');
  });
});
