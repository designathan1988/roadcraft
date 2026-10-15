/**
 * NO GLOBAL REVISION READ (docs/PLANO-ESPINHA-2026-10-14.md, Passo 4): a
 * product derived from the document is told what changed - by the diary read
 * through a cursor (`world/derived.ts`, `JournalCursor`), by a log of changes
 * (`core/changeLog.ts`, `Network.changesSince`, `SimWorld.topologyLog`) - and
 * never keys itself on a revision that says only THAT something changed
 * somewhere: such a key made every product redo the whole map for any edit.
 * Reported:
 * - reading `x.revision` or `x.somethingRevision` of another object (a
 *   class's own `this.revision` is its definition);
 * - `x.serialOf(...)` and `x.changes.since(...)`, the diary read past the
 *   cursors that keep what each reader saw.
 * Allowed in the engine, the diary and its cursors, the persistence and the
 * load (`eslint.config.js`); what stands elsewhere is in
 * `eslint-suppressions.json`, which only shrinks. DO NOT suppress it inline.
 */
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
