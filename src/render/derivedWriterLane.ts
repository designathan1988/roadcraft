import { WriteBudget } from '@core/derivedCache';

/** THE PAGE'S WRITES TO THE DERIVED CACHE, HANDED TO ITS WRITER (`derivedWriter.worker.ts`) UNDER A CEILING OF BYTES IN FLIGHT: answered on each commit; past the ceiling a write is not kept (made again next time) - DO NOT post without bound, the bytes waited in the writer and the page's next session waited behind them (the V8 cage, the defect that kills the runs) */
export class DerivedWriterLane {
  private readonly budget: WriteBudget;
  private readonly open = new Map<number, () => void>();
  /** Reads asked of the writer (`read`), by id: answered with the entries it found. */
  private readonly reads = new Map<number, (got: Map<string, unknown>) => void>();
  private next = 1;

  constructor(private readonly port: Worker, most: number) {
    this.budget = new WriteBudget(most);
    port.onmessage = (event: MessageEvent<{ readonly done?: number; readonly got?: number; readonly entries?: readonly [string, unknown][] }>) => {
      const got = event.data.got;
      if (got !== undefined) {
        this.reads.get(got)?.(new Map(event.data.entries ?? []));
        this.reads.delete(got);
        return;
      }
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

  /** The entries of `keys` under `prefix`, read by the writer off the page, their arrays handed over (`derivedWriter.worker.ts`). */
  read<T>(prefix: string, keys: readonly string[]): Promise<Map<string, T>> {
    const id = this.next++;
    return new Promise((resolve) => {
      this.reads.set(id, resolve as (got: Map<string, unknown>) => void);
      this.port.postMessage({ read: id, prefix, keys });
    });
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
