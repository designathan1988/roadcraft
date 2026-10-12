import { describe, expect, it } from 'vitest';
import { CATALOG_CATEGORIES, catalogRoads } from '@world/roads/catalog';
import { classTemplates } from '@world/roads/templates';
import { profileIssues, profileRoad } from '@world/roads/profile';

/**
 * THE ROAD CATALOGUE (the player's order of 2026-10-09): twenty and more
 * ready roads by category, every one buildable as it stands, the six classes
 * among them.
 */
describe('the road catalogue', () => {
  const roads = catalogRoads();
  it('has more than twenty roads, each in a category, with distinct ids', () => {
    expect(roads.length).toBeGreaterThanOrEqual(25);
    expect(new Set(roads.map((r) => r.id)).size).toBe(roads.length);
    for (const c of CATALOG_CATEGORIES.filter((c) => c !== 'mine')) expect(roads.some((r) => r.category === c), c).toBe(true);
  });
  it('every road builds as it stands', () => {
    for (const r of roads) expect(profileIssues(r.profile, r.type), r.id).toEqual([]);
    for (const r of roads) expect(profileRoad(r.profile, r.type).width, r.id).toBeGreaterThan(0);
  });
  it('the six classes are in it, as they were', () => {
    for (const c of classTemplates()) expect(roads.find((r) => r.id === c.id)?.profile).toEqual(c.profile);
  });
});
