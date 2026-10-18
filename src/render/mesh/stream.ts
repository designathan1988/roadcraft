/** A STREAM OF NUMBERS UNDER CONSTRUCTION IN A TYPED ARRAY grown by doubling, read through `data` (replaced as it grows) up to `length`
 *  - DO NOT accumulate a mesh's vertices or triangles in number[]: a JS array lives in the V8 heap, inside the pointer-compression cage the page and its workers share (4 GB), and a dense tile's near roads allocated 1.3 GB there in one job; an ArrayBuffer's contents live outside it (V8 src/sandbox/sandbox.h: the pointer-compression region at the start of the sandbox, the rest for ArrayBuffer backing stores). */
export class Stream<T extends Float64Array | Uint32Array> {
  data: T;
  length = 0;

  constructor(private readonly make: (size: number) => T, size = 256) {
    this.data = make(size);
  }

  /** Room for `n` more, the array doubled until it fits. */
  private room(n: number): void {
    if (this.length + n <= this.data.length) return;
    let size = this.data.length * 2;
    while (size < this.length + n) size *= 2;
    const next = this.make(size);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  push1(a: number): void {
    this.room(1);
    this.data[this.length++] = a;
  }

  push2(a: number, b: number): void {
    this.room(2);
    const d = this.data;
    d[this.length] = a; d[this.length + 1] = b;
    this.length += 2;
  }

  push3(a: number, b: number, c: number): void {
    this.room(3);
    const d = this.data;
    d[this.length] = a; d[this.length + 1] = b; d[this.length + 2] = c;
    this.length += 3;
  }

  /** Emptied, its array kept for the next use. */
  clear(): void {
    this.length = 0;
  }

  /** What was written, sharing the array (`data` until the next push). */
  view(): T {
    return this.data.subarray(0, this.length) as T;
  }
}

/** A stream of doubles: the numbers exactly as a number[] holds them. */
export const doubles = (size = 256): Stream<Float64Array> => new Stream((n) => new Float64Array(n), size);
/** A stream of vertex indices. */
export const indices = (size = 256): Stream<Uint32Array> => new Stream((n) => new Uint32Array(n), size);
