import { describe, expect, it } from 'vitest';
import { CommandRegistry, type KeyPress } from '@core/commands';

type Ctx = { tool: string; ran: string[]; own: boolean };
const press = (code: string, key: string, mods: Partial<{ ctrl: boolean; shift: boolean; alt: boolean }> = {}): KeyPress =>
  ({ code, key, ctrl: false, shift: false, alt: false, ...mods });

function registry() {
  const r = new CommandRegistry<Ctx>();
  r.register({ id: 'undo', label: 'action.undo', run: (c) => { c.ran.push('undo'); return 'done'; } });
  r.register({ id: 'tool.road', label: 'tool.road', run: (c) => { c.ran.push('road'); return 'done'; } });
  r.register({ id: 'height.up', label: 'x', enabled: (c) => c.tool === 'road', run: (c, args) => { c.ran.push(`height ${String(args)}`); return 'done'; } });
  r.register({ id: 'tool.keys', label: 'x', run: (c) => { if (!c.own) return 'pass'; c.ran.push('tool key'); return 'done'; } });
  return r;
}

describe('the command registry', () => {
  it('resolves a key on its physical code, or on its character without case, and its modifiers', () => {
    const r = registry();
    r.bind({ code: 'KeyZ', ctrl: true, command: 'undo' });
    r.bind({ key: ['1', '!'], ctrl: false, command: 'tool.road' });
    const ctx: Ctx = { tool: 'inspect', ran: [], own: false };
    expect(r.press(press('KeyZ', 'z', { ctrl: true }), ctx)?.command).toBe('undo');
    expect(r.press(press('KeyZ', 'z'), ctx)).toBe(null);
    expect(r.press(press('Digit1', '!', { shift: true }), ctx)?.command).toBe('tool.road');
    expect(r.press(press('Digit1', '1', { ctrl: true }), ctx)).toBe(null);
    expect(ctx.ran).toEqual(['undo', 'road']);
  });

  it('reads the rules from the last bound: a later rule overrides, and `when` picks among them', () => {
    const r = registry();
    r.bind({ code: 'Digit1', command: 'undo' });
    r.bind({ code: 'Digit1', command: 'tool.road' });
    r.bind({ code: 'PageUp', when: (c) => c.tool === 'road', command: 'height.up', args: 1 });
    const ctx: Ctx = { tool: 'inspect', ran: [], own: false };
    r.press(press('Digit1', '1'), ctx);
    expect(ctx.ran).toEqual(['road']);
    expect(r.press(press('PageUp', 'PageUp'), ctx)).toBe(null);
    ctx.tool = 'road';
    r.press(press('PageUp', 'PageUp'), ctx);
    expect(ctx.ran).toEqual(['road', 'height 1']);
  });

  it('runs one command per press: a command that passes lets the key go on to the rule before it', () => {
    const r = registry();
    r.bind({ code: 'KeyZ', command: 'undo' });
    r.bind({ command: 'tool.keys' });
    const ctx: Ctx = { tool: 'inspect', ran: [], own: true };
    expect(r.press(press('KeyZ', 'z'), ctx)?.command).toBe('tool.keys');
    ctx.own = false;
    expect(r.press(press('KeyZ', 'z'), ctx)?.command).toBe('undo');
    expect(ctx.ran).toEqual(['tool key', 'undo']);
  });

  it('cancels a command that may not run now, and refuses unknown ids and double registration', () => {
    const r = registry();
    const ctx: Ctx = { tool: 'inspect', ran: [], own: false };
    expect(r.run('height.up', ctx)).toBe('cancelled');
    expect(() => r.run('nothing', ctx)).toThrow(/Unknown command/);
    expect(() => r.bind({ code: 'KeyQ', command: 'nothing' })).toThrow(/unknown command/);
    expect(() => r.register({ id: 'undo', label: 'x', run: () => 'done' })).toThrow(/twice/);
  });
});
