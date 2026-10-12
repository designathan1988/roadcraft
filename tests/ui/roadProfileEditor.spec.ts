// @vitest-environment happy-dom
// The profile editor and its drawn cross-section (docs/VIAS.md V2).
import { afterEach, describe, expect, it } from 'vitest';

import { drawSection, metresText } from '@ui/roads/crossSection';
import { formatDecimal } from '@ui/i18n';
import { closeProfileEditor, insertionIndex, moved, openProfileEditor, withWidth } from '@ui/roads/profileEditor';
import { mountProfilePanel } from '@ui/roads/profilePanel';
import type { RoadSegment } from '@world/doc';
import { type RoadProfileSpec, profileIssues } from '@world/roads/profile';
import { classTemplates } from '@world/roads/templates';
import { ROAD_TYPES } from '@world/roadTypes';
import { m } from '@world/units';

const typeIndex = (id: string): number => ROAD_TYPES.findIndex((t) => t.id === id);

/** Footway, a lane each way, footway: the plainest two-way street. */
const street: RoadProfileSpec = {
  elements: [
    { kind: 'footway', width: m(2) },
    { kind: 'lane', width: m(3), dir: 'backward' },
    { kind: 'lane', width: m(3), dir: 'forward' },
    { kind: 'footway', width: m(2) },
  ],
  speedKmh: 50,
  priority: 1,
};

afterEach(() => closeProfileEditor());

describe('palette placement', () => {
  it('puts each new element where the road can carry it', () => {
    expect(insertionIndex(street, 'laneBackward', 0)).toBe(2);
    expect(insertionIndex(street, 'laneForward', 0)).toBe(3);
    expect(insertionIndex(street, 'median', 0)).toBe(2);
    // A bay goes by the kerb nearest the picked element.
    expect(insertionIndex(street, 'parking', 0)).toBe(1);
    expect(insertionIndex(street, 'parking', 3)).toBe(3);
    // ...and by the other kerb when that one has its band already.
    const parked = { ...street, elements: [street.elements[0]!, { kind: 'parking' as const, width: m(2) }, ...street.elements.slice(1)] };
    expect(insertionIndex(parked, 'cycle', 1)).toBe(4);
    // A footway fills a missing edge first.
    const noRight = { ...street, elements: street.elements.slice(0, 3) };
    expect(insertionIndex(noRight, 'footway', 1)).toBe(3);
    const noLeft = { ...street, elements: street.elements.slice(1) };
    expect(insertionIndex(noLeft, 'footway', 1)).toBe(0);
  });

  it('every class template stays buildable after a lane pair is added through the palette', () => {
    for (const template of classTemplates()) {
      if (template.profile.elements.every((e) => e.kind !== 'lane' || e.dir === 'forward')) continue;
      let p = template.profile;
      for (const kind of ['laneBackward', 'laneForward'] as const) {
        const at = insertionIndex(p, kind, 1);
        const lane = p.elements.find((e) => e.kind === 'lane')!;
        const elements = [...p.elements];
        elements.splice(at, 0, { kind: 'lane', width: lane.width, dir: kind === 'laneForward' ? 'forward' : 'backward' });
        p = { ...p, elements };
      }
      expect(profileIssues(p, template.type), template.id).toEqual([]);
    }
  });
});

describe('editing', () => {
  it('a lane takes every lane to its width; another element only itself', () => {
    const wider = withWidth(street, 1, 4);
    expect(wider.elements.map((e) => e.width)).toEqual([m(2), m(4), m(4), m(2)]);
    const footway = withWidth(street, 3, 5);
    expect(footway.elements.map((e) => e.width)).toEqual([m(2), m(3), m(3), m(5)]);
  });

  it('a lane moved past the other direction is named on that lane', () => {
    const wrong = moved(street, 1, 2);
    const issues = profileIssues(wrong, typeIndex('urban'));
    expect(issues).toEqual([{ problem: 'order', elements: [2] }]);
  });
});

describe('the drawn section', () => {
  it('lays every element at its width, with a group, a label and a handle between each pair', () => {
    const drawing = drawSection(street, { width: 1000, height: 200, selected: 1, flagged: new Set([2]) });
    const total = drawing.spans.reduce((sum, [a, b]) => sum + (b - a), 0);
    expect(total).toBeCloseTo(1000 - 24, 0);
    const widths = drawing.spans.map(([a, b]) => b - a);
    expect(widths[1]! / widths[0]!).toBeCloseTo(1.5, 1);
    expect(drawing.svg.match(/data-index="/g)?.length).toBe(4);
    expect(drawing.svg.match(/data-edge="/g)?.length).toBe(3);
    expect(drawing.svg.match(/class="xs-label"/g)?.length).toBe(4);
    expect(drawing.svg).toContain('>3 m<');
    expect(drawing.svg.match(/class="xs-selected"/g)?.length).toBe(1);
    expect(drawing.svg.match(/class="xs-flag"/g)?.length).toBe(1);
    // A car in each lane, somebody on each footway.
    expect(drawing.svg.match(/class="xs-car"/g)?.length).toBe(2);
    expect(drawing.svg.match(/class="xs-person"/g)?.length).toBe(2);
  });

  it('the whole column over each element picks it, not only its slab (a drag on the air over a lane moves the lane)', () => {
    const drawing = drawSection(street, { width: 1000, height: 200 });
    const hits = [...drawing.svg.matchAll(/<rect class="xs-hit" x="([\d.]+)" y="0" width="([\d.]+)" height="([\d.]+)"/g)];
    expect(hits.length).toBe(street.elements.length);
    hits.forEach((hit, i) => {
      expect(Number(hit[1])).toBeCloseTo(drawing.spans[i]![0], 1);
      expect(Number(hit[2])).toBeCloseTo(drawing.spans[i]![1] - drawing.spans[i]![0], 0);
    });
  });

  it('a lane towards A shows a car from the front, a lane towards B from behind', () => {
    const svg = drawSection(street, { width: 1000, height: 200 }).svg;
    expect(svg.match(/#fff4c8/g)?.length).toBe(2);
    expect(svg.match(/#d9483b/g)?.length).toBe(2);
  });

  it('a thumbnail carries no handles, labels or people', () => {
    const drawing = drawSection(street, { width: 92, height: 34, compact: true });
    expect(drawing.svg).not.toContain('data-edge');
    expect(drawing.svg).not.toContain('xs-label');
    expect(drawing.svg).not.toContain('xs-person');
  });

  it('writes widths in metres: whole metres plain, else one decimal in the interface language', () => {
    expect(metresText(m(3))).toBe('3');
    expect(metresText(m(2.4))).toBe(formatDecimal(2.4, 1));
  });

  it('is cheap enough to redraw on every pointer move', () => {
    const boulevard = classTemplates().find((x) => x.id.endsWith('boulevard'))?.profile ?? street;
    const runs = 300;
    const started = performance.now();
    for (let i = 0; i < runs; i++) drawSection(boulevard, { width: 960, height: 200, selected: i % 4 });
    const each = (performance.now() - started) / runs;
    // A frame is 16 ms; the picture should take a small slice of it.
    expect(each).toBeLessThan(2);
  });
});

describe('the editor and the inspector use the interface’s own controls', () => {
  it('no native select, checkbox or number box; every problem shown in its element’s block', () => {
    openProfileEditor({ title: 'test', profile: street, type: typeIndex('urban'), apply: () => {} });
    const panel = document.querySelector('.rp-panel')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelectorAll('select, input[type="checkbox"], input[type="number"]').length).toBe(0);
    expect(panel.querySelectorAll('.rp-card').length).toBe(classTemplates().length + 1);
    expect(panel.querySelectorAll('.rp-tool').length).toBe(6);
    // Add a forward lane: it goes after the forward lane, and the road is now unbalanced.
    (panel.querySelector('[data-palette="laneForward"]') as HTMLButtonElement).click();
    const labels = [...panel.querySelectorAll('.xs-label')].map((x) => x.textContent);
    expect(labels).toEqual(['2 m', '3 m', '3 m', '3 m', '2 m']);
    const block = panel.querySelector('.rp-element')!;
    expect(block.querySelector('.rp-issue')?.textContent).toBeTruthy();
    expect((panel.querySelector('[data-action="apply"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('a saved template appears as a picked card, and the actions keep one line (no status text)', () => {
    openProfileEditor({ title: 'test', profile: street, type: typeIndex('urban'), apply: () => {} });
    const panel = document.querySelector('.rp-panel')!;
    const before = panel.querySelectorAll('.rp-card').length;
    (panel.querySelector('[data-action="save"]') as HTMLButtonElement).click();
    const field = panel.querySelector('.rp-field') as HTMLInputElement;
    field.value = 'Minha rua';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(panel.querySelectorAll('.rp-card').length).toBe(before + 1);
    const picked = [...panel.querySelectorAll('.rp-card.on .rp-card-name')].map((x) => x.textContent);
    expect(picked).toContain('Minha rua');
    expect(panel.querySelector('.rp-foot [role="status"]')).toBeNull();
    localStorage.clear();
  });

  it('the inspector shows the profile in miniature and one button, no selects', () => {
    const host = document.createElement('div');
    const segment = { type: typeIndex('urban'), lanes: null, direction: 'both' } as unknown as RoadSegment;
    mountProfilePanel(host, segment, () => {});
    expect(host.querySelector('svg.xs')).not.toBeNull();
    expect(host.querySelectorAll('select, input').length).toBe(0);
    expect(host.querySelectorAll('button').length).toBe(1);
  });
});
