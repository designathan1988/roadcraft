import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The rules of `scripts/check-code.mjs`, each made to fire once and each
 * escape made to hold, on a small project written here: a frame that reaches
 * JSON, a material, a loop over the whole map, through a direct call, an
 * interface implemented by an object literal, a callback run by `forEach`;
 * and does not reach a deferred callback, a stored one, or a `@rebuild`
 * body's per-frame work.
 */
const root = fileURLToPath(new URL('../..', import.meta.url));
const three = join(root, 'node_modules', '@types', 'three', 'index.d.ts').split('\\').join('/');

const FRAME = `
import { MeshBasicMaterial } from 'three';

export class RoadDoc { readonly nodes = new Map<number, number>(); readonly name = 'town'; }
interface Layer { refresh(): void }
const layers: Layer[] = [];
layers.push({ refresh() { void new MeshBasicMaterial(); } });
const kept: (() => void)[] = [];
function store(fn: () => void): void { kept.push(fn); }
function helper(): void { JSON.parse('{}'); }
/** @rebuild Only when the document changed. */
function rebuild(doc: RoadDoc): void {
  JSON.stringify([...doc.nodes.values()]);
  void new MeshBasicMaterial();
}

/** @perFrame */
export function frame(doc: RoadDoc): void {
  helper();
  for (const layer of layers) layer.refresh();
  rebuild(doc);
  [1, 2].forEach(() => structuredClone({}));
  setTimeout(() => JSON.parse('1'), 0);
  store(() => JSON.parse('2'));
  for (const n of doc.nodes.values()) void n;
  void doc.name.length;
  window.addEventListener('keydown', () => undefined);
  // own key listener: follows a modifier, runs no command.
  window.addEventListener('keyup', () => undefined);
}
`;

/**
 * The traversal rules: a loop over the map inside a loop over the map, through
 * a call or over a local filled from the map (CLARITY's redundant traversal),
 * and a loop over the map reached from what runs once an item; a `@rebuild`
 * callee is amortized, and code not marked per item is not held to it.
 */
const ITEMS = `
export class RoadDoc { readonly nodes = new Map<number, { x: number }>(); readonly lots: { id: number }[] = []; }
/** @perFrame */
export function frame(): void {}
function lotIndex(doc: RoadDoc, id: number): number { return doc.lots.findIndex((l) => l.id === id); }
/** @rebuild Once a revision. */
function summed(doc: RoadDoc): number { let n = 0; for (const l of doc.lots) n += l.id; return n; }
export function quadratic(doc: RoadDoc): number {
  let n = 0;
  for (const node of doc.nodes.values()) n += lotIndex(doc, node.x);
  const kept = doc.lots.filter((l) => l.id > 0);
  for (const l of kept) n += doc.lots.indexOf(l);
  for (const node of doc.nodes.values()) n += summed(doc) + node.x;
  return n;
}
/** @perItem Once a thing grown. */
export function grow(doc: RoadDoc): number { return lotIndex(doc, 1); }
export function free(doc: RoadDoc): number { return lotIndex(doc, 2); }
`;

/**
 * The blind spots closed: a class field filled from the map and walked once a
 * query (`Sight.blocked`, as `AmbientWorld.walls` was), a collection marked
 * `@mapWide` walked inside a walk over itself, the map redone because a global
 * revision moved (a `!==` branch, a key holding a revision with an early
 * return, a `@rebuild` callee: not excused), and the map walked once a
 * pointer move (`@perInput`). Spared: a loop over what `near(...)` hands
 * back, and the diary read (`changes.since`) under a revision guard.
 */
const DERIVED = `
export class RoadDoc {
  readonly lots: { id: number; x: number }[] = [];
  revision = 0;
  readonly changes = { since(_from: number): { id: number }[] { return []; } };
  near(_x: number): { id: number }[] { return []; }
}
export class Sight {
  private walls: { x: number }[] = [];
  private wallsFor = -1;
  blocked(doc: RoadDoc, x: number): boolean {
    if (this.wallsFor !== doc.revision) {
      this.wallsFor = doc.revision;
      this.walls = [];
      for (const l of doc.lots) this.walls.push({ x: l.x });
    }
    for (const w of this.walls) if (w.x === x) return true;
    return false;
  }
}
export class Sim {
  /** @mapWide Every vehicle. */
  readonly vehicles = new Map<number, { lane: number }>();
  step(): number { let n = 0; for (const v of this.vehicles.values()) n += this.laneClear(v.lane) ? 1 : 0; return n; }
  laneClear(lane: number): boolean { for (const v of this.vehicles.values()) if (v.lane === lane) return false; return true; }
}
export class Keyed {
  private key = '';
  update(doc: RoadDoc, zoom: number): number {
    const key = \`\${doc.revision}:\${zoom}\`;
    if (key === this.key) return 0;
    this.key = key;
    let n = 0;
    for (const l of doc.lots) n += l.id;
    return n;
  }
}
/** @rebuild Once a revision. */
function rebuildAll(doc: RoadDoc): number { let n = 0; for (const l of doc.lots) n += l.id; return n; }
export class Rebuilt {
  private seen = -1;
  tick(doc: RoadDoc): number {
    if (doc.revision !== this.seen) { this.seen = doc.revision; return rebuildAll(doc); }
    return 0;
  }
}
export class Follower {
  private seen = -1;
  follow(doc: RoadDoc): number {
    let n = 0;
    if (this.seen !== doc.revision) {
      for (const c of doc.changes.since(this.seen)) n += c.id;
      this.seen = doc.revision;
    }
    return n;
  }
}
/** @perInput Once a pointer move. */
export function hover(doc: RoadDoc, x: number): number { let n = 0; for (const l of doc.near(x)) n += l.id; return n; }
/** @perInput Once a pointer move. */
export function pick(doc: RoadDoc, x: number): number { return doc.lots.find((l) => l.x === x)?.id ?? 0; }
/** @perFrame */
export function frame(doc: RoadDoc, sight: Sight, sim: Sim, keyed: Keyed, rebuilt: Rebuilt, follower: Follower): number {
  return (sight.blocked(doc, 1) ? 1 : 0) + sim.step() + keyed.update(doc, 1) + rebuilt.tick(doc) + follower.follow(doc);
}
`;

/** The rules' findings on a project of one file. */
function findings(file: string, text: string): Record<string, number> {
  const dir = mkdtempSync(join(tmpdir(), 'check-code-'));
  try {
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', file), text);
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'bundler',
        strict: true, noEmit: true, skipLibCheck: true, types: [], paths: { three: [three] },
      },
      include: ['src'],
    }));
    const out = execFileSync(process.execPath, [join(root, 'scripts', 'check-code.mjs'), '--project', dir, '--list'], { encoding: 'utf8' });
    return JSON.parse(out) as Record<string, number>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the traversal rules', () => {
  it('fire on the map walked once an item, and spare what is amortized', () => {
    const found = findings('items.ts', ITEMS);
    const traversals = Object.fromEntries(Object.entries(found).filter(([key]) => key.startsWith('whole-map-nested') || key.startsWith('whole-map-per-item')));
    expect(traversals).toEqual({
      'whole-map-nested  src/items.ts quadratic  for RoadDoc.nodes ⊃ lotIndex: findIndex RoadDoc.lots': 1,
      'whole-map-nested  src/items.ts quadratic  for kept(RoadDoc.lots) ⊃ indexOf RoadDoc.lots': 1,
      'whole-map-per-item  src/items.ts lotIndex  findIndex RoadDoc.lots': 1,
    });
  });
});

describe('the blind spots of the traversal rules', () => {
  it('fire on a field filled from the map, a @mapWide collection, a revision guard and a pointer move; spare near() and the diary', () => {
    const found = findings('derived.ts', DERIVED);
    const fresh = Object.fromEntries(Object.entries(found).filter(([key]) => /^(derived-map|whole-map-on-revision|whole-map-per-input)/.test(key)));
    expect(fresh).toEqual({
      'derived-map-per-frame  src/derived.ts Sight.blocked  for Sight.walls': 1,
      'derived-map-per-frame  src/derived.ts Sim.step  for Sim.vehicles': 1,
      'derived-map-per-frame  src/derived.ts Sim.laneClear  for Sim.vehicles': 1,
      'derived-map-nested  src/derived.ts Sim.step  for Sim.vehicles ⊃ Sim.laneClear: for Sim.vehicles': 1,
      'whole-map-on-revision  src/derived.ts Sight.blocked  for RoadDoc.lots': 1,
      'whole-map-on-revision  src/derived.ts Keyed.update  for RoadDoc.lots': 1,
      'whole-map-on-revision  src/derived.ts Rebuilt.tick  rebuildAll: for RoadDoc.lots': 1,
      'whole-map-per-input  src/derived.ts pick  find RoadDoc.lots': 1,
    });
    // The old rules keep their own findings: the field and the mark are counted under the new names only.
    expect(Object.keys(found).filter((key) => /^whole-map-(per-frame|nested)/.test(key) && /Sight\.walls|Sim\.vehicles/.test(key))).toEqual([]);
  });
});

describe('the code rules', () => {
  it('fire on what a frame reaches, and hold their escapes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-code-'));
    try {
      mkdirSync(join(dir, 'src'));
      writeFileSync(join(dir, 'src', 'frame.ts'), FRAME);
      writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2022', lib: ['ES2022', 'DOM'], module: 'ESNext', moduleResolution: 'bundler',
          strict: true, noEmit: true, skipLibCheck: true, types: [], paths: { three: [three] },
        },
        include: ['src'],
      }));
      const out = execFileSync(process.execPath, [join(root, 'scripts', 'check-code.mjs'), '--project', dir, '--list'], { encoding: 'utf8' });
      const found = JSON.parse(out) as Record<string, number>;
      expect(found).toEqual({
        'heavy-call-per-frame  src/frame.ts frame/λforEach  structuredClone': 1,
        'heavy-call-per-frame  src/frame.ts helper  JSON.parse': 1,
        'material-in-frame  src/frame.ts rebuild  new MeshBasicMaterial': 1,
        'material-in-frame  src/frame.ts refresh  new MeshBasicMaterial': 1,
        'whole-map-per-frame  src/frame.ts frame  for RoadDoc.nodes': 1,
        'window-key-listener  src/frame.ts frame  window keydown': 1,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
