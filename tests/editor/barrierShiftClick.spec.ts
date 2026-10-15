import { describe, expect, it } from 'vitest';

import { BarrierTool, type BarrierToolHost } from '@editor/barriers';

/**
 * SHIFT-CLICK REMOVES, AND ONLY REMOVES. With no wall under the pointer the
 * Shift-click fell through to "put a point down" and began a fence the player
 * never asked for.
 */
function tool(removes: boolean): { tool: BarrierTool; hints: string[] } {
  const hints: string[] = [];
  const host: BarrierToolHost = {
    net: () => null,
    kind: () => 'fence',
    removeAt: () => removes,
    build: () => { throw new Error('nothing should be built'); },
    hint: (key) => hints.push(key),
    redraw: () => {},
  };
  return { tool: new BarrierTool(host), hints };
}

describe('the walls tool, Shift-click', () => {
  it('with nothing under it puts no point down and starts no run', () => {
    const { tool: t, hints } = tool(false);
    t.down({ x: 10, y: 10 }, true, 100, 100, 1);
    expect(t.gesture()).toBeNull();
    expect(t.plan().dots).toEqual([]);
    expect(hints).toEqual(['hint.barrier.nothing']);
  });

  it('over a run removes it', () => {
    const { tool: t, hints } = tool(true);
    t.down({ x: 10, y: 10 }, true, 100, 100, 1);
    expect(t.gesture()).toBeNull();
    expect(hints).toEqual(['hint.barrier.removed']);
  });

  it('a plain click still puts a point down', () => {
    const { tool: t } = tool(false);
    t.down({ x: 10, y: 10 }, false, 100, 100, 1);
    expect(t.plan().dots).toHaveLength(1);
    expect(t.gesture()).not.toBeNull();
  });
});
