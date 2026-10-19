import { afterEach, describe, expect, it, vi } from 'vitest';
import { watchDesktopShown } from '../../src/desktopShown';

/** AST-03: the desktop window minimized or hidden stops the drawing, as a hidden tab does. */
describe("the desktop window's sight", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('turns hidden and back on the shell word from the page itself, never on a message from elsewhere', () => {
    const listeners: ((event: { source: unknown; data: unknown }) => void)[] = [];
    const fakeWindow = { addEventListener: (_type: string, listener: (event: { source: unknown; data: unknown }) => void) => { listeners.push(listener); } };
    vi.stubGlobal('window', fakeWindow);
    const told: boolean[] = [];
    const shown = watchDesktopShown((s) => { told.push(s); });
    const send = (data: unknown, source: unknown = fakeWindow): void => { for (const l of listeners) l({ source, data }); };
    expect(shown.hidden).toBe(false);
    send({ roadcraftShown: false });
    expect(shown.hidden).toBe(true);
    // The same word again changes nothing; another window's is not heard.
    send({ roadcraftShown: false });
    send({ roadcraftShown: true }, {});
    expect(shown.hidden).toBe(true);
    send({ roadcraftShown: true });
    expect(shown.hidden).toBe(false);
    expect(told).toEqual([false, true]);
    // Other messages of the page (the saves' port) are not read as it.
    send('roadcraft:saves-port');
    expect(shown.hidden).toBe(false);
  });
});
