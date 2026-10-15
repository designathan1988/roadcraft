/**
 * THE GAME'S INPUT, IN ONE QUEUE (docs/PLANO-ESPINHA-2026-10-14.md, Passo 2):
 * what the browser dispatches - the pointer, the wheel, the clicks - is taken
 * while it is dispatched, with everything read off it then (the canvas's box,
 * the coalesced positions: Pointer Events 3 does not say they outlive the
 * dispatch, w3c.github.io/pointerevents), and handled at the start of the next
 * frame, in the order it came, before the simulation and the drawing (the
 * game loop's "process input" step: Nystrom, "Game Loop",
 * gameprogrammingpatterns.com/game-loop.html). A handler never runs in the
 * middle of a frame's update, and what it changes is seen by the whole frame.
 *
 * What must happen during the dispatch stays in the listener: `preventDefault`
 * (it has effect only then, DOM Standard, "canceled flag") and
 * `setPointerCapture`. The keys are handled in their listener for that reason:
 * whether a key's default is prevented is decided by the command it runs,
 * which may pass it to the next rule (`core/commands.ts` press).
 */
export class InputQueue<T> {
  private items: T[] = [];

  /** Input taken; `wake` asks for the frame that will handle it. */
  constructor(private readonly wake: () => void) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    this.items.push(item);
    this.wake();
  }

  /** Everything taken since the last drain, handled in order; what a handler pushes waits for the next frame. */
  drain(handle: (item: T) => void): void {
    if (!this.items.length) return;
    const items = this.items;
    this.items = [];
    for (const item of items) handle(item);
  }

  /** Everything taken dropped unhandled (a map opened under it). */
  clear(): void {
    this.items.length = 0;
  }
}
