import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { DEFAULT_GULLY_AUTO, readGullyDab } from '@world/gullies';

describe('gullies laid with the brush', () => {
  it('are kept in the map with the land’s own amount: saved and loaded', () => {
    const doc = new RoadDoc();
    expect(doc.gullyAuto).toBe(DEFAULT_GULLY_AUTO);
    doc.addGullyDab({ x: 10, y: 20, radius: 60, strength: 0.7 });
    doc.addGullyDab({ x: 40, y: 20, radius: 60, strength: 0.5, erase: true });
    doc.setGullyAuto(0.6);
    const loaded = RoadDoc.fromJSON(doc.toJSON());
    expect(loaded.gullyDabs).toEqual(doc.gullyDabs);
    expect(loaded.gullyAuto).toBeCloseTo(0.6);
    expect(loaded.gullyRevision).toBeGreaterThan(0);
  });

  it('moves the revision only when something changed', () => {
    const doc = new RoadDoc();
    const before = doc.gullyRevision;
    doc.setGullyAuto(DEFAULT_GULLY_AUTO);
    doc.clearGullies();
    expect(doc.gullyRevision).toBe(before);
    doc.addGullyDab({ x: 0, y: 0, radius: 30, strength: 1 });
    expect(doc.gullyRevision).toBe(before + 1);
  });

  it('reads only well-formed dabs from a file', () => {
    expect(readGullyDab({ x: 1, y: 2, radius: 3, strength: 2 })).toEqual({ x: 1, y: 2, radius: 3, strength: 1 });
    expect(readGullyDab({ x: 1, y: 'a', radius: 3, strength: 1 })).toBeNull();
    expect(readGullyDab(null)).toBeNull();
  });
});
