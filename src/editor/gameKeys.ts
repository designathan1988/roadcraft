/** THE GAME'S KEYS: every key the game answers, as rules of the command registry */
import { CommandRegistry, type CommandResult, type KeyRule } from '@core/commands';
import type { Tool } from './toolMachine';

/** What the keys act on: the game's commands, handed in by `main.ts`. */
export interface GameKeyDeps {
  tool(): Tool;
  /** The Builder's own keys; whether it used this one. */
  buildingKey(e: KeyboardEvent): boolean;
  transitKey(key: string): boolean;
  barrierKey(key: string): boolean;
  /** The road tool's rebindable keys (`ui/roads/keys.ts`); whether the key is one of them. */
  roadKey(key: string): boolean;
  /** Whether Inspect has a smooth node picked, which Page Up/Down raise and lower. */
  smoothNodePicked(): boolean;
  stepNodeHeight(metres: 1 | -1): void;
  camera: {
    /** A quarter turn, glided. */
    readonly turn: (radians: number) => void;
    /** A camera key held; whether it is one (`view/cameraMotion.ts`). */
    readonly press: (code: string, shift: boolean) => boolean;
    /** The view the game starts with, framing the map. */
    readonly home: () => void;
  };
  requestDraw(): void;
  saveMap(): void;
  openMap(): void;
  duplicateRoad(): void;
  undo(): void;
  redo(): void;
  /** Whether Inspect has a road picked, which Delete removes. */
  roadPicked(): boolean;
  deleteRoad(): void;
  /** Whether the focus sits on a button the player reached with the keyboard (Space is that button's). */
  keyboardOnButton(e: KeyboardEvent): boolean;
  togglePause(e: KeyboardEvent): void;
  /** The terrain brush: its operation by number (1 = the first), radius and strength steps; false: no such operation. */
  terrainMode(index: number): boolean;
  terrainRadius(step: 1 | -1): void;
  terrainStrength(step: 1 | -1): void;
  roadClassCount: number;
  pickRoadClass(index: number): void;
  toggleChanges(): void;
  /** The F9 monitor (`ui/healthPanel.ts`): toggled, or closed (false: it was not open). */
  health: { toggle(): void; close(): boolean };
  /** The F7 effects panel (`ui/effectsPanel.ts`): toggled, or closed (false: it was not open). */
  effects: { toggle(): void; close(): boolean };
  /** A tool's key: takes the tool or puts it down (`toolMachine` `toggle`), and the drawer follows. */
  toolKey(tool: Tool): void;
  /** Escape, one step back: the stroke, then what Inspect picked, then the tool; false: nothing to put down. */
  escape(): boolean;
}

/** The letter of each tool (R is the Builder's rotation; the road tool is the number row). */
const TOOL_LETTERS: Readonly<Record<string, Tool>> = {
  u: 'upgrade', m: 'move', x: 'split', b: 'bulldoze', c: 'control', t: 'terrain', i: 'inspect',
  p: 'pole', g: 'streetscape', f: 'barrier', z: 'zone', h: 'building', o: 'transit',
};

const done = (act: () => void): CommandResult => { act(); return 'done'; };
const used = (yes: boolean): CommandResult => (yes ? 'done' : 'pass');
/** A held key's command: when the key is taken, a frame is asked for. */
const held = (taken: boolean, requestDraw: () => void): CommandResult => {
  if (taken) requestDraw();
  return used(taken);
};

/** The registry with the game's commands and keys. */
export function createGameKeys(d: GameKeyDeps): CommandRegistry<KeyboardEvent> {
  const r = new CommandRegistry<KeyboardEvent>();
  const tool = (t: Tool) => () => d.tool() === t;
  const command = (id: string, run: (e: KeyboardEvent, args?: unknown) => CommandResult): void => r.register({ id, label: `key.${id}`, run });

  command('building.keys', (e) => used(d.buildingKey(e)));
  command('transit.keys', (e) => used(d.transitKey(e.key)));
  command('barrier.keys', (e) => used(d.barrierKey(e.key)));
  command('road.keys', (e) => used(d.roadKey(e.key)));
  command('node.height', (e) => done(() => d.stepNodeHeight(e.key === 'PageUp' ? 1 : -1)));
  command('camera.turn', (e) => done(() => {
    if (e.shiftKey) { if (!e.repeat) d.camera.turn((e.code === 'KeyQ' ? -1 : 1) * Math.PI / 2); } else d.camera.press(e.code, false);
    d.requestDraw();
  }));
  command('map.save', () => done(d.saveMap));
  command('map.open', () => done(d.openMap));
  command('road.duplicate', () => done(d.duplicateRoad));
  command('history.undo', () => done(d.undo));
  command('history.redo', () => done(d.redo));
  command('road.delete', () => done(d.deleteRoad));
  command('sim.pause', (e) => done(() => d.togglePause(e)));
  command('terrain.mode', (e) => used(d.terrainMode(Number(e.key))));
  command('terrain.radius', (_e, step) => done(() => d.terrainRadius(step as 1 | -1)));
  command('terrain.strength', (_e, step) => done(() => d.terrainStrength(step as 1 | -1)));
  command('road.class', (e) => done(() => d.pickRoadClass(Number(e.key) - 1)));
  command('debug.changes', () => done(d.toggleChanges));
  command('debug.health', () => done(d.health.toggle));
  command('health.close', () => used(d.health.close()));
  command('debug.effects', () => done(d.effects.toggle));
  command('effects.close', () => used(d.effects.close()));
  command('tool.key', (e) => done(() => d.toolKey(TOOL_LETTERS[e.key.toLowerCase()]!)));
  command('escape', () => used(d.escape()));
  command('camera.keys', (e) => held(d.camera.press(e.code, e.shiftKey), d.requestDraw));
  command('camera.home', () => done(() => { d.camera.home(); d.requestDraw(); }));

  const digits = (n: number): string[] => Array.from({ length: n }, (_, i) => String(i + 1));
  /** First rule first: the first that matches and does not pass acts. */
  const RULES: KeyRule<KeyboardEvent>[] = [
    // The F9 monitor: an open popover takes Escape before the tool in hand (WAI-ARIA, Escape closes the popup).
    { key: 'F9', command: 'debug.health' },
    { key: 'Escape', command: 'health.close' },
    { key: 'F7', command: 'debug.effects' },
    { key: 'Escape', command: 'effects.close' },
    // The tool in hand reads its own keys first.
    { command: 'building.keys', when: tool('building') },
    { ctrl: false, command: 'transit.keys', when: tool('transit') },
    { ctrl: false, command: 'barrier.keys', when: tool('barrier') },
    { ctrl: false, alt: false, command: 'road.keys', when: tool('road') },
    { key: ['PageUp', 'PageDown'], ctrl: false, command: 'node.height', when: () => d.tool() === 'inspect' && d.smoothNodePicked() },
    // Q/E turn the camera, held; with Shift a quarter turn.
    { code: 'KeyQ', ctrl: false, alt: false, command: 'camera.turn', prevent: false },
    { code: 'KeyE', ctrl: false, alt: false, command: 'camera.turn', prevent: false },
    { key: 's', ctrl: true, command: 'map.save' },
    { key: 'o', ctrl: true, command: 'map.open' },
    { key: 'd', ctrl: true, command: 'road.duplicate' },
    { key: 'z', ctrl: true, shift: false, command: 'history.undo' },
    { key: 'y', ctrl: true, command: 'history.redo' },
    { key: 'z', ctrl: true, shift: true, command: 'history.redo' },
    { key: ['Delete', 'Backspace'], ctrl: false, command: 'road.delete', when: () => d.tool() === 'inspect' && d.roadPicked() },
    // Space pauses and resumes; a button reached with the keyboard keeps it.
    { key: ' ', ctrl: false, command: 'sim.pause', when: (e) => !d.keyboardOnButton(e) },
    // Sculpting, the number row picks the operation (the road classes are not on screen).
    { key: digits(9), command: 'terrain.mode', when: tool('terrain'), prevent: false },
    { key: '[', command: 'terrain.radius', args: -1, when: tool('terrain'), prevent: false },
    { key: ']', command: 'terrain.radius', args: 1, when: tool('terrain'), prevent: false },
    { key: ['{', '-', '_'], command: 'terrain.strength', args: -1, when: tool('terrain'), prevent: false },
    { key: ['}', '=', '+'], command: 'terrain.strength', args: 1, when: tool('terrain'), prevent: false },
    // The number row: a road class, and the road tool that draws it.
    { key: digits(d.roadClassCount), ctrl: false, alt: false, command: 'road.class', prevent: false },
    { key: 'F8', command: 'debug.changes', prevent: false },
    { key: Object.keys(TOOL_LETTERS), ctrl: false, alt: false, command: 'tool.key', prevent: false },
    { key: 'Escape', command: 'escape' },
    // W A S D, the arrows, Page Up/Down and + - move the camera, held (`view/cameraMotion.ts`).
    { ctrl: false, alt: false, command: 'camera.keys', when: (e) => e.code !== 'KeyQ' && e.code !== 'KeyE' },
    { key: 'Home', ctrl: false, alt: false, command: 'camera.home' },
  ];
  // The registry reads the last bound first.
  for (let i = RULES.length - 1; i >= 0; i--) r.bind(RULES[i]!);
  return r;
}
