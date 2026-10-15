import { describe, expect, it } from 'vitest';

import { Rng } from '@core/rng';
import { greenCity, layCity, widenCityFootways } from '@editor/cityGenerator';
import { DEFAULT_CITY, planCity } from '@world/cityGen/plan';
import { JournalCursor } from '@world/derived';
import { RoadDoc } from '@world/doc';
import { LANDSCAPE_KINDS, type LandscapeKind } from '@world/landscape';
import { applyLots, planLots } from '@world/lots';
import { Network } from '@world/network';
import { m } from '@world/units';

/**
 * ITEMS PLACED IN A BATCH (`RoadDoc.addLandscapeMany`): the same items, ids and
 * order as placed one by one, in ONE diary entry naming them; and a generated
 * city's furniture and names (`greenCity`) read from the diary as the items
 * placed, never as "everything changed" - its 11,000 entries, one an item,
 * overflowed the kind's kept entries and every reader of the landscaping
 * worked out the whole map again.
 */
describe('landscaping placed in a batch', () => {
  it('is the landscaping placed one by one, in one entry naming its items', () => {
    const rng = new Rng(0xba);
    const list = Array.from({ length: 300 }, () => ({
      kind: LANDSCAPE_KINDS[Math.floor(rng.float() * LANDSCAPE_KINDS.length)]! as LandscapeKind,
      at: { x: rng.float() * m(800), y: rng.float() * m(800) },
      extra: rng.float() < 0.3 ? { text: `Rua ${Math.floor(rng.float() * 99)}` } : rng.float() < 0.3 ? { planted: Math.floor(rng.float() * 500) } : {},
    }));
    const one = new RoadDoc(), many = new RoadDoc();
    const v1 = one.changes.version, v2 = many.changes.version;
    const placed = list.map((p) => one.addLandscape(p.kind, p.at, p.extra));
    const batch = many.addLandscapeMany(list);
    expect(batch).toEqual(placed);
    expect([...many.landscape.values()]).toEqual([...one.landscape.values()]);
    expect(many.toJSON()).toEqual(one.toJSON());
    const entries = many.changes.since(v2, ['landscape'])!;
    expect(entries.length).toBe(1);
    expect(entries[0]!.ids).toEqual(placed.map((item) => item.id));
    expect(entries[0]!.rects).toEqual(one.changes.since(v1, ['landscape'])!.flatMap((e) => e.rects!));
  });

  it('a generated city\'s furniture and names reach a reader as the items placed', () => {
    const plan = planCity({ ...DEFAULT_CITY, seed: 3 });
    const doc = layCity(plan);
    widenCityFootways(doc);
    const net = new Network(doc);
    net.rebuild();
    applyLots(doc, planLots(doc, net));
    const reader = new JournalCursor(['landscape'], true);
    reader.read(doc.changes);
    const before = new Set(doc.landscape.keys());
    greenCity(doc, net, 3);
    const entries = reader.read(doc.changes);
    // More items than the diary keeps entries of a kind: placed one by one, "everything changed".
    expect(doc.landscape.size).toBeGreaterThan(2048);
    expect(entries).not.toBeNull();
    const named = new Set(entries!.flatMap((e) => e.ids ?? []));
    expect(named).toEqual(new Set([...doc.landscape.keys()].filter((id) => !before.has(id))));
  });
});
