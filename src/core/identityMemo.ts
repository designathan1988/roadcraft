/** DO NOT key one by anything changed in place (the document, the network, a Map): it would answer for what the object was. */
export function identityMemo<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const known = new WeakMap<K, V>();
  return (key) => {
    // One lookup for a value kept (the common answer); `has` only for a value that is undefined.
    const kept = known.get(key);
    if (kept !== undefined || known.has(key)) return kept as V;
    const value = compute(key);
    known.set(key, value);
    return value;
  };
}

/** Numbers never handed out twice in this page: a stamp that must not match any other's */
export function uniqueCounter(): () => number {
  let last = 0;
  return () => ++last;
}
