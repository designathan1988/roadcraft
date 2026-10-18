/** `Math.min` AND `Math.max` OF TWO NUMBERS, BIT FOR BIT, AS COMPARISONS */
// In a dense cell job the optimising compiler left `Math.min`/`Math.max` as calls to the built-in in the instance boxes' loops,
// each result a heap number (`cellArrays.ts` `boxOfInstances`): comparisons it keeps unboxed, with the built-in's NaN and -0.

/** `Math.min(a, b)` to the bit: NaN if either is, -0 under 0. */
export const least = (a: number, b: number): number => (a !== a || b !== b ? NaN : b < a || (b === 0 && a === 0 && 1 / b < 0) ? b : a);

/** `Math.max(a, b)` to the bit: NaN if either is, 0 over -0. */
export const most = (a: number, b: number): number => (a !== a || b !== b ? NaN : b > a || (b === 0 && a === 0 && 1 / b > 0) ? b : a);
