/** WHICH RENDERER DRAWS THE GAME (`MIGRACAO-WEBGPU.md`): WebGL, as always, unless `?gpu=webgpu` asks for the WebGPU renderer (the desktop's
 *  own setting adds it to the page's address, `desktop/main.cjs`). WebGPU is asked for only where the browser has it: elsewhere WebGL. */
export type GpuBackend = 'webgl' | 'webgpu';

export function chosenBackend(search: string = typeof location === 'undefined' ? '' : location.search,
  hasWebGpu: boolean = typeof navigator !== 'undefined' && 'gpu' in navigator): GpuBackend {
  return new URLSearchParams(search).get('gpu') === 'webgpu' && hasWebGpu ? 'webgpu' : 'webgl';
}
