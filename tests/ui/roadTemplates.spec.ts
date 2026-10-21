// @vitest-environment happy-dom The player's own road templates (`ui/roads/templates.ts`, a `core/keptList.ts`)
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteTemplate, saveTemplate, savedTemplates } from '@ui/roads/templates';
import { classTemplates } from '@world/roads/templates';

const STORE = 'roadcraft.roadTemplates';
const stored = (): unknown => JSON.parse(localStorage.getItem(STORE)!);
const base = classTemplates()[0]!;
const keys = (): string[] => Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)!);

beforeEach(() => localStorage.clear());

describe("the player's road templates", () => {
  it('keeps a template this build cannot read when another is saved or deleted', () => {
    const unreadable = { id: 'user:later', name: 'From another version', type: 0, profile: { elements: [{ kind: 'hovercraft-lane' }] }, unit: 1 };
    localStorage.setItem(STORE, JSON.stringify([unreadable]));
    expect(savedTemplates()).toEqual([]);
    const saved = saveTemplate('My street', base.type, base.profile);
    expect(saved).not.toBeNull();
    expect(stored()).toContainEqual(unreadable);
    expect(deleteTemplate(saved!.id)).toBe(true);
    expect(stored()).toEqual([unreadable]);
  });

  it('never writes over a list whose text it cannot parse: the text is kept aside, whole', () => {
    const cut = '[{"id":"user:1","name":"Mine","type":0,"profile":{"elements":[';
    localStorage.setItem(STORE, cut);
    expect(saveTemplate('New', base.type, base.profile)).not.toBeNull();
    expect(keys().filter((k) => k !== STORE).map((k) => localStorage.getItem(k))).toContain(cut);
    expect(savedTemplates().map((t) => t.name)).toEqual(['New']);
  });

  it('says so when a save or a deletion did not happen, and leaves the list as it was', () => {
    const first = saveTemplate('My street', base.type, base.profile)!;
    const before = localStorage.getItem(STORE);
    const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      expect(saveTemplate('Other', base.type, base.profile)).toBeNull();
      expect(deleteTemplate(first.id)).toBe(false);
    } finally {
      full.mockRestore();
    }
    expect(localStorage.getItem(STORE)).toBe(before);
  });
});
