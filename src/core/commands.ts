/** THE COMMAND REGISTRY: one table of what the player can do, behind the shortcuts, the dock, the drawers */

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

  /** Resolves a key press and runs its command */
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
