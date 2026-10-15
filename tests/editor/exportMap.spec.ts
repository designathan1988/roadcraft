// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SavedSettings } from '@editor/persistence';
import { exportToFile } from '@editor/mapExport';
import { RoadDoc } from '@world/doc';

/** SAVE MAP NEVER FAILS IN SILENCE. */

const settings: SavedSettings = {
  camera: { x: 1, y: 2, zoom: 3 }, paused: false, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false,
};

function town(): RoadDoc {
  const doc = new RoadDoc();
  let last = doc.addNode({ x: 0, y: 0 });
  for (let i = 1; i <= 60; i++) {
    const next = doc.addNode({ x: i * 40, y: (i % 3) * 7 });
    doc.addSegment(last.id, next.id, 1);
    last = next;
  }
  return doc;
}

/** The blobs the export offers, and the clicks on the download link stopped. */
function captureDownloads(): { blobs: Blob[]; clicks: number } {
  const seen = { blobs: [] as Blob[], clicks: 0 };
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { seen.blobs.push(blob as Blob); return 'blob:test'; });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { seen.clicks++; });
  return seen;
}

/** `JSON.stringify` refusing any text longer than `limit`, as V8 refuses one past its string limit. */
function limitStrings(limit: number): void {
  const real = JSON.stringify.bind(JSON);
  vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, replacer?: never, space?: never) => {
    const text = real(value, replacer, space);
    if (text !== undefined && text.length > limit) throw new RangeError('Invalid string length');
    return text;
  }) as typeof JSON.stringify);
}

afterEach(() => { vi.restoreAllMocks(); });

describe('Save map (the export to a file)', () => {
  it('writes the same session as one JSON text would, without indentation', async () => {
    const seen = captureDownloads();
    const doc = town();
    exportToFile(doc, settings);
    expect(seen.blobs).toHaveLength(1);
    const text = await seen.blobs[0]!.text();
    expect(text).not.toContain('\n');
    expect(JSON.parse(text)).toEqual(JSON.parse(JSON.stringify({ version: 2, document: doc.toJSON(), settings: { ...settings, unit: JSON.parse(text).settings.unit } })));
    expect(seen.clicks).toBe(1);
  });

  it('writes a map larger than the longest string the engine can make', async () => {
    const seen = captureDownloads();
    const doc = town();
    const whole = JSON.stringify({ version: 2, document: doc.toJSON(), settings });
    // Every node or segment fits in a string; the whole map does not.
    limitStrings(400);
    expect(whole.length).toBeGreaterThan(400);
    exportToFile(doc, settings);
    vi.restoreAllMocks();
    expect(seen.blobs).toHaveLength(1);
    expect(JSON.parse(await seen.blobs[0]!.text()).document).toEqual(JSON.parse(JSON.stringify(doc.toJSON())));
  });

  it('tells the player when the file cannot be made, and offers nothing', () => {
    const seen = captureDownloads();
    limitStrings(0);
    const failed: unknown[] = [];
    expect(() => exportToFile(town(), settings, undefined, (error) => failed.push(error))).not.toThrow();
    vi.restoreAllMocks();
    expect(failed).toHaveLength(1);
    expect(failed[0]).toBeInstanceOf(RangeError);
    expect(seen.clicks).toBe(0);
  });
});
