/** Global declarations: a file with no import or export, so these are global. */

/** A folder of `public/models`: its files' URLs by their path inside it (`model-urls-plugin.ts`). */
declare module 'virtual:model-urls/*' {
  const urls: Readonly<Record<string, string>>;
  export default urls;
}
