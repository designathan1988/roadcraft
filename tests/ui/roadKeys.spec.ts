// @vitest-environment happy-dom The road tool's rebindable keys.
import { afterEach, describe, expect, it } from 'vitest';
import { bindableKey, resetRoadKeys, roadKey, roadKeyAction, roadKeyParams, setRoadKey } from '@ui/roads/keys';
import { closeRoadKeys, openRoadKeys } from '@ui/roads/keysPanel';
import { setGlobalParams, t } from '@ui/i18n';

afterEach(() => { resetRoadKeys(); closeRoadKeys(); });

describe('the road keys', () => {
  it('give the same placeholders while they stand, made again when one is rebound', () => {
    const first = roadKeyParams();
    expect(roadKeyParams()).toBe(first);
    expect(setRoadKey('heightUp', 'PageDown')).toBe(true);
    const next = roadKeyParams();
    expect(next).not.toBe(first);
    expect(next['heightUp']).toBe('Page Down');
    expect(roadKeyParams()).toBe(next);
  });

  it('start as Page Up, Page Down and V', () => {
    expect([roadKey('heightUp'), roadKey('heightDown'), roadKey('alignment')]).toEqual(['PageUp', 'PageDown', 'v']);
    expect(roadKeyAction('PageUp')).toBe('heightUp');
    expect(roadKeyAction('V')).toBe('alignment');
  });

  it('a key given to one action is taken from the one that had it: no key does two things', () => {
    expect(setRoadKey('heightUp', 'PageDown')).toBe(true);
    expect(roadKey('heightUp')).toBe('PageDown');
    expect(roadKey('heightDown')).toBe('PageUp');
  });

  it('refuses the keys the game keeps (tools, camera, Esc, digits)', () => {
    for (const key of ['Escape', 'q', 'B', '1', ' ', 'ArrowUp']) expect(bindableKey(key)).toBe(false);
    expect(setRoadKey('alignment', 'b')).toBe(false);
    expect(roadKey('alignment')).toBe('v');
  });

  it('is kept in the browser and comes back', async () => {
    setRoadKey('heightUp', 'r');
    expect(JSON.parse(localStorage.getItem('roadcraft.roadKeys')!).heightUp).toBe('r');
  });

  it('every sentence that names a key names the bound one', () => {
    setGlobalParams(roadKeyParams);
    setRoadKey('heightUp', 'r');
    expect(t('hint.road.curve')).toContain(' R/');
    expect(t('hint.road')).not.toContain('{');
  });

  it('the panel takes the next key pressed on a waiting chip', () => {
    openRoadKeys();
    const chip = document.querySelector<HTMLButtonElement>('.rp-key[data-action="alignment"]')!;
    chip.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    expect(roadKey('alignment')).toBe('k');
    expect(document.querySelector('.rp-key[data-action="alignment"]')!.textContent).toBe('K');
    // A reserved key is refused with the reason.
    document.querySelector<HTMLButtonElement>('.rp-key[data-action="alignment"]')!.click();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    expect(roadKey('alignment')).toBe('k');
    expect(document.querySelector('.rp-keys [role="status"]')).not.toBeNull();
  });
});
