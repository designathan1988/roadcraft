/** DO NOT suppress it inline. */
const REVISION = /^(revision|[a-z][A-Za-z]*Revision)$/;

export default {
  meta: {
    type: 'problem',
    docs: { description: 'No product keyed on a global revision: read what changed.' },
    schema: [],
    messages: {
      revision: 'Reads `{{name}}`, a revision that says only that something changed: read what changed (the diary through a cursor, a change log).',
      diary: '`{{name}}` reads the diary past the cursors: use a `JournalCursor` / `derivedProduct`, or the change log of what it derives from.',
    },
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (node.computed || node.property.type !== 'Identifier' || !REVISION.test(node.property.name)) return;
        if (node.object.type === 'ThisExpression') return;
        const parent = node.parent;
        // Written, not read: an assignment's target, a ++/--.
        if (parent && parent.type === 'AssignmentExpression' && parent.left === node) return;
        if (parent && parent.type === 'UpdateExpression') return;
        context.report({ node, messageId: 'revision', data: { name: node.property.name } });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier') return;
        if (callee.property.name === 'serialOf') {
          context.report({ node, messageId: 'diary', data: { name: 'serialOf' } });
          return;
        }
        if (callee.property.name === 'since' && callee.object.type === 'MemberExpression' && !callee.object.computed
          && callee.object.property.type === 'Identifier' && callee.object.property.name === 'changes') {
          context.report({ node, messageId: 'diary', data: { name: 'changes.since' } });
        }
      },
    };
  },
};
