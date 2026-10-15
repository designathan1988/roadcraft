// @deprecated THE ACCUSER: points at code to look at, never blocks anything.
import ts from 'typescript';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const root = arg('--project') ? resolve(arg('--project')) : process.cwd();
/** The project's own files, for the rules sourced in it (CLAUDE.md); the game's when another project is read. */
const game = process.cwd();
const REF = 'C:/Codex-Shared/referencia/threejs';
const onlyRule = arg('--rule');
const onlyFile = arg('--file');
const showAll = process.argv.includes('--all');
const asJson = process.argv.includes('--json');
/** Shown per rule unless --all: the rest are counted, and all are in the file report. */
const SHOWN = 25;

const RULES = {
  'material-needs-update': {
    title: 'material.needsUpdate = true (recompiles the shader)',
    why: 'Changing what needs another shader program recompiles the material; during play that stutters.',
    source: { file: 'repo-r186/manual/pages/how-to-update-things.html', excerpt: 'Bear in mind this might be quite slow and induce jerkiness in framerate' },
  },
  'whole-buffer': {
    title: 'whole attribute sent to the GPU again (needsUpdate without addUpdateRange)',
    why: 'With no range the whole buffer goes up again; with addUpdateRange, only the changed part.',
    source: { file: 'docs/BufferAttribute.html.md', excerpt: 'This can be used to only update some components of stored vectors' },
  },
  'geometry-swapped': {
    title: 'setAttribute/setIndex on a geometry already in use (buffer resized)',
    why: 'Swapping the attribute of a drawn geometry amounts to making a new geometry.',
    source: { file: 'repo-r186/manual/pages/how-to-update-things.html', excerpt: 'you cannot resize buffers (this is very costly' },
  },
  'position-without-bounds': {
    title: 'positions changed without recomputing the bounding volume',
    why: 'With the old volume, frustum culling hides the object or draws it for nothing (a picture defect).',
    source: { file: 'repo-r186/manual/pages/how-to-update-things.html', excerpt: 'you may need to recompute bounding volumes so other features of the engine like view frustum culling' },
  },
  'remove-without-dispose': {
    title: 'object taken out of the scene with no dispose in the same function',
    why: 'Removing from the scene frees no geometry, material or texture on the GPU. Check whether another function disposes them.',
    source: { file: 'repo-r186/manual/pages/how-to-dispose-of-objects.html', excerpt: 'No, you have to explicitly dispose the geometry and material' },
  },
  'gpu-readback': {
    title: 'synchronous GPU read (readPixels, readRenderTargetPixels, getImageData)',
    why: 'The page waits for the GPU to finish. There is readRenderTargetPixelsAsync; a canvas read often wants willReadFrequently.',
    source: { file: 'docs/WebGLRenderer.html.md', excerpt: 'readRenderTargetPixelsAsync' },
  },
  'created-in-loop': {
    title: 'material, geometry, texture or render target created inside a loop',
    why: 'Each one allocates GPU resources that only leave with dispose. In a catalogue built once at load that is normal; in a rebuild, it is not.',
    source: { file: 'repo-r186/manual/pages/how-to-dispose-of-objects.html', excerpt: 'these objects are not released automatically' },
  },
  'culling-off': {
    title: 'frustumCulled = false (drawn even out of view)',
    why: 'The object goes to the GPU every frame, seen or not. Sometimes right (the sky, instances with their own volume).',
    source: { file: 'docs/Object3D.html.md', excerpt: 'frustumCulled' },
  },
  'redundant-uniforms': {
    title: 'uniformsNeedUpdate = true (uniforms already go up every frame)',
    why: 'Changing the uniform value is enough; setting the flag forces extra upload work.',
    source: { file: 'repo-r186/manual/pages/how-to-update-things.html', excerpt: 'values are sent to the shader every frame' },
  },
  'deprecated-api': {
    title: 'API marked @deprecated in the installed types',
    why: 'It will go in a coming version; it usually has a faster or more correct replacement.',
    source: null,
  },
  'typed-copy': {
    title: 'new Float32BufferAttribute(typed array) and siblings (three copies the array)',
    why: 'The constructor does new Float32Array(array): a freshly made typed array is copied whole. Use new BufferAttribute(array, n), which keeps the array itself (215 ms every 20 s of walking in the shell build, audit of 2026-10-14).',
    source: { file: 'repo-r186/src/core/BufferAttribute.js', excerpt: 'super( new Float32Array( array ), itemSize, normalized );' },
  },
  'compare-json': {
    title: 'comparison by JSON.stringify',
    why: 'Serializes everything to compare; compare what the diary says changed.',
    source: { project: 'CLAUDE.md', excerpt: 'Comparing by JSON' },
  },
  'global-revision-key': {
    title: 'cache key with a global revision (`${...revision}`)',
    why: 'Any change invalidates everything; the key should be what the output reads.',
    source: { project: 'CLAUDE.md', excerpt: 'cache key with a global revision' },
  },
  'check-code': {
    title: 'already accused by the check-code rules (baseline)',
    why: 'Known occurrences that may only shrink (scripts/check-code.mjs), among them the map walked inside a loop over the map (whole-map-nested), followed through the calls.',
    source: { project: 'scripts/baselines/code-rules.baseline.json', excerpt: '' },
  },
};

// ------------------------------------------------------------ sources checked
const squash = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
for (const rule of Object.values(RULES)) {
  if (!rule.source) { rule.checked = 'installed types (@types/three)'; continue; }
  const path = rule.source.project ? join(game, rule.source.project) : join(REF, rule.source.file);
  const text = existsSync(path) ? squash(readFileSync(path, 'utf8')) : null;
  rule.checked = text === null ? 'SOURCE NOT FOUND' : text.includes(squash(rule.source.excerpt)) ? `${rule.source.project ?? `referencia/threejs/${rule.source.file}`}` : 'EXCERPT NOT FOUND IN THE SOURCE';
}

// ------------------------------------------------------------ program
const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, projectReferences: parsed.projectReferences });
const checker = program.getTypeChecker();
const rel = (f) => relative(root, f).split(sep).join('/');

/** The names of a type, its bases and, for a union, each member's: "a Material" includes MeshStandardMaterial. */
function typeNames(type) {
  const names = new Set();
  const seen = new Set();
  const walk = (t) => {
    if (!t || seen.has(t)) return;
    seen.add(t);
    if (t.isUnion?.()) { for (const u of t.types) walk(u); return; }
    const s = t.getSymbol?.() ?? t.aliasSymbol;
    if (s) names.add(s.getName());
    const target = t.target ?? t;
    if (target.isClassOrInterface?.()) for (const b of checker.getBaseTypes(target) ?? []) walk(b);
  };
  walk(type);
  return names;
}
const isA = (node, ...bases) => { const n = typeNames(checker.getTypeAtLocation(node)); return bases.some((b) => n.has(b)); };
const resolved = (s) => (s && s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s);

const findings = [];
/** A lead read and found right is marked where it is, with the reason, on its line or the line above */
const OK = /accuse-ok\s+([\w-]+)\s*:\s*\S/;
const silenced = [];
const accuse = (id, sf, node, fn, extra = '') => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = sf.text.split('\n');
  const code = lines[line]?.trim().slice(0, 140) ?? '';
  const where = { rule: id, file: rel(sf.fileName), line: line + 1, function: fn ?? '(top)', code, extra };
  const mark = [lines[line], lines[line - 1]].map((l) => l?.match(OK)).find((m) => m && m[1] === id);
  (mark ? silenced : findings).push(where);
};

const isLoop = (n) => ts.isForStatement(n) || ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isWhileStatement(n) || ts.isDoStatement(n)
  || (ts.isCallExpression(n.parent ?? {}) && (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
    && ts.isPropertyAccessExpression(n.parent.expression) && /^(forEach|map|filter|reduce|some|every|flatMap|find)$/.test(n.parent.expression.name.text));
const fnName = (n) => {
  if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) return n.name?.getText() ?? null;
  if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent) {
    if (ts.isVariableDeclaration(n.parent) || ts.isPropertyAssignment(n.parent) || ts.isPropertyDeclaration(n.parent)) return n.parent.name.getText();
  }
  return null;
};
const isFunctionLike = (n) => ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isConstructorDeclaration(n) || ts.isGetAccessor(n) || ts.isSetAccessor(n);

for (const sf of program.getSourceFiles()) {
  const file = rel(sf.fileName);
  if (!file.startsWith('src/') || sf.isDeclarationFile) continue; // the project's own code, not tests nor tooling
  if (onlyFile && !file.includes(onlyFile)) continue;
  const fileText = sf.text;
  /** Per function: its name, its body's text, how deep in loops a node sits. */
  const visit = (node, fn, body, loops) => {
    if (isFunctionLike(node)) {
      const name = fnName(node) ?? fn;
      const inner = node.body ? node.body.getText(sf) : '';
      const loopsIn = isLoop(node) ? loops + 1 : loops;
      ts.forEachChild(node, (c) => visit(c, name, inner, loopsIn));
      return;
    }
    const loopsHere = isLoop(node) ? loops + 1 : loops;

    // x.needsUpdate = true / x.frustumCulled = false
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const prop = node.left.name.text;
      const target = node.left.expression;
      if (prop === 'needsUpdate' && node.right.kind === ts.SyntaxKind.TrueKeyword) {
        if (isA(target, 'Material')) accuse('material-needs-update', sf, node, fn);
        else if (isA(target, 'BufferAttribute', 'InterleavedBuffer', 'InterleavedBufferAttribute', 'InstancedBufferAttribute')) {
          // A buffer made in this same function goes up whole the first time: that is no re-upload.
          const madeHere = /new \w*(BufferAttribute|InstancedMesh|InterleavedBuffer)\b|\.setAttribute\(/.test(body);
          if (!body.includes('addUpdateRange') && !madeHere) accuse('whole-buffer', sf, node, fn);
          if (/position/i.test(target.getText(sf)) && !/computeBounding(Sphere|Box)/.test(body)) accuse('position-without-bounds', sf, node, fn);
        }
      }
      if (prop === 'frustumCulled' && node.right.kind === ts.SyntaxKind.FalseKeyword) accuse('culling-off', sf, node, fn);
      if (prop === 'uniformsNeedUpdate' && node.right.kind === ts.SyntaxKind.TrueKeyword && isA(target, 'ShaderMaterial')) accuse('redundant-uniforms', sf, node, fn);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const recv = node.expression.expression;
      if ((name === 'setAttribute' || name === 'setIndex') && ts.isPropertyAccessExpression(recv) && recv.name.text === 'geometry' && isA(recv, 'BufferGeometry')) accuse('geometry-swapped', sf, node, fn);
      if ((name === 'remove' || name === 'clear') && isA(recv, 'Object3D') && !body.includes('.dispose(')) accuse('remove-without-dispose', sf, node, fn);
      if (name === 'readPixels' || name === 'readRenderTargetPixels') accuse('gpu-readback', sf, node, fn);
      if (name === 'getImageData' && !fileText.includes('willReadFrequently')) accuse('gpu-readback', sf, node, fn, 'no willReadFrequently in the file');
    }

    // new Float32BufferAttribute(aTypedArray): the typed subclasses copy what they are given
    if (ts.isNewExpression(node) && /^(Float32|Float16|Uint32|Int32|Uint16|Int16|Uint8|Int8|Uint8Clamped)BufferAttribute$/.test(node.expression.getText(sf))
      && node.arguments?.[0] && /^(Float32|Float64|Uint32|Int32|Uint16|Int16|Uint8|Int8|Uint8Clamped)Array$/.test(checker.typeToString(checker.getTypeAtLocation(node.arguments[0])).replace(/<.*$/, ''))) {
      accuse('typed-copy', sf, node, fn);
    }

    // new Material / Texture / render target inside a loop (geometry built piece by piece to be merged is ordinary)
    if (ts.isNewExpression(node) && loopsHere > 0 && isA(node, 'Material', 'Texture', 'WebGLRenderTarget', 'RenderTarget')) accuse('created-in-loop', sf, node, fn);

    // JSON.stringify(a) === JSON.stringify(b)
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)
      && [node.left, node.right].some((s) => ts.isCallExpression(s) && s.expression.getText(sf) === 'JSON.stringify')) accuse('compare-json', sf, node, fn);

    // `${doc.revision}` as a key
    if (ts.isTemplateExpression(node) && node.templateSpans.some((s) => ts.isPropertyAccessExpression(s.expression) && s.expression.name.text === 'revision')) accuse('global-revision-key', sf, node, fn);

    // @deprecated APIs of the installed libraries (three's types, the DOM).
    if (ts.isPropertyAccessExpression(node) || ts.isNewExpression(node) || (ts.isIdentifier(node) && ts.isImportSpecifier(node.parent ?? {}))) {
      const at = ts.isPropertyAccessExpression(node) ? node.name : ts.isNewExpression(node) ? node.expression : node;
      const sym = resolved(checker.getSymbolAtLocation(at));
      const decls = sym?.declarations ?? [];
      const fromLib = decls.length > 0 && decls.every((d) => d.getSourceFile().fileName.includes('node_modules'));
      const deprecatedDecl = (d) => ts.getJSDocTags(d).find((t) => t.tagName.text === 'deprecated');
      const call = ts.isCallExpression(node.parent ?? {}) && node.parent.expression === node ? node.parent : ts.isNewExpression(node) ? node : null;
      let tag = null;
      if (fromLib && call) {
        const decl = checker.getResolvedSignature(call)?.getDeclaration?.();
        tag = decl ? deprecatedDecl(decl) : null;
      } else if (fromLib && decls.every((d) => deprecatedDecl(d))) tag = deprecatedDecl(decls[0]);
      if (tag) accuse('deprecated-api', sf, node, fn, `${sym.getName()}: ${String(ts.getTextOfJSDocComment(tag.comment) ?? '').slice(0, 120) || 'deprecated'}`);
    }

    // Only a loop's body runs per turn: what `for (const b of x.all())` iterates is read once.
    const loopBody = ts.isIterationStatement(node, false) ? node.statement : null;
    ts.forEachChild(node, (c) => visit(c, fn, body, loopBody && c !== loopBody ? loops : loopsHere));
  };
  ts.forEachChild(sf, (c) => visit(c, null, fileText, 0));
}

// what check-code already holds
const baselinePath = join(root, 'scripts/baselines/code-rules.baseline.json');
if (existsSync(baselinePath)) {
  for (const [key, count] of Object.entries(JSON.parse(readFileSync(baselinePath, 'utf8')))) {
    const [rule, place, what] = key.split(/ {2,}/);
    const [file, fn] = (place ?? '').split(' ');
    if (onlyFile && !String(file).includes(onlyFile)) continue;
    findings.push({ rule: 'check-code', file, line: 0, function: fn ?? '', code: `${rule}: ${what}${count > 1 ? ` (×${count})` : ''}`, extra: '' });
  }
}

// ------------------------------------------------------------ report
const chosen = findings.filter((f) => !onlyRule || f.rule === onlyRule);
if (asJson) {
  console.log(JSON.stringify({ rules: RULES, accusations: chosen, markedRight: silenced }, null, 2));
  process.exit(0);
}
const lines = ['# Accusations (leads to read, not proofs)', '',
  `Already read and marked right in the code (\`// accuse-ok <rule>: reason\`): ${silenced.length}.`, ''];
const byRule = Object.keys(RULES).map((id) => [id, chosen.filter((f) => f.rule === id)]).filter(([, l]) => l.length);
lines.push('| rule | count |', '|---|---|', ...byRule.map(([id, l]) => `| ${id} | ${l.length} |`), '');
for (const [id, list] of byRule) {
  const r = RULES[id];
  lines.push(`## ${id}: ${r.title} (${list.length})`, '', r.why);
  if (r.source?.excerpt) lines.push(`Source: "${r.source.excerpt}" — ${r.checked}`);
  else lines.push(`Source: ${r.checked}`);
  lines.push('');
  for (const f of showAll ? list : list.slice(0, SHOWN)) lines.push(`- ${f.file}${f.line ? `:${f.line}` : ''} ${f.function} — \`${f.code}\`${f.extra ? ` (${f.extra})` : ''}`);
  if (!showAll && list.length > SHOWN) lines.push(`- … and ${list.length - SHOWN} more (use --all or --rule ${id})`);
  lines.push('');
}
const out = join(tmpdir(), 'roadcraft-accusations.md');
writeFileSync(out, lines.join('\n'));
console.log(lines.join('\n'));
console.log(`\nreport: ${out}`);
