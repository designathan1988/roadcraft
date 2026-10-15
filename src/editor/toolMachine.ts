/** THE TOOL IN HAND as a state machine (`core/statechart.ts`): the only way the tool changes. */
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
      // The free hand put down again only lets go of what it picked; another tool's button pressed twice puts that tool down.
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
