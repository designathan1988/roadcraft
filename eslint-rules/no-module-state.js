/** NO MUTABLE STATE LOOSE IN A MODULE (CLAUDE.md, Architecture: "No mutable state loose in a module"). */
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
