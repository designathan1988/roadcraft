/**
 * NO MUTABLE STATE LOOSE IN A MODULE (CLAUDE.md, Architecture: "No mutable
 * state loose in a module"). State belongs to one of the global controllers
 * (document, session store, state machines, simulation, render), each the
 * only writer of its data. Reported at a module's top level:
 * - `let` and `var` declarations (a value reassigned from anywhere in the file);
 * - `const` bound to a fresh mutable container (`new Map/Set/WeakMap/WeakSet/Array`,
 *   an empty array literal), the usual shape of a hidden cache.
 * Frozen tables (`as const`, `Object.freeze`) and constants are fine.
 */
const CONTAINERS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array']);

function mutableContainer(init) {
  if (!init) return false;
  let node = init;
  while (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression') node = node.expression;
  if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && CONTAINERS.has(node.callee.name)) return true;
  if (node.type === 'ArrayExpression' && node.elements.length === 0) return true;
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'No mutable state at module level.' },
    schema: [],
    messages: {
      binding: 'Module-level `{{kind}}`: mutable state loose in a module. Give it to the controller that owns it.',
      container: 'Module-level mutable container: state loose in a module. Give it to the controller that owns it.',
    },
  },
  create(context) {
    const check = (decl) => {
      if (decl.type !== 'VariableDeclaration') return;
      if (decl.kind === 'let' || decl.kind === 'var') {
        context.report({ node: decl, messageId: 'binding', data: { kind: decl.kind } });
        return;
      }
      for (const d of decl.declarations) if (mutableContainer(d.init)) context.report({ node: d, messageId: 'container' });
    };
    return {
      Program(program) {
        for (const statement of program.body) {
          if (statement.type === 'ExportNamedDeclaration' && statement.declaration) check(statement.declaration);
          else check(statement);
        }
      },
    };
  },
};
