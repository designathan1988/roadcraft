import { Box3, DoubleSide, Group, type Material, type Mesh, MeshBasicMaterial, type Object3D, OrthographicCamera, Scene, ShaderMaterial, Vector3, WebGLRenderTarget, WebGLRenderer } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { UNITS_PER_METER } from '@world/units';
import type { Point3, ReferenceSampler, Triangle } from '@world/buildings/reference';

/**
 * A reference model in the Builder: a real building's 3D model (glTF/GLB),
 * shown translucent where a building stands, to build it over - the way an
 * architect traces a survey. It is a drawing aid only: never saved with the
 * city, never part of a building, and it casts no shadow.
 *
 * Placed on the selected building: its plan centred on the building's plan,
 * its foot on the building's floor, turned with the building, in metres (glTF
 * is Y-up in metres). The player turns it in quarter turns, mirrors it front
 * to back, fades it, hides it or removes it.
 */
export interface ReferenceTarget {
  /** Centre of the building's plan, world units. */
  readonly x: number;
  readonly y: number;
  /** Height of its floor, world units. */
  readonly floor: number;
  /** The building's rotation, radians. */
  readonly rotation: number;
}

export interface ReferenceInfo {
  readonly name: string;
  /** Size in metres: across, deep, tall. */
  readonly size: readonly [number, number, number];
}

export interface ReferenceModel {
  load(file: File): Promise<ReferenceInfo>;
  placeOn(target: ReferenceTarget): void;
  turn(): void;
  flip(): void;
  fade(step: number): void;
  toggle(): void;
  remove(): void;
  /**
   * The model as a surveyor reads it, in the frame of where it stands (the
   * building it is placed on, or the origin): its triangles and a sampler of
   * its own colours, in metres - x across, y away from the front, z up.
   */
  capture(): ReferenceCapture | null;
  /** Where it stands: the building it was placed on, or the map's origin. */
  readonly frame: ReferenceTarget;
  readonly loaded: boolean;
  readonly info: ReferenceInfo | null;
  readonly opacity: number;
}

export interface ReferenceCapture {
  readonly triangles: Triangle[];
  readonly sample: ReferenceSampler;
}

/** Pixels per metre of the pictures a capture reads its colours from. */
const CAPTURE_DENSITY = 8;
const CAPTURE_MAX = 2048;

/** Depth as two 8-bit channels (an orthographic camera's depth is linear). */
const DEPTH_MATERIAL = new ShaderMaterial({
  side: DoubleSide,
  vertexShader: 'void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'void main() { float d = gl_FragCoord.z * 255.0; gl_FragColor = vec4(floor(d) / 255.0, fract(d), 0.0, 1.0); }',
});

const toSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

/** Reads the triangles and the colours of a model (a copy of it in metres, three's axes). */
function captureModel(model: Object3D): ReferenceCapture {
  model.updateMatrixWorld(true);
  const triangles: Triangle[] = [];
  const v = new Vector3();
  const plan = (p: Vector3): Point3 => [p.x, -p.z, p.y];
  const box = new Box3();
  model.traverse((o) => {
    const mesh = o as Mesh;
    if (!mesh.isMesh) return;
    const pos = mesh.geometry.getAttribute('position');
    if (!pos) return;
    const index = mesh.geometry.getIndex();
    const count = index ? index.count : pos.count;
    const at = (k: number): Point3 => plan(v.fromBufferAttribute(pos, index ? index.getX(k) : k).applyMatrix4(mesh.matrixWorld));
    for (let k = 0; k + 2 < count; k += 3) triangles.push([at(k), at(k + 1), at(k + 2)]);
    box.expandByObject(mesh);
    // Unlit, opaque, both faces: the colours of its own textures.
    const flat = [mesh.material].flat().map((m) => {
      const source = m as MeshBasicMaterial;
      return new MeshBasicMaterial({ map: source.map ?? null, color: source.map ? 0xffffff : (source.color ?? 0xffffff), side: DoubleSide });
    });
    mesh.material = flat.length === 1 ? flat[0]! : flat;
  });

  const scene = new Scene();
  scene.add(model);
  const size = box.getSize(new Vector3()), centre = box.getCenter(new Vector3());
  const renderer = new WebGLRenderer({ antialias: false });
  // Outward directions in three's axes: front (plan -y = three +z), right, back, left, and from above.
  const dirs: [number, number, number][] = [[0, 0, 1], [1, 0, 0], [0, 0, -1], [-1, 0, 0], [0, 1, 0]];
  interface View { cam: OrthographicCamera; W: number; H: number; rgb: Uint8Array; depth: Uint8Array; dir: [number, number, number]; far: number }
  const views: View[] = dirs.map((dir) => {
    const top = dir[1] === 1;
    const across = top ? size.x : dir[0] !== 0 ? size.z : size.x;
    const tall = top ? size.z : size.y;
    const px = Math.min(CAPTURE_DENSITY, CAPTURE_MAX / Math.max(across, tall, 1));
    const W = Math.max(8, Math.ceil(across * px)), H = Math.max(8, Math.ceil(tall * px));
    const reach = size.length() + 10;
    const cam = new OrthographicCamera(-across / 2, across / 2, tall / 2, -tall / 2, 1, reach * 2);
    cam.position.set(centre.x + dir[0] * reach, centre.y + dir[1] * reach, centre.z + dir[2] * reach);
    if (top) cam.up.set(0, 0, -1);
    cam.lookAt(centre);
    cam.updateMatrixWorld(true);
    const target = new WebGLRenderTarget(W, H);
    renderer.setRenderTarget(target);
    renderer.setClearColor(0x000000, 0);
    scene.overrideMaterial = null;
    renderer.render(scene, cam);
    const rgb = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(target, 0, 0, W, H, rgb);
    scene.overrideMaterial = DEPTH_MATERIAL;
    renderer.render(scene, cam);
    const depth = new Uint8Array(W * H * 4);
    renderer.readRenderTargetPixels(target, 0, 0, W, H, depth);
    target.dispose();
    return { cam, W, H, rgb, depth, dir, far: reach * 2 };
  });
  scene.overrideMaterial = null;
  renderer.setRenderTarget(null);
  renderer.dispose();
  renderer.forceContextLoss();

  const p = new Vector3();
  const sample: ReferenceSampler = (x, y, z, nx, ny) => {
    // The view that looks at that face most squarely (from above for a roof).
    const out: [number, number, number] = nx === 0 && ny === 0 ? [0, 1, 0] : [nx, 0, -ny];
    const view = views.reduce((a, b) => (b.dir[0] * out[0] + b.dir[1] * out[1] + b.dir[2] * out[2] > a.dir[0] * out[0] + a.dir[1] * out[1] + a.dir[2] * out[2] ? b : a));
    p.set(x, z, -y);
    const camDistance = p.clone().applyMatrix4(view.cam.matrixWorldInverse).z * -1;
    p.project(view.cam);
    const col = Math.floor((p.x + 1) / 2 * view.W), row = Math.floor((p.y + 1) / 2 * view.H);
    if (col < 0 || row < 0 || col >= view.W || row >= view.H) return null;
    const i = (row * view.W + col) * 4;
    if (view.rgb[i + 3]! < 128) return null;
    // Hidden behind another part of the model: not this face.
    const seen = (view.depth[i]! + view.depth[i + 1]! / 255) / 255;
    const seenDistance = view.cam.near + seen * (view.far - view.cam.near);
    if (seenDistance < camDistance - 1.2) return null;
    return [toSrgb(view.rgb[i]! / 255), toSrgb(view.rgb[i + 1]! / 255), toSrgb(view.rgb[i + 2]! / 255)];
  };
  return { triangles, sample };
}

export function createReferenceModel(scene: Scene, redraw: () => void): ReferenceModel {
  const holder = new Group();
  holder.name = 'builder-reference';
  holder.visible = false;
  scene.add(holder);
  const inner = new Group();
  holder.add(inner);
  let info: ReferenceInfo | null = null;
  let opacity = 0.5;
  let quarter = 0;
  let mirrored = false;
  let target: ReferenceTarget | null = null;
  const materials: Material[] = [];

  const apply = (): void => {
    for (const m of materials) {
      m.transparent = opacity < 0.999;
      m.opacity = opacity;
      m.depthWrite = opacity >= 0.999;
      m.needsUpdate = true;
    }
    if (target) {
      // World (x, y, height) is three (x, height, -y); a world turn of +a is +a about three's Y.
      holder.position.set(target.x, target.floor, -target.y);
      holder.rotation.y = target.rotation + quarter * Math.PI / 2;
    }
    inner.scale.set(UNITS_PER_METER, UNITS_PER_METER, (mirrored ? -1 : 1) * UNITS_PER_METER);
    redraw();
  };

  return {
    async load(file) {
      const data = await file.arrayBuffer();
      const gltf = await new GLTFLoader().parseAsync(data, '');
      inner.clear();
      materials.length = 0;
      const model = gltf.scene;
      // Its plan centred on the origin, its foot at 0: in metres, Y up.
      const box = new Box3().setFromObject(model);
      const centre = box.getCenter(new Vector3());
      model.position.set(-centre.x, -box.min.y, -centre.z);
      model.traverse((o) => {
        const mesh = o as Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        mesh.renderOrder = 2;
        for (const m of [mesh.material].flat()) {
          m.side = DoubleSide;
          materials.push(m);
        }
      });
      inner.add(model);
      const size = box.getSize(new Vector3());
      info = { name: file.name, size: [size.x, size.z, size.y] };
      quarter = 0;
      mirrored = false;
      holder.visible = true;
      apply();
      return info;
    },
    placeOn(next) {
      target = next;
      apply();
    },
    turn() {
      quarter = (quarter + 1) % 4;
      apply();
    },
    flip() {
      mirrored = !mirrored;
      apply();
    },
    fade(step) {
      opacity = Math.min(1, Math.max(0.1, Math.round((opacity + step) * 10) / 10));
      apply();
    },
    toggle() {
      if (!info) return;
      holder.visible = !holder.visible;
      redraw();
    },
    remove() {
      inner.clear();
      materials.length = 0;
      info = null;
      holder.visible = false;
      redraw();
    },
    capture() {
      if (!info) return null;
      // A copy turned and mirrored as shown, in metres, in the frame of where it stands.
      const copy = new Group();
      copy.rotation.y = quarter * Math.PI / 2;
      const body = inner.clone(true);
      body.scale.set(1, 1, mirrored ? -1 : 1);
      copy.add(body);
      return captureModel(copy);
    },
    get frame() { return target ?? { x: 0, y: 0, floor: 0, rotation: 0 }; },
    get loaded() { return info !== null; },
    get info() { return info; },
    get opacity() { return opacity; },
  };
}
