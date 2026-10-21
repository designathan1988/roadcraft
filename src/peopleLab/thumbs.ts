import {
  ACESFilmicToneMapping, DirectionalLight, HemisphereLight, PMREMGenerator, PerspectiveCamera, Scene, SRGBColorSpace, Vector3, WebGLRenderer, type Mesh, type Object3D, type Texture,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createPersonLayers, type PersonLayers } from '@render/people/skinAppearance';
import type { LabBuilder } from './build';
import { dressPerson } from './dress';
import type { LabPerson } from './record';

/** PICTURES OF CHOICES, as Create-a-Sim's tiles: each preset shown on the person themself, built and photographed off screen, one at a time, kept for the page's life */

export type Framing = 'face' | 'head' | 'body' | 'feet';

const SIZE = 112;

export class Thumbs {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(24, 1, 0.05, 20);
  private readonly done = new Map<string, string>();
  private readonly waiting = new Map<string, { person: LabPerson; framing: Framing; img: HTMLImageElement[] }>();
  private busy = false;

  /** Its own texture arrays (`createPersonLayers`): the main view's are bound to the main renderer and must never be shared across WebGL contexts. */
  private readonly layers: PersonLayers = createPersonLayers();
  /** True while the person is being shaped or built: pictures wait, the page stays smooth. */
  paused = false;

  constructor(private readonly builder: LabBuilder, private readonly painted: WeakMap<Texture, Texture>) {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE * 2;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(SIZE * 2, SIZE * 2, false);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.scene.environment = new PMREMGenerator(this.renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;
    this.scene.add(new HemisphereLight(0xeaf6ff, 0x9fb7c9, 1));
    const key = new DirectionalLight(0xfff3e6, 2.2);
    key.position.set(1.4, 3, 2.8);
    this.scene.add(key);
  }

  /** An image showing `person` framed so; drawn now when known, else when its turn comes. */
  image(key: string, person: LabPerson, framing: Framing): HTMLImageElement {
    const img = document.createElement('img');
    img.alt = '';
    const known = this.done.get(key);
    if (known) { img.src = known; return img; }
    img.className = 'pending';
    // Built only once it scrolls into view: a panel of forty choices costs only the ones seen.
    const seen = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      seen.disconnect();
      const done = this.done.get(key);
      if (done !== undefined) { img.src = done; img.classList.remove('pending'); return; }
      const job = this.waiting.get(key);
      if (job) job.img.push(img); else this.waiting.set(key, { person, framing, img: [img] });
      void this.pump();
    });
    seen.observe(img);
    return img;
  }

  /** Forget the pictures not yet drawn (the panel changed). */
  clearQueue(): void { this.waiting.clear(); }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const next = this.waiting.entries().next();
        if (next.done) break;
        const [key, job] = next.value;
        this.waiting.delete(key);
        const src = await this.shoot(job.person, job.framing).catch((error: unknown) => { console.warn('[people-lab] a thumbnail failed', key, error); return ''; });
        this.done.set(key, src);
        for (const img of job.img) { img.src = src; img.classList.remove('pending'); }
        // A breath between builds, longer while the person is being worked on: the page stays responsive.
        // Frames, not a timer: ~8 frames between pictures, and none while paused.
        for (let f = 0; f < 8 || this.paused; f++) await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    } finally { this.busy = false; }
  }

  private async shoot(person: LabPerson, framing: Framing): Promise<string> {
    const built = await this.builder.build(person);
    const skin = await dressPerson(built, person.spec, this.layers, this.painted);
    this.scene.add(built.scene);
    built.scene.updateWorldMatrix(true, true);
    const head = new Vector3(0, 1.5, 0);
    built.scene.traverse((o) => { if (o.name === 'Bip01_Head' || o.name === 'head') o.getWorldPosition(head); });
    const tall = head.y * 1.13;
    const [target, dist] = framing === 'face' ? [head.clone().add(new Vector3(0, 0.05, 0)), 0.75]
      : framing === 'head' ? [head.clone().add(new Vector3(0, 0.03, 0)), 1.05]
        : framing === 'feet' ? [new Vector3(0, 0.12, 0), 1.1] : [new Vector3(0, tall * 0.5, 0), tall * 4.6];
    this.camera.position.copy(target).add(new Vector3(0.28, 0.06, 1).normalize().multiplyScalar(dist));
    this.camera.lookAt(target);
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement.toDataURL('image/webp', 0.85);
    this.scene.remove(built.scene);
    dispose(built.scene);
    // The skin's textures are NOT released: they are leased by name and shared with the person on screen (releasing them blanked the main view, 2026-10-21).
    void skin;
    return src;
  }
}

function dispose(root: Object3D): void {
  root.traverse((o) => {
    const m = o as Mesh;
    m.geometry?.dispose();
    for (const mat of Array.isArray(m.material) ? m.material : m.material ? [m.material] : []) mat.dispose();
  });
}
