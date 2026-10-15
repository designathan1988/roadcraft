/** Whether two plain values (numbers, strings, booleans, null, arrays, objects) are the same; a key holding `undefined` is no key. */
export function samePlain(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) return false;
  if (arrayA) {
    const x = a as unknown[], y = b as unknown[];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!samePlain(x[i], y[i])) return false;
    return true;
  }
  const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
  let count = 0;
  for (const k in x) {
    if (x[k] === undefined) continue;
    count++;
    if (!samePlain(x[k], y[k])) return false;
  }
  for (const k in y) if (y[k] !== undefined) count--;
  return count === 0;
}
