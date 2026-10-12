/**
 * THE COMMAND REGISTRY: one table of what the player can do, behind the
 * shortcuts, the dock, the drawers, the menus and the top bar
 * (docs/ARCHITECTURE.md 4.4, docs/research/controllers.md).
 * - A command is an id, its label (an i18n key), whether it may run now
 *   (`enabled`) and what it does (`run`), which reports `done`, `cancelled`
 *   or `pass` (Blender's operators: FINISHED, CANCELLED, PASS_THROUGH; only
 *   `done` acted, `pass` lets the key go on to the next rule).
 * - Keys are rules on the physical key (`code`, `KeyboardEvent.code`) or on
 *   the character (`key`, `KeyboardEvent.key`, compared without case), with
 *   modifiers (`ctrl` stands for Ctrl or Cmd; a modifier left out matches
 *   either way) and a `when`. A rule with neither `code` nor `key` takes any
 *   key: a tool that reads its own keys and passes the rest.
 * - Rules are read from the last bound to the first and the first whose key
 *   and `when` match and whose command does not pass wins (VS Code's key
 *   bindings): a later rule overrides an earlier one. One key press runs one
 *   command at most.
 * Pure: no DOM (the key press is described by its fields), no three.
 */

export type CommandResult = 'done' | 'cancelled' | 'pass';

export interface Command<Ctx> {
  readonly id: string;
  /** The i18n key of its name. */
  readonly label: string;
  readonly enabled?: (ctx: Ctx) => boolean;
  readonly run: (ctx: Ctx, args?: unknown) => CommandResult;
}

export interface KeyRule<Ctx> {
  /** `KeyboardEvent.code` (the physical key: 'KeyZ', 'Digit1', 'Escape'). */
  readonly code?: string;
  /** `KeyboardEvent.key` (the character: 'z', '[', 'PageUp'), or several; without case. */
  readonly key?: string | readonly string[];
  /** Ctrl or Cmd held; left out: either. */
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** When the rule applies; omitted: always. */
  readonly when?: (ctx: Ctx) => boolean;
  readonly command: string;
  readonly args?: unknown;
  /** Whether the page's own use of the key is cancelled when the command acts (default: yes). */
  readonly prevent?: boolean;
}

export interface KeyPress {
  readonly code: string;
  readonly key: string;
  /** Ctrl or Cmd. */
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
}

export class CommandRegistry<Ctx> {
  private readonly commands = new Map<string, Command<Ctx>>();
  private readonly keys: KeyRule<Ctx>[] = [];

  register(command: Command<Ctx>): void {
    if (this.commands.has(command.id)) throw new Error(`Command ${command.id} registered twice`);
    this.commands.set(command.id, command);
  }

  bind(rule: KeyRule<Ctx>): void {
    if (!this.commands.has(rule.command)) throw new Error(`Key ${String(rule.code ?? rule.key ?? 'any')} bound to an unknown command ${rule.command}`);
    this.keys.push(rule);
  }

  has(id: string): boolean {
    return this.commands.has(id);
  }

  /** Every command, in the order registered. */
  all(): Command<Ctx>[] {
    return [...this.commands.values()];
  }

  /** Every key rule, in the order bound. */
  bindings(): readonly KeyRule<Ctx>[] {
    return this.keys;
  }

  /** Runs `id` if it may run now; `cancelled` when it may not. An unknown id is an error. */
  run(id: string, ctx: Ctx, args?: unknown): CommandResult {
    const command = this.commands.get(id);
    if (!command) throw new Error(`Unknown command ${id}`);
    if (command.enabled && !command.enabled(ctx)) return 'cancelled';
    return command.run(ctx, args);
  }

  /**
   * Resolves a key press and runs its command: the last bound rule whose key
   * and `when` match, or the one before it while the commands pass. The rule
   * that acted, or null when none did.
   */
  press(press: KeyPress, ctx: Ctx): KeyRule<Ctx> | null {
    for (let i = this.keys.length - 1; i >= 0; i--) {
      const r = this.keys[i]!;
      if (!matches(r, press)) continue;
      if (r.when && !r.when(ctx)) continue;
      const result = this.run(r.command, ctx, r.args);
      if (result === 'pass') continue;
      return r;
    }
    return null;
  }
}

function matches<Ctx>(r: KeyRule<Ctx>, press: KeyPress): boolean {
  if (r.code !== undefined && r.code !== press.code) return false;
  if (r.key !== undefined) {
    const key = press.key.toLowerCase();
    if (typeof r.key === 'string' ? r.key.toLowerCase() !== key : !r.key.some((k) => k.toLowerCase() === key)) return false;
  }
  return (r.ctrl === undefined || r.ctrl === press.ctrl)
    && (r.shift === undefined || r.shift === press.shift)
    && (r.alt === undefined || r.alt === press.alt);
}
