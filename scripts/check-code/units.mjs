// THE FUNCTIONS of `src/` and how a call reaches them, for the code rules (`scripts/check-code.mjs`):
// each function's stable name, the implementations a call through an interface or a stored
// callback can run, the members by name and holder, and every unit collected. Split from
// check-code.mjs (eslint max-lines).
import ts from 'typescript';
import { checker, inSrc, isFunction, rel, skipParens, sources, symbolOf } from './program.mjs';

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
/** The named types of the game a type is (its interface, class or alias declared in `src/`). */
function namedIn(type) {
  const out = new Set();
  for (const t of typesOf(type)) {
    for (const s of [t.aliasSymbol, t.getSymbol()]) {
      if (s && (s.flags & (ts.SymbolFlags.Interface | ts.SymbolFlags.Class | ts.SymbolFlags.TypeAlias)) && (s.declarations ?? []).some(inSrc)) out.add(s);
    }
  }
  return out;
}
/** The named types a holder declares itself to be: an object literal's contextual type, a class and its bases. */
const holderNames = new Map();
function namesOfHolder(holder) {
  let names = holderNames.get(holder);
  if (names) return names;
  names = new Set();
  if (ts.isObjectLiteralExpression(holder)) {
    const contextual = checker.getContextualType(holder);
    if (contextual) for (const s of namedIn(contextual)) names.add(s);
  } else if (ts.isClassLike(holder)) {
    const queue = [checker.getTypeAtLocation(holder)];
    for (const clause of holder.heritageClauses ?? []) for (const t of clause.types) queue.push(checker.getTypeAtLocation(t));
    for (let i = 0; i < queue.length; i++) {
      for (const s of namedIn(queue[i])) names.add(s);
      if (queue[i].isClassOrInterface()) queue.push(...checker.getBaseTypes(queue[i]));
    }
  }
  holderNames.set(holder, names);
  return names;
}
/** A holder whose type is assignable to the receiver's (its shape fits). */
const fitting = new Map();
function fits(holder, receiver) {
  let type = holderTypes.get(holder);
  if (!type) holderTypes.set(holder, type = checker.getTypeAtLocation(holder));
  let byReceiver = fitting.get(holder);
  if (!byReceiver) fitting.set(holder, byReceiver = new Map());
  let ok = byReceiver.get(receiver);
  if (ok === undefined) byReceiver.set(receiver, ok = typesOf(receiver).some((r) => checker.isTypeAssignableTo(type, r)));
  return ok;
}
function holdsFor(holder, receiver) {
  let type = holderTypes.get(holder);
  if (!type) holderTypes.set(holder, type = checker.getTypeAtLocation(holder));
  let byReceiver = assignable.get(holder);
  if (!byReceiver) assignable.set(holder, byReceiver = new Map());
  let ok = byReceiver.get(receiver);
  if (ok === undefined) {
    // A receiver of a named type of the game (`BuildingMeshes`) runs the holders that say they are one - an
    // object literal typed as it, a class implementing it -, not every holder whose shape happens to fit:
    // `{ dispose(): void }` fits half the game (the roads' `dispose` was tied to every cell's, 2026-10-14).
    const named = namedIn(receiver);
    ok = named.size
      ? [...namesOfHolder(holder)].some((s) => named.has(s))
      : typesOf(receiver).some((r) => checker.isTypeAssignableTo(type, r));
    byReceiver.set(receiver, ok);
  }
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

/**
 * A key listener that runs no command of the game, said so with its reason in
 * a comment just above its statement (`// own key listener: <why>`): it tracks
 * a modifier or the focus, or holds the keys while a panel of its own is open.
 */
function ownListener(call) {
  let statement = call;
  while (statement && !ts.isExpressionStatement(statement)) statement = statement.parent;
  if (!statement) return false;
  const text = statement.getSourceFile().getFullText();
  return (ts.getLeadingCommentRanges(text, statement.getFullStart()) ?? [])
    .some((r) => /own key listener: \S/.test(text.slice(r.pos, r.end)));
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
      if (ts.isIdentifier(target) && (target.text === 'window' || target.text === 'document') && !ownListener(n)) keyListeners.push([n, `${target.text} ${n.arguments[0].text}`]);
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
export { byName, fits, holdsFor, keyListeners, nameOf, typesOf, unitSet, units, unitsOfSymbol };
