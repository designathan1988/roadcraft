/**
 * THE WORK OF A REBUILD AFTER A ROAD EDIT, counted per derived product: how
 * many things each one looked at (`tests/scale/edit.spec.ts`). CLAUDE.md: "A
 * scale test proves the same edit costs the same on a small map and a large
 * one (work counters, not timings)". Counts, never times: a count is the same
 * on every machine and every run.
 *
 * - `conflicts`: junctions whose movements the conflict index looked at
 *   (`conflictPoints.ts`);
 * - `walkways`: roads and nodes the residents' walkways looked at (`walkways.ts`);
 * - `signals`: junctions whose controller was synchronised (`sim/world.ts`);
 * - `sidewalks`: kerb nodes, legs and roads of the zebra graph (`sim/peds/sidewalk.ts`);
 * - `spans`: movements and approaches measured against the zebras (`sim/intersections/crossingSpans.ts`);
 * - `lanes`: runtime lanes, junctions and segments the topology swap walked (`sim/world.ts`);
 * - `routing`: lanes the trap analysis looked at (`sim/routing/router.ts`).
 */
/**
 * The network's rebuild (`networkBuild.ts`): records compared for changes
 * (`sources`), junction solves looked up or made (`junctions`), segment ends
 * reconciled, trimmed and ribboned (`segments`), nodes marked (`marks`).
 */
export const networkWork = { sources: 0, junctions: 0, segments: 0, marks: 0 };

export const rebuildWork = { conflicts: 0, walkways: 0, signals: 0, sidewalks: 0, spans: 0, lanes: 0, routing: 0 };
