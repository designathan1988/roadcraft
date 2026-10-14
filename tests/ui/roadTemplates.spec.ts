// @vitest-environment happy-dom
// The player's own road templates (`ui/roads/templates.ts`, a `core/keptList.ts`): saving or
// deleting one never takes the others with it - not one this build cannot read, not a list whose
// text no longer parses - and a change the browser would not keep says so.
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
    const unreadable = { id: 'user:later', name: 'De outra versão', type: 0, profile: { elements: [{ kind: 'hovercraft-lane' }] }, unit: 1 };
    localStorage.setItem(STORE, JSON.stringify([unreadable]));
    expect(savedTemplates()).toEqual([]);
    const saved = saveTemplate('Minha rua', base.type, base.profile);
    expect(saved).not.toBeNull();
    expect(stored()).toContainEqual(unreadable);
    expect(deleteTemplate(saved!.id)).toBe(true);
    expect(stored()).toEqual([unreadable]);
  });

  it('never writes over a list whose text it cannot parse: the text is kept aside, whole', () => {
    const cut = '[{"id":"user:1","name":"Minha","type":0,"profile":{"elements":[';
    localStorage.setItem(STORE, cut);
    expect(saveTemplate('Nova', base.type, base.profile)).not.toBeNull();
    expect(keys().filter((k) => k !== STORE).map((k) => localStorage.getItem(k))).toContain(cut);
    expect(savedTemplates().map((t) => t.name)).toEqual(['Nova']);
  });

  it('says so when a save or a deletion did not happen, and leaves the list as it was', () => {
    const first = saveTemplate('Minha rua', base.type, base.profile)!;
    const before = localStorage.getItem(STORE);
    const full = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    try {
      expect(saveTemplate('Outra', base.type, base.profile)).toBeNull();
      expect(deleteTemplate(first.id)).toBe(false);
    } finally {
      full.mockRestore();
    }
    expect(localStorage.getItem(STORE)).toBe(before);
  });
});
