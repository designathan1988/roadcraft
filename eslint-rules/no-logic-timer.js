/**
 * NO TIMER OF THE GAME'S OWN (docs/PLANO-ESPINHA-2026-10-14.md, Passo 2 and
 * 4): the game's work runs in the frame (`main.ts` frame: the input, the
 * simulation, the engine's products, the drawing) or on the simulation's
 * clock (`frameLoop.ts` `SimPeriodic`), never on a `setTimeout` or
 * `setInterval` of its own, which ran it between frames, in the middle of
 * whatever the page was doing. Allowed where waiting on the page is the point
 * - the saves, the interface's notices, a GPU release while nothing draws,
 * the frame loop itself (`eslint.config.js`); what stands elsewhere is in
 * `eslint-suppressions.json`, which only shrinks. DO NOT suppress it inline.
 */
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
