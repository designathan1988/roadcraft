/* global fetch, performance, document, createImageBitmap */
// A model's sheet: the game's own furniture model rendered and, beside it, its triangles as a hidden-line wireframe, with the triangle count.
// `node scripts/model-sheet.mjs [kind] [out.png] [--url=http://127.0.0.1:5300]`  (kind: any `FURNITURE_KINDS` entry, default `chair`; out: `<kind>-sheet.png`)
// Uses the dev server on the url, or starts one of its own when none answers.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [kind = 'chair', outArg] = args.filter((a) => !a.startsWith('--'));
const url = flags.find((f) => f.startsWith('--url='))?.slice(6) ?? 'http://127.0.0.1:5300/';
const out = resolve(outArg ?? `${kind}-sheet.png`);

let server = null;
const up = await fetch(url).then((r) => r.ok, () => false);
if (!up) {
  const { createServer } = await import('vite');
  server = await createServer({ server: { host: '127.0.0.1', port: 5300, strictPort: true } });
  await server.listen();
}

/** Runs in the page: renders the model twice into one canvas, labels it, and returns the PNG and the counts. */
const sheet = async (name) => {
  const threeUrl = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/deps\/three\.js/.test(n));
  const T = await import(threeUrl ?? '/node_modules/.vite/deps/three.js');
  const kit = await import('/src/render/buildings/furnitureKit.ts');
  const geometry = kit.createFurnitureGeometries()[name];
  if (!geometry) throw new Error(`no furniture kind "${name}"`);
  const triangles = (geometry.index ? geometry.index.count : geometry.getAttribute('position').count) / 3;
  const vertices = geometry.getAttribute('position').count;

  const W = 900, H = 1000;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const renderer = new T.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(W, H, false);
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const centre = box.getCenter(new T.Vector3());
  const size = box.getSize(new T.Vector3());
  const camera = new T.PerspectiveCamera(30, W / H, 0.05, 80);
  camera.position.copy(centre).addScaledVector(new T.Vector3(-1.0, 0.75, 1.25).normalize(), size.length() * 2.0);
  camera.lookAt(centre);

  // Shaded, as the game shades furniture.
  const shaded = new T.Scene();
  shaded.background = new T.Color(0xe9edf1);
  const sun = new T.DirectionalLight(0xffffff, 2.6);
  sun.position.set(-1.5, 3, 2).multiplyScalar(Math.max(1, size.length()));
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const span = size.length() * 1.2;
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, far: 60 });
  sun.shadow.bias = -0.0005;
  shaded.add(new T.HemisphereLight(0xf4f7ff, 0x8a7f72, 1.4), sun);
  const mesh = new T.Mesh(geometry, kit.createFurnitureMaterial());
  mesh.castShadow = true;
  const floor = new T.Mesh(new T.PlaneGeometry(40, 40), new T.MeshStandardMaterial({ color: 0xd8d4cc, roughness: 0.9 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = box.min.y;
  floor.receiveShadow = true;
  shaded.add(mesh, floor);
  renderer.render(shaded, camera);
  const left = await createImageBitmap(canvas);

  // Wireframe, the hidden edges left out: the solid drawn into the depth a little pushed back, every triangle's edges tested against it.
  renderer.toneMapping = T.NoToneMapping;
  renderer.shadowMap.enabled = false;
  const wire = new T.Scene();
  wire.background = new T.Color(0xffffff);
  wire.add(
    new T.Mesh(geometry, new T.MeshBasicMaterial({ color: 0xf7f8fa, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 })),
    new T.LineSegments(new T.WireframeGeometry(geometry), new T.LineBasicMaterial({ color: 0x1b2a3a })),
  );
  renderer.render(wire, camera);
  const right = await createImageBitmap(canvas);
  renderer.dispose();

  // The sheet: title, the two pictures side by side.
  const pad = 24, top = 90;
  const page = document.createElement('canvas');
  page.width = W * 2 + pad * 3; page.height = H + top + pad;
  const g = page.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, page.width, page.height);
  g.drawImage(left, pad, top); g.drawImage(right, W + pad * 2, top);
  g.fillStyle = '#141e28'; g.font = 'bold 38px Segoe UI, sans-serif';
  g.fillText(`${name} - ${triangles} triangles, ${vertices} vertices`, pad, 58);
  g.fillStyle = '#28323c'; g.font = '32px Segoe UI, sans-serif';
  g.fillText('Rendered', pad + 10, top + 44);
  g.fillText('Wireframe (hidden edges removed)', W + pad * 2 + 10, top + 44);
  return { triangles, vertices, png: page.toDataURL('image/png').split(',')[1] };
};

const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  await page.goto(url);
  await page.waitForFunction(() => performance.getEntriesByName('opening:shown').length > 0, null, { timeout: 180000, polling: 250 });
  const result = await page.evaluate(sheet, kind);
  writeFileSync(out, Buffer.from(result.png, 'base64'));
  console.log(`${kind}: ${result.triangles} triangles, ${result.vertices} vertices -> ${out}`);
} finally {
  await browser.close();
  await server?.close();
}
