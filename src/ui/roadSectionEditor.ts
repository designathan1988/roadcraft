import type { RoadType } from '@world/roadTypes';
import { laneWidth } from '@world/roadTypes';
import { LANE_TURN_RULES, ROAD_SECTION_LIMITS, type LaneTurnRule, type RoadSection } from '@world/roadSection';
import type { SegmentDirection } from '@world/doc';
import { METERS_PER_UNIT, UNITS_PER_METER } from '@world/units';
import { formatDecimal, t } from './i18n';

/** Editing is opt-in; saved road dimensions remain readable without the flag. */
export const freeRoadsEnabled = (): boolean =>
  new URLSearchParams(location.search).get('roads') === 'free';
let turnsExpanded = false;

/** One change on release, so a drag creates one exact undo step. */
export function mountRoadSectionEditor(
  host: HTMLElement, profile: RoadType, direction: SegmentDirection, authored: RoadSection | undefined,
  change: (section: RoadSection | undefined) => void,
): void {
  const oneWay = direction !== 'both';
  const section = {
    laneWidth: laneWidth(profile), sidewalk: profile.sidewalk, median: profile.median,
    speedKmh: profile.speedLimit * METERS_PER_UNIT * 3.6, priority: profile.priorityRank,
    ...authored,
  };
  const panel = document.createElement('fieldset');
  panel.className = 'road-section-editor';
  panel.style.cssText = 'border:1px solid #ffffff24;border-radius:8px;padding:10px;margin:10px 0';
  const legend = document.createElement('legend');
  legend.textContent = t('road.section.title');
  panel.append(legend);
  const diagram = document.createElement('div');
  diagram.style.cssText = 'display:flex;height:44px;gap:2px;margin:4px 0 12px;overflow:hidden;border-radius:4px';
  diagram.setAttribute('aria-label', t('road.section.preview'));
  const draw = (): void => {
    diagram.replaceChildren();
    const band = (width: number, color: string, text: string): void => {
      if (width <= 0) return;
      const node = document.createElement('span');
      node.style.cssText = `flex:${width} 1 0;background:${color};display:grid;place-items:center;color:white;min-width:0;font-size:11px;overflow:hidden`;
      node.textContent = text;
      diagram.append(node);
    };
    band(section.sidewalk, '#77766e', t('road.section.walk'));
    for (let i = 0; i < profile.lanes; i++) {
      if (i === profile.lanes / 2 && !oneWay) band(section.median, '#496447', '');
      band(section.laneWidth, '#363f49', oneWay ? '→' : i < profile.lanes / 2 ? '←' : '→');
    }
    band(section.sidewalk, '#77766e', t('road.section.walk'));
  };
  draw();
  panel.append(diagram);
  const controls: readonly [keyof typeof ROAD_SECTION_LIMITS, number, number, string][] = [
    // Whole metres: the universal grid's subdivision.
    ['laneWidth', 1, UNITS_PER_METER, 'm'],
    ['sidewalk', 1, UNITS_PER_METER, 'm'],
    ['median', 1, UNITS_PER_METER, 'm'],
    ['speedKmh', 5, 1, 'km/h'],
    ['priority', 1, 1, ''],
  ];
  for (const [field, step, scale, unit] of controls) {
    const [min, max] = ROAD_SECTION_LIMITS[field];
    const label = document.createElement('label');
    label.className = 'inspect-range';
    const title = document.createElement('span');
    title.textContent = t(`road.section.${field}`);
    const output = document.createElement('output');
    const input = document.createElement('input');
    input.type = 'range'; input.min = String(min / scale); input.max = String(max / scale); input.step = String(step);
    input.disabled = field === 'median' && oneWay;
    input.value = String(section[field] / scale);
    input.dataset['sectionField'] = field;
    const update = (): void => {
      output.value = `${formatDecimal(Number(input.value), step < 1 ? 1 : 0)} ${unit}`.trim();
    };
    update();
    input.oninput = () => { section[field] = Number(input.value) * scale; update(); draw(); };
    input.onchange = () => { section[field] = Number(input.value) * scale; change({ ...section }); };
    label.append(title, output, input); panel.append(label);
  }
  const turns = document.createElement('details');
  turns.open = turnsExpanded;
  turns.ontoggle = () => { turnsExpanded = turns.open; };
  const summary = document.createElement('summary');
  summary.textContent = t('road.section.turns');
  turns.append(summary);
  const directions = direction === 'both' ? ['turnsForward', 'turnsBackward'] as const
    : direction === 'aToB' ? ['turnsForward'] as const : ['turnsBackward'] as const;
  for (const key of directions) {
    const count = oneWay ? profile.lanes : profile.lanes / 2;
    for (let i = 0; i < count; i++) {
      const label = document.createElement('label');
      label.className = 'inspect-select';
      label.textContent = t(`road.section.${key}`, { count: i + 1 });
      const select = document.createElement('select');
      select.dataset['laneTurn'] = `${key}:${i}`;
      for (const rule of LANE_TURN_RULES) {
        const option = document.createElement('option');
        option.value = rule; option.textContent = t(`road.turn.${rule}`);
        select.append(option);
      }
      select.value = section[key]?.[i] ?? 'all';
      select.onchange = () => {
        const rules = Array.from({ length: count }, (_, n) => section[key]?.[n] ?? 'all');
        rules[i] = select.value as LaneTurnRule;
        change({ ...section, [key]: rules });
      };
      label.append(select); turns.append(label);
    }
  }
  panel.append(turns);
  const reset = document.createElement('button');
  reset.type = 'button'; reset.textContent = t('road.section.reset');
  reset.onclick = () => change(undefined);
  // In the inspector's own button row, so it is drawn like its neighbours: a
  // bare <button> kept the browser's light grey under the panel's light text.
  const actions = document.createElement('div');
  actions.className = 'inspect-actions';
  actions.append(reset);
  panel.append(actions);
  host.append(panel);
}
