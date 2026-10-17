import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { SimWorld, issuesSince } from '@sim/world';
import type { AuditIssue } from '@sim/audit';

/** THE PROBLEMS THE SIMULATION REPORTS REACH THE PAGE AFTER ITS KEPT LIST IS FULL (`SimWorld.issuesReported`, `simHost.ts` stats) */
describe('the issues told to the page', () => {
  it('go on arriving once 512 are kept, and a reset of the city starts no reader over', () => {
    const doc = new RoadDoc();
    const w = new SimWorld(doc, new Network(doc), 1);
    const issue = (n: number): AuditIssue => ({ code: 'stuck', tick: n, subject: String(n), detail: '' } as unknown as AuditIssue);
    let sent = 0;
    const told: number[] = [];
    const frame = (): void => { for (const i of issuesSince(w, sent)) told.push(i.tick); sent = w.issuesReported; };
    for (let n = 0; n < 600; n++) w.report(issue(n));
    frame();
    // The oldest are gone from the kept list; the last 512 told.
    expect(told.length).toBe(512);
    expect(told[told.length - 1]).toBe(599);
    // Full, one more: told.
    w.report(issue(600));
    frame();
    expect(told[told.length - 1]).toBe(600);
    expect(told.length).toBe(513);
    // The city reset (another map): the next issue still told.
    w.reset();
    w.report(issue(601));
    frame();
    expect(told[told.length - 1]).toBe(601);
  });
});
