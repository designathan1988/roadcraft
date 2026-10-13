import { describe, expect, it } from 'vitest';
import { createGameKeys, type GameKeyDeps } from '@editor/gameKeys';
import type { Tool } from '@editor/toolMachine';

/**
 * One key, one command. At the SOURCE (4cc2926e) four `keydown` listeners each
 * read every key, so these presses did two things each (docs/PROBLEMS.md R16).
 */
interface World {
  tool: Tool;
  smoothNode: boolean;
  road: boolean;
  buildingUses: (key: string) => boolean;
  focusFromKeyboard: boolean;
  healthOpen: boolean;
  calls: string[];
}

function setup(start: Partial<World> = {}) {
  const w: World = { tool: 'inspect', smoothNode: false, road: false, buildingUses: () => false, focusFromKeyboard: false, healthOpen: false, calls: [], ...start };
  const log = (what: string) => () => { w.calls.push(what); };
  const deps: GameKeyDeps = {
    tool: () => w.tool,
    buildingKey: (e) => { const used = w.buildingUses(e.key); if (used) w.calls.push(`building ${e.key}`); return used; },
    transitKey: () => false,
    barrierKey: () => false,
    roadKey: (key) => { const used = key === 'PageUp' || key === 'v'; if (used) w.calls.push(`road ${key}`); return used; },
    smoothNodePicked: () => w.smoothNode,
    stepNodeHeight: (m) => w.calls.push(`node ${m}`),
    camera: {
      turn: (r) => w.calls.push(`turn ${r.toFixed(2)}`),
      press: (code) => { const used = ['KeyW', 'KeyA', 'PageUp', 'Equal', 'Minus', 'ArrowUp', 'KeyQ', 'KeyE'].includes(code); if (used) w.calls.push(`camera ${code}`); return used; },
      home: log('home'),
    },
    requestDraw: () => {},
    saveMap: log('save'),
    openMap: log('open'),
    duplicateRoad: log('duplicate'),
    undo: log('undo'),
    redo: log('redo'),
    roadPicked: () => w.road,
    deleteRoad: log('delete road'),
    keyboardOnButton: () => w.focusFromKeyboard,
    togglePause: log('pause'),
    terrainMode: (i) => { w.calls.push(`terrain mode ${i}`); return true; },
    terrainRadius: (s) => w.calls.push(`radius ${s}`),
    terrainStrength: (s) => w.calls.push(`strength ${s}`),
    roadClassCount: 6,
    pickRoadClass: (i) => w.calls.push(`class ${i}`),
    toggleChanges: log('changes'),
    health: {
      toggle: log('health toggle'),
      close: () => { if (!w.healthOpen) return false; w.healthOpen = false; w.calls.push('health close'); return true; },
    },
    toolKey: (t) => w.calls.push(`tool ${t}`),
    escape: () => { w.calls.push('escape'); return true; },
  };
  const keys = createGameKeys(deps);
  const press = (code: string, key: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean; repeat: boolean }> = {}) => {
    const e = { code, key, ctrlKey: !!mods.ctrl, metaKey: false, shiftKey: !!mods.shift, altKey: !!mods.alt, repeat: !!mods.repeat, target: null } as unknown as KeyboardEvent;
    return keys.press({ code, key, ctrl: !!mods.ctrl, shift: !!mods.shift, alt: !!mods.alt }, e);
  };
  return { w, press, keys };
}

describe('the game keys', () => {
  it('lets the Builder have Escape while it has something in hand, and the game after', () => {
    let held = true;
    const { w, press } = setup({ tool: 'building', buildingUses: (k) => k === 'Escape' && held });
    press('Escape', 'Escape');
    held = false;
    press('Escape', 'Escape');
    expect(w.calls).toEqual(['building Escape', 'escape']);
  });

  it('lets the open F9 monitor have Escape, and the tool in hand the next one', () => {
    // At the SOURCE the monitor listened on the window: one Escape closed it AND put the tool down.
    const { w, press } = setup({ tool: 'building', buildingUses: (k) => k === 'Escape', healthOpen: true });
    press('Escape', 'Escape');
    press('Escape', 'Escape');
    expect(w.calls).toEqual(['health close', 'building Escape']);
  });

  it('toggles the F9 monitor through the game keys', () => {
    const { w, press } = setup();
    press('F9', 'F9');
    expect(w.calls).toEqual(['health toggle']);
  });

  it('gives + and - to the terrain brush strength, not also to the zoom', () => {
    const { w, press } = setup({ tool: 'terrain' });
    press('Equal', '=');
    press('Minus', '-');
    expect(w.calls).toEqual(['strength 1', 'strength -1']);
  });

  it('gives Page Up to a picked smooth node or the road tool, not also to the camera tilt', () => {
    const node = setup({ smoothNode: true });
    node.press('PageUp', 'PageUp');
    expect(node.w.calls).toEqual(['node 1']);
    const road = setup({ tool: 'road' });
    road.press('PageUp', 'PageUp');
    expect(road.w.calls).toEqual(['road PageUp']);
    const free = setup();
    free.press('PageUp', 'PageUp');
    expect(free.w.calls).toEqual(['camera PageUp']);
  });

  it('leaves Ctrl and Alt with a tool letter or a digit to the browser', () => {
    const { w, press } = setup();
    expect(press('KeyF', 'f', { ctrl: true })).toBe(null);
    expect(press('KeyT', 't', { ctrl: true })).toBe(null);
    expect(press('Digit1', '1', { ctrl: true })).toBe(null);
    expect(press('KeyB', 'b', { alt: true })).toBe(null);
    expect(w.calls).toEqual([]);
  });

  it('takes every tool by its letter, O and G included, and the road class by its digit', () => {
    const { w, press } = setup();
    for (const [code, key] of [['KeyO', 'o'], ['KeyG', 'g'], ['KeyZ', 'Z'], ['KeyI', 'i']] as const) press(code, key, { shift: key === 'Z' });
    press('Digit3', '3');
    press('Digit7', '7');
    expect(w.calls).toEqual(['tool transit', 'tool streetscape', 'tool zone', 'tool inspect', 'class 2']);
  });

  it('runs the page shortcuts once each', () => {
    const { w, press } = setup({ road: true });
    press('KeyZ', 'z', { ctrl: true });
    press('KeyZ', 'Z', { ctrl: true, shift: true });
    press('KeyY', 'y', { ctrl: true });
    press('KeyS', 's', { ctrl: true });
    press('KeyD', 'd', { ctrl: true });
    press('Delete', 'Delete');
    expect(w.calls).toEqual(['undo', 'redo', 'redo', 'save', 'duplicate', 'delete road']);
  });

  it('leaves V to the road plan with the road tool in hand', () => {
    const { w, press } = setup({ tool: 'road' });
    press('KeyV', 'v');
    expect(w.calls).toEqual(['road v']);
  });

  it('turns with Q and E, a quarter turn with Shift once per press', () => {
    const { w, press } = setup();
    press('KeyQ', 'q');
    press('KeyE', 'E', { shift: true });
    press('KeyE', 'E', { shift: true, repeat: true });
    expect(w.calls).toEqual(['camera KeyQ', 'turn 1.57']);
  });

  it('pauses on Space unless a button the keyboard reached has the focus', () => {
    const { w, press } = setup();
    press('Space', ' ');
    w.focusFromKeyboard = true;
    expect(press('Space', ' ')).toBe(null);
    expect(w.calls).toEqual(['pause']);
  });

  it('binds every rule to a registered command', () => {
    const { keys } = setup();
    for (const rule of keys.bindings()) expect(keys.has(rule.command)).toBe(true);
  });
});
