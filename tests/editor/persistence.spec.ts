import { afterEach, describe, expect, it } from 'vitest';

import { type LargeStore, MAX_INTENSITY, Persistence, QUARANTINE_KEY, isSerializedDoc, normalizeSettings } from '@editor/persistence';
import { RoadDoc } from '@world/doc';
import { insideMap } from '@world/bounds';
import { RELIEF_FLAT, RELIEF_LEGACY, RELIEF_NATURAL } from '@world/terrain';

/** The boundary where data from OUTSIDE enters the model: the autosave and imported files. */
const base = (): Record<string, unknown> => ({
  version: 1,
  nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }],
  segments: [{ id: 1, a: 1, b: 2, type: 1, curve: null }],
});

describe('the load boundary', () => {
  it('accepts a plain map, with and without poles', () => {
    expect(isSerializedDoc(base())).toBe(true);
    expect(isSerializedDoc({ ...base(), poles: [{ id: 1, x: 5, y: 5, lamp: true }, { id: 2, x: 9, y: 5 }],
      poleSpans: [{ id: 1, a: 1, b: 2 }] })).toBe(true);
  });

  it.each([
    ['poles that are not a list', { poles: {} }],
    ['spans that are not a list', { poleSpans: 5 }],
    ['a pole with a string position', { poles: [{ id: 1, x: 'a', y: null }] }],
    ['a pole with a string id', { poles: [{ id: '7', x: 0, y: 0 }] }],
    ['a pole with a non-boolean lamp', { poles: [{ id: 1, x: 0, y: 0, lamp: 'yes' }] }],
    ['a span from a pole to itself', { poles: [{ id: 1, x: 0, y: 0 }], poleSpans: [{ id: 1, a: 1, b: 1 }] }],
    ['a span to a missing pole', { poles: [{ id: 1, x: 0, y: 0 }], poleSpans: [{ id: 1, a: 1, b: 2 }] }],
    ['a flatten stamp levelling to a word', { terrain: [{ id: 1, x: 0, y: 0, radius: 80, strength: 4, mode: 'flatten', level: 'high' }] }],
    ['a stamp wider than the map', { terrain: [{ id: 1, x: 0, y: 0, radius: 1e6, strength: 4, mode: 'raise' }] }],
    ['a stamp of a stroke with no proper id', { terrain: [{ id: 1, x: 0, y: 0, radius: 80, strength: 4, mode: 'raise', stroke: 'a' }] }],
  ])('refuses %s', (_name, patch) => {
    expect(isSerializedDoc({ ...base(), ...patch })).toBe(false);
  });

  it('accepts every relief a map is saved with, the planet Earth too', () => {
    // The Earth's (4) was refused here while the document read it
    for (const relief of [RELIEF_LEGACY, RELIEF_NATURAL, RELIEF_FLAT]) {
      const doc = new RoadDoc();
      doc.terrainRelief = relief;
      expect(isSerializedDoc(doc.toJSON()), `relief ${relief}`).toBe(true);
    }
    expect(isSerializedDoc({ ...base(), relief: 4 })).toBe(true);
    expect(isSerializedDoc({ ...base(), relief: 5 })).toBe(false);
  });

  it('opens a map saved on the planet Earth (4) on the level plain', () => {
    // The planet and its Earth are gone (2026-10-13): its maps open flat, never set aside.
    expect(RoadDoc.fromJSON({ ...new RoadDoc().toJSON(), relief: 4 }).terrainRelief).toBe(RELIEF_FLAT);
  });

  it('accepts the stamps the brush and the default town lay', () => {
    // The town is shaped by stamps up to 1 400 units wide and the brush now reaches 300
    expect(isSerializedDoc({ ...base(), terrain: [
      { id: 1, x: 0, y: 0, radius: 1_400, strength: 34, mode: 'raise' },
      { id: 2, x: 0, y: 0, radius: 300, strength: 160, mode: 'raise', stroke: 3 },
    ] })).toBe(true);
  });

  it('refuses ids past the range an allocator can count in', () => {
    const doc = base();
    (doc.nodes as { id: number }[])[1]!.id = 2 ** 53;
    (doc.segments as { b: number }[])[0]!.b = 2 ** 53;
    expect(isSerializedDoc(doc)).toBe(false);
  });

  it('loads a file position back onto the map', () => {
    const doc = RoadDoc.fromJSON({ ...base(), nodes: [{ id: 1, x: 1e9, y: -1e9 }, { id: 2, x: 0, y: 0 }] } as never);
    for (const node of doc.nodes.values()) expect(insideMap(node)).toBe(true);
  });
});

/** A `Storage` in memory (MDN: `getItem` of a missing key is null), throwing past `quota` characters as a browser does. */
function memoryStorage(quota = Infinity): Storage {
  const items = new Map<string, string>();
  return {
    get length() { return items.size; },
    key: (n: number) => [...items.keys()][n] ?? null,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const used = [...items].reduce((n, [key, value]) => (key === k ? n : n + key.length + value.length), 0);
      if (used + k.length + String(v).length > quota) throw new DOMException('quota', 'QuotaExceededError');
      items.set(k, String(v));
    },
    removeItem: (k: string) => { items.delete(k); },
    clear: () => items.clear(),
  };
}

describe('maps set aside', () => {
  const real = (globalThis as { localStorage?: Storage | undefined }).localStorage;
  afterEach(() => { (globalThis as { localStorage?: Storage | undefined }).localStorage = real; });

  it('never sets a second unreadable map aside over the first', () => {
    const storage = memoryStorage();
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    storage.setItem('roadcraft.world.v7', 'first map {broken');
    new Persistence().loadSession();
    expect(storage.getItem(QUARANTINE_KEY)).toBe('first map {broken');

    storage.setItem('roadcraft.world.v7', 'second map {broken');
    new Persistence().loadSession();
    const kept = [...Array(storage.length).keys()].map((i) => storage.key(i)!).filter((k) => k.startsWith(QUARANTINE_KEY)).map((k) => storage.getItem(k));
    expect(kept.sort()).toEqual(['first map {broken', 'second map {broken']);
    expect(storage.getItem('roadcraft.world.v7')).toBeNull();
  });
});

describe('the model\'s own copies', () => {
  it('clone keeps two nodes the player stacked on one point, and the road between them', () => {
    // Two connected nodes dragged past the same map corner both clamp there.
    const doc = new RoadDoc();
    const a = doc.addNode({ x: 0, y: 0 });
    const b = doc.addNode({ x: 60, y: 0 });
    const c = doc.addNode({ x: 120, y: 0 });
    doc.addSegment(a.id, b.id, 1);
    doc.addSegment(b.id, c.id, 1);
    doc.moveNode(b.id, { x: 1e6, y: 1e6 });
    doc.moveNode(c.id, { x: 1e6, y: 1e6 });
    const copy = doc.clone();
    expect(copy.nodes.size).toBe(3);
    expect(copy.segments.size).toBe(2);
    expect(copy.toJSON()).toEqual(doc.toJSON());
  });
});

describe('a map too large for Web Storage', () => {
  const real = (globalThis as { localStorage?: Storage | undefined }).localStorage;
  afterEach(() => { (globalThis as { localStorage?: Storage | undefined }).localStorage = real; });
  const settings = normalizeSettings({ camera: { x: 0, y: 0, zoom: 1 }, paused: true, speed: 1, trafficIntensity: 1, pedestrianIntensity: 1, congestionOverlay: false });
  /** A town whose text is past the 5 MiB of `localStorage` (a generated city of 1 530 buildings is 12.7 MB). */
  const bigDoc = (): RoadDoc => {
    const doc = RoadDoc.fromJSON(base() as never);
    const json = doc.toJSON();
    return Object.assign(doc, { toJSON: () => ({ ...json, padding: 'x'.repeat(3_000_000) }) as never });
  };
  const memoryStore = (): LargeStore & { items: Map<string, string> } => {
    const items = new Map<string, string>();
    return { items, get: async (k) => items.get(k) ?? null, put: async (k, v) => { items.set(k, v); return true; }, delete: async (k) => items.delete(k) };
  };

  it('is kept in the large store and read back on the next opening', async () => {
    // The autosave wrote it to `localStorage` alone, which threw: every reload opened an old map or none.
    const storage = memoryStorage(2_600_000);
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const store = memoryStore();
    let failed = false;
    const saver = new Persistence(undefined, store);
    saver.onSaveFailed = () => { failed = true; };
    saver.saveSession(bigDoc(), settings);
    await new Promise((r) => setTimeout(r, 0));
    expect(failed).toBe(false);
    expect(store.items.get('roadcraft.world.v7')?.length).toBeGreaterThan(3_000_000);
    expect(storage.getItem('roadcraft.world.v7')).toContain('"stored":"indexeddb"');
    const back = await new Persistence(undefined, store).loadSessionAsync();
    expect(back?.document.nodes?.length).toBe(2);
    // The pointer is not an unreadable map: nothing set aside.
    expect(storage.getItem(QUARANTINE_KEY)).toBeNull();
  });

  it('gives way to a newer small map written after it', async () => {
    const storage = memoryStorage(2_600_000);
    (globalThis as { localStorage?: Storage }).localStorage = storage;
    const store = memoryStore();
    const saver = new Persistence(undefined, store);
    saver.saveSession(bigDoc(), settings);
    await new Promise((r) => setTimeout(r, 5));
    const small = RoadDoc.fromJSON({ ...base(), nodes: [{ id: 1, x: 0, y: 0 }, { id: 2, x: 100, y: 0 }, { id: 3, x: 200, y: 0 }] } as never);
    saver.saveSession(small, settings);
    const back = await new Persistence(undefined, store).loadSessionAsync();
    expect(back?.document.nodes?.length).toBe(3);
  });
});

describe('loaded settings', () => {
  it('come back as values the controls offer', () => {
    const settings = normalizeSettings({
      camera: { x: 0, y: 0, zoom: 1 }, paused: false, speed: -3,
      trafficIntensity: 9, pedestrianIntensity: -1, demandMultiplier: 1.4, congestionOverlay: false,
    });
    // A negative speed froze the simulation while it read as playing.
    expect(settings.speed).toBe(1);
    // The panel's Traffic share at most (`MAX_INTENSITY`, 300 %).
    expect(settings.trafficIntensity).toBe(MAX_INTENSITY);
    expect(settings.pedestrianIntensity).toBe(0);
    expect(settings.demandMultiplier).toBe(1.55);
  });
});

describe('buildings from a file', () => {
  it('are pulled onto the map and their base kept below the top storey', () => {
    const doc = RoadDoc.fromJSON({ ...base(), buildings: [{
      schema: 2, id: 1, x: 1e12, y: -5, rotation: 0, use: 'residential', module: 7.5, groundHeight: 9, storeyHeight: 7.75,
      palette: 0, volumes: [{ id: 1, x: 0, y: 0, w: 20, d: 20, base: 99_999, roof: 'flat', storeys: [{ facade: { fill: 'window' } }] }],
      cores: [], nextVolumeId: 2,
    }] } as never);
    const building = [...doc.buildings.all()][0]!;
    expect(insideMap(building)).toBe(true);
    expect(building.volumes[0]!.base).toBeLessThan(60);
  });
});

describe('the autosave under a stream of edits', () => {
  it('saves within 5 s however often edits keep coming (a growing zone)', async () => {
    const { vi } = await import('vitest');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    try {
      const saves: number[] = [];
      const store = new Persistence();
      store.saveSession = () => { saves.push(performance.now()); return true; };
      const doc = new RoadDoc();
      const settings = () => ({ camera: { x: 0, y: 0, zoom: 1 }, paused: false }) as never;
      // A building grown every half second for 15 s, each one an edit.
      for (let t = 0; t < 15000; t += 500) {
        store.saveSessionSoon(doc, settings);
        vi.advanceTimersByTime(500);
      }
      expect(saves.length).toBeGreaterThan(0);
      expect(saves[0]!).toBeLessThanOrEqual(5000);
    } finally {
      vi.useRealTimers();
    }
  });
});
