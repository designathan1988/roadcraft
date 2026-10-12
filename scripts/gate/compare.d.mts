// Types of the gate's arithmetic (`compare.mjs`) for the specs that test it.
export declare const ALPHA: number;
export declare const ALPHA_SUSPECT: number;
export declare const LARGE_DELTA: number;
export declare const FAMILY_ALPHA: number;
export declare const PRIMARY: readonly RegExp[];
export declare function mannWhitney(a: readonly number[], b: readonly number[]): { p: number; delta: number };
export interface SummaryRow {
  key: string;
  a: number;
  b: number;
  p: number;
  delta: number;
  judged: boolean;
  primary: boolean;
  verdict: '' | 'PIOR' | 'suspeito' | 'melhor' | 'igual' | 'acima' | 'abaixo';
}
export declare function summarize(runsA: readonly object[], runsB: readonly object[]): SummaryRow[];
