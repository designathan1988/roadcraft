import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClipIdentity } from '@render/riggedCitizens';

/**
 * A person keeps their clothes for as long as they are about, however many
 * other people the city has drawn meanwhile (the player, 2026-10-13: "se
 * trocam de roupa e cabelo"). Tested through the renderer's own registry
 * (`createRiggedCitizens`), as the game casts people.
 */

let saved: unknown;
beforeAll(() => {
  // `createRiggedCitizens` hangs its development hooks on `window`.
  saved = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = globalThis;
});
afterAll(() => {
  (globalThis as { window?: unknown }).window = saved;
});

const who = (seed: number): ClipIdentity => ({ seed, gender: 'f', ageClass: 'adult', company: 'solo', companyId: seed });

describe('casting memory', () => {
  it('keeps a person in the body first cast for them while thousands of others are drawn', async () => {
    const { createRiggedCitizens } = await import('@render/riggedCitizens');
    // The body a walker gets in an empty street, and one cast where that body is worn close by.
    let walker = 1, plain = -1, first = -1;
    let citizens = createRiggedCitizens();
    for (; walker < 200; walker++) {
      const empty = createRiggedCitizens();
      empty.begin();
      plain = empty.indexFor(who(walker), false, 0, 0)!;
      empty.dispose();
      citizens.dispose();
      citizens = createRiggedCitizens();
      citizens.begin();
      // Somebody close by in the body the walker would take, and nobody in any other.
      for (let other = 100_000; other < 100_200; other++) {
        if (citizens.indexFor(who(other), false, 0, 0) === plain) break;
        citizens.dispose();
        citizens = createRiggedCitizens();
        citizens.begin();
      }
      first = citizens.indexFor(who(walker), false, 0, 0)!;
      if (first !== plain) break;
    }
    expect(first).not.toBe(plain);
    // Out of sight while the city draws its next thousands of people, each
    // in a street of their own, and minutes go by.
    for (let other = 0; other < 10_000; other++) {
      if (other % 100 === 0) citizens.begin();
      citizens.indexFor(who(200_000 + other), false, 1e6 + other * 1000, 1e6);
    }
    for (let frame = 0; frame < 4000; frame++) citizens.begin();
    // Back on screen in an empty street: the same body.
    expect(citizens.indexFor(who(walker), false, -1e6, -1e6)).toBe(first);
    citizens.dispose();
  });
});
