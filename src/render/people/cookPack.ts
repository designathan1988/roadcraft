/**
 * A cooked record on disk: a JSON header of its fields, then each typed
 * array's bytes, 8-byte aligned. Numbers, strings, booleans and plain number
 * lists go in the header; typed arrays after it, read back as views of the one
 * buffer (no copy).
 */

type Typed = Float32Array | Float64Array | Int32Array | Uint32Array | Int16Array | Uint16Array | Uint8Array;
export type PackValue = Typed | number | string | boolean | readonly number[] | null;
export type PackRecord = Readonly<Record<string, PackValue>>;

const KINDS = { Float32Array, Float64Array, Int32Array, Uint32Array, Int16Array, Uint16Array, Uint8Array } as const;
type KindName = keyof typeof KINDS;

const kindOf = (value: Typed): KindName => {
  for (const [name, kind] of Object.entries(KINDS)) if (value instanceof kind) return name as KindName;
  throw new Error('cookPack: an unknown typed array');
};

export function packRecord(record: PackRecord): ArrayBuffer {
  const header: Record<string, unknown> = {};
  const arrays: { name: string; bytes: Uint8Array; kind: KindName; length: number }[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (ArrayBuffer.isView(value)) {
      const typed = value as Typed;
      arrays.push({ name, bytes: new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength), kind: kindOf(typed), length: typed.length });
    } else header[name] = value;
  }
  let at = 0;
  const layout: { name: string; kind: KindName; offset: number; length: number }[] = [];
  for (const a of arrays) {
    layout.push({ name: a.name, kind: a.kind, offset: at, length: a.length });
    at += Math.ceil(a.bytes.byteLength / 8) * 8;
  }
  const text = new TextEncoder().encode(JSON.stringify({ header, layout }));
  const start = Math.ceil((8 + text.byteLength) / 8) * 8;
  const out = new Uint8Array(start + at);
  new DataView(out.buffer).setUint32(0, text.byteLength, true);
  out.set(text, 8);
  arrays.forEach((a, i) => out.set(a.bytes, start + layout[i]!.offset));
  return out.buffer;
}

export function unpackRecord(buffer: ArrayBuffer): Record<string, PackValue> {
  const length = new DataView(buffer).getUint32(0, true);
  const { header, layout } = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length))) as {
    header: Record<string, PackValue>; layout: { name: string; kind: KindName; offset: number; length: number }[];
  };
  const start = Math.ceil((8 + length) / 8) * 8;
  const out: Record<string, PackValue> = { ...header };
  for (const { name, kind, offset, length: n } of layout) out[name] = new KINDS[kind](buffer, start + offset, n);
  return out;
}
