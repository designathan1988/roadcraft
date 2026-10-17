// @vitest-environment happy-dom The road section editor, behind ?roads=free.
import { describe, expect, it } from 'vitest';
import { mountRoadSectionEditor } from '@ui/roadSectionEditor';
import { roadProfile, laneWidth } from '@world/roadTypes';
import { normalizeRoadSection, type RoadSection } from '@world/roadSection';
import { m } from '@world/units';

/** THE SECTION EDITOR SAVES WHAT IT SHOWS (plan K7) */
function mount(authored?: RoadSection, type = 1): { host: HTMLElement; sent: (RoadSection | undefined)[] } {
  const host = document.createElement('div');
  const sent: (RoadSection | undefined)[] = [];
  mountRoadSectionEditor(host, roadProfile(type), 'both', authored, (s) => sent.push(s));
  return { host, sent };
}
const fire = (input: HTMLInputElement | HTMLSelectElement, value: string): void => { input.value = value; input.dispatchEvent(new Event('change')); };

describe('the road section editor', () => {
  it('shows the lane width a saved section will hold, so confirming another field does not widen the road', () => {
    // An avenue: its lanes 3.5 m, off the 1 m grid a saved section is put on.
    expect(laneWidth(roadProfile(2)) % m(1)).not.toBe(0);
    const { host, sent } = mount(undefined, 2);
    const lane = host.querySelector<HTMLInputElement>('[data-section-field="laneWidth"]')!;
    fire(host.querySelector<HTMLInputElement>('[data-section-field="speedKmh"]')!, '40');
    const saved = normalizeRoadSection(sent.at(-1))!;
    // What the field shows is what is saved: no half metre added behind the player's back.
    expect(saved.laneWidth).toBe(Number(lane.value) * m(1));
    expect(Math.abs(saved.laneWidth - laneWidth(roadProfile(2)))).toBeLessThanOrEqual(m(0.5));
  });

  it('sets both footways with the footway control, over a side of its own saved before', () => {
    const base = normalizeRoadSection({ laneWidth: m(3), sidewalk: m(3), median: 0, speedKmh: 40, priority: 1, sidewalkLeft: m(2), sidewalkRight: m(3) })!;
    const { host, sent } = mount(base);
    fire(host.querySelector<HTMLInputElement>('[data-section-field="sidewalk"]')!, '5');
    const saved = sent.at(-1)!;
    expect(saved.sidewalk).toBe(m(5));
    expect(saved.sidewalkLeft).toBeUndefined();
    expect(saved.sidewalkRight).toBeUndefined();
  });

  it('keeps a lane turn changed before when another lane is changed', () => {
    // An avenue: two lanes each way.
    const { host, sent } = mount(undefined, 2);
    const selects = [...host.querySelectorAll<HTMLSelectElement>('[data-lane-turn^="turnsForward"]')];
    expect(selects.length).toBeGreaterThan(1);
    const rule = [...selects[0]!.options].map((o) => o.value).find((v) => v !== 'all')!;
    fire(selects[0]!, rule);
    fire(selects[1]!, rule);
    expect(sent.at(-1)!.turnsForward?.slice(0, 2)).toEqual([rule, rule]);
  });
});
