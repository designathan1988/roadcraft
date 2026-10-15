// @deprecated THE ACCUSER: points at code to look at, never blocks anything.
import ts from 'typescript';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; };
const root = arg('--projeto') ? resolve(arg('--projeto')) : process.cwd();
/** The project's own files, for the rules sourced in it (CLAUDE.md); the game's when another project is read. */
const game = process.cwd();
const REF = 'C:/Codex-Shared/referencia/threejs';
const onlyRule = arg('--regra');
const onlyFile = arg('--arquivo');
const showAll = process.argv.includes('--todas');
const asJson = process.argv.includes('--json');
/** Shown per rule unless --todas: the rest are counted, and all are in the file report. */
const SHOWN = 25;

const RULES = {
  'material-needs-update': {
    titulo: 'material.needsUpdate = true (recompila o shader)',
    porque: 'Trocar o que exige outro programa de shader recompila o material; em jogo isso dá tranco.',
    fonte: { arquivo: 'repo-r186/manual/pages/how-to-update-things.html', trecho: 'Bear in mind this might be quite slow and induce jerkiness in framerate' },
  },
  'buffer-inteiro': {
    titulo: 'atributo inteiro reenviado à GPU (needsUpdate sem addUpdateRange)',
    porque: 'Sem faixa, o buffer inteiro sobe de novo; com addUpdateRange, só o trecho mudado.',
    fonte: { arquivo: 'docs/BufferAttribute.html.md', trecho: 'This can be used to only update some components of stored vectors' },
  },
  'geometria-trocada': {
    titulo: 'setAttribute/setIndex numa geometria já em uso (buffer redimensionado)',
    porque: 'Trocar o atributo de uma geometria desenhada equivale a criar uma geometria nova.',
    fonte: { arquivo: 'repo-r186/manual/pages/how-to-update-things.html', trecho: 'you cannot resize buffers (this is very costly' },
  },
  'posicao-sem-volume': {
    titulo: 'posições mudadas sem recalcular o volume envolvente',
    porque: 'Com o volume velho, o recorte de visibilidade some com o objeto ou o desenha à toa (defeito de imagem).',
    fonte: { arquivo: 'repo-r186/manual/pages/how-to-update-things.html', trecho: 'you may need to recompute bounding volumes so other features of the engine like view frustum culling' },
  },
  'remove-sem-dispose': {
    titulo: 'objeto tirado da cena sem dispose na mesma função',
    porque: 'Remover da cena não libera geometria, material nem textura da GPU. Confira se outra função descarta.',
    fonte: { arquivo: 'repo-r186/manual/pages/how-to-dispose-of-objects.html', trecho: 'No, you have to explicitly dispose the geometry and material' },
  },
  'leitura-da-gpu': {
    titulo: 'leitura síncrona da GPU (readPixels, readRenderTargetPixels, getImageData)',
    porque: 'A página espera a GPU terminar. Há readRenderTargetPixelsAsync; canvas lido com frequência pede willReadFrequently.',
    fonte: { arquivo: 'docs/WebGLRenderer.html.md', trecho: 'readRenderTargetPixelsAsync' },
  },
  'criado-em-laco': {
    titulo: 'material, geometria, textura ou alvo de render criado dentro de laço',
    porque: 'Cada um aloca recursos na GPU que só saem com dispose. Num catálogo montado uma vez na carga é normal; numa reconstrução, não.',
    fonte: { arquivo: 'repo-r186/manual/pages/how-to-dispose-of-objects.html', trecho: 'these objects are not released automatically' },
  },
  'recorte-desligado': {
    titulo: 'frustumCulled = false (desenhado mesmo fora da vista)',
    porque: 'O objeto vai para a GPU em todo quadro, visível ou não. Às vezes é certo (céu, instâncias com volume próprio).',
    fonte: { arquivo: 'docs/Object3D.html.md', trecho: 'frustumCulled' },
  },
  'uniforms-redundante': {
    titulo: 'uniformsNeedUpdate = true (os uniforms já sobem a cada quadro)',
    porque: 'Mudar o valor do uniform basta; marcar a flag força trabalho a mais no envio.',
    fonte: { arquivo: 'repo-r186/manual/pages/how-to-update-things.html', trecho: 'values are sent to the shader every frame' },
  },
  'api-obsoleta': {
    titulo: 'API marcada @deprecated nos tipos instalados',
    porque: 'Vai sumir numa versão próxima; costuma ter substituta mais rápida ou correta.',
    fonte: null,
  },
  'copia-tipada': {
    titulo: 'new Float32BufferAttribute(array tipado) e irmãos (o three copia o array)',
    porque: 'O construtor faz new Float32Array(array): um array tipado recém-feito é copiado inteiro. Use new BufferAttribute(array, n), que guarda o próprio array (215 ms a cada 20 s de caminhada na montagem das cascas, auditoria 2026-10-14).',
    fonte: { arquivo: 'repo-r186/src/core/BufferAttribute.js', trecho: 'super( new Float32Array( array ), itemSize, normalized );' },
  },
  'compara-json': {
    titulo: 'comparação por JSON.stringify',
    porque: 'Serializa tudo para comparar; compare o que o diário diz que mudou.',
    fonte: { projeto: 'CLAUDE.md', trecho: 'Comparing by JSON' },
  },
  'chave-revisao-global': {
    titulo: 'chave de cache com revisão global (`${...revision}`)',
    porque: 'Qualquer mudança invalida tudo; a chave deveria ser o que a saída lê.',
    fonte: { projeto: 'CLAUDE.md', trecho: 'cache key with a global revision' },
  },
  'check-code': {
    titulo: 'já acusado pelas regras do check-code (linha de base)',
    porque: 'Ocorrências conhecidas que só podem diminuir (scripts/check-code.mjs), entre elas o mapa varrido dentro de laço sobre o mapa (whole-map-nested), seguido pelas chamadas.',
    fonte: { projeto: 'scripts/baselines/code-rules.baseline.json', trecho: '' },
  },
};

// ------------------------------------------------------------ sources checked
const squash = (s) => s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
for (const rule of Object.values(RULES)) {
  if (!rule.fonte) { rule.conferida = 'tipos instalados (@types/three)'; continue; }
  const path = rule.fonte.projeto ? join(game, rule.fonte.projeto) : join(REF, rule.fonte.arquivo);
  const text = existsSync(path) ? squash(readFileSync(path, 'utf8')) : null;
  rule.conferida = text === null ? 'FONTE NÃO ENCONTRADA' : text.includes(squash(rule.fonte.trecho)) ? `${rule.fonte.projeto ?? `referencia/threejs/${rule.fonte.arquivo}`}` : 'TRECHO NÃO ACHADO NA FONTE';
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
const OK = /acusar-ok\s+([\w-]+)\s*:\s*\S/;
const silenced = [];
const accuse = (id, sf, node, fn, extra = '') => {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = sf.text.split('\n');
  const code = lines[line]?.trim().slice(0, 140) ?? '';
  const where = { regra: id, arquivo: rel(sf.fileName), linha: line + 1, funcao: fn ?? '(topo)', codigo: code, extra };
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
          if (!body.includes('addUpdateRange') && !madeHere) accuse('buffer-inteiro', sf, node, fn);
          if (/position/i.test(target.getText(sf)) && !/computeBounding(Sphere|Box)/.test(body)) accuse('posicao-sem-volume', sf, node, fn);
        }
      }
      if (prop === 'frustumCulled' && node.right.kind === ts.SyntaxKind.FalseKeyword) accuse('recorte-desligado', sf, node, fn);
      if (prop === 'uniformsNeedUpdate' && node.right.kind === ts.SyntaxKind.TrueKeyword && isA(target, 'ShaderMaterial')) accuse('uniforms-redundante', sf, node, fn);
    }

    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const name = node.expression.name.text;
      const recv = node.expression.expression;
      if ((name === 'setAttribute' || name === 'setIndex') && ts.isPropertyAccessExpression(recv) && recv.name.text === 'geometry' && isA(recv, 'BufferGeometry')) accuse('geometria-trocada', sf, node, fn);
      if ((name === 'remove' || name === 'clear') && isA(recv, 'Object3D') && !body.includes('.dispose(')) accuse('remove-sem-dispose', sf, node, fn);
      if (name === 'readPixels' || name === 'readRenderTargetPixels') accuse('leitura-da-gpu', sf, node, fn);
      if (name === 'getImageData' && !fileText.includes('willReadFrequently')) accuse('leitura-da-gpu', sf, node, fn, 'sem willReadFrequently no arquivo');
    }

    // new Float32BufferAttribute(aTypedArray): the typed subclasses copy what they are given
    if (ts.isNewExpression(node) && /^(Float32|Float16|Uint32|Int32|Uint16|Int16|Uint8|Int8|Uint8Clamped)BufferAttribute$/.test(node.expression.getText(sf))
      && node.arguments?.[0] && /^(Float32|Float64|Uint32|Int32|Uint16|Int16|Uint8|Int8|Uint8Clamped)Array$/.test(checker.typeToString(checker.getTypeAtLocation(node.arguments[0])).replace(/<.*$/, ''))) {
      accuse('copia-tipada', sf, node, fn);
    }

    // new Material / Texture / render target inside a loop (geometry built piece by piece to be merged is ordinary)
    if (ts.isNewExpression(node) && loopsHere > 0 && isA(node, 'Material', 'Texture', 'WebGLRenderTarget', 'RenderTarget')) accuse('criado-em-laco', sf, node, fn);

    // JSON.stringify(a) === JSON.stringify(b)
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)
      && [node.left, node.right].some((s) => ts.isCallExpression(s) && s.expression.getText(sf) === 'JSON.stringify')) accuse('compara-json', sf, node, fn);

    // `${doc.revision}` as a key
    if (ts.isTemplateExpression(node) && node.templateSpans.some((s) => ts.isPropertyAccessExpression(s.expression) && s.expression.name.text === 'revision')) accuse('chave-revisao-global', sf, node, fn);

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
      if (tag) accuse('api-obsoleta', sf, node, fn, `${sym.getName()}: ${String(ts.getTextOfJSDocComment(tag.comment) ?? '').slice(0, 120) || 'obsoleta'}`);
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
    findings.push({ regra: 'check-code', arquivo: file, linha: 0, funcao: fn ?? '', codigo: `${rule}: ${what}${count > 1 ? ` (×${count})` : ''}`, extra: '' });
  }
}

// ------------------------------------------------------------ report
const chosen = findings.filter((f) => !onlyRule || f.regra === onlyRule);
if (asJson) {
  console.log(JSON.stringify({ regras: RULES, acusacoes: chosen, conferidas: silenced }, null, 2));
  process.exit(0);
}
const lines = ['# Acusações (pistas para ler, não provas)', '',
  `Já lidas e marcadas certas no código (\`// acusar-ok <regra>: motivo\`): ${silenced.length}.`, ''];
const byRule = Object.keys(RULES).map((id) => [id, chosen.filter((f) => f.regra === id)]).filter(([, l]) => l.length);
lines.push('| regra | quantas |', '|---|---|', ...byRule.map(([id, l]) => `| ${id} | ${l.length} |`), '');
for (const [id, list] of byRule) {
  const r = RULES[id];
  lines.push(`## ${id}: ${r.titulo} (${list.length})`, '', r.porque);
  if (r.fonte?.trecho) lines.push(`Fonte: "${r.fonte.trecho}" — ${r.conferida}`);
  else lines.push(`Fonte: ${r.conferida}`);
  lines.push('');
  for (const f of showAll ? list : list.slice(0, SHOWN)) lines.push(`- ${f.arquivo}${f.linha ? `:${f.linha}` : ''} ${f.funcao} — \`${f.codigo}\`${f.extra ? ` (${f.extra})` : ''}`);
  if (!showAll && list.length > SHOWN) lines.push(`- … e mais ${list.length - SHOWN} (use --todas ou --regra ${id})`);
  lines.push('');
}
const out = join(tmpdir(), 'roadcraft-acusacoes.md');
writeFileSync(out, lines.join('\n'));
console.log(lines.join('\n'));
console.log(`\nrelatório: ${out}`);
