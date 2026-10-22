/** DO NOT key one by anything changed in place (the document, the network, a Map): it would answer for what the object was. */
export function identityMemo<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const known = new WeakMap<K, V>();
  return (key) => {
    if (known.has(key)) return known.get(key)!;
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
