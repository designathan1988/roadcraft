/**
 * The sea's surface, world units: what lies under it is the sea (the ocean is
 * drawn there). Its own module so the relief (`relief.ts`) and the ice on it
 * (`ice.ts`) both read it without importing each other.
 */
export const SEA_LEVEL = 0;
