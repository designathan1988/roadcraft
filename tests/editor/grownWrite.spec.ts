import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { WHOLE_MAP_DEFAULTS, type WholeMapOptions, planWholeMap } from '@world/cityGen/wholeMap';
import { buildStreamTilePair } from '@editor/wholeMapTile';
import { prepareTile, preparedRecords } from '@editor/tileStore';
import { tileBuildingsOf } from '@world/growth/grownRows';
import { RoadDoc } from '@world/doc';
import type { Building } from '@world/buildings/types';

/** A TILE WRITTEN BY THE PAGE KEEPS ITS GROWN BUILDINGS AS THEIR ROWS WHILE NO EDIT TOUCHED THEM (`RoadDoc.tileRecords`, plan D4) */

const { size: _size, radius: _radius, ...base } = DEFAULT_CITY;
const options: WholeMapOptions = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 1 };

describe('a generated tile written by the page', () => {
  it('writes its untouched grown buildings back as their rows, an edited one as a record, and reads back the same buildings', () => {
    // A light tile with grown buildings: the least dense one round the origin that has some.
    const map = planWholeMap(options);
    let pick: [number, number] | null = null, heat = Infinity;
    for (let j = -3; j < 3; j++) for (let i = -3; i < 3; i++) { const h = map.tile(i, j).heat; if (h > 0.05 && h < heat) { heat = h; pick = [i, j]; } }
    const { records } = buildStreamTilePair(options, pick![0], pick![1]);
    expect(records.grown?.id.length).toBeGreaterThan(5);
    const doc = new RoadDoc();
    doc.loadTile(preparedRecords(prepareTile(records, false)));
    const before = new Map<number, Building>((tileBuildingsOf(records) as Building[]).map((b) => [b.id, b]));
    // Untouched: every grown building goes back as its row.
    const clean = doc.tileRecords(records.key, records.version);
    expect(clean.grown?.id.length).toBe(records.grown!.id.length);
    expect(clean.buildings.length).toBe(records.buildings.length);
    expect(clean.gates).toEqual(records.gates);
    // One worn (a record replaced): it alone goes as a record.
    const worn = records.grown!.id[0]!;
    doc.buildings.wear(worn as never, 0.3);
    const edited = doc.tileRecords(records.key, records.version);
    expect(edited.grown?.id).not.toContain(worn);
    expect(edited.grown?.id.length).toBe(records.grown!.id.length - 1);
    expect((edited.buildings as Building[]).map((b) => b.id)).toContain(worn);
    // Read back, the same buildings.
    const again = new Map<number, Building>((tileBuildingsOf(edited) as Building[]).map((b) => [b.id, b]));
    expect([...again.keys()].sort()).toEqual([...before.keys()].sort());
    expect(again.get(worn)!.decay).toBe(0.3);
    const other = records.grown!.id[1]!;
    expect(JSON.parse(JSON.stringify(again.get(other)))).toEqual(JSON.parse(JSON.stringify(before.get(other))));
  }, 10_000);
});
