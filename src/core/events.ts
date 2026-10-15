/** THE GAME'S INPUT, IN ONE QUEUE: what the browser dispatches */
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
