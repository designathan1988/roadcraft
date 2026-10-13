/**
 * The fixed simulation step, seconds. Physics never depends on frame rate.
 *
 * In a module of its own: the people cooked ahead read it (their walk and
 * gait clocks), and the cook is fingerprinted by the import closure of the
 * code that builds them (`cook-plugin.ts`). Read from `params.ts`, every
 * tunable of the simulation was in that closure, and any change to one made
 * every cooked body stale and the build ask for a new cook (the player,
 * 2026-10-13: "toda hora tem que ficar cozinhando essas pessoas").
 */
export const DT = 1 / 60;
