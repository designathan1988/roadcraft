import { afterEach, describe, expect, it, vi } from 'vitest';
import { measureHitch } from '@core/hitch';

/** DECISION 5.4: THE GAME SHIPPED MEASURES NOTHING - a `hitch:` step is timed in a development build only */

describe('a timed step', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it('is measured in a development build', () => {
    const measure = vi.spyOn(performance, 'measure');
    measureHitch('hitch:test/dev', 0);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('is not measured in the game built for the player', () => {
    vi.stubEnv('DEV', false);
    const measure = vi.spyOn(performance, 'measure');
    measureHitch('hitch:test/shipped', 0);
    expect(measure).not.toHaveBeenCalled();
  });
});
