// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindableKey, resetRoadKeys, roadKey, setRoadKey } from '@ui/roads/keys';
import { CameraMotion } from '@view/cameraMotion';

/** A ROAD KEY NEVER TAKES THE CAMERA'S. */
afterEach(() => { resetRoadKeys(); });

/** The key a US keyboard gives for a camera key's code, upper and lower case. */
const KEYS_OF_CODE: Readonly<Record<string, readonly string[]>> = {
  KeyW: ['w', 'W'], KeyA: ['a', 'A'], KeyS: ['s', 'S'], KeyD: ['d', 'D'], KeyQ: ['q', 'Q'], KeyE: ['e', 'E'],
  ArrowUp: ['ArrowUp'], ArrowDown: ['ArrowDown'], ArrowLeft: ['ArrowLeft'], ArrowRight: ['ArrowRight'],
  Equal: ['=', '+'], NumpadAdd: ['+'], Minus: ['-', '_'], NumpadSubtract: ['-'],
};

describe('the road keys and the camera', () => {
  it('refuses every key that moves the camera', () => {
    for (const [code, keys] of Object.entries(KEYS_OF_CODE)) {
      expect(CameraMotion.owns(code), code).toBe(true);
      for (const key of keys) {
        expect(bindableKey(key), key).toBe(false);
        expect(setRoadKey('heightUp', key), key).toBe(false);
      }
    }
    expect(roadKey('heightUp')).toBe('PageUp');
  });

  it('keeps Page Up and Page Down for the road (its own raise and lower)', () => {
    expect(bindableKey('PageUp')).toBe(true);
    expect(bindableKey('PageDown')).toBe(true);
  });

  it('a camera key stored by an older build is not read back', async () => {
    localStorage.setItem('roadcraft.roadKeys', JSON.stringify({ heightUp: 'w', heightDown: 'PageDown', alignment: 'v' }));
    vi.resetModules();
    const fresh = await import('@ui/roads/keys');
    expect(fresh.roadKey('heightUp')).toBe('PageUp');
    localStorage.removeItem('roadcraft.roadKeys');
  });
});
