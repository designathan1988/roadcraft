/**
 * A pure function of an object that is never changed in place - a stored
 * building record, a road's ribbon, a junction as solved, a version of the
 * transit data - worked out once per object and kept exactly as long as the
 * object is (a `WeakMap`): no ceiling, nothing to forget, nothing stale, since
 * a changed thing is a new object with no answer yet.
 *
 * The one form a module-level memo takes. It is not state of the game (that
 * belongs to its controllers, CLAUDE.md): it is the object's own derived
 * value, kept beside it. DO NOT key one by anything changed in place (the
 * document, the network, a Map): it would answer for what the object was. A
 * cursor of a process over such a thing (what was read last) belongs to the
 * process's owner, not here.
 */
export function identityMemo<K extends object, V>(compute: (key: K) => V): (key: K) => V {
  const known = new WeakMap<K, V>();
  return (key) => {
    if (known.has(key)) return known.get(key)!;
    const value = compute(key);
    known.set(key, value);
    return value;
  };
}

/**
 * Numbers never handed out twice in this page: a stamp that must not match
 * any other's (`world/cells.ts` cell versions), as an allocator hands out ids.
 */
export function uniqueCounter(): () => number {
  let last = 0;
  return () => ++last;
}
