import { Color } from 'three';

/** THE COLOUR OF A LIT ROOM, by the room: one lamp colour for every window of the town read as a sheet of amber at night */
const KELVIN_SRGB: Readonly<Record<number, readonly [number, number, number]>> = {
  2700: [255, 169, 87],
  3000: [255, 180, 107],
  3500: [255, 196, 137],
  4000: [255, 209, 163],
  5000: [255, 228, 206],
  6500: [255, 249, 253],
  9000: [210, 223, 255],
};

/** A black body's colour at `kelvin`, linear, of luminance 1, as GLSL. */
function lampVec(kelvin: number): string {
  const [r, g, b] = KELVIN_SRGB[kelvin]!;
  const c = new Color().setRGB(r / 255, g / 255, b / 255, 'srgb');
  const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return `vec3(${(c.r / lum).toFixed(4)}, ${(c.g / lum).toFixed(4)}, ${(c.b / lum).toFixed(4)})`;
}

/** The share of homes' lit rooms by lamp: warm 2700 K, 3000 K, the kitchen's 3500 K, cool white. */
const HOME_MIX = [[2700, 0.36], [3000, 0.24], [3500, 0.1], [6500, 0.3]] as const;
/** Offices and shops: neutral 4000 K, daylight 5000 K, a warmer 3500 K in some. */
const OFFICE_MIX = [[4000, 0.5], [5000, 0.35], [3500, 0.15]] as const;

function mixGlsl(mix: readonly (readonly [number, number])[]): string {
  let at = 0;
  const lines = mix.slice(0, -1).map(([k, share]) => `  if (lot < ${(at += share).toFixed(3)}) return ${lampVec(k)};`);
  return `${lines.join('\n')}\n  return ${lampVec(mix[mix.length - 1]![0])};`;
}

/** A mix's mean lamp, as GLSL: what its rooms' lamps average to where many windows fall in a pixel. */
function meanGlsl(mix: readonly (readonly [number, number])[]): string {
  let mr = 0, mg = 0, mb = 0;
  for (const [k, share] of mix) {
    const [r, g, b] = KELVIN_SRGB[k]!;
    const c = new Color().setRGB(r / 255, g / 255, b / 255, 'srgb');
    const lum = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    mr += (share * c.r) / lum; mg += (share * c.g) / lum; mb += (share * c.b) / lum;
  }
  return `vec3(${mr.toFixed(4)}, ${mg.toFixed(4)}, ${mb.toFixed(4)})`;
}

/** GLSL: `roomLamp(lot, office)`, a lit room's lamp colour from its lot (0..1) and whether it is an office or a shop; `roomLampMean(office)`, the mix's mean, worked out here once */
export const ROOM_LAMP_GLSL = `
vec3 roomLampHome(float lot) {
${mixGlsl(HOME_MIX)}
}
vec3 roomLampOffice(float lot) {
${mixGlsl(OFFICE_MIX)}
}
vec3 roomLamp(float lot, float office) { return office > 0.5 ? roomLampOffice(lot) : roomLampHome(lot); }
vec3 roomLampMean(float office) { return office > 0.5 ? ${meanGlsl(OFFICE_MIX)} : ${meanGlsl(HOME_MIX)}; }
vec3 tvLight(float clock, float lot) {
  float cut = fract(sin(floor(clock * 0.6 + lot * 37.0) * 91.345 + lot * 13.1) * 43758.5453);
  float shimmer = 0.92 + 0.08 * sin(clock * 11.0 + lot * 40.0);
  return ${lampVec(9000)} * (0.45 + 0.45 * cut) * shimmer;
}`;

/** The share of a home's lit rooms that are lit by a television alone. */
export const TV_SHARE = 0.12;
