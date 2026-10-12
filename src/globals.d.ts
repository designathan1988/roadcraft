/**
 * Compile-time keys, replaced by literals in the build (`vite.config.ts`
 * `define`) and in the test runner (`vitest.config.ts`). A file with no
 * import or export, so these are global.
 */

/** The planet (`vite --mode planet`): six flat maps on a cube, drawn as a sphere. Off: the flat game, none of it bundled. */
declare const __PLANET__: boolean;

/** Metres in one world unit (`core/units.ts` `METERS_PER_UNIT`); set by the build. */
declare const __METERS_PER_UNIT__: number;

/** A folder of `public/models`: its files' URLs by their path inside it (`model-urls-plugin.ts`). */
declare module 'virtual:model-urls/*' {
  const urls: Readonly<Record<string, string>>;
  export default urls;
}
