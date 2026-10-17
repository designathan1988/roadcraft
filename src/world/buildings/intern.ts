/** THE BUILDINGS' RECORDS SHARE WHAT THEY HAVE ALIKE (hash-consing): one storey, facade or material object for every building */

/** A record's member made of plain data (numbers, strings, booleans, null, arrays and objects of those). */
type Plain = Record<string, unknown> | unknown[];

/** Each canonical object's number: what a parent's key is made of (its children are canonical, so equal means the same object). */
const ids = new WeakMap<object, number>();
let nextId = 1;
/** The canonical objects by their shallow key's hash; held weakly, a shape no building uses any more goes. */
const table = new Map<number, WeakRef<Plain>[]>();

/** DO NOT leave a collected object's entry in its bucket until the same hash is asked again (most never are): the table would keep a bucket for every shape ever made. Let go when the object is collected (MDN "FinalizationRegistry"). */
export function forgetCollected(entry: { readonly h: number; readonly ref: WeakRef<Plain> }): void {
  const bucket = table.get(entry.h);
  if (!bucket) return;
  const at = bucket.indexOf(entry.ref);
  if (at >= 0) bucket.splice(at, 1);
  if (bucket.length === 0) table.delete(entry.h);
}
const collected = typeof FinalizationRegistry === 'undefined' ? null : new FinalizationRegistry(forgetCollected);

/** How many hashes the table holds a bucket for (`forgetCollected`). */
export const internBuckets = (): number => table.size;

/** Inside the hash: 32-bit FNV-1a over the key's pieces. */
function mix(h: number, n: number): number {
  return Math.imul(h ^ n, 16777619) >>> 0;
}

function hashString(h: number, s: string): number {
  for (let i = 0; i < s.length; i++) h = mix(h, s.charCodeAt(i));
  return mix(h, 0x1f);
}

/** A number's bits, to hash it without making its text (DO NOT `String(v)`: a string for every number of every building loaded). */
const BITS = new Float64Array(1);
const WORDS = new Uint32Array(BITS.buffer);

function hashValue(h: number, v: unknown): number {
  if (v === null) return mix(h, 1);
  switch (typeof v) {
    case 'number': BITS[0] = v; return mix(mix(mix(h, 2), WORDS[0]!), WORDS[1]!);
    case 'string': return hashString(mix(h, 3), v);
    case 'boolean': return mix(h, v ? 4 : 5);
    case 'object': return mix(mix(h, 6), ids.get(v as object) ?? 0);
    default: return mix(h, 7);
  }
}

/** Whether two nodes with canonical children are the same: their primitives equal, their children the same objects. */
function sameShallow(a: Plain, b: Plain): boolean {
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    if (a.length !== bb.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== bb[i]) return false;
    return true;
  }
  const ka = Object.keys(a), bo = b as Record<string, unknown>;
  if (ka.length !== Object.keys(bo).length) return false;
  for (const k of ka) if (!(k in bo) || a[k] !== bo[k]) return false;
  return true;
}

/** The canonical object equal to `value` (its children made canonical first): the one already shared, or `value` itself. */
export function intern<T>(value: T): T {
  if (typeof value !== 'object' || value === null || ids.has(value)) return value;
  const node = value as unknown as Plain;
  let h = Array.isArray(node) ? 0x811c9dc5 : 0x01000193;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const item = node[i];
      if (typeof item === 'object' && item !== null) node[i] = intern(item);
      h = hashValue(h, node[i]);
    }
  } else {
    for (const key of Object.keys(node)) {
      const item = node[key];
      if (typeof item === 'object' && item !== null) node[key] = intern(item);
      h = hashValue(hashString(h, key), node[key]);
    }
  }
  let bucket = table.get(h);
  if (bucket) {
    for (let i = bucket.length - 1; i >= 0; i--) {
      const known = bucket[i]!.deref();
      if (!known) { bucket.splice(i, 1); continue; }
      if (sameShallow(known, node)) return known as unknown as T;
    }
  } else table.set(h, bucket = []);
  const ref = new WeakRef(node);
  bucket.push(ref);
  collected?.register(node, { h, ref });
  ids.set(node, nextId++);
  // DO NOT write a shared object in place: every building sharing it would change (records are replaced, never edited).
  Object.freeze(node);
  return value;
}

/** A record's object members made canonical, in place (the record itself stays its own: its id, place and wear). */
export function internMembers(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (typeof value === 'object' && value !== null) record[key] = intern(value);
  }
}
