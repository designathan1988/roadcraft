import type { LabContext, LabTab } from './labTypes';
import { createCodeTabs } from './code';
import { createGpuTabs } from './gpu';
import { createOptimizationTabs } from './optimizations';
import { createRecorderTabs } from './recorder';
import { createResourceTabs } from './resources';
import { createTestTabs } from './tests';

/** THE LAB'S TABS, in the order shown: each area builds its own (one folder each). */
export function createLabTabs(ctx: LabContext): LabTab[] {
  const switches: LabTab = {
    id: 'switches',
    title: 'Interruptores',
    mount: (host) => ctx.effects.panel.embed(host),
    unmount: () => ctx.effects.panel.release(),
  };
  const [overview = null, ...resources] = createResourceTabs(ctx);
  return [
    ...(overview ? [overview] : []),
    switches,
    ...createOptimizationTabs(ctx),
    ...resources,
    ...createCodeTabs(ctx),
    ...createGpuTabs(ctx),
    ...createRecorderTabs(ctx),
    ...createTestTabs(ctx),
  ];
}
