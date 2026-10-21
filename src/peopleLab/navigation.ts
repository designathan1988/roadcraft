import { MOUSE, Raycaster, Vector2, Vector3, type Camera, type Object3D } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/** VIEWPORT NAVIGATION as character tools do it (CLO 3D and Marvelous: right orbits, middle pans, wheel zooms; Maya: Alt with any button; Blender: F frames, numbers for views).
 *  The left button is kept for the tools on the model; on empty background it orbits. */

export interface NavigationHooks {
  /** What the left button may act on: when the pointer is over one, the left button belongs to the tool. */
  readonly targets: () => readonly Object3D[];
  /** Frames the person (F). */
  readonly frame: () => void;
}

export function setupNavigation(controls: OrbitControls, camera: Camera, dom: HTMLElement, hooks: NavigationHooks): void {
  controls.enableDamping = true;
  controls.dampingFactor = 0.18;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  controls.rotateSpeed = 0.8;
  controls.zoomSpeed = 1.1;
  const standard = { LEFT: null, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.ROTATE } as const;
  controls.mouseButtons = { ...standard };
  const raycaster = new Raycaster();
  const ndc = new Vector2();
  const overModel = (e: PointerEvent): boolean => {
    const r = dom.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(hooks.targets().filter((o) => o.visible), true).length > 0;
  };
  // Decided before OrbitControls reads the press (capture phase): which button does what for this drag.
  dom.addEventListener('pointerdown', (e) => {
    if (e.altKey) controls.mouseButtons = { LEFT: MOUSE.ROTATE, MIDDLE: MOUSE.PAN, RIGHT: MOUSE.DOLLY };
    else if (e.shiftKey && e.button === 2) controls.mouseButtons = { ...standard, RIGHT: MOUSE.PAN };
    else controls.mouseButtons = { ...standard, LEFT: e.button === 0 && !overModel(e) ? MOUSE.ROTATE : null };
  }, { capture: true });
  dom.addEventListener('contextmenu', (e) => e.preventDefault());
  // Double-click on the model: orbit about that point from now on.
  dom.addEventListener('dblclick', (e) => {
    const r = dom.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(hooks.targets().filter((o) => o.visible), true)[0];
    if (!hit) return;
    const shift = hit.point.clone().sub(controls.target);
    controls.target.add(shift);
    camera.position.add(shift);
  });
  window.addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
    const d = camera.position.distanceTo(controls.target);
    const view = (dir: Vector3): void => { camera.position.copy(controls.target).addScaledVector(dir, d); };
    if (e.key === 'f' || e.key === 'F') hooks.frame();
    else if (e.key === '1') view(new Vector3(0, 0, 1));
    else if (e.key === '3') view(new Vector3(1, 0, 0));
    else if (e.key === '7') view(new Vector3(0, 1, 0.0001).normalize());
    else if (e.key === '9') view(new Vector3(0, 0, -1));
  });
}
