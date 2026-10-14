// @vitest-environment happy-dom
// The player's own blueprints (`editor/blueprintLibrary.ts`) are the player's work: saving or
// removing one must never take the others with it - not one this build cannot read (a newer
// build's, or one damaged), not a library whose text no longer parses, not the oldest past a count
// (Protocol Buffers keep what they do not understand: "Proto3 messages preserve unknown fields
// and include them during parsing and in the serialized output").
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BlueprintLibrary } from '@editor/blueprintLibrary';
import { BLUEPRINTS } from '@world/buildings/blueprints';

const KEY = 'test.blueprints';
const stored = (): unknown => JSON.parse(localStorage.getItem(KEY)!);
const body = BLUEPRINTS[0]!.body;
/** Every key in storage but the library's own, with its text. */
const others = (): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)!;
    if (key !== KEY) out[key] = localStorage.getItem(key)!;
  }
  return out;
};

beforeEach(() => localStorage.clear());

describe("the player's blueprint library", () => {
  it('keeps a blueprint this build cannot read when another is saved or removed', () => {
    const unreadable = { key: 'user-later', name: 'De outra versão', body: { volumes: [] }, unit: 1 };
    localStorage.setItem(KEY, JSON.stringify([unreadable]));
    const library = new BlueprintLibrary(KEY);
    expect(library.list()).toEqual([]);
    const saved = library.save('Casa', body);
    expect(saved).not.toBeNull();
    expect(stored()).toContainEqual(unreadable);
    expect(library.remove(saved!.key)).toBe(true);
    expect(stored()).toEqual([unreadable]);
  });

  it('never writes over a library whose text it cannot parse: the text is kept aside, whole', () => {
    const cut = '[{"key":"user-1","name":"Casa","body":{"volumes":[';
    localStorage.setItem(KEY, cut);
    const library = new BlueprintLibrary(KEY);
    expect(library.save('Nova', body)).not.toBeNull();
    expect(Object.values(others())).toContain(cut);
    expect(library.list().map((b) => b.name)).toEqual(['Nova']);
  });

  it('drops no blueprint, however many are saved', () => {
    const library = new BlueprintLibrary(KEY);
    for (let i = 0; i < 60; i++) expect(library.save(`Projeto ${i}`, body), `save ${i}`).not.toBeNull();
    expect(library.list()).toHaveLength(60);
  });

  it('says so when a save or a removal did not happen, and leaves the library as it was', () => {
    const library = new BlueprintLibrary(KEY);
    const first = library.save('Casa', body)!;
    const before = localStorage.getItem(KEY);
    const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      expect(library.save('Outra', body)).toBeNull();
      expect(library.remove(first.key)).toBe(false);
    } finally {
      full.mockRestore();
    }
    expect(localStorage.getItem(KEY)).toBe(before);
  });
});
