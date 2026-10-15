import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** THE ACCUSER'S RULES ON A PROJECT OF ONE FILE (`scripts/accuse.mjs`), as typescript-eslint's RuleTester checks a rule */
const root = fileURLToPath(new URL('../..', import.meta.url));
const three = join(root, 'node_modules', '@types', 'three', 'index.d.ts').split('\\').join('/');

const CASES = `
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Object3D, ShaderMaterial, WebGLRenderer, WebGLRenderTarget } from 'three';

export function recompile(m: MeshBasicMaterial): void {
  m.needsUpdate = true; // expect material-needs-update
}
export function notAMaterial(o: { needsUpdate: boolean }): void {
  o.needsUpdate = true; // not material-needs-update
}
export function wholePosition(g: BufferGeometry): void {
  const position = g.getAttribute('position') as BufferAttribute;
  position.needsUpdate = true; // expect whole-buffer expect position-without-bounds
}
export function rangedWithBounds(g: BufferGeometry): void {
  const position = g.getAttribute('position') as BufferAttribute;
  position.addUpdateRange(0, 3);
  position.needsUpdate = true; // not whole-buffer not position-without-bounds
  g.computeBoundingSphere();
}
export function madeHere(): BufferAttribute {
  const fresh = new BufferAttribute(new Float32Array(3), 3);
  fresh.needsUpdate = true; // not whole-buffer
  return fresh;
}
export function swap(mesh: Mesh): void {
  mesh.geometry.setAttribute('uv', new BufferAttribute(new Float32Array(2), 2)); // expect geometry-swapped
}
export function build(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('uv', new BufferAttribute(new Float32Array(2), 2)); // not geometry-swapped
  return g;
}
export function drop(scene: Object3D, mesh: Mesh): void {
  scene.remove(mesh); // expect remove-without-dispose
}
export function dropAndFree(scene: Object3D, mesh: Mesh): void {
  scene.remove(mesh); // not remove-without-dispose
  mesh.geometry.dispose();
}
export function setDelete(ids: Set<number>): void {
  ids.delete(1);
  const list: number[] = [];
  list.splice(0, 1); // not remove-without-dispose
}
export function readBack(r: WebGLRenderer, t: WebGLRenderTarget, out: Uint8Array): void {
  r.readRenderTargetPixels(t, 0, 0, 1, 1, out); // expect gpu-readback
}
export function materials(): MeshBasicMaterial[] {
  const out: MeshBasicMaterial[] = [];
  for (let i = 0; i < 3; i++) out.push(new MeshBasicMaterial()); // expect created-in-loop
  return out;
}
export function geometries(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) out.push(new BufferGeometry()); // not created-in-loop
  return out;
}
export function always(mesh: Mesh): void {
  mesh.frustumCulled = false; // expect culling-off
}
export function uniforms(m: ShaderMaterial): void {
  m.uniformsNeedUpdate = true; // expect redundant-uniforms
}
export function same(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b); // expect compare-json
}
export function save(a: object): string {
  return JSON.stringify(a); // not compare-json
}
export function key(d: { revision: number }): string {
  return \`\${d.revision}:x\`; // expect global-revision-key
}
export function checked(m: MeshBasicMaterial): void {
  // accuse-ok material-needs-update: texture swapped once, at load
  m.needsUpdate = true; // not material-needs-update
}
export function reasonless(m: MeshBasicMaterial): void {
  m.needsUpdate = true; // accuse-ok material-needs-update expect material-needs-update
}
`;

interface Finding { rule: string; line: number }

/** The accuser's findings on a project of one file. */
function accused(text: string): Finding[] {
  const dir = mkdtempSync(join(tmpdir(), 'accuse-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'cases.ts'), text);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'bundler',
        strict: true, noEmit: true, skipLibCheck: true, types: [], paths: { three: [three] },
      },
      include: ['src'],
    }));
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'accuse.mjs'), '--project', dir, '--json'], { encoding: 'utf8', cwd: root });
    return (JSON.parse(out) as { accusations: Finding[] }).accusations;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** What each line of the cases declares: rules it must be accused of, rules it must not. */
function declared(text: string): { must: Finding[]; mustNot: Finding[] } {
  const must: Finding[] = [];
  const mustNot: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    const comment = line.slice(line.indexOf('//') + 2);
    if (!line.includes('//')) return;
    for (const m of comment.matchAll(/\b(expect|not) ([a-z-]+)/g)) (m[1] === 'expect' ? must : mustNot).push({ rule: m[2]!, line: i + 1 });
  });
  return { must, mustNot };
}

describe('the accuser', () => {
  it('accuses each declared line by the declared type, and spares the rest and what was marked right with a reason', () => {
    const found = accused(CASES);
    const { must, mustNot } = declared(CASES);
    expect(must.length).toBeGreaterThan(10);
    const has = (f: Finding): boolean => found.some((x) => x.rule === f.rule && x.line === f.line);
    expect(must.filter((f) => !has(f))).toEqual([]);
    expect(mustNot.filter(has)).toEqual([]);
  });
});
