/** The page cross-origin isolated (MDN, crossOriginIsolated): what SharedArrayBuffer needs, for the simulation's worker; the one set sent by the Vite server (`vite.config.ts`) and by the desktop's `app://` (`main.cjs`). */
module.exports = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' };
