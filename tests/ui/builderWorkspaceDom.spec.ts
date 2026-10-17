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
});
