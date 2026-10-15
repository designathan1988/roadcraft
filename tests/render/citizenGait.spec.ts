import { describe, expect, it } from 'vitest';
import { createGait, gaitHeading, gaitPlays, stepGait, type Gait } from '@render/citizenGait';
import { auditFlow, auditGait, type GaitController } from './support/gaitAudit';

/** WHAT THE LEGS DO AGAINST HOW THE BODY MOVES. */
const CONTROLLER: GaitController<Gait> = {
  create: (ped, time, heading, hash) => createGait(ped, time, heading, hash),
  step: (g, ped, clips, time, heading, size, hash) => stepGait(g, ped, clips, time, heading, size, hash),
  plays: (g, clips, out) => gaitPlays(g, clips, out),
  heading: gaitHeading,
};

/** Simulated seconds of each audit (120 before 2026-10-13, when it ran in no check); the totals below scale with it. */
const SECONDS = 15;
const share = SECONDS / 120;

describe('citizen gait', () => {
  it('steps at the pace the body moves, and steps round its turns', () => {
    const audit = auditGait(CONTROLLER, SECONDS);
    expect(audit.walkSeconds).toBeGreaterThan(1000 * share);
    // Slow motion: a walk cycle played at under three quarters of its rate.
    expect(audit.slowMotionSeconds / audit.walkSeconds).toBeLessThan(0.015);
    // Gliding: the body moving at a visible pace while the legs do not step.
    expect(audit.glideSeconds / audit.movingSeconds).toBeLessThan(0.008);
    // Swivelling on motionless legs, radians over the whole run
    expect(audit.unsteppedRotation).toBeLessThan(7.5 * share);
    // Feet sliding, as a share of the pace: an absolute ceiling failed walkers for walking at a real pace
    expect(audit.skateMean / audit.movingSpeedMean).toBeLessThan(0.028);
  });

  it('walks round the furniture and the other people, not through them', () => {
    const flow = auditFlow(SECONDS);
    expect(flow.walkingSeconds).toBeGreaterThan(1000 * share);
    expect(flow.insideFurniture / flow.walkingSeconds).toBeLessThan(0.003);
    expect(flow.overlapping / flow.walkingSeconds).toBeLessThan(0.01);
  });
});
