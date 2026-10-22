import type { Camera, Material, Object3D, Scene, WebGLRenderer } from 'three';

/**
 * PROGRAMS BUILT OFF THE DRAW WITHOUT THE PAGE WAITING FOR THE GPU PROCESS: three's `compileAsync` asks each program's
 * COMPLETION_STATUS_KHR every 10 ms, and every such query is a round trip that waits for all the commands queued before it (MDN, WebGL
 * best practices: program queries flush and round-trip; Khronos public_webgl 2019-05, crbug.com/881152). Behind the opening's uploads and
 * links one query held the page 1.8-2.6 s (`npm run diagnose`, 2026-10-22: 2.2-3.0 s of the city's creation frozen in three.module.js isReady).
 * Here each poll first waits on a fence (`fenceSync` + `getSyncParameter`, which reads the fence's last known state and never waits:
 * WebGL 2.0 sync objects only change between tasks), so the status is asked only once the GPU process has worked through what came before.
 */
export function fenceCompilePolls(renderer: WebGLRenderer): void {
  const gl = renderer.getContext();
  // Without the parallel compile three settles the programs at once (no polls), and WebGL 1 has no fences.
  if (!(gl instanceof WebGL2RenderingContext) || !renderer.extensions.has('KHR_parallel_shader_compile')) return;
  const properties = renderer.properties;
  renderer.compileAsync = (scene: Object3D, camera: Camera, targetScene: Scene | null = null): Promise<Object3D> => {
    const waiting: Set<Material> = renderer.compile(scene, camera, targetScene);
    return new Promise((resolve) => {
      let fence: WebGLSync | null = null;
      const fenced = (): void => {
        fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        // Sent now: a fence still in the page's buffer would never signal.
        gl.flush();
      };
      const check = (): void => {
        if (fence) {
          if (gl.getSyncParameter(fence, gl.SYNC_STATUS) !== gl.SIGNALED) {
            setTimeout(check, 10);
            return;
          }
          gl.deleteSync(fence);
          fence = null;
        }
        for (const material of waiting) {
          const program = (properties.get(material) as { currentProgram?: { isReady(): boolean } }).currentProgram;
          // Ready, or let go meanwhile: nothing to wait for (three's own rule).
          if (program === undefined || program.isReady()) waiting.delete(material);
        }
        if (waiting.size === 0) {
          resolve(scene);
          return;
        }
        fenced();
        setTimeout(check, 10);
      };
      fenced();
      setTimeout(check, 10);
    });
  };
}
