import { WebGLRenderTarget } from 'three';
import { describe, expect, it } from 'vitest';
import { liveTargets, renderTargetsBytes } from '@render/targetBytes';

/** RND-19: the VRAM ledger charged for the targets drawn into, never for those made and left unused. */
describe('the render targets the ledger counts', () => {
  it('are the ones three made a framebuffer for, not the ones never bound', () => {
    const used = new WebGLRenderTarget(256, 256), unused = new WebGLRenderTarget(512, 512);
    // three's properties: a framebuffer once bound (r186 `setupRenderTarget`), an empty record otherwise.
    const props = new Map<object, Record<string, unknown>>([[used, { __webglFramebuffer: {} }]]);
    const properties = { get: (o: object) => props.get(o) ?? {} };
    const live = liveTargets([used, unused], properties);
    expect(live).toEqual([used]);
    expect(renderTargetsBytes(live)).toBe(renderTargetsBytes([used]));
    expect(renderTargetsBytes(live)).toBeLessThan(renderTargetsBytes([used, unused]));
  });
});
