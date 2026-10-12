import { describe, expect, it } from 'vitest';
import { createToolMachine, TOOLS, type Tool } from '@editor/toolMachine';

const ROAD_TOOLS: readonly Tool[] = ['road', 'upgrade', 'split', 'control', 'move', 'roundabout'];

function machine(start: Tool = 'inspect') {
  const log: string[] = [];
  const m = createToolMachine(start, { take: (t) => log.push(`take ${t}`), letGo: () => log.push('let go') }, () => 0);
  return { m, log };
}

/** The SOURCE's rule (`main.ts` pickTool at 4cc2926e): the oracle the machine must agree with. */
function sourcePick(held: Tool, next: Tool): Tool {
  const family = ROAD_TOOLS.includes(held) ? 'road' : held;
  return next === 'inspect' || next === family ? 'inspect' : next;
}

describe('the tool machine', () => {
  it('takes nothing at the start: the store already holds the tool', () => {
    const { m, log } = machine('terrain');
    expect(m.tool).toBe('terrain');
    expect(log).toEqual([]);
  });

  it('agrees with the old pickTool rule for every tool in hand and every button', () => {
    for (const held of TOOLS) {
      for (const next of TOOLS) {
        const { m } = machine(held);
        m.send({ type: 'toggle', tool: next });
        expect(m.tool, `${held} + ${next}`).toBe(sourcePick(held, next));
      }
    }
  });

  it('puts the road family down from the Roads button, whichever road tool is in hand', () => {
    for (const held of ROAD_TOOLS) {
      const { m, log } = machine(held);
      m.send({ type: 'toggle', tool: 'road' });
      expect(m.tool).toBe('inspect');
      expect(log).toEqual(['let go', 'take inspect']);
    }
  });

  it('lets go before taking the free hand, and only lets go when the hand is already free', () => {
    const { m, log } = machine('zone');
    m.send({ type: 'putDown' });
    expect(log).toEqual(['let go', 'take inspect']);
    log.length = 0;
    m.send({ type: 'putDown' });
    m.send({ type: 'toggle', tool: 'inspect' });
    expect(log).toEqual(['let go', 'let go']);
  });

  it('takes a tool again when picked again (its gestures cancelled), and writes every change down', () => {
    const { m, log } = machine('inspect');
    m.send({ type: 'pick', tool: 'road' });
    m.send({ type: 'pick', tool: 'road' });
    m.send({ type: 'pick', tool: 'upgrade' });
    expect(log).toEqual(['take road', 'take road', 'take upgrade']);
    expect(m.latest(3).map((r) => `${r.from}>${r.to}`)).toEqual(['road>upgrade', 'road>road', 'inspect>road']);
  });
});
