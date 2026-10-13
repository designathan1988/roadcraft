// THE CODE RULES NO LINT RULE CAN SEE, in seconds (docs/research/regression-barrier.md).
//
// One TypeScript program does the type check `tsc --noEmit` did (the same
// diagnostics) and, with the same checker, a call graph of `src/` from the
// functions that run every frame (JSDoc `@perFrame`). As Clang's function
// effect analysis does for `nonblocking` (clang.llvm.org/docs/FunctionEffectAnalysis.html),
// a call is followed into every body the checker can name; a call through an
// interface goes to every implementation the checker can tie to it, and one it
// cannot tie goes, by its name, to every method so named (the field-based call
// graph of Feldthaus et al., ICSE 2013), filtered by the receiver's type. A
// function marked `@rebuild` does its work only when what it reads changed (an
// edit, a load) or once; called any other time it returns at its first check.
// The per-frame rules stop at it, the rules for everything a frame reaches do
// not. The marks are claims the analysis trusts, as Clang trusts `blocking`.
//
// Rules:
//   material-in-frame      a three.js material made in anything a frame reaches (the closed catalogue, made at load)
//   compile-in-frame       a shader compile in anything a frame reaches (all compiled at load)
//   heavy-call-per-frame   JSON, structuredClone, a bounding volume computed, in per-frame code
//   whole-map-per-frame    a loop over a collection as big as the map, in per-frame code
//   window-key-listener    a key listener on the window or the document outside `main.ts` (one keyboard listener)
//
// What is already there is listed in `code-rules.baseline.json`, which only
// shrinks: the check fails on anything not in it and on any entry fixed.
// node scripts/check-code.mjs [--update] [--why "<entry>"] [--project <dir> --list]
// (`--project` and `--list`: another project, its findings printed as JSON; the
// rules' own test, `tests/arch/checkCode.spec.ts`.)
import ts from 'typescript';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';

const projectAt = process.argv.indexOf('--project');
const root = projectAt >= 0 ? resolve(process.argv[projectAt + 1]) : process.cwd();
const BASELINE = join(root, 'code-rules.baseline.json');
const rel = (file) => relative(root, file).split(sep).join('/');
const started = performance.now();

// ------------------------------------------------------------ the type check
const configPath = ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => { console.error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); process.exit(2); },
});
const program = ts.createProgram({
  rootNames: parsed.fileNames,
  options: parsed.options,
  projectReferences: parsed.projectReferences,
  configFileParsingDiagnostics: ts.getConfigFileParsingDiagnostics(parsed),
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => root,
    getNewLine: () => ts.sys.newLine,
  }));
  console.error(`tipos: ${diagnostics.length} erro(s)`);
  process.exit(1);
}
const typed = performance.now();
const checker = program.getTypeChecker();

// ------------------------------------------------------------ the functions
const sources = program.getSourceFiles().filter((f) => !f.isDeclarationFile && rel(f.fileName).startsWith('src/'));
const inSrc = (node) => rel(node.getSourceFile().fileName).startsWith('src/');
const fromThree = (node) => /node_modules[\\/](three|@types[\\/]three)[\\/]/.test(node.getSourceFile().fileName);

const isFunction = (n) => (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n)
  || ts.isArrowFunction(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
  || ts.isConstructorDeclaration(n)) && n.body !== undefined;
const skipParens = (n) => { while (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)) n = n.expression; return n; };
const tagged = (node, tag) => ts.getJSDocTags(node).some((t) => t.tagName.text === tag)
  || (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent)
    && ts.getJSDocTags(node.parent.parent.parent).some((t) => t.tagName.text === tag);

const symbolOf = (node) => {
  let s = checker.getSymbolAtLocation(node);
  if (s && s.flags & ts.SymbolFlags.Alias) s = checker.getAliasedSymbol(s);
  return s;
};

/** A unit's name: stable across edits elsewhere in its file (no line numbers). */
const names = new Map();
function nameOf(unit) {
  const known = names.get(unit);
  if (known) return known;
  const file = rel(unit.getSourceFile().fileName);
  const owner = (n) => {
    for (let p = n.parent; p; p = p.parent) if (ts.isClassLike(p)) return p.name ? `${p.name.text}.` : '';
    return '';
  };
  let name;
  if (ts.isClassLike(unit)) name = `${unit.name?.text ?? '(class)'}.(fields)`;
  else if (ts.isConstructorDeclaration(unit)) name = `${owner(unit)}constructor`;
  else if (unit.name && (ts.isIdentifier(unit.name) || ts.isStringLiteral(unit.name))) name = `${owner(unit)}${unit.name.text}`;
  else if (ts.isVariableDeclaration(unit.parent) && ts.isIdentifier(unit.parent.name)) name = unit.parent.name.text;
  else if ((ts.isPropertyAssignment(unit.parent) || ts.isPropertyDeclaration(unit.parent)) && ts.isIdentifier(unit.parent.name)) name = `${owner(unit.parent)}${unit.parent.name.text}`;
  else if (ts.isBinaryExpression(unit.parent) && ts.isPropertyAccessExpression(unit.parent.left)) name = `${unit.parent.left.name.text}=`;
  else {
    // Named by the call it is given to (`draw/λbuildTransit`), numbered only
    // among those given to a call of the same name: an arrow added or taken
    // elsewhere in the function does not rename it.
    let outer = unit.parent;
    while (outer && !isFunction(outer) && !ts.isSourceFile(outer)) outer = outer.parent;
    const base = outer && !ts.isSourceFile(outer) ? nameOf(outer).split(' ')[1] : '(module)';
    const label = (fn) => {
      const call = fn.parent;
      if (!call || !(ts.isCallExpression(call) || ts.isNewExpression(call))) return '';
      const callee = skipParens(call.expression);
      return ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
    };
    const mine = label(unit);
    const siblings = [];
    const collect = (n) => {
      if (isFunction(n) && n !== outer) { if (!n.name && label(n) === mine) siblings.push(n); return; }
      ts.forEachChild(n, collect);
    };
    if (outer) ts.forEachChild(outer, collect);
    const at = siblings.indexOf(unit);
    name = `${base}/λ${mine}${at > 0 ? at + 1 : ''}`;
  }
  const full = `${file} ${name}`;
  names.set(unit, full);
  return full;
}

// Implementations: what a call through an interface, a base class or a stored
// callback can run, keyed by the DECLARATION it is called through.
const implementations = new Map();
const implement = (declarations, unit) => {
  for (const d of declarations ?? []) {
    const list = implementations.get(d);
    if (list) list.push(unit); else implementations.set(d, [unit]);
  }
};
// And by member name with the object or class that holds it, for a call the
// checker cannot tie: kept only where that holder's type is assignable to the
// receiver's (class hierarchy analysis, Dean, Grove and Chambers, ECOOP 1995,
// with TypeScript's structural assignability in place of subclassing).
const byName = new Map();
const nameUnit = (name, unit, holder) => { const list = byName.get(name); const entry = { unit, holder }; if (list) list.push(entry); else byName.set(name, [entry]); };
const holderTypes = new Map();
const assignable = new Map();
function holdsFor(holder, receiver) {
  let type = holderTypes.get(holder);
  if (!type) holderTypes.set(holder, type = checker.getTypeAtLocation(holder));
  let byReceiver = assignable.get(holder);
  if (!byReceiver) assignable.set(holder, byReceiver = new Map());
  let ok = byReceiver.get(receiver);
  if (ok === undefined) byReceiver.set(receiver, ok = typesOf(receiver).some((r) => checker.isTypeAssignableTo(type, r)));
  return ok;
}

function unitsOfValue(expr, seen = new Set()) {
  const e = skipParens(expr);
  if (isFunction(e)) return [e];
  if (ts.isIdentifier(e) || ts.isPropertyAccessExpression(e)) {
    const s = symbolOf(ts.isPropertyAccessExpression(e) ? e.name : e);
    return s ? unitsOfSymbol(s, seen) : [];
  }
  return [];
}

function unitsOfSymbol(symbol, seen = new Set()) {
  if (seen.has(symbol)) return [];
  seen.add(symbol);
  const out = [];
  for (const d of symbol.declarations ?? []) {
    if (isFunction(d)) out.push(d);
    else if ((ts.isVariableDeclaration(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d)) && d.initializer) out.push(...unitsOfValue(d.initializer, seen));
    else if (ts.isShorthandPropertyAssignment(d)) {
      const value = checker.getShorthandAssignmentValueSymbol(d);
      if (value) out.push(...unitsOfSymbol(value, seen));
    }
    for (const unit of implementations.get(d) ?? []) out.push(unit);
  }
  return out;
}

function typesOf(type) {
  return type.isUnionOrIntersection() ? type.types : [type];
}

function indexMember(memberName, unit, container) {
  nameUnit(memberName, unit, container);
  if (ts.isObjectLiteralExpression(container)) {
    const contextual = checker.getContextualType(container);
    if (contextual) for (const t of typesOf(contextual)) implement(t.getProperty(memberName)?.declarations, unit);
  } else if (ts.isClassLike(container)) {
    const own = checker.getTypeAtLocation(container);
    const bases = [];
    // The clause itself (`extends Base`, `implements Shape`) is the instance type; its expression is the constructor.
    for (const clause of container.heritageClauses ?? []) for (const t of clause.types) bases.push(checker.getTypeAtLocation(t));
    const queue = [...bases, ...(own.isClassOrInterface() ? checker.getBaseTypes(own) : [])];
    for (let i = 0; i < queue.length; i++) {
      const base = queue[i];
      implement(base.getProperty(memberName)?.declarations, unit);
      if (base.isClassOrInterface()) queue.push(...checker.getBaseTypes(base));
    }
  }
}

const units = [];
const unitSet = new Set();
/** Key listeners on the window or the document: [file, what]. */
const keyListeners = [];
for (const file of sources) {
  const visit = (n) => {
    if (isFunction(n)) units.push(n);
    if (ts.isClassLike(n) && n.members.some((m) => ts.isPropertyDeclaration(m) && m.initializer && !ts.getModifiers(m)?.some((x) => x.kind === ts.SyntaxKind.StaticKeyword))) units.push(n);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'addEventListener'
      && n.arguments[0] && ts.isStringLiteral(n.arguments[0]) && /^key(down|up|press)$/.test(n.arguments[0].text)) {
      const target = skipParens(n.expression.expression);
      if (ts.isIdentifier(target) && (target.text === 'window' || target.text === 'document')) keyListeners.push([n, `${target.text} ${n.arguments[0].text}`]);
    }
    // Members: methods, accessors and function-valued properties of classes and object literals.
    if ((ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) && n.body && n.name && ts.isIdentifier(n.name)) indexMember(n.name.text, n, n.parent);
    if ((ts.isPropertyAssignment(n) || ts.isPropertyDeclaration(n)) && n.initializer && ts.isIdentifier(n.name)) {
      for (const unit of unitsOfValue(n.initializer)) indexMember(n.name.text, unit, n.parent);
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      const value = checker.getShorthandAssignmentValueSymbol(n);
      if (value) for (const unit of unitsOfSymbol(value)) indexMember(n.name.text, unit, n.parent);
    }
    // A callback stored: `obj.onX = fn` runs where `obj.onX()` is called.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left)) {
      const target = symbolOf(n.left.name);
      for (const unit of unitsOfValue(n.right)) if (target) implement(target.declarations, unit);
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
}
for (const u of units) unitSet.add(u);

// ------------------------------------------------------------ what a unit does
/** Calls whose callbacks run later, not inside the call. */
const DEFERRING = new Set(['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask',
  'addEventListener', 'then', 'catch', 'finally']);
/** Members of these classes are as big as the map ('*': every collection member). */
const MAP_WIDE = { RoadDoc: '*', Network: '*', LaneletGraph: '*', SidewalkGraph: '*', BuildingStore: ['all'], SimWorld: ['controllers'] };
const COLLECTION = /^(Readonly)?(Map|Set|Array)<|\[\]$|^readonly .*\[\]$|IterableIterator</;
const ITERATING = new Set(['forEach', 'map', 'filter', 'some', 'every', 'reduce', 'reduceRight', 'find', 'findIndex', 'findLast',
  'findLastIndex', 'flatMap', 'indexOf', 'lastIndexOf', 'includes', 'join', 'sort', 'slice', 'toSorted']);
const HEAVY = new Set(['JSON.parse', 'JSON.stringify', 'structuredClone']);
const BOUNDS = new Set(['computeBoundingSphere', 'computeBoundingBox']);

/** The member a collection expression reads, when that member is as big as the map: `Class.member`. */
function mapWide(expr) {
  let e = skipParens(expr);
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const method = e.expression.name.text;
    if (method === 'values' || method === 'keys' || method === 'entries') e = skipParens(e.expression.expression);
    else if (e.arguments.length === 0) {
      const named = memberOf(e.expression);
      return named && named.list !== '*' && named.list.includes(named.member) ? named.label : null;
    }
  }
  if (!ts.isPropertyAccessExpression(e)) return null;
  const named = memberOf(e);
  if (!named) return null;
  if (named.list === '*') {
    const type = checker.typeToString(checker.getTypeAtLocation(e));
    return COLLECTION.test(type) ? named.label : null;
  }
  return named.list.includes(named.member) ? named.label : null;
}

function memberOf(access) {
  const s = symbolOf(access.name);
  for (const d of s?.declarations ?? []) {
    const owner = d.parent;
    if (owner && ts.isClassLike(owner) && owner.name && MAP_WIDE[owner.name.text] && inSrc(owner)) {
      return { list: MAP_WIDE[owner.name.text], member: access.name.text, label: `${owner.name.text}.${access.name.text}` };
    }
  }
  return null;
}

function isThreeMaterial(type, depth = 0) {
  if (!type || depth > 8) return false;
  const s = type.getSymbol();
  if (s?.name === 'Material' && s.declarations?.some(fromThree)) return true;
  const target = type.target ?? type;
  return target.isClassOrInterface?.() ? checker.getBaseTypes(target).some((b) => isThreeMaterial(b, depth + 1)) : false;
}

/** The units a callee expression names, without noting anything (`runsNow`). */
function calleeUnits(callee) {
  const c = skipParens(callee);
  if (isFunction(c)) return [c];
  const nameNode = ts.isPropertyAccessExpression(c) ? c.name : ts.isIdentifier(c) ? c : null;
  const s = nameNode && symbolOf(nameNode);
  if (!s || (s.declarations ?? []).some((d) => !inSrc(d))) return [];
  return unitsOfSymbol(s);
}

/**
 * Whether the function given as argument `index` of `call` runs inside the
 * call. A library's runs when that parameter is declared a function
 * (`forEach(callbackfn: (…) => void)`, `sort`, `new Promise`), unless the
 * call is one of the deferring ones; `push(...items: T[])` keeps it. One of
 * ours runs it when its body calls that parameter, or hands it to a call that
 * does; a helper that only stores it (a button's click) does not.
 */
function runsNow(call, index, depth = 0) {
  const callee = skipParens(call.expression);
  const name = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : '';
  if (DEFERRING.has(name)) return false;
  const targets = calleeUnits(call.expression);
  if (!targets.length) {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    const params = declaration?.parameters ?? [];
    let type = params[Math.min(index, params.length - 1)]?.type;
    while (type && ts.isParenthesizedTypeNode(type)) type = type.type;
    if (!type) return false;
    return ts.isFunctionTypeNode(type) || (ts.isUnionTypeNode(type) && type.types.some((t) => ts.isFunctionTypeNode(t)));
  }
  return depth < 6 && targets.some((t) => invokesParameter(t, index, depth + 1));
}

const invoking = new Map();
function invokesParameter(unit, index, depth) {
  const key = `${index}`;
  let memo = invoking.get(unit);
  if (!memo) invoking.set(unit, memo = new Map());
  if (memo.has(key)) return memo.get(key);
  memo.set(key, false);
  const param = unit.parameters?.[index];
  if (!param || !ts.isIdentifier(param.name) || !unit.body) return false;
  const symbol = checker.getSymbolAtLocation(param.name);
  let calls = false;
  const visit = (n) => {
    if (calls) return;
    if (n !== unit && isFunction(n)) {
      const parent = n.parent;
      if (!(parent && ts.isCallExpression(parent) && parent.arguments.includes(n) && runsNow(parent, parent.arguments.indexOf(n), depth))) return;
    }
    if (ts.isCallExpression(n)) {
      const callee = skipParens(n.expression);
      if (ts.isIdentifier(callee) && checker.getSymbolAtLocation(callee) === symbol) { calls = true; return; }
      n.arguments.forEach((a, i) => {
        if (!calls && ts.isIdentifier(a) && checker.getSymbolAtLocation(a) === symbol && runsNow(n, i, depth)) calls = true;
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(unit.body);
  memo.set(key, calls);
  return calls;
}

/** Per unit: the units it runs, and what it does (the rules' raw facts). */
const facts = new Map();
let fieldBased = 0;
let unresolved = 0;
function factsOf(unit) {
  const known = facts.get(unit);
  if (known) return known;
  const calls = new Set();
  const does = [];
  const callTargets = (callee) => {
    const c = skipParens(callee);
    if (isFunction(c)) return [c];
    const nameNode = ts.isPropertyAccessExpression(c) ? c.name : ts.isIdentifier(c) ? c : null;
    if (!nameNode) return [];
    const s = symbolOf(nameNode);
    if (s && (s.declarations ?? []).some((d) => !inSrc(d))) {
      const qualified = checker.getFullyQualifiedName(s);
      if (HEAVY.has(qualified)) does.push({ kind: 'heavy', what: qualified });
      if (BOUNDS.has(s.name) && s.declarations.some(fromThree)) does.push({ kind: 'heavy', what: s.name });
      if ((s.name === 'compile' || s.name === 'compileAsync') && s.declarations.some(fromThree)) does.push({ kind: 'compile', what: s.name });
      return [];
    }
    const found = s ? unitsOfSymbol(s) : [];
    if (found.length) return found;
    // A function given as a parameter runs what its callers pass, and those
    // are followed where they are passed (`visit` below).
    if (!ts.isPropertyAccessExpression(c)) return [];
    // A member not tied by the checker (of an interface whose implementations
    // are returned without a declared type): the members so named on holders
    // the receiver's type admits.
    const receiver = checker.getNonNullableType(checker.getTypeAtLocation(c.expression));
    const byMember = (byName.get(nameNode.text) ?? []).filter((e) => holdsFor(e.holder, receiver)).map((e) => e.unit);
    if (byMember.length) fieldBased++;
    else unresolved++;
    return byMember;
  };
  const visit = (n) => {
    if (n !== unit && (isFunction(n) || ts.isClassLike(n))) {
      // A function given to a call that runs it now (`forEach`, `advance`): part of this unit.
      const call = n.parent;
      if (isFunction(n) && call && (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.arguments?.includes(n)
        && runsNow(call, call.arguments.indexOf(n))) calls.add(n);
      return;
    }
    if (ts.isCallExpression(n)) {
      for (const t of callTargets(n.expression)) calls.add(t);
      const callee = skipParens(n.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (ITERATING.has(method)) { const wide = mapWide(callee.expression); if (wide) does.push({ kind: 'loop', what: `${method} ${wide}` }); }
        if (method === 'from' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Array' && n.arguments[0]) {
          const wide = mapWide(n.arguments[0]);
          if (wide) does.push({ kind: 'loop', what: `Array.from ${wide}` });
        }
      }
    } else if (ts.isNewExpression(n)) {
      if (isThreeMaterial(checker.getTypeAtLocation(n))) does.push({ kind: 'material', what: `new ${n.expression.getText()}` });
      const s = symbolOf(n.expression);
      for (const d of s?.declarations ?? []) {
        if (!ts.isClassLike(d) || !inSrc(d)) continue;
        for (const m of d.members) if (ts.isConstructorDeclaration(m) && m.body) calls.add(m);
        if (unitSet.has(d)) calls.add(d);
      }
    } else if (ts.isPropertyAccessExpression(n) && !(ts.isCallExpression(n.parent) && n.parent.expression === n)) {
      // A getter read runs its body.
      const s = symbolOf(n.name);
      for (const d of s?.declarations ?? []) if (ts.isGetAccessorDeclaration(d) && d.body) calls.add(d);
    } else if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const wide = mapWide(n.expression);
      if (wide) does.push({ kind: 'loop', what: `for ${wide}` });
    } else if (ts.isSpreadElement(n)) {
      const wide = mapWide(n.expression);
      if (wide) does.push({ kind: 'loop', what: `spread ${wide}` });
    }
    ts.forEachChild(n, visit);
  };
  if (ts.isClassLike(unit)) {
    for (const m of unit.members) if (ts.isPropertyDeclaration(m) && m.initializer) visit(m.initializer);
  } else {
    for (const p of unit.parameters ?? []) if (p.initializer) visit(p.initializer);
    visit(unit.body);
  }
  const result = { calls: [...calls], does };
  facts.set(unit, result);
  return result;
}

// ------------------------------------------------------------ reach and rules
const roots = units.filter((u) => tagged(u, 'perFrame'));
if (!roots.length) { console.error('código: nenhuma função @perFrame achada'); process.exit(2); }

function reach(stopAtRebuild) {
  const parent = new Map(roots.map((r) => [r, null]));
  const queue = [...roots];
  for (let i = 0; i < queue.length; i++) {
    for (const next of factsOf(queue[i]).calls) {
      if (parent.has(next) || (stopAtRebuild && tagged(next, 'rebuild'))) continue;
      parent.set(next, queue[i]);
      queue.push(next);
    }
  }
  return parent;
}
const perFrame = reach(true);
const inFrame = reach(false);

const pathTo = (reached, unit) => {
  const path = [];
  for (let u = unit; u; u = reached.get(u)) path.unshift(nameOf(u).split(' ')[1]);
  return path.join(' → ');
};

/** Each finding: how many times its function does it, and a way a frame reaches that function. */
const found = new Map();
const note = (rule, unit, what, reached) => {
  const key = `${rule}  ${nameOf(unit)}  ${what}`;
  const known = found.get(key);
  if (known) known.count++;
  else found.set(key, { count: 1, path: reached ? pathTo(reached, unit) : nameOf(unit) });
};
for (const unit of inFrame.keys()) {
  for (const d of factsOf(unit).does) {
    if (d.kind === 'material') note('material-in-frame', unit, d.what, inFrame);
    if (d.kind === 'compile') note('compile-in-frame', unit, d.what, inFrame);
  }
}
for (const unit of perFrame.keys()) {
  for (const d of factsOf(unit).does) {
    if (d.kind === 'heavy') note('heavy-call-per-frame', unit, d.what, perFrame);
    if (d.kind === 'loop') note('whole-map-per-frame', unit, d.what, perFrame);
  }
}
for (const [call, what] of keyListeners) {
  if (rel(call.getSourceFile().fileName) === 'src/main.ts') continue;
  let unit = call.parent;
  while (unit && !unitSet.has(unit) && !ts.isSourceFile(unit)) unit = unit.parent;
  const key = `window-key-listener  ${ts.isSourceFile(unit) ? `${rel(unit.fileName)} (module)` : nameOf(unit)}  ${what}`;
  const known = found.get(key);
  if (known) known.count++;
  else found.set(key, { count: 1, path: key });
}

// ------------------------------------------------------------ the verdict
const issues = Object.fromEntries([...found.keys()].sort().map((key) => [key, found.get(key).count]));
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(issues));
  process.exit(0);
}
const why = process.argv.indexOf('--why');
if (why >= 0) {
  for (const key of Object.keys(issues)) if (key.includes(process.argv[why + 1] ?? '')) console.log(`${key}  ×${issues[key]}\n    ${found.get(key).path}`);
  process.exit(0);
}
const total = (list) => Object.values(list).reduce((a, b) => a + b, 0);
const stats = `${units.length} funções, ${perFrame.size} por quadro, ${inFrame.size} alcançadas do quadro, ${fieldBased} chamadas ligadas pelo tipo do receptor, ${unresolved} sem alvo no código; tipos ${((typed - started) / 1000).toFixed(1)} s, regras ${((performance.now() - typed) / 1000).toFixed(1)} s`;
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {};
const added = Object.keys(issues).filter((key) => issues[key] > (baseline[key] ?? 0));
const gone = Object.keys(baseline).filter((key) => (issues[key] ?? 0) < baseline[key]);
if (process.argv.includes('--update')) {
  if (added.length && existsSync(BASELINE)) {
    for (const key of added) console.error(`novo: ${key}  ×${issues[key]}\n    ${found.get(key).path}`);
    console.error(`código: ${added.length} achados novos; a linha de base só diminui.`);
    process.exit(1);
  }
  writeFileSync(BASELINE, JSON.stringify(issues, null, 1) + '\n');
  console.log(`código: linha de base com ${total(issues)} ocorrências em ${Object.keys(issues).length} itens (${stats})`);
  process.exit(0);
}
for (const key of added) console.error(`novo: ${key}  ×${issues[key]} (linha de base ${baseline[key] ?? 0})\n    ${found.get(key).path}`);
if (gone.length) console.error(`código: ${gone.length} itens da linha de base resolvidos ou reduzidos; atualize (node scripts/check-code.mjs --update):\n${gone.join('\n')}`);
console.log(`código: ${added.length} novos, linha de base ${total(baseline)} ocorrências (${stats})`);
process.exit(added.length || gone.length ? 1 : 0);
