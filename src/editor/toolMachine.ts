/**
 * THE TOOL IN HAND as a state machine (docs/ARCHITECTURE.md 4.2,
 * `core/statechart.ts`): the only way the tool changes.
 * - Each tool is a state; the road tools (draw, upgrade, split, control, move,
 *   roundabout) are the children of `roads`, which is what the Roads button
 *   and the road key hold. `inspect` is the free hand: nothing in hand, a click
 *   inspects what it hits.
 * - `pick(tool)` takes a tool in hand (a panel's own choice, a road class key).
 * - `toggle(tool)` is a tool button or key: it takes the tool, or puts it down
 *   when that tool (or, for `road`, any road tool) is already in hand. Before
 *   this machine the rule was a function in `main.ts` (`pickTool`) and the
 *   road family a list (`heldTool`); here it is one transition each, which a
 *   test walks.
 * - `putDown`: the free hand, and whatever Inspect had picked is let go.
 * Entering a state takes that tool (`ToolHands.take`); the boot's entry takes
 * nothing, the store already holds the starting tool.
 */
import { Machine, type StateSpec, type TransitionRecord } from '@core/statechart';

export type Tool =
  | 'building'
  | 'zone'
  | 'road'
  | 'roundabout'
  | 'terrain'
  | 'upgrade'
  | 'move'
  | 'split'
  | 'bulldoze'
  | 'control'
  | 'inspect'
  | 'pole'
  | 'streetscape'
  | 'barrier'
  | 'transit'
  | 'person';

/** Every tool, as the interface names them. */
export const TOOLS: readonly Tool[] = ['building', 'zone', 'road', 'roundabout', 'terrain', 'upgrade', 'move', 'split', 'bulldoze', 'control', 'inspect', 'pole', 'streetscape', 'barrier', 'transit', 'person'];

/** The tools the Roads button holds. */
const ROAD_TOOLS: readonly Tool[] = ['road', 'upgrade', 'split', 'control', 'move', 'roundabout'];

export function isTool(name: string): name is Tool {
  return (TOOLS as readonly string[]).includes(name);
}

type ToolEvent =
  | { readonly type: 'pick'; readonly tool: Tool }
  | { readonly type: 'toggle'; readonly tool: Tool }
  | { readonly type: 'putDown' };

/** What the machine does to the game: take a tool, let go of what Inspect picked. */
export interface ToolHands {
  /** Takes `tool` in hand: gestures cancelled, the store written, the Builder woken or put to sleep. */
  take(tool: Tool): void;
  /** Lets go of the road or junction Inspect picked, and its panel. */
  letGo(): void;
}

export interface ToolMachine {
  readonly tool: Tool;
  send(event: ToolEvent): void;
  latest(n: number): TransitionRecord[];
}

/** A machine whose state is `start` (the store's tool). */
export function createToolMachine(start: Tool, hands: ToolHands, now?: () => number): ToolMachine {
  const putDown = { target: 'inspect', actions: () => hands.letGo() };
  const states: Record<string, StateSpec<ToolHands, ToolEvent>> = {
    hand: {
      on: {
        pick: [{ target: (e) => (e.type === 'pick' ? e.tool : 'inspect') }],
        toggle: [
          { guard: (e) => e.type === 'toggle' && e.tool === 'inspect', ...putDown },
          { target: (e) => (e.type === 'toggle' ? e.tool : 'inspect') },
        ],
        putDown: [putDown],
      },
    },
    roads: { parent: 'hand', on: { toggle: [{ guard: (e) => e.type === 'toggle' && e.tool === 'road', ...putDown }] } },
  };
  for (const tool of TOOLS) {
    const road = ROAD_TOOLS.includes(tool);
    states[tool] = {
      parent: road ? 'roads' : 'hand',
      // The boot enters with no event: the store already holds the tool.
      entry: (e) => { if (e) hands.take(tool); },
      // The free hand put down again only lets go of what it picked; another
      // tool's button pressed twice puts that tool down.
      on: tool === 'inspect'
        ? { putDown: [{ actions: () => hands.letGo() }], toggle: [{ guard: (e) => e.type === 'toggle' && e.tool === 'inspect', actions: () => hands.letGo() }] }
        : road ? {} : { toggle: [{ guard: (e) => e.type === 'toggle' && e.tool === tool, ...putDown }] },
    };
  }
  const machine = new Machine<ToolHands, ToolEvent>('tool', states, start, hands, now);
  return {
    get tool() { return machine.state as Tool; },
    send: (event) => machine.send(event),
    latest: (n) => machine.latest(n),
  };
}
