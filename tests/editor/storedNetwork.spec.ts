import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CITY } from '@world/cityGen/plan';
import { WHOLE_MAP_DEFAULTS, type WholeMapOptions } from '@world/cityGen/wholeMap';
import { buildStreamTile } from '@editor/wholeMapTile';
import { prepareTile } from '@editor/tileStore';
import { networkOfSection, tileNetworkSection } from '@sim/tileSections';

/** A STORED TILE'S JUNCTIONS READ, NOT SOLVED AGAIN (`cityTile.worker.ts` storedAnswer): the region's tiles of a reopened world each solved their network in the worker though the store held it (the reopening's tiles 9 s in the workers, 2026-10-18) */

const { size: _size, radius: _radius, ...base } = DEFAULT_CITY as typeof DEFAULT_CITY & { radius?: number };
const options: WholeMapOptions = { ...base, ...WHOLE_MAP_DEFAULTS, seed: 3 };

describe("a stored tile's network", () => {
  it('read back from its section is the network solving it gives', () => {
    const records = buildStreamTile(options, 0, 0);
    const solved = prepareTile(records).network!;
    expect(solved).not.toBeNull();
    // As the store keeps the section: a JSON value, gzipped (`sectionPart`).
    const kept = JSON.parse(JSON.stringify(tileNetworkSection(solved))) as { json: unknown };
    expect(networkOfSection(kept.json)).toEqual(solved);
  });

  it('is read before the tile is prepared, and solved only where the tile has none', () => {
    const worker = readFileSync('src/cityTile.worker.ts', 'utf8');
    const answer = worker.slice(worker.indexOf('async function storedAnswer('), worker.indexOf('async function addNetwork('));
    const read = answer.indexOf('readTileSection(stored(), store.map, key, NETWORK_SECTION)');
    expect(read).toBeGreaterThan(0);
    expect(answer.indexOf('prepareTile(records, false)')).toBeGreaterThan(read);
    expect(answer.indexOf('const prepared = prepareTile(records);')).toBeGreaterThan(read);
  });
});
