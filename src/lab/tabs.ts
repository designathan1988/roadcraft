import type { LabContext, LabTab } from './labTypes';
import { createCodeTabs } from './code';
import { createDoctorTabs } from './doctor';
import { createGpuTabs } from './gpu';
import { createInspectorTabs } from './inspector';
import { createOptimizationTabs } from './optimizations';
import { createRecorderTabs } from './recorder';
import { createResourceTabs } from './resources';
import { createTestTabs } from './tests';

/** THE LAB'S TABS, in the order shown: each area builds its own (one folder each). */
export function createLabTabs(ctx: LabContext): LabTab[] {
  const switches: LabTab = {
    id: 'switches',
    title: 'Switches',
    mount: (host) => ctx.effects.panel.embed(host),
    unmount: () => ctx.effects.panel.release(),
  };
  const [overview = null, ...resources] = createResourceTabs(ctx);
  return [
    ...createDoctorTabs(ctx),
    ...(overview ? [overview] : []),
    ...createInspectorTabs(ctx),
    switches,
    ...createOptimizationTabs(ctx),
    ...resources,
    ...createCodeTabs(ctx),
    ...createGpuTabs(ctx),
    ...createRecorderTabs(ctx),
    ...createTestTabs(ctx),
  ];
}
