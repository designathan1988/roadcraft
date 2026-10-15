/** DO NOT suppress it inline. */
const RIBBON_WALKS = new Set(['values', 'keys', 'entries', 'forEach']);

const named = (node, name) => node && node.type === 'MemberExpression' && !node.computed
  && node.property.type === 'Identifier' && node.property.name === name;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Every building or road of the map walked only in a function marked @rebuild.' },
    schema: [],
    messages: {
      walk: 'Walks {{what}} of the whole map outside a `@rebuild`: find what is near by an index, what changed by the diary.',
    },
  },
  create(context) {
    const source = context.sourceCode;
    /** Whether the function holding `node` is marked: its doc comment, or a comment in it before the walk. */
    const marked = (node) => {
      for (let fn = node.parent; fn; fn = fn.parent) {
        if (fn.type !== 'FunctionDeclaration' && fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression') continue;
        const holder = fn.parent && (fn.parent.type === 'MethodDefinition' || fn.parent.type === 'Property' || fn.parent.type === 'VariableDeclarator') ? fn.parent : fn;
        const leading = [...source.getCommentsBefore(holder), ...source.getCommentsBefore(holder.parent?.type === 'VariableDeclaration' || holder.parent?.type === 'ExportNamedDeclaration' ? holder.parent : holder)];
        if (leading.some((c) => c.value.includes('@rebuild'))) return true;
        if (source.getCommentsInside(fn).some((c) => c.value.includes('@rebuild') && c.range[0] < node.range[0])) return true;
      }
      return false;
    };
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        let what = null;
        if (callee.property.name === 'all' && named(callee.object, 'buildings')) what = 'every building';
        else if (RIBBON_WALKS.has(callee.property.name) && named(callee.object, 'ribbons')) what = 'every road';
        if (what && !marked(node)) context.report({ node, messageId: 'walk', data: { what } });
      },
      ForOfStatement(node) {
        if (named(node.right, 'ribbons') && !marked(node)) context.report({ node: node.right, messageId: 'walk', data: { what: 'every road' } });
      },
    };
  },
};
