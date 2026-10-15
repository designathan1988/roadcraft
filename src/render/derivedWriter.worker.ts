import { keepDerivedMany } from './derivedCache';

/**
 * Keeps values for a later session off the page (`derivedCache.ts`): the page hands their buffers
 * over (MDN, "Transferable objects") and the store's copy is made here. DO NOT write them from the
 * page: `put` copies each value by the structured clone on the thread that calls it, and a city's
 * road tiles were copied there tile by tile while its roads were built.
 */
self.onmessage = (event: MessageEvent<{ readonly prefix: string; readonly entries: readonly [string, unknown][] }>) => {
  void keepDerivedMany(event.data.prefix, new Map(event.data.entries));
};
