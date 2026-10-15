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
//   whole-map-nested       a loop over a map-sized collection whose body - or anything it calls - loops over
//                          one again: the redundant traversal of CLARITY (Olivo, Dillig and Lin, PLDI 2015),
//                          O(map²) wherever it runs. A `@rebuild` callee is amortized and does not count.
//   whole-map-per-item     a loop over the map reached from a function marked `@perItem` (it runs once a
//                          building grown, a pole run, an edit of one thing): O(map) per item
//   whole-map-per-input    a loop over the map (any collection below) reached from a function marked
//                          `@perInput` (a pointer move, a hover, a snap, a click on one thing): O(map) per event
//   whole-map-on-revision  a loop over the map run because a GLOBAL revision moved (`if (x.revision !==
//                          this.for) { ... }`, `if (key === this.key) return;` with a key holding a revision):
//                          the whole map redone for any one change. Read the diary (`doc.changes.since`).
//                          `@rebuild` does not excuse it: it is the rebuild done the wrong way.
//   derived-map-per-frame, derived-map-nested, derived-map-per-item
//                          the three rules above, over the collections their lists did not see: a class
//                          field filled from the map (`this.walls = []` then `this.walls.push(...)` in a
//                          loop over the map, `this.kept = doc.lots.filter(...)`), followed as CLARITY's
//                          traversal footprint follows a data structure through fields and assignments;
//                          a local filled the same way; a member marked `@mapWide` (the simulation's
//                          vehicles and people, an index as big as the map). The old rules keep their
//                          own findings exactly; these are where the new ones are counted.
//
// What is already there is listed in `code-rules.baseline.json`, which only
// shrinks: the check fails on anything not in it and on any entry fixed.
// node scripts/check-code.mjs [--update [--seed <rule>,<rule>]] [--why "<entry>"] [--project <dir> --list]
// (`--seed <rule>`: a NEW rule's findings as they stand enter the baseline once; never for an old rule.)
// (`--project` and `--list`: another project, its findings printed as JSON; the
// rules' own test, `tests/arch/checkCode.spec.ts`.)
import ts from 'typescript';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { performance } from 'node:perf_hooks';
import { BASELINE, checker, fromThree, inSrc, isFunction, rel, skipParens, sources, started, symbolOf, tagged, typed } from './check-code/program.mjs';
import { byName, fits, holdsFor, keyListeners, nameOf, typesOf, unitSet, units, unitsOfSymbol } from './check-code/units.mjs';


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

/**
 * Locals holding a collection as big as the map (`const kept = doc.lots.filter(...)`,
 * `[...net.ribbons.values()]`): a loop over one is a loop over the map, as
 * CLARITY's traversal footprint follows a collection through assignments.
 */
const wideLocals = new Map();
/** Methods that hand back a collection of the receiver's size (or near it). */
const DERIVING = new Set(['filter', 'map', 'slice', 'sort', 'toSorted', 'concat', 'flatMap', 'reverse', 'values', 'keys', 'entries']);
function wideSource(expr) {
  const e = skipParens(expr);
  const direct = mapWide(e);
  if (direct) return direct;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const method = e.expression.name.text;
    if (DERIVING.has(method)) return wideSource(e.expression.expression);
    if (method === 'from' && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'Array' && e.arguments[0]) return wideSource(e.arguments[0]);
  }
  if (ts.isArrayLiteralExpression(e)) {
    for (const el of e.elements) if (ts.isSpreadElement(el)) { const w = wideSource(el.expression); if (w) return w; }
  }
  if (ts.isNewExpression(e) && e.arguments?.[0] && ts.isIdentifier(e.expression) && /^(Set|Map)$/.test(e.expression.text)) return wideSource(e.arguments[0]);
  return null;
}

/** The member a collection expression reads, when that member is as big as the map: `Class.member`. */
function mapWide(expr) {
  let e = skipParens(expr);
  if (ts.isIdentifier(e)) {
    const s = symbolOf(e);
    return s ? wideLocals.get(s) ?? null : null;
  }
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

/**
 * The collections the fixed list does not name, as big as the map: fields and
 * locals followed from it (`derivedWide`, filled below) and members marked
 * `@mapWide`. Symbol → label.
 */
const derivedWide = new Map();
const markedMemo = new Map();
function markedLabel(access) {
  const s = symbolOf(access.name);
  if (!s) return null;
  if (markedMemo.has(s)) return markedMemo.get(s);
  let label = null;
  for (const d of s.declarations ?? []) {
    if (!inSrc(d) || !ts.getJSDocTags(d).some((t) => t.tagName.text === 'mapWide')) continue;
    const owner = d.parent;
    const holder = owner && (ts.isClassLike(owner) || ts.isInterfaceDeclaration(owner)) && owner.name ? `${owner.name.text}.` : '';
    label = `${holder}${access.name.text}`;
    break;
  }
  markedMemo.set(s, label);
  return label;
}

/** What `mapWide` does not see: a followed field or local, a `@mapWide` member, one read through `values()`. */
function derivedOf(expr) {
  const e = skipParens(expr);
  if (ts.isIdentifier(e)) {
    const s = symbolOf(e);
    return s ? derivedWide.get(s) ?? null : null;
  }
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const method = e.expression.name.text;
    if (method === 'values' || method === 'keys' || method === 'entries') return wideOf(e.expression.expression)?.label ?? null;
    return e.arguments.length === 0 ? markedLabel(e.expression) : null;
  }
  if (!ts.isPropertyAccessExpression(e)) return null;
  const s = symbolOf(e.name);
  return (s && derivedWide.get(s)) ?? markedLabel(e);
}

/** A collection as big as the map, and whether only the new sources see it (`derived`). */
function wideOf(expr) {
  const fixed = mapWide(expr);
  if (fixed) return { label: fixed, derived: false };
  const label = derivedOf(expr);
  return label ? { label, derived: true } : null;
}

/** As `wideSource`, over every source. */
function wideSourceAny(expr) {
  const e = skipParens(expr);
  const direct = wideOf(e);
  if (direct) return direct.label;
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression)) {
    const method = e.expression.name.text;
    if (DERIVING.has(method)) return wideSourceAny(e.expression.expression);
    if (method === 'from' && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === 'Array' && e.arguments[0]) return wideSourceAny(e.arguments[0]);
  }
  if (ts.isArrayLiteralExpression(e)) {
    for (const el of e.elements) if (ts.isSpreadElement(el)) { const w = wideSourceAny(el.expression); if (w) return w; }
  }
  if (ts.isNewExpression(e) && e.arguments?.[0] && ts.isIdentifier(e.expression) && /^(Set|Map)$/.test(e.expression.text)) return wideSourceAny(e.arguments[0]);
  return null;
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

// The locals filled from a collection as big as the map, in source order (a later
// one built from an earlier one is seen; `const`/`let` initialisers only).
for (const file of sources) {
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      const from = wideSource(n.initializer);
      const s = from ? symbolOf(n.name) : null;
      if (s) wideLocals.set(s, `${n.name.text}(${from.replace(/\(.*$/, '')})`);
    }
    ts.forEachChild(n, visit);
  };
  visit(file);
}

// The fields and locals filled from the map, which `wideLocals` does not follow:
// one assigned a collection as big as the map (`this.kept = doc.lots.filter(...)`,
// `this.ws = this.walls`), one a loop over the map pushes, sets or adds into
// (`for (const b of doc.buildings.all()) this.walls.push(...)`), and a local so
// filled. Repeated until nothing new is found, as one field is built from another.
const FILLING = new Set(['push', 'unshift', 'set', 'add']);
/** The class field or the local a collection expression names, with its label. */
function holderOf(expr) {
  const e = skipParens(expr);
  const nameNode = ts.isPropertyAccessExpression(e) ? e.name : ts.isIdentifier(e) ? e : null;
  const s = nameNode && symbolOf(nameNode);
  const d = s?.declarations?.[0];
  if (!d || !inSrc(d)) return null;
  if (ts.isPropertyDeclaration(d) && ts.isClassLike(d.parent)) return { s, label: `${d.parent.name?.text ?? '(class)'}.${nameNode.text}` };
  if (ts.isVariableDeclaration(d) && ts.isIdentifier(d.name)) return { s, label: null };
  return null;
}
function follow(holder, from) {
  if (!holder || derivedWide.has(holder.s) || wideLocals.has(holder.s)) return false;
  derivedWide.set(holder.s, holder.label ?? `${holder.s.name}(${from.replace(/\(.*$/, '')})`);
  return true;
}
for (let round = 0, grew = true; grew && round < 4; round++) {
  grew = false;
  for (const file of sources) {
    /** The loops over the map we are inside, innermost last (their labels). */
    const inside = [];
    const visit = (n) => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
        const from = wideSourceAny(n.initializer);
        if (from) grew = follow(holderOf(n.name), from) || grew;
      } else if (ts.isPropertyDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
        const from = wideSourceAny(n.initializer);
        if (from) grew = follow(holderOf(n.name), from) || grew;
      } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const from = wideSourceAny(n.right);
        if (from) grew = follow(holderOf(n.left), from) || grew;
      } else if (inside.length && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && FILLING.has(n.expression.name.text)) {
        const holder = holderOf(n.expression.expression);
        if (holder && COLLECTION.test(checker.typeToString(checker.getTypeAtLocation(n.expression.expression)))) grew = follow(holder, inside[inside.length - 1]) || grew;
      }
      if (ts.isForOfStatement(n)) {
        const wide = wideOf(n.expression);
        if (wide) {
          visit(n.expression);
          inside.push(wide.label);
          visit(n.statement);
          inside.pop();
          return;
        }
      }
      if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isCallExpression(n.parent) && n.parent.arguments.includes(n)
        && ts.isPropertyAccessExpression(n.parent.expression) && ITERATING.has(n.parent.expression.name.text)) {
        const wide = wideOf(n.parent.expression.expression);
        if (wide) {
          inside.push(wide.label);
          ts.forEachChild(n, visit);
          inside.pop();
          return;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(file);
  }
}

// A global revision: a member or a name ending in `revision` (`doc.revision`,
// `lotRevision`, `topologyRevision`), or a local whose value holds one (a key
// `${doc.revision}:${zoom}`). The diary (`doc.changes.since(...)`) is what to read instead.
const REVISION = /revision$/i;
function mentionsRevision(expr, depth = 0) {
  let found = false;
  const visit = (n) => {
    if (found || isFunction(n)) return;
    if (ts.isPropertyAccessExpression(n) && REVISION.test(n.name.text)) { found = true; return; }
    if (ts.isIdentifier(n)) {
      if (REVISION.test(n.text)) { found = true; return; }
      if (depth < 2) {
        const d = symbolOf(n)?.declarations?.[0];
        if (d && ts.isVariableDeclaration(d) && d.initializer && inSrc(d) && mentionsRevision(d.initializer, depth + 1)) { found = true; return; }
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}
/** 'changed' when a condition holds once a revision moved (`!==`), 'same' when it holds while it did not (`===`). */
function revisionTest(condition) {
  let test = null;
  const visit = (n) => {
    if (test || isFunction(n)) return;
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      const changed = op === ts.SyntaxKind.ExclamationEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken;
      const same = op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken;
      if ((changed || same) && (mentionsRevision(n.left) || mentionsRevision(n.right))) { test = changed ? 'changed' : 'same'; return; }
    }
    ts.forEachChild(n, visit);
  };
  visit(condition);
  return test;
}
/** A statement that leaves what follows it: `return`, `throw`, `continue`, or a block ending in one. */
function exits(s) {
  if (ts.isReturnStatement(s) || ts.isThrowStatement(s) || ts.isContinueStatement(s)) return true;
  return ts.isBlock(s) && s.statements.length > 0 && exits(s.statements[s.statements.length - 1]);
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
  /** Inside a loop over a map-sized collection: the loops it holds, the units it calls, the callbacks it hands one. */
  const nested = [];
  const insideWide = [];
  const wideCallbacks = [];
  // Two stacks of the loops we are inside: over the fixed list only (the old
  // rules' view, kept exactly) and over every collection as big as the map.
  const fixedStack = [];
  const anyStack = [];
  const top = (stack) => stack[stack.length - 1] ?? null;
  /** Inside a branch run because a global revision moved: the loops it holds, the units it calls. */
  let guard = 0;
  const revisionLoops = [];
  const revisionCalls = [];
  const wideLoop = (how, wide) => {
    const what = `${how} ${wide.label}`;
    does.push({ kind: 'loop', what, derived: wide.derived });
    if (guard) revisionLoops.push(what);
    if (!wide.derived && fixedStack.length) nested.push({ outer: top(fixedStack), inner: what, derived: false });
    const outer = top(anyStack);
    if (outer && (outer.derived || wide.derived)) nested.push({ outer: outer.what, inner: what, derived: true });
  };
  const pushLoop = (what, derived) => {
    if (!derived) fixedStack.push(what);
    anyStack.push({ what, derived });
  };
  const popLoop = (derived) => {
    if (!derived) fixedStack.pop();
    anyStack.pop();
  };
  const ran = (target) => {
    calls.add(target);
    if (anyStack.length) insideWide.push({ target, fixed: top(fixedStack), any: top(anyStack) });
    if (guard) revisionCalls.push(target);
  };
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
    // A receiver the checker cannot type (`any`) or a type of a library (three's `InstancedMesh`): no member
    // of the game runs. DO NOT tie it by name: `any` admits every holder, and a mesh's `dispose()` was tied to
    // the 65 `dispose` methods of the game, the roads' among them (2026-10-14).
    const library = (t) => (t.aliasSymbol ?? t.getSymbol())?.declarations?.every((d) => !inSrc(d)) ?? false;
    if ((receiver.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) || typesOf(receiver).every(library)) { unresolved++; return []; }
    const named = (byName.get(nameNode.text) ?? []).filter((e) => holdsFor(e.holder, receiver));
    // No holder says it is the receiver's named type (a literal returned through a local): by its shape.
    const byMember = (named.length ? named : (byName.get(nameNode.text) ?? []).filter((e) => fits(e.holder, receiver))).map((e) => e.unit);
    if (byMember.length) fieldBased++;
    else unresolved++;
    return byMember;
  };
  const visit = (n) => {
    if (n !== unit && (isFunction(n) || ts.isClassLike(n))) {
      // A function given to a call that runs it now (`forEach`, `advance`): part of this unit.
      const call = n.parent;
      if (isFunction(n) && call && (ts.isCallExpression(call) || ts.isNewExpression(call)) && call.arguments?.includes(n)
        && runsNow(call, call.arguments.indexOf(n))) {
        ran(n);
        // Handed to a loop over the map (`all.forEach((b) => ...)`): its body runs once an item.
        const callee = ts.isCallExpression(call) ? skipParens(call.expression) : null;
        if (callee && ts.isPropertyAccessExpression(callee) && ITERATING.has(callee.name.text)) {
          const wide = wideOf(callee.expression);
          if (wide) wideCallbacks.push({ target: n, outer: `${callee.name.text} ${wide.label}`, derived: wide.derived });
        }
      }
      return;
    }
    if (ts.isCallExpression(n)) {
      for (const t of callTargets(n.expression)) ran(t);
      const callee = skipParens(n.expression);
      if (ts.isPropertyAccessExpression(callee)) {
        const method = callee.name.text;
        if (ITERATING.has(method)) { const wide = wideOf(callee.expression); if (wide) wideLoop(method, wide); }
        if (method === 'from' && ts.isIdentifier(callee.expression) && callee.expression.text === 'Array' && n.arguments[0]) {
          const wide = wideOf(n.arguments[0]);
          if (wide) wideLoop('Array.from', wide);
        }
      }
    } else if (ts.isIfStatement(n)) {
      const test = revisionTest(n.expression);
      if (test) {
        visit(n.expression);
        if (test === 'changed') guard++;
        visit(n.thenStatement);
        if (test === 'changed') guard--;
        if (n.elseStatement) {
          if (test === 'same') guard++;
          visit(n.elseStatement);
          if (test === 'same') guard--;
        }
        return;
      }
    } else if (ts.isBlock(n)) {
      // `if (key === this.key) return;` guards what follows it in the block.
      let opened = 0;
      for (const s of n.statements) {
        visit(s);
        if (ts.isIfStatement(s) && !s.elseStatement && exits(s.thenStatement) && revisionTest(s.expression) === 'same') { guard++; opened++; }
      }
      guard -= opened;
      return;
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
      const wide = wideOf(n.expression);
      if (wide) {
        wideLoop('for', wide);
        // The body runs once an item: what it does is done the map's size times.
        visit(n.initializer);
        visit(n.expression);
        pushLoop(`for ${wide.label}`, wide.derived);
        visit(n.statement);
        popLoop(wide.derived);
        return;
      }
    } else if (ts.isSpreadElement(n)) {
      const wide = wideOf(n.expression);
      if (wide) wideLoop('spread', wide);
    }
    ts.forEachChild(n, visit);
  };
  if (ts.isClassLike(unit)) {
    for (const m of unit.members) if (ts.isPropertyDeclaration(m) && m.initializer) visit(m.initializer);
  } else {
    for (const p of unit.parameters ?? []) if (p.initializer) visit(p.initializer);
    visit(unit.body);
  }
  const result = { calls: [...calls], does, nested, insideWide, wideCallbacks, revisionLoops, revisionCalls };
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
const perFrameDerived = (d) => d.derived || d.what.includes('(');
for (const unit of perFrame.keys()) {
  for (const d of factsOf(unit).does) {
    if (d.kind === 'heavy') note('heavy-call-per-frame', unit, d.what, perFrame);
    // A loop over a local filled from the map (`kept(RoadDoc.lots)`) counts for the newer rules only:
    // this rule's baseline was taken without them.
    if (d.kind === 'loop' && !d.derived && !d.what.includes('(')) note('whole-map-per-frame', unit, d.what, perFrame);
    else if (d.kind === 'loop' && perFrameDerived(d)) note('derived-map-per-frame', unit, d.what, perFrame);
  }
}
// A unit traverses the map when it, or anything it calls, loops over a
// map-sized collection - a procedure summary, as CLARITY's. A `@rebuild` unit
// says it does its work only when what it reads changed: amortized, not a
// traversal for its callers (but it is for `whole-map-on-revision`: `amortized`
// false). `kind`: the loops counted, 'fixed' (the old rules' list), 'derived'
// (only the new sources) or 'any'.
const traversals = new Map();
function traversesMap(unit, kind = 'fixed', amortized = true, stack = new Set()) {
  const memoKey = `${kind} ${amortized}`;
  let traversal = traversals.get(memoKey);
  if (!traversal) traversals.set(memoKey, traversal = new Map());
  if (traversal.has(unit)) return traversal.get(unit);
  if ((amortized && tagged(unit, 'rebuild')) || stack.has(unit)) return null;
  stack.add(unit);
  const f = factsOf(unit);
  const own = f.does.find((d) => d.kind === 'loop' && (kind === 'any' || (kind === 'derived') === d.derived));
  let found = own ? `${nameOf(unit).split(' ')[1]}: ${own.what}` : null;
  for (const c of own ? [] : f.calls) {
    const inner = traversesMap(c, kind, amortized, stack);
    if (inner) { found = `${nameOf(unit).split(' ')[1]} → ${inner}`; break; }
  }
  stack.delete(unit);
  traversal.set(unit, found);
  return found;
}
for (const unit of units) {
  const f = factsOf(unit);
  for (const n of f.nested) note(n.derived ? 'derived-map-nested' : 'whole-map-nested', unit, `${n.outer} ⊃ ${n.inner}`, null);
  for (const { target, fixed, any } of f.insideWide) {
    if (fixed) {
      const inner = traversesMap(target);
      if (inner) note('whole-map-nested', unit, `${fixed} ⊃ ${inner}`, null);
    }
    // The new rule: an outer loop only the new sources see, with any traversal inside it; a fixed one, with a new traversal.
    const inner = traversesMap(target, any.derived ? 'any' : 'derived');
    if (inner) note('derived-map-nested', unit, `${any.what} ⊃ ${inner}`, null);
  }
  for (const { target, outer, derived } of f.wideCallbacks) {
    const body = factsOf(target);
    for (const d of body.does) {
      if (d.kind !== 'loop') continue;
      note(derived || d.derived ? 'derived-map-nested' : 'whole-map-nested', unit, `${outer} ⊃ ${d.what}`, null);
    }
    for (const c of body.calls) {
      if (!derived) {
        const inner = traversesMap(c);
        if (inner) note('whole-map-nested', unit, `${outer} ⊃ ${inner}`, null);
      }
      const inner = traversesMap(c, derived ? 'any' : 'derived');
      if (inner) note('derived-map-nested', unit, `${outer} ⊃ ${inner}`, null);
    }
  }
  // The map redone because a global revision moved, `@rebuild` or not.
  for (const what of f.revisionLoops) note('whole-map-on-revision', unit, what, null);
  for (const target of f.revisionCalls) {
    const inner = traversesMap(target, 'any', false);
    if (inner) note('whole-map-on-revision', unit, inner, null);
  }
}
/** What runs once a thing marked `tag`, and what it reaches short of a `@rebuild`. */
function reachFrom(tag) {
  const reached = new Map(units.filter((u) => tagged(u, tag)).map((r) => [r, null]));
  const queue = [...reached.keys()];
  for (let i = 0; i < queue.length; i++) {
    for (const next of factsOf(queue[i]).calls) {
      if (reached.has(next) || tagged(next, 'rebuild')) continue;
      reached.set(next, queue[i]);
      queue.push(next);
    }
  }
  return reached;
}
const perItem = reachFrom('perItem');
for (const unit of perItem.keys()) {
  for (const d of factsOf(unit).does) if (d.kind === 'loop') note(d.derived ? 'derived-map-per-item' : 'whole-map-per-item', unit, d.what, perItem);
}
const perInput = reachFrom('perInput');
for (const unit of perInput.keys()) {
  for (const d of factsOf(unit).does) if (d.kind === 'loop') note('whole-map-per-input', unit, d.what, perInput);
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
  const seedAt = process.argv.indexOf('--seed');
  // New rules' findings enter once (`--seed a,b`), and only for a rule the baseline has none of yet.
  const seeding = (seedAt >= 0 ? process.argv[seedAt + 1] ?? '' : '').split(',').filter(Boolean)
    .filter((rule) => !Object.keys(baseline).some((key) => key.startsWith(`${rule}  `)));
  const refused = added.filter((key) => !seeding.some((rule) => key.startsWith(`${rule}  `)));
  if (refused.length && existsSync(BASELINE)) {
    for (const key of refused) console.error(`novo: ${key}  ×${issues[key]}
    ${found.get(key).path}`);
    console.error(`código: ${refused.length} achados novos; a linha de base só diminui.`);
    process.exit(1);
  }
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify(issues, null, 1) + '\n');
  console.log(`código: linha de base com ${total(issues)} ocorrências em ${Object.keys(issues).length} itens (${stats})`);
  process.exit(0);
}
for (const key of added) console.error(`novo: ${key}  ×${issues[key]} (linha de base ${baseline[key] ?? 0})\n    ${found.get(key).path}`);
if (gone.length) console.error(`código: ${gone.length} itens da linha de base resolvidos ou reduzidos; atualize (node scripts/check-code.mjs --update):\n${gone.join('\n')}`);
// The baseline is the list of known defects to fix (docs/PLANO-ESPINHA-2026-10-14.md), not an
// acceptance: "0 new" proves nothing about the code. DO NOT word this line as a pass.
console.log(`código: ${added.length} novos; ${Object.keys(baseline).length} defeitos conhecidos ainda no código (${total(baseline)} ocorrências na linha de base, a corrigir) (${stats})`);
process.exit(added.length || gone.length ? 1 : 0);
