/** TYPED ARRAYS PACKED IN ONE BUFFER: a few numbers and named typed arrays after a small JSON head, each array 8-byte aligned, read back as views on the one buffer (no copy, transferable whole, MDN "Transferable objects") */

/** The typed arrays a pack holds, by their tag in the head. */
const KINDS = {
  f64: Float64Array, f32: Float32Array, u32: Uint32Array, i32: Int32Array, u16: Uint16Array, i16: Int16Array, u8: Uint8Array, i8: Int8Array,
} as const;
type Kind = keyof typeof KINDS;

/** Any typed array a pack can hold. */
type PackableArray = Float64Array | Float32Array | Uint32Array | Int32Array | Uint16Array | Int16Array | Uint8Array | Int8Array;

/** What a pack holds: its numbers and its arrays by name (the arrays views on the pack's buffer). */
interface ArrayPack {
  readonly numbers: Readonly<Record<string, number>>;
  readonly arrays: Readonly<Record<string, PackableArray>>;
}

/** The head: the numbers, and each array's name, kind, element offset past the head (in bytes) and length. */
interface PackHead {
  readonly n: Record<string, number>;
  readonly a: [string, Kind, number, number][];
}

const align8 = (n: number): number => Math.ceil(n / 8) * 8;

function kindOf(array: PackableArray): Kind {
  for (const kind of Object.keys(KINDS) as Kind[]) if (array instanceof KINDS[kind]) return kind;
  throw new Error('a pack holds typed arrays only');
}

/** The numbers and arrays laid in one buffer: a u32 head length, the head's JSON, then each array at an offset of 8. */
export function packArrays(numbers: Readonly<Record<string, number>>, arrays: Readonly<Record<string, PackableArray>>): Uint8Array<ArrayBuffer> {
  const head: PackHead = { n: { ...numbers }, a: [] };
  let at = 0;
  for (const [name, array] of Object.entries(arrays)) {
    head.a.push([name, kindOf(array), at, array.length]);
    at = align8(at + array.byteLength);
  }
  const text = new TextEncoder().encode(JSON.stringify(head));
  const start = align8(4 + text.byteLength);
  const out = new Uint8Array(start + at);
  new DataView(out.buffer).setUint32(0, text.byteLength, true);
  out.set(text, 4);
  for (const [name, , offset] of head.a) {
    const array = arrays[name]!;
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), start + offset);
  }
  return out;
}

/** A pack read back: its arrays views on `buffer` (the buffer's own, from its start). */
export function unpackArrays(buffer: ArrayBuffer): ArrayPack {
  const length = new DataView(buffer).getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as PackHead;
  const start = align8(4 + length);
  const arrays: Record<string, PackableArray> = {};
  for (const [name, kind, offset, count] of head.a) {
    if (!(kind in KINDS)) throw new Error(`a pack's array ${name} is of an unknown kind ${String(kind)}`);
    const make = KINDS[kind] as unknown as new (buffer: ArrayBuffer, byteOffset: number, length: number) => PackableArray;
    arrays[name] = new make(buffer, start + offset, count);
  }
  return { numbers: head.n, arrays };
}

/** One array of a pack, of the kind its reader expects (a pack of another layout throws, never read as garbage). */
export function packedArray<T extends PackableArray>(pack: ArrayPack, name: string, kind: new (length: number) => T): T {
  const array = pack.arrays[name];
  if (!(array instanceof kind)) throw new Error(`a pack has no array ${name} of the kind asked`);
  return array;
}

/** One number of a pack. */
export function packedNumber(pack: ArrayPack, name: string): number {
  const value = pack.numbers[name];
  if (typeof value !== 'number') throw new Error(`a pack has no number ${name}`);
  return value;
}
