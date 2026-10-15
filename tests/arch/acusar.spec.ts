import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** THE ACCUSER'S RULES ON A PROJECT OF ONE FILE (`scripts/acusar.mjs`), as typescript-eslint's RuleTester checks a rule */
const root = fileURLToPath(new URL('../..', import.meta.url));
const three = join(root, 'node_modules', '@types', 'three', 'index.d.ts').split('\\').join('/');

const CASES = `
import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Object3D, ShaderMaterial, WebGLRenderer, WebGLRenderTarget } from 'three';

export function recompile(m: MeshBasicMaterial): void {
  m.needsUpdate = true; // espera material-needs-update
}
export function notAMaterial(o: { needsUpdate: boolean }): void {
  o.needsUpdate = true; // não material-needs-update
}
export function wholePosition(g: BufferGeometry): void {
  const position = g.getAttribute('position') as BufferAttribute;
  position.needsUpdate = true; // espera buffer-inteiro espera posicao-sem-volume
}
export function rangedWithBounds(g: BufferGeometry): void {
  const position = g.getAttribute('position') as BufferAttribute;
  position.addUpdateRange(0, 3);
  position.needsUpdate = true; // não buffer-inteiro não posicao-sem-volume
  g.computeBoundingSphere();
}
export function madeHere(): BufferAttribute {
  const fresh = new BufferAttribute(new Float32Array(3), 3);
  fresh.needsUpdate = true; // não buffer-inteiro
  return fresh;
}
export function swap(mesh: Mesh): void {
  mesh.geometry.setAttribute('uv', new BufferAttribute(new Float32Array(2), 2)); // espera geometria-trocada
}
export function build(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('uv', new BufferAttribute(new Float32Array(2), 2)); // não geometria-trocada
  return g;
}
export function drop(scene: Object3D, mesh: Mesh): void {
  scene.remove(mesh); // espera remove-sem-dispose
}
export function dropAndFree(scene: Object3D, mesh: Mesh): void {
  scene.remove(mesh); // não remove-sem-dispose
  mesh.geometry.dispose();
}
export function setDelete(ids: Set<number>): void {
  ids.delete(1);
  const list: number[] = [];
  list.splice(0, 1); // não remove-sem-dispose
}
export function readBack(r: WebGLRenderer, t: WebGLRenderTarget, out: Uint8Array): void {
  r.readRenderTargetPixels(t, 0, 0, 1, 1, out); // espera leitura-da-gpu
}
export function materials(): MeshBasicMaterial[] {
  const out: MeshBasicMaterial[] = [];
  for (let i = 0; i < 3; i++) out.push(new MeshBasicMaterial()); // espera criado-em-laco
  return out;
}
export function geometries(): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) out.push(new BufferGeometry()); // não criado-em-laco
  return out;
}
export function always(mesh: Mesh): void {
  mesh.frustumCulled = false; // espera recorte-desligado
}
export function uniforms(m: ShaderMaterial): void {
  m.uniformsNeedUpdate = true; // espera uniforms-redundante
}
export function same(a: object, b: object): boolean {
  return JSON.stringify(a) === JSON.stringify(b); // espera compara-json
}
export function save(a: object): string {
  return JSON.stringify(a); // não compara-json
}
export function key(d: { revision: number }): string {
  return \`\${d.revision}:x\`; // espera chave-revisao-global
}
export function checked(m: MeshBasicMaterial): void {
  // acusar-ok material-needs-update: troca de textura uma vez, na carga
  m.needsUpdate = true; // não material-needs-update
}
export function reasonless(m: MeshBasicMaterial): void {
  m.needsUpdate = true; // acusar-ok material-needs-update espera material-needs-update
}
`;

interface Finding { regra: string; linha: number }

/** The accuser's findings on a project of one file. */
function accused(text: string): Finding[] {
  const dir = mkdtempSync(join(tmpdir(), 'acusar-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'casos.ts'), text);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'bundler',
        strict: true, noEmit: true, skipLibCheck: true, types: [], paths: { three: [three] },
      },
      include: ['src'],
    }));
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'acusar.mjs'), '--projeto', dir, '--json'], { encoding: 'utf8', cwd: root });
    return (JSON.parse(out) as { acusacoes: Finding[] }).acusacoes;
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
    for (const m of comment.matchAll(/\b(espera|não) ([a-z-]+)/g)) (m[1] === 'espera' ? must : mustNot).push({ regra: m[2]!, linha: i + 1 });
  });
  return { must, mustNot };
}

describe('the accuser', () => {
  it('accuses each declared line by the declared type, and spares the rest and what was marked right with a reason', () => {
    const found = accused(CASES);
    const { must, mustNot } = declared(CASES);
    expect(must.length).toBeGreaterThan(10);
    const has = (f: Finding): boolean => found.some((x) => x.regra === f.regra && x.linha === f.linha);
    expect(must.filter((f) => !has(f))).toEqual([]);
    expect(mustNot.filter(has)).toEqual([]);
  });
});
