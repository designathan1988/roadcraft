/** The graphics tier a machine starts on, by the GPU's name as the driver gives it (`WEBGL_debug_renderer_info`). */
export type GpuTier = 'low' | 'medium' | 'high' | 'ultra';

/** First match wins: software, phones and integrated chips before the discrete families; unknown is medium. */
const RULES: readonly (readonly [RegExp, GpuTier | ((m: RegExpMatchArray) => GpuTier)])[] = [
  [/swiftshader|llvmpipe|softpipe|basic render|software/i, 'low'],
  [/mali|adreno|powervr|apple a\d+/i, 'low'],
  // NVIDIA: RTX x050 and the 20 series high, the rest of the RTX ultra; GTX 16 and 1070/1080 high; MX and older medium or low.
  [/rtx\s*a?(\d{2})(\d{2})/i, (m) => (m[2] === '50' || m[1] === '20' ? 'high' : 'ultra')],
  [/\bmx\s*\d{3}/i, 'low'],
  [/gtx\s*(16\d0|10[78]0|titan)/i, 'high'],
  [/gtx|quadro|geforce|nvidia/i, 'medium'],
  // AMD: RX 6000-7000 from x700 up and RX 9070 ultra, below high; RX 5700 high; Polaris, Vega, the APUs and the Steam Deck medium.
  [/rx\s*([6-9])(\d)(\d)0/i, (m) => (Number(m[1] === '9' ? m[3] : m[2]) >= 7 ? 'ultra' : 'high')],
  [/rx\s*57\d0/i, 'high'],
  [/radeon|amd|ati\b/i, 'medium'],
  // Intel: Arc high, Iris Xe medium, UHD and HD low.
  [/intel.*\barc\b|\barc\s*a\d{3}/i, 'high'],
  [/iris/i, 'medium'],
  [/intel/i, 'low'],
  // Apple silicon: Max and Ultra ultra, the rest high.
  [/apple m\d+\s*(max|ultra)/i, 'ultra'],
  [/apple m\d+/i, 'high'],
];

export function tierForGpu(label: string): GpuTier {
  for (const [pattern, tier] of RULES) {
    const match = label.match(pattern);
    if (match) return typeof tier === 'function' ? tier(match) : tier;
  }
  return 'medium';
}
