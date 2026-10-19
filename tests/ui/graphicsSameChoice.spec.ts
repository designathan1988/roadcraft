// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { type GraphicsChoices, createGraphicsPanel } from '@ui/graphicsPanel';

/** UI-08: a click on the choice already made applies nothing (the post chain was made again for it). */
describe('the graphics options', () => {
  it('apply nothing for the lit choice, and the other choice once', () => {
    const now: GraphicsChoices = { preset: 'high', shadows: 2048, ambientOcclusion: true, smaa: true, dynamicResolution: false, fpsLimit: 0, vsync: true, fullscreen: false };
    const changes: Partial<GraphicsChoices>[] = [];
    const panel = createGraphicsPanel({ read: () => now, change: (patch) => changes.push(patch), desktop: () => false, gpu: () => 'test' });
    panel.open();
    const presets = [...document.querySelectorAll<HTMLButtonElement>('.options-choices')][0]!.querySelectorAll<HTMLButtonElement>('button');
    const lit = [...presets].find((b) => b.getAttribute('aria-pressed') === 'true')!;
    lit.click();
    expect(changes).toEqual([]);
    const other = [...presets].find((b) => b.getAttribute('aria-pressed') === 'false')!;
    other.click();
    expect(changes.length).toBe(1);
  });
});
