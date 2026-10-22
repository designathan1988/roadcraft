import type { Building } from './types';

/** A TILE'S BUILDINGS AS ONE TYPED TABLE IN SHARED MEMORY (CLAUDE.md "Architecture": per-tile typed tables read by stateless jobs): columns for what is read without the record (id, place, rotation), each record's members in a binary stream, every string, object shape and shared member (`intern.ts`) written once for the tile; a SharedArrayBuffer is posted as a handle, never copied (MDN "SharedArrayBuffer"), and each reader decodes only the rows it is asked for */

const MAGIC = 0x52435442;
/** Bumped when the layout below changes. */
const FORMAT = 1;
/** Header words: magic, format, rows, strings, string units, shapes, shape keys, nodes, stream bytes. */
const HEAD = 9;

const T_NULL = 0, T_FALSE = 1, T_TRUE = 2, T_U8 = 3, T_I32 = 4, T_F64 = 5, T_STR = 6, T_ARR = 7, T_OBJ = 8, T_NODE = 9;

const align8 = (n: number): number => Math.ceil(n / 8) * 8;

/** Shared memory where the page is cross-origin isolated (and in workers and tests); a plain buffer otherwise (only read on its own thread). */
/** DO NOT trust the constructor alone: a context not isolated may still define it, and posting its buffer throws (MDN "crossOriginIsolated"; Node's tests have no such flag). */
export function allocate(bytes: number): ArrayBufferLike {
  const isolated = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated !== false;
  return isolated && typeof SharedArrayBuffer !== 'undefined' ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes);
}

/** A table's bytes in a buffer of their own (shared where the thread is isolated, `allocate`): one read back from a store, which keeps plain buffers only (IndexedDB refuses shared memory, HTML "StructuredSerialize"). */
export function tableIn(bytes: ArrayBufferLike): ArrayBufferLike {
  const out = allocate(bytes.byteLength);
  new Uint8Array(out).set(new Uint8Array(bytes));
  return out;
}

/** A table's bytes as a store keeps them: a plain buffer, copied when the table is in shared memory. */
export function tableBytes(table: ArrayBufferLike): ArrayBuffer {
  if (table instanceof ArrayBuffer) return table;
  const out = new ArrayBuffer(table.byteLength);
  new Uint8Array(out).set(new Uint8Array(table));
  return out;
}

/** Where each section starts, from the header's counts. */
interface Layout {
  readonly rows: number;
  readonly strings: number;
  readonly units: number;
  readonly shapes: number;
  readonly keys: number;
  readonly nodes: number;
  readonly stream: number;
  readonly ids: number;
  readonly xs: number;
  readonly ys: number;
  readonly turns: number;
  readonly rootAt: number;
  readonly nodeAt: number;
  readonly strStart: number;
  readonly shapeStart: number;
  readonly shapeKeys: number;
  readonly strUnits: number;
  readonly streamAt: number;
  readonly bytes: number;
}

function layout(rows: number, strings: number, units: number, shapes: number, keys: number, nodes: number, stream: number): Layout {
  let at = align8(HEAD * 4);
  const take = (bytes: number): number => { const start = at; at = align8(at + bytes); return start; };
  const ids = take(rows * 8), xs = take(rows * 8), ys = take(rows * 8), turns = take(rows * 8);
  const rootAt = take(rows * 4), nodeAt = take(nodes * 4), strStart = take((strings + 1) * 4), shapeStart = take((shapes + 1) * 4), shapeKeys = take(keys * 4);
  const strUnits = take(units * 2), streamAt = take(stream);
  return { rows, strings, units, shapes, keys, nodes, stream, ids, xs, ys, turns, rootAt, nodeAt, strStart, shapeStart, shapeKeys, strUnits, streamAt, bytes: at };
}

/** A growable byte stream the encoder writes the members into. */
class Stream {
  bytes = new Uint8Array(1 << 12);
  view = new DataView(this.bytes.buffer);
  length = 0;

  private room(n: number): void {
    if (this.length + n <= this.bytes.length) return;
    // Doubled while small; past 64 MB a quarter more (a city's table, `TableWriter`: DO NOT leave up to half of a buffer of hundreds of MB empty).
    const grow = (size: number): number => (size < 1 << 26 ? size * 2 : Math.ceil(size * 1.25));
    let size = grow(this.bytes.length);
    while (size < this.length + n) size = grow(size);
    const next = new Uint8Array(size);
    next.set(this.bytes.subarray(0, this.length));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }

  u8(v: number): void { this.room(1); this.bytes[this.length++] = v; }
  u32(v: number): void { this.room(4); this.view.setUint32(this.length, v, true); this.length += 4; }
  i32(v: number): void { this.room(4); this.view.setInt32(this.length, v, true); this.length += 4; }
  f64(v: number): void { this.room(8); this.view.setFloat64(this.length, v, true); this.length += 8; }
}

/** Every object reached more than once from the rows (a member shared by `intern.ts`): written once, as a node. */
function sharedObjects(rows: readonly object[]): Set<object> {
  const seen = new Set<object>(), shared = new Set<object>();
  const walk = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    if (seen.has(value)) { shared.add(value); return; }
    seen.add(value);
    if (Array.isArray(value)) for (const item of value) walk(item);
    else for (const key of Object.keys(value)) walk((value as Record<string, unknown>)[key]);
  };
  for (const row of rows) for (const key of Object.keys(row)) walk((row as Record<string, unknown>)[key]);
  return shared;
}

/** The rows written as one table: their values as JSON would keep them (undefined members left out, in arrays null), numbers exact. */
export function encodeRecords(rows: readonly Building[]): RecordTable {
  const writer = new TableWriter();
  writer.add(rows);
  return writer.finish();
}

/**
 * A TABLE WRITTEN A BATCH OF ROWS AT A TIME (a city generated off the page, `editor/smallCityMap.ts` buildCityTable): every string and
 * object shape once for the whole table, a member shared within a batch written once (`sharedObjects` of the batch), each row read back
 * while the table is still being written (`read`). One batch writes the very bytes `encodeRecords` always wrote. DO NOT hold a whole
 * city's records as objects to encode them at the end: ~20 KB of JS heap a building, and the city of 160,000 buildings took its worker
 * to 5.6 GB, past the V8 cage it shares with its page (2026-10-22); the table holds ~1 KB a building, outside the JS heap.
 */
export class TableWriter {
  private readonly strings = new Map<string, number>();
  private readonly stringList: string[] = [];
  private readonly shapes = new Map<string, number>();
  private readonly shapeList: number[][] = [];
  /** Each shape's keys as strings, for `read`. */
  private readonly shapeNames: string[][] = [];
  private readonly nodeAt: number[] = [];
  private readonly stream = new Stream();
  private readonly ids: number[] = [];
  private readonly xs: number[] = [];
  private readonly ys: number[] = [];
  private readonly turns: number[] = [];
  private readonly rootAt: number[] = [];
  /** Where `read` stands in the stream. */
  private pos = 0;
  /** The shared members written as nodes, kept across batches (`keepShared`): a member met again in a later batch written as its mark. */
  private readonly keptNodes = new Map<object, number>();

  /** `keepShared`: a member written as a node in one batch is that node in the batches after (the members shared across batches, `intern.ts` SharedMembers); without it each batch writes its own. */
  constructor(private readonly keepShared = false) {}

  get rows(): number {
    return this.rootAt.length;
  }

  /** The id of a row written. */
  idAt(row: number): number {
    return this.ids[row]!;
  }

  private stringId(s: string): number {
    let id = this.strings.get(s);
    if (id === undefined) { this.strings.set(s, id = this.stringList.length); this.stringList.push(s); }
    return id;
  }

  private shapeId(keys: readonly string[]): number {
    const name = keys.join('\u0000');
    let id = this.shapes.get(name);
    if (id === undefined) {
      this.shapes.set(name, id = this.shapeList.length);
      this.shapeList.push(keys.map((k) => this.stringId(k)));
      this.shapeNames.push([...keys]);
    }
    return id;
  }

  /** Of the nodes kept across batches (`keepShared`), only those `keep` keeps (`SharedMembers.keeps`): DO NOT keep every node ever written, they grew with the city. */
  keepOnly(keep: (node: object) => boolean): void {
    for (const node of this.keptNodes.keys()) if (!keep(node)) this.keptNodes.delete(node);
  }

  /** Rows written after those before; a member shared between rows of this batch written once, as a node. */
  add(rows: readonly Building[]): void {
    const shared = sharedObjects(rows);
    const nodes = this.keepShared ? this.keptNodes : new Map<object, number>();
    const stream = this.stream, nodeAt = this.nodeAt;
    const number = (v: number): void => {
      if (Number.isInteger(v) && !Object.is(v, -0)) {
        if (v >= 0 && v < 256) { stream.u8(T_U8); stream.u8(v); return; }
        if (v >= -0x80000000 && v <= 0x7fffffff) { stream.u8(T_I32); stream.i32(v); return; }
      }
      stream.u8(T_F64); stream.f64(v);
    };
    // A shared member is written where it is first met, behind its node's mark; later meetings write only the mark.
    const value = (v: unknown): void => {
      if (v === null || v === undefined) { stream.u8(T_NULL); return; }
      switch (typeof v) {
        case 'boolean': stream.u8(v ? T_TRUE : T_FALSE); return;
        case 'number': number(v); return;
        case 'string': stream.u8(T_STR); stream.u32(this.stringId(v)); return;
        case 'object': break;
        default: stream.u8(T_NULL); return;
      }
      const known = nodes.get(v);
      if (known !== undefined) { stream.u8(T_NODE); stream.u32(known); return; }
      if (shared.has(v)) {
        const id = nodeAt.length;
        nodes.set(v, id);
        nodeAt.push(stream.length + 5);
        stream.u8(T_NODE); stream.u32(id);
      }
      body(v);
    };
    const body = (v: object): void => {
      if (Array.isArray(v)) {
        stream.u8(T_ARR); stream.u32(v.length);
        for (const item of v) value(item);
        return;
      }
      const record = v as Record<string, unknown>;
      const keys = Object.keys(record).filter((k) => { const t = typeof record[k]; return t !== 'undefined' && t !== 'function' && t !== 'symbol'; });
      stream.u8(T_OBJ); stream.u32(this.shapeId(keys));
      for (const k of keys) value(record[k]);
    };
    for (const row of rows) {
      this.rootAt.push(stream.length);
      this.ids.push(row.id); this.xs.push(row.x); this.ys.push(row.y); this.turns.push(row.rotation);
      body(row);
    }
  }

  /** A row written, decoded: a fresh object of its own, its shared members its own too. */
  read(row: number): Building {
    if (row < 0 || row >= this.rows) throw new Error(`[buildings] no row ${row} in the table being written`);
    this.pos = this.rootAt[row]!;
    return this.value(this.stream.view) as Building;
  }

  private value(view: DataView): unknown {
    const tag = view.getUint8(this.pos++);
    switch (tag) {
      case T_NULL: return null;
      case T_FALSE: return false;
      case T_TRUE: return true;
      case T_U8: return view.getUint8(this.pos++);
      case T_I32: { const v = view.getInt32(this.pos, true); this.pos += 4; return v; }
      case T_F64: { const v = view.getFloat64(this.pos, true); this.pos += 8; return v; }
      case T_STR: { const id = view.getUint32(this.pos, true); this.pos += 4; return this.stringList[id]!; }
      case T_ARR: {
        const n = view.getUint32(this.pos, true); this.pos += 4;
        const out = new Array<unknown>(n);
        for (let i = 0; i < n; i++) out[i] = this.value(view);
        return out;
      }
      case T_OBJ: {
        const keys = this.shapeNames[view.getUint32(this.pos, true)]!; this.pos += 4;
        const out: Record<string, unknown> = {};
        for (const key of keys) out[key] = this.value(view);
        return out;
      }
      case T_NODE: {
        const id = view.getUint32(this.pos, true); this.pos += 4;
        // Met here first: its body follows the mark.
        if (this.pos === this.nodeAt[id]) return this.value(view);
        const back = this.pos;
        this.pos = this.nodeAt[id]!;
        const node = this.value(view);
        this.pos = back;
        return node;
      }
      default: throw new Error(`[buildings] a record table holds an unknown tag ${tag}`);
    }
  }

  /** The table as written so far, in a buffer of its own (shared where the thread is isolated, `allocate`). */
  finish(): RecordTable {
    const { stringList, shapeList, nodeAt, stream, rootAt } = this;
    const units = stringList.reduce((n, s) => n + s.length, 0);
    const keys = shapeList.reduce((n, s) => n + s.length, 0);
    const at = layout(this.rows, stringList.length, units, shapeList.length, keys, nodeAt.length, stream.length);
    const buffer = allocate(at.bytes);
    new Uint32Array(buffer, 0, HEAD).set([MAGIC, FORMAT, at.rows, at.strings, at.units, at.shapes, at.keys, at.nodes, at.stream]);
    new Float64Array(buffer, at.ids, at.rows).set(this.ids);
    new Float64Array(buffer, at.xs, at.rows).set(this.xs);
    new Float64Array(buffer, at.ys, at.rows).set(this.ys);
    new Float64Array(buffer, at.turns, at.rows).set(this.turns);
    new Uint32Array(buffer, at.rootAt, at.rows).set(rootAt);
    new Uint32Array(buffer, at.nodeAt, at.nodes).set(nodeAt);
    const strStart = new Uint32Array(buffer, at.strStart, at.strings + 1), strUnits = new Uint16Array(buffer, at.strUnits, at.units);
    let u = 0;
    stringList.forEach((s, i) => { strStart[i] = u; for (let c = 0; c < s.length; c++) strUnits[u++] = s.charCodeAt(c); });
    strStart[at.strings] = u;
    const shapeStart = new Uint32Array(buffer, at.shapeStart, at.shapes + 1), shapeKeys = new Uint32Array(buffer, at.shapeKeys, at.keys);
    let k = 0;
    shapeList.forEach((s, i) => { shapeStart[i] = k; for (const id of s) shapeKeys[k++] = id; });
    shapeStart[at.shapes] = k;
    new Uint8Array(buffer, at.streamAt, at.stream).set(stream.bytes.subarray(0, stream.length));
    return new RecordTable(buffer);
  }
}

/** Whether a buffer holds a record table of this format: written once when encoded (`encodeRecords`), never again - a job process's thread keeps the copy it is sent (`jobs/processWorker.ts` KeptBuffer). */
export function isRecordTable(buffer: ArrayBufferLike): boolean {
  if (buffer.byteLength < HEAD * 4) return false;
  const head = new Uint32Array(buffer, 0, 2);
  return head[0] === MAGIC && head[1] === FORMAT;
}

/** A table read back from its buffer (posted or shared): its columns are views on it; its records are decoded by a `TableReader`. */
export class RecordTable {
  readonly rows: number;
  readonly ids: Float64Array;
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly rotations: Float64Array;
  /** The row of each id, made when first asked. */
  private rowOf: Map<number, number> | null = null;
  /** @internal */ readonly at: Layout;

  constructor(readonly buffer: ArrayBufferLike) {
    const head = new Uint32Array(buffer, 0, HEAD);
    if (head[0] !== MAGIC || head[1] !== FORMAT) throw new Error('[buildings] not a record table of this format');
    this.at = layout(head[2]!, head[3]!, head[4]!, head[5]!, head[6]!, head[7]!, head[8]!);
    this.rows = this.at.rows;
    this.ids = new Float64Array(buffer, this.at.ids, this.rows);
    this.xs = new Float64Array(buffer, this.at.xs, this.rows);
    this.ys = new Float64Array(buffer, this.at.ys, this.rows);
    this.rotations = new Float64Array(buffer, this.at.turns, this.rows);
  }

  /** The row holding a building's id; -1 when it is not in the table. */
  row(id: number): number {
    if (!this.rowOf) { this.rowOf = new Map(); for (let i = 0; i < this.rows; i++) this.rowOf.set(this.ids[i]!, i); }
    return this.rowOf.get(id) ?? -1;
  }

  /** A reader of this table: what it decodes (strings, shapes, shared members) is kept for its own life only (a job's). `weak`: its shared members kept only while a record read holds them (`TableReader`). */
  reader(weak = false): TableReader {
    return new TableReader(this, weak);
  }
}

/** DO NOT keep a reader past the job it was made for: a stateless job decodes what it reads and lets it go; the shared members it decoded are one object for all its rows (as `intern.ts` on the page) */
export class TableReader {
  private readonly view: DataView;
  private readonly rootAt: Uint32Array;
  private readonly nodeAt: Uint32Array;
  private readonly strStart: Uint32Array;
  private readonly strUnits: Uint16Array;
  private readonly shapeStart: Uint32Array;
  private readonly shapeKeys: Uint32Array;
  // DO NOT fill these at the ids met, from empty: a row read first meets ids far past the array's end, and V8 turns such an array into a dictionary (each look-up hashed: the cell jobs' decoding, wprof4). Sized and filled once.
  private readonly strings: (string | undefined)[];
  private readonly shapes: (string[] | undefined)[];
  /** Each shared member decoded (a strong reader's: sized and filled once); empty in a weak reader. */
  private readonly nodes: unknown[];
  /** Whether each shared member was decoded (a member may decode to null): a strong reader's. */
  private readonly decoded: Uint8Array;
  /** A weak reader's shared members held somewhere now, by id (`WeakRef`, MDN "WeakRef"): an entry while its member lives, let go by `collected` once the collector takes it. DO NOT size an array a member nor leave a dead `WeakRef` in it: a slot a member and a `WeakRef` each one ever decoded stayed for the table's life (~9 members a building). A member that is no object is decoded again each time. */
  private readonly weakNodes: Map<number, WeakRef<object>> | null;
  private readonly collected: FinalizationRegistry<number> | null;
  private pos = 0;

  /** `weak`: a reader that lives as long as its table (`tableRows.ts`, the page's whole city) - DO NOT hold every shared member it ever decoded: a walk of the whole map left them all decoded and held (13.8 MB of the large city of 8 102 buildings, 2026-10-21); held weakly, they live while a record read holds them. */
  constructor(readonly table: RecordTable, weak = false) {
    const { buffer, at } = table;
    this.view = new DataView(buffer, at.streamAt, at.stream);
    this.rootAt = new Uint32Array(buffer, at.rootAt, at.rows);
    this.nodeAt = new Uint32Array(buffer, at.nodeAt, at.nodes);
    this.strStart = new Uint32Array(buffer, at.strStart, at.strings + 1);
    this.strUnits = new Uint16Array(buffer, at.strUnits, at.units);
    this.shapeStart = new Uint32Array(buffer, at.shapeStart, at.shapes + 1);
    this.shapeKeys = new Uint32Array(buffer, at.shapeKeys, at.keys);
    this.strings = new Array<string | undefined>(at.strings).fill(undefined);
    this.shapes = new Array<string[] | undefined>(at.shapes).fill(undefined);
    this.nodes = weak ? [] : new Array<unknown>(at.nodes).fill(undefined);
    this.decoded = new Uint8Array(weak ? 0 : at.nodes);
    const held = weak ? new Map<number, WeakRef<object>>() : null;
    this.weakNodes = held;
    // A member collected: its entry let go, unless it was decoded again since (a new `WeakRef` in its place).
    this.collected = held ? new FinalizationRegistry<number>((id) => { if (held.get(id)?.deref() === undefined) held.delete(id); }) : null;
  }

  /** A row's record: a fresh object of its own, its shared members the reader's. */
  record(row: number): Building {
    if (row < 0 || row >= this.table.rows) throw new Error(`[buildings] no row ${row} in the record table`);
    this.pos = this.rootAt[row]!;
    return this.value() as Building;
  }

  private string(id: number): string {
    let s = this.strings[id];
    if (s === undefined) {
      const a = this.strStart[id]!, b = this.strStart[id + 1]!;
      s = '';
      // DO NOT TextDecoder a shared view (browsers refuse it): the units are read in short runs.
      for (let i = a; i < b; i += 4096) s += String.fromCharCode(...this.strUnits.subarray(i, Math.min(b, i + 4096)));
      this.strings[id] = s;
    }
    return s;
  }

  private shape(id: number): string[] {
    let keys = this.shapes[id];
    if (!keys) {
      keys = [];
      for (let i = this.shapeStart[id]!; i < this.shapeStart[id + 1]!; i++) keys.push(this.string(this.shapeKeys[i]!));
      this.shapes[id] = keys;
    }
    return keys;
  }

  private value(): unknown {
    const view = this.view;
    const tag = view.getUint8(this.pos++);
    switch (tag) {
      case T_NULL: return null;
      case T_FALSE: return false;
      case T_TRUE: return true;
      case T_U8: return view.getUint8(this.pos++);
      case T_I32: { const v = view.getInt32(this.pos, true); this.pos += 4; return v; }
      case T_F64: { const v = view.getFloat64(this.pos, true); this.pos += 8; return v; }
      case T_STR: { const id = view.getUint32(this.pos, true); this.pos += 4; return this.string(id); }
      case T_ARR: {
        const n = view.getUint32(this.pos, true); this.pos += 4;
        const out = new Array<unknown>(n);
        for (let i = 0; i < n; i++) out[i] = this.value();
        return out;
      }
      case T_OBJ: {
        const keys = this.shape(view.getUint32(this.pos, true)); this.pos += 4;
        const out: Record<string, unknown> = {};
        for (const key of keys) out[key] = this.value();
        return out;
      }
      case T_NODE: {
        const id = view.getUint32(this.pos, true); this.pos += 4;
        const held = this.weakNodes;
        const live = held ? held.get(id)?.deref() : undefined;
        if (live !== undefined || (!held && this.decoded[id])) {
          // The first meeting is followed by the member's body: stepped over when it was decoded before.
          if (this.pos === this.nodeAt[id]) this.skip();
          return held ? live : this.nodes[id];
        }
        const back = this.pos;
        this.pos = this.nodeAt[id]!;
        const node = this.value();
        if (!held) { this.nodes[id] = node; this.decoded[id] = 1; }
        else if (typeof node === 'object' && node !== null) { held.set(id, new WeakRef(node)); this.collected!.register(node, id); }
        if (back !== this.nodeAt[id]) this.pos = back;
        return node;
      }
      default: throw new Error(`[buildings] a record table holds an unknown tag ${tag}`);
    }
  }

  /** The value at `pos` passed over without making it. */
  private skip(): void {
    const view = this.view;
    const tag = view.getUint8(this.pos++);
    switch (tag) {
      case T_NULL: case T_FALSE: case T_TRUE: return;
      case T_U8: this.pos += 1; return;
      case T_I32: case T_STR: this.pos += 4; return;
      // A shared member met here first has its body behind its mark: passed over with it.
      case T_NODE: { const id = view.getUint32(this.pos, true); this.pos += 4; if (this.pos === this.nodeAt[id]) this.skip(); return; }
      case T_F64: this.pos += 8; return;
      case T_ARR: { const n = view.getUint32(this.pos, true); this.pos += 4; for (let i = 0; i < n; i++) this.skip(); return; }
      case T_OBJ: { const keys = this.shape(view.getUint32(this.pos, true)); this.pos += 4; for (let i = 0; i < keys.length; i++) this.skip(); return; }
      default: throw new Error(`[buildings] a record table holds an unknown tag ${tag}`);
    }
  }
}

/** Where a building's record is read from: a table and its row (posted to a worker as the table's buffer and the row). */
export interface RecordRef {
  readonly buffer: ArrayBufferLike;
  readonly row: number;
}

/** Each record's place in a table: its tile's (`tableRecords`) or its own, written once when first asked (a record is replaced, never edited). */
const refs = new WeakMap<object, RecordRef>();

/** A row's record read on the page, knowing its row: a job is handed the row, never the record (`refOf`). */
export function readRow(reader: TableReader, row: number): Building {
  const b = reader.record(row);
  refs.set(b, { buffer: reader.table.buffer, row });
  return b;
}

/** DO NOT read a whole city's table this way on the page (`world/buildings/tableRows.ts` reads a row when asked): every record decoded and kept is ~8 KB of heap a building. A tile's buildings read from its table, each knowing its row. */
export function tableRecords(buffer: ArrayBufferLike): Building[] {
  const table = new RecordTable(buffer);
  const reader = table.reader();
  const out: Building[] = [];
  for (let row = 0; row < table.rows; row++) out.push(readRow(reader, row));
  return out;
}

/** Where a worker reads a record: its tile's row, or a table of its own (an edited or new building, or one opened by the cut). */
export function refOf(b: Building, kept = true): RecordRef {
  let ref = refs.get(b);
  if (!ref) {
    ref = { buffer: encodeRecords([b]).buffer, row: 0 };
    if (kept) refs.set(b, ref);
  }
  return ref;
}

/** Records read from their refs, one reader a table for the batch (a job's): the shared members of a tile decoded once. */
export function readRecords(refs: readonly RecordRef[]): Building[] {
  return [...eachRecord(refs)];
}

/** Records read from their refs one at a time, as `readRecords` reads them: DO NOT hold them all where each is used once - what is worked out of a record lives as long as it does (`identityMemo`, the WeakMaps of `geometry.ts`), and a plate's mass job held its four tiles' buildings with all their layouts (~110 MB a dense tile) in a worker sharing the page's heap cage (`jobs/jobPool.ts`, 2026-10-17). */
export function* eachRecord(refs: readonly RecordRef[]): Generator<Building, void, void> {
  const readers = new Map<ArrayBufferLike, TableReader>();
  for (const ref of refs) {
    let reader = readers.get(ref.buffer);
    if (!reader) readers.set(ref.buffer, reader = new RecordTable(ref.buffer).reader());
    yield reader.record(ref.row);
  }
}
