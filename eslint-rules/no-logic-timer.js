/** DO NOT suppress it inline. */
const TIMERS = new Set(['setTimeout', 'setInterval']);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'The game\'s work in the frame or on the simulation\'s clock, not on a timer.' },
    schema: [],
    messages: {
      timer: '`{{name}}` runs the game\'s work between frames: run it in the frame (`main.ts` frame) or on the simulation\'s clock (`SimPeriodic`).',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        let name = null;
        if (callee.type === 'Identifier' && TIMERS.has(callee.name)) name = callee.name;
        else if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && TIMERS.has(callee.property.name)
          && callee.object.type === 'Identifier' && (callee.object.name === 'window' || callee.object.name === 'globalThis' || callee.object.name === 'self')) name = callee.property.name;
        if (name) context.report({ node, messageId: 'timer', data: { name } });
      },
    };
  },
};
