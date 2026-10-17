import { WriteBudget } from '@core/derivedCache';

/** THE PAGE'S WRITES TO THE DERIVED CACHE, HANDED TO ITS WRITER (`derivedWriter.worker.ts`) UNDER A CEILING OF BYTES IN FLIGHT: answered on each commit; past the ceiling a write is not kept (made again next time) - DO NOT post without bound, the bytes waited in the writer and the page's next session waited behind them (the V8 cage, the defect that kills the runs) */
export class DerivedWriterLane {
  private readonly budget: WriteBudget;
  private readonly open = new Map<number, () => void>();
  private next = 1;

  constructor(private readonly port: Worker, most: number) {
    this.budget = new WriteBudget(most);
    port.onmessage = (event: MessageEvent<{ readonly done?: number }>) => {
      const id = event.data.done;
      if (id === undefined) return;
      this.open.get(id)?.();
      this.open.delete(id);
    };
  }

  /** Bytes posted and not committed yet. */
  get bytes(): number {
    return this.budget.bytes;
  }

  /** `entries` posted to be kept under `prefix`, `transfer` handed over; false when they did not fit (nothing posted). */
  post(prefix: string, entries: readonly [string, unknown][], transfer: Transferable[], bytes: number): boolean {
    const release = this.budget.tryTake(bytes);
    if (!release) return false;
    const id = this.next++;
    this.open.set(id, release);
    this.port.postMessage({ id, prefix, entries }, transfer);
    return true;
  }
}
