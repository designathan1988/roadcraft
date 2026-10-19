import type { Object3D } from 'three';
import type { LabContext, LabTab } from '../labTypes';
import { createGpuLab } from './controller';
import { createPassesTab } from './passesTab';
import { createFrameTab } from './frameTab';
import { createObjectsTab, createWebglTab } from './objectsTab';
import { readCapabilities } from './caps';

/** THE LAB'S GPU AREA: the GPU time of each pass, one frame's every draw, the programs, the GPU's objects, the debug views and the context's capabilities. `window.__labGpu` for the browser checks. */
export function createGpuTabs(ctx: LabContext): LabTab[] {
  const lab = createGpuLab(ctx);
  ctx.reportSection('gpu', () => lab.report());
  Object.assign(window, {
    __labGpu: {
      lab,
      passTiming: (on: boolean) => lab.setPassTiming(on),
      passes: () => lab.passRows(),
      capture: () => lab.capture(),
      liveLayers: (on: boolean) => lab.setLiveLayers(on),
      layers: () => lab.layerRows(),
      /** The last captured frame's draws of `object` (an Object3D or its uuid): the inspector's lookup (`window.__labInspector`). */
      drawsOf: (object: Object3D | string) => {
        const uuid = typeof object === 'string' ? object : object.uuid;
        return lab.lastCapture?.records.filter((r) => r.uuid === uuid) ?? [];
      },
      lastCapture: () => lab.lastCapture,
      view: (view: Parameters<typeof lab.views.set>[0]) => lab.views.set(view),
      programs: () => lab.programs.rows,
      objects: () => lab.refreshObjects(),
      capabilities: () => readCapabilities(ctx.scene.gl),
      report: () => lab.report(),
    },
  });
  return [createPassesTab(lab), createFrameTab(lab), createObjectsTab(lab), createWebglTab(lab)];
}
