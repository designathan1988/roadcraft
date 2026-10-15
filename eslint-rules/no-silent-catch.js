/** NO ERROR SWALLOWED (CLAUDE.md: "Never silence errors"). */
const REPORTS = /^(report|record|warn|error|fail|reject|notify|onError|onSaveFailed)/i;

function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') return callee.property.name;
  if (callee.type === 'ChainExpression') return calleeName(callee.expression);
  return '';
}

function isConsoleReport(callee) {
  return callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'console'
    && callee.property.type === 'Identifier' && (callee.property.name === 'error' || callee.property.name === 'warn');
}

/** Whether `node` (a handler's body) throws or reports somewhere inside it. */
function speaks(node, visitorKeys) {
  let found = false;
  const walk = (n) => {
    if (!n || found || typeof n.type !== 'string') return;
    if (n.type === 'ThrowStatement') { found = true; return; }
    if (n.type === 'CallExpression') {
      const name = calleeName(n.callee);
      if (isConsoleReport(n.callee) || REPORTS.test(name) || name === 'queueMicrotask') { found = true; return; }
    }
    for (const key of visitorKeys[n.type] ?? []) {
      const child = n[key];
      if (Array.isArray(child)) child.forEach(walk); else walk(child);
    }
  };
  walk(node);
  return found;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'A catch must throw again or report the error.' },
    schema: [],
    messages: { silent: 'This catch swallows the error: throw it again or report it (console.error, a report*/record* call).' },
  },
  create(context) {
    const keys = context.sourceCode.visitorKeys;
    return {
      CatchClause(node) {
        if (!speaks(node.body, keys)) context.report({ node, messageId: 'silent' });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed || callee.property.name !== 'catch') return;
        const handler = node.arguments[0];
        if (!handler) return;
        if (handler.type !== 'ArrowFunctionExpression' && handler.type !== 'FunctionExpression') return;
        if (!speaks(handler.body, keys)) context.report({ node: handler, messageId: 'silent' });
      },
    };
  },
};
