// @vitest-environment happy-dom The Builder's panel touches the page when it loads.
import { describe, expect, it } from 'vitest';
import { type BuilderActions, type BuilderState, initBuilderWorkspace } from '@ui/builder/workspace';

/** THE BUILDER'S PANEL WRITES THE PAGE ONLY WHEN WHAT IT SHOWS CHANGED, NOT AT EACH MOVE OF THE POINTER (`renderInspector`, plan K5) */
describe('the builder panel', () => {
  it('leaves the toggle and the quick buttons alone when the same state comes again', async () => {
    document.body.innerHTML = '<div id="builder"></div>';
    const actions = new Proxy({}, { get: () => () => {} }) as unknown as BuilderActions;
    const workspace = initBuilderWorkspace(actions);
    const state = { category: 'models', tool: '', armed: null, ready: new Set<string>(), floor: { active: 0, total: 1 }, snap: 'auto', grid: false, hideOthers: false,
      canUndo: false, canRedo: false, inspectorOpen: true, busy: false, selection: null, hint: '', planning: false, planPoints: 0, userBlueprints: [], pattern: null } as unknown as BuilderState;
    workspace.setMode('builder');
    workspace.refresh(state);
    let changes = 0;
    const watch = new MutationObserver((records) => { changes += records.length; });
    watch.observe(document.querySelector('.bw-inspector-head')!.parentElement!, { subtree: true, childList: true, attributes: true, attributeFilter: ['title', 'aria-label'] });
    for (let k = 0; k < 5; k++) workspace.refresh(state);
    await Promise.resolve();
    expect(changes).toBe(0);
    // The inspector folded: its toggle's icon written once.
    workspace.refresh({ ...state, inspectorOpen: false } as BuilderState);
    await Promise.resolve();
    expect(changes).toBeGreaterThan(0);
    watch.disconnect();
  });

  it('writes a value changed into the same field, the one being typed in left as typed (PRD-09)', () => {
    document.body.innerHTML = '<div id="builder"></div>';
    const actions = new Proxy({}, { get: () => () => {} }) as unknown as BuilderActions;
    const workspace = initBuilderWorkspace(actions);
    const fields = (floors: number, height: number) => [
      { id: 'floors', labelKey: 'builder.field.storeys', value: floors, unit: 'count', min: 1, max: 60, step: 1 },
      { id: 'floorHeight', labelKey: 'builder.field.storeyHeight', value: height, unit: 'm', min: 2.6, max: 9, step: 0.05 },
    ];
    const state = (floors: number, height: number) => ({ category: 'models', tool: '', armed: null, ready: new Set<string>(), floor: { active: 0, total: 1 }, snap: 'auto', grid: false, hideOthers: false,
      canUndo: false, canRedo: false, inspectorOpen: true, busy: false, hint: '', planning: false, planPoints: 0, userBlueprints: [], pattern: null,
      selection: { titleKey: 'builder.sel.title', name: 'Volume 1', fields: fields(floors, height) } }) as unknown as BuilderState;
    workspace.setMode('builder');
    workspace.refresh(state(3, 3));
    const input = (id: string) => document.querySelector<HTMLInputElement>(`[data-field="${id}"]`)!;
    const floors = input('floors'), height = input('floorHeight');
    height.focus();
    height.value = '3.4';
    workspace.refresh(state(4, 3.4));
    // The same elements: nothing remade.
    expect(input('floors')).toBe(floors);
    expect(input('floorHeight')).toBe(height);
    expect(floors.value).toBe('4');
    expect(height.value).toBe('3.4');
  });
});
