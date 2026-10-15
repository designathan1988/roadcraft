import { keepDerivedMany } from './derivedCache';

/** DO NOT write them from the page */
self.onmessage = (event: MessageEvent<{ readonly prefix: string; readonly entries: readonly [string, unknown][] }>) => {
  void keepDerivedMany(event.data.prefix, new Map(event.data.entries));
};
