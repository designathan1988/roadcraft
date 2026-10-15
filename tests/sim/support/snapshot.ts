import type { SimWorld } from '@sim/world';

/** A stable fingerprint of simulation state. */
export function hashSim(w: SimWorld): number {
  let h = 2166136261;

  const mix = (n: number): void => {
    h = Math.imul(h ^ (n & 0xff), 16777619) >>> 0;
    h = Math.imul(h ^ ((n >>> 8) & 0xff), 16777619) >>> 0;
    h = Math.imul(h ^ ((n >>> 16) & 0xff), 16777619) >>> 0;
    h = Math.imul(h ^ ((n >>> 24) & 0xff), 16777619) >>> 0;
  };

  const mixText = (s: string): void => {
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  };

  const q = (v: number): number => Math.round(v * 1000) | 0;

  for (const v of w.vehiclesInIdOrder()) {
    mix(v.id);
    mixText(v.lanelet);
    mix(q(v.s));
    mix(q(v.v));
  }

  // The people as the walking engine publishes them (`sim/agents/walk.ts`).
  for (const p of [...w.pedViews].sort((a, b) => a.id - b.id)) {
    mix(p.id);
    mixText(p.ground);
    mix(q(p.x));
    mix(q(p.y));
    mix(q(p.heading));
  }

  for (const node of w.junctionNodesInOrder()) {
    const c = w.controllers.get(node);
    if (!c) continue;
    mix(node);
    mix(c.stageIndex);
    mixText(c.sub);
    mix(q(c.elapsed));
  }

  return h >>> 0;
}
