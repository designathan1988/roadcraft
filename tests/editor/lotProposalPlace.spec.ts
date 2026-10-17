import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { LotTool } from '@editor/lotTool';
import { type LotPlan, planLots } from '@world/lots';
import { m } from '@world/units';

/** A street, its network, and a zoning tool whose plans are answered by `plan`. */
function street(plan: (doc: RoadDoc, net: Network) => Promise<LotPlan | null>): { doc: RoadDoc; net: Network; tool: LotTool } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: m(-120), y: 0 });
  const b = doc.addNode({ x: m(120), y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  const tool = new LotTool({
    doc, net, zoom: () => 1,
    settings: () => ({ mode: 'edit', use: 'residential', density: 'low', eraser: false, splitKind: 'vertical', splitParts: 2 }),
    mutate: (fn) => { fn(); }, hint: () => undefined, redraw: () => undefined,
    plan: () => plan(doc, net),
  });
  return { doc, net, tool };
}

/** The street land's proposed lots made real */
describe('the proposed lots taken in', () => {
  it('are written in the diary with their places', async () => {
    const { doc, tool } = street(async (d, n) => planLots(d, n));
    await tool.advanceProposal();
    expect(tool.proposalReady()).toBeGreaterThan(0);
    const before = doc.changes.version;
    tool.down(1, { x: m(500), y: m(500) }, false, 1);
    const lots = (doc.changes.since(before, ['lots']) ?? []);
    expect(lots.length).toBeGreaterThan(0);
    expect(lots.every((e) => e.rects !== null)).toBe(true);
    expect(doc.lots.length).toBeGreaterThan(0);
  });

  it('are planned off the page, the last plan drawn until the next is in', async () => {
    // DO NOT plan on the page: the first plan of a region floods its land (`LotPlanner`), the simulation's worker plans it (`SimHost.lotPlan`).
    expect(readFileSync('src/editor/lotTool.ts', 'utf8')).not.toMatch(/planLots\(/);
    const answers: ((plan: LotPlan) => void)[] = [];
    const { doc, net, tool } = street(() => new Promise<LotPlan>((done) => answers.push(done)));
    void tool.advanceProposal();
    // Asked once, however many frames ask while it is out.
    tool.overlay(true);
    tool.overlay(true);
    expect(answers).toHaveLength(1);
    expect(tool.proposalReady()).toBe(-1);
    answers[0]!(planLots(doc, net));
    await tool.advanceProposal();
    const first = tool.proposalReady();
    expect(first).toBeGreaterThan(0);
    const drawn = (): number => [...tool.overlay(true).groups.keys()].filter((name) => name.startsWith('p')).length;
    expect(drawn()).toBe(first);
    // The land changes: a plan for it asked, the last one drawn meanwhile (never picked or laid: it is not the land's now).
    const c = doc.addNode({ x: m(0), y: m(-200) });
    doc.addSegment(c.id, doc.nodes.keys().next().value!, 1);
    net.rebuild();
    expect(drawn()).toBe(first);
    expect(tool.proposalReady()).toBe(-1);
    expect(answers).toHaveLength(2);
    answers[1]!(planLots(doc, net));
    await tool.advanceProposal();
    expect(tool.proposalReady()).toBeGreaterThan(0);
  });
});
