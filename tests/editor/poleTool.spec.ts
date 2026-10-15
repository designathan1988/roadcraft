import { describe, expect, it } from 'vitest';

import { RoadDoc } from '@world/doc';
import { Network } from '@world/network';
import { PoleTool, type PoleToolHost } from '@editor/poles';
import { TUNED_UNIT } from '@world/units';

/** The 0.4 m unit these scenes were laid out in: every length below is in it, times U. */
const U = TUNED_UNIT;

/**
 * The pole tool as the player uses it (`editor/poles.ts` `PoleTool`, taken
 * out of `main.ts`): click, click, click along a footway traces a line.
 */
function street(): { doc: RoadDoc; net: Network } {
  const doc = new RoadDoc();
  const a = doc.addNode({ x: -400 * U, y: 0 });
  const b = doc.addNode({ x: 400 * U, y: 0 });
  doc.addSegment(a.id, b.id, 1);
  const net = new Network(doc);
  net.rebuild();
  return { doc, net };
}

function tool(mode = 'build'): { pole: PoleTool; doc: RoadDoc; hints: string[] } {
  const { doc, net } = street();
  const hints: string[] = [];
  const host: PoleToolHost = {
    doc, net, zoom: () => 2 / U, mode: () => mode, lamps: () => 'none', inHand: () => true,
    mutate: (fn) => fn(), hint: (key) => hints.push(key), redraw: () => {},
  };
  return { pole: new PoleTool(host), doc, hints };
}

/** A press and a release in place: a click. */
function click(pole: PoleTool, at: { x: number; y: number }): void {
  pole.down(at, false);
  pole.up(true);
}

/** On the street's footway (the poles' line is 4.8-6.4 m off its centre). */
const Y = 14 * U;

describe('the pole tool', () => {
  it('starts a line on the first click and builds a stretch on each next one', () => {
    const { pole, doc } = tool();
    click(pole, { x: -200 * U, y: Y });
    expect(doc.poles.size).toBe(0);
    expect(pole.gesture()).toBe('gesture.pole.tracing');
    click(pole, { x: -60 * U, y: Y });
    expect(doc.poles.size).toBeGreaterThan(1);
    expect(doc.poleSpans.size).toBeGreaterThan(0);
    const after = doc.poles.size;
    // The line goes on from its last pole.
    click(pole, { x: 80 * U, y: Y });
    expect(doc.poles.size).toBeGreaterThan(after);
  });

  it('builds a stretch dragged in one go', () => {
    const { pole, doc } = tool();
    pole.down({ x: -200 * U, y: Y }, false);
    pole.move({ x: -100 * U, y: Y });
    pole.move({ x: 0, y: Y });
    pole.up(true);
    expect(doc.poles.size).toBeGreaterThan(1);
  });

  it('drops the stretch when the press is cancelled, and Esc ends the line', () => {
    const { pole, doc } = tool();
    click(pole, { x: -200 * U, y: Y });
    pole.down({ x: -60 * U, y: Y }, false);
    pole.up(false);
    expect(doc.poles.size).toBe(0);
    expect(pole.gesture()).toBeNull();
  });

  it('takes a pole away with the Remove verb', () => {
    const built = tool();
    click(built.pole, { x: -200 * U, y: Y });
    click(built.pole, { x: -60 * U, y: Y });
    const [first] = [...built.doc.poles.values()];
    const removing = new PoleTool({
      doc: built.doc, net: new Network(built.doc), zoom: () => 2 / U, mode: () => 'remove', lamps: () => 'none', inHand: () => true,
      mutate: (fn) => fn(), hint: () => {}, redraw: () => {},
    });
    const before = built.doc.poles.size;
    removing.down({ x: first!.x, y: first!.y }, false);
    expect(built.doc.poles.size).toBe(before - 1);
  });
});
