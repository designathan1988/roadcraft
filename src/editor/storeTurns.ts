/** THE SAVE WORKER'S TURNS: its writes before its reads, on the one worker they share (`jobPool.ts` KEPT_CLEAR) */

/** A task of its own (a message to itself, HTML's task queue): what came in meanwhile (a write's message, an IndexedDB event) runs first. */
function nextTask(): Promise<void> {
  return new Promise((done) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => { channel.port1.close(); done(); };
    channel.port2.postMessage(null);
  });
}

/** DO NOT let a write wait behind the reads queued before it: a read's decoding and preparing is synchronous (a tile's records parsed, `prepareTile`), and three of them held an edit's and the balance's commits ~460 ms, a reload meanwhile lost them (conf28). The reads one at a time, each begun in a task of its own once no write is under way: a write waits for one read at most, never takes a worker from the pool. */
export class StoreTurns {
  /** Writes under way. */
  private writing = 0;
  /** Reads waiting for the writes to end. */
  private readonly waiting: (() => void)[] = [];
  /** The last read's turn. */
  private reads: Promise<void> = Promise.resolve();

  /** A write run at once, ahead of every read not begun. */
  async write<T>(run: () => Promise<T>): Promise<T> {
    this.writing++;
    try {
      return await run();
    } finally {
      if (--this.writing === 0) for (const go of this.waiting.splice(0)) go();
    }
  }

  /** A read run in its turn: after the reads before it, and when no write is under way. */
  read<T>(run: () => Promise<T>): Promise<T> {
    const turn = this.reads.then(async () => {
      for (;;) {
        await nextTask();
        if (this.writing === 0) break;
        await new Promise<void>((go) => this.waiting.push(go));
      }
      return run();
    });
    this.reads = turn.then(() => undefined, () => undefined);
    return turn;
  }
}
