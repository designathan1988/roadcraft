// @vitest-environment happy-dom The lane connector editor of a junction.
import { describe, expect, it } from 'vitest';
import { mountConnectorPanel, refreshConnectorPanel } from '@ui/roads/connectorPanel';
import type { LaneEnds, LaneLink } from '@world/roads/connectors';
import type { NodeId, SegmentId } from '@world/ids';

/** THE CONNECTOR EDITOR FOLLOWS UNDO, THE CAMERA AND THE KEYBOARD (plan K8) */
const node = 7 as NodeId;
const a = 1 as SegmentId, b = 2 as SegmentId;
function lanesOf(revision: number, arrivingLanes: number): LaneEnds {
  const arriving = Array.from({ length: arrivingLanes }, (_, lane) => ({ segment: a, lane }));
  const leaving = [{ segment: b, lane: 0 }, { segment: b, lane: 1 }];
  return {
    node, revision, arriving, leaving,
    built: arriving.map((l) => ({ from: a, fromLane: l.lane, to: b, toLane: 0 })),
    ends: [
      ...arriving.map((l) => ({ ...l, arriving: true, at: { x: -5, y: l.lane * 3 }, next: { x: -20, y: l.lane * 3 } })),
      ...leaving.map((l) => ({ ...l, arriving: false, at: { x: 5, y: l.lane * 3 }, next: { x: 20, y: l.lane * 3 } })),
    ],
  };
}
function mount(start: LaneEnds): { root: HTMLElement; state: { lanes: LaneEnds; turn: number }; sent: (LaneLink[] | undefined)[] } {
  const root = document.createElement('div');
  document.body.append(root);
  const state = { lanes: start, turn: 0 };
  const sent: (LaneLink[] | undefined)[] = [];
  mountConnectorPanel(root, node, {
    lanes: () => state.lanes,
    links: () => undefined,
    set: (links) => sent.push(links),
    project: (x, y) => ({ x: Math.cos(state.turn) * x - Math.sin(state.turn) * y, y: -(Math.sin(state.turn) * x + Math.cos(state.turn) * y) }),
  });
  return { root, state, sent };
}
const end = (root: HTMLElement, key: string): SVGElement => root.querySelector<SVGElement>(`[data-end="${key}"]`)!;
const press = (el: Element, key: string): void => { el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); };

describe('the lane connector editor', () => {
  it('drops the picked lane when an undo takes it away, instead of offering links from a lane that is gone', () => {
    const { root, state, sent } = mount(lanesOf(1, 2));
    end(root, `a${a}:1`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(end(root, `a${a}:1`).getAttribute('class')).toContain(' on');
    state.lanes = lanesOf(2, 1);
    refreshConnectorPanel();
    end(root, `l${b}:0`).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(sent).toEqual([]);
    // Nothing is drawn as picked: no link dimmed for a lane that is not there.
    expect(root.querySelectorAll('.dim, .on').length).toBe(0);
  });

  it('redraws the plan when the camera turns', () => {
    const { root, state } = mount(lanesOf(1, 1));
    const before = end(root, `a${a}:0`).getAttribute('cx');
    state.turn = Math.PI / 2;
    refreshConnectorPanel();
    expect(end(root, `a${a}:0`).getAttribute('cx')).not.toBe(before);
  });

  it('presses a lane end with Enter and Space, keeping the focus on it', () => {
    const { root, sent } = mount(lanesOf(1, 2));
    end(root, `a${a}:0`).focus();
    press(end(root, `a${a}:0`), 'Enter');
    expect(end(root, `a${a}:0`).getAttribute('class')).toContain(' on');
    expect(document.activeElement?.getAttribute('data-end')).toBe(`a${a}:0`);
    press(end(root, `l${b}:1`), ' ');
    expect(sent.length).toBe(1);
  });

  it('keeps the keyboard on its lane end when the inspector is made again', () => {
    const lanes = lanesOf(1, 2);
    const host = { lanes: () => lanes, links: () => undefined, set: () => {} };
    const first = document.createElement('div');
    document.body.replaceChildren(first);
    mountConnectorPanel(first, node, host);
    end(first, `a${a}:1`).focus();
    // The inspector's body written again: the panel made anew, the old one (and its focus) gone.
    const again = document.createElement('div');
    document.body.replaceChildren(again);
    mountConnectorPanel(again, node, host);
    expect(document.activeElement?.getAttribute('data-end')).toBe(`a${a}:1`);
    expect(again.contains(document.activeElement)).toBe(true);
  });
});
