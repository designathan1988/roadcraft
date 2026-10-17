import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClassBodies } from '@render/people/crowdBodies';

/** The people's memory on the page: one copy of a class's shape basis, and a cooked body's face shapes let go once three holds its own */

describe("the people's memory", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keeps one copy of a class's shape basis: the one shared with the workers", () => {
    vi.stubGlobal('crossOriginIsolated', true);
    const basis = new Float32Array(2 * 2 * 4).fill(1);
    const bodies = createClassBodies(basis, 2, 2, new Float32Array(6), 1);
    expect(bodies.basis).not.toBe(basis);
    expect(bodies.basis.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...bodies.basis]).toEqual([...basis]);
    bodies.dispose();
  });
});
