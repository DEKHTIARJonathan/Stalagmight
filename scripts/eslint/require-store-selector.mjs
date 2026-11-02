// ESLint rule stalagmight/require-store-selector (#576 D2). Zero tolerance.
//
// A zustand store hook called without a selector (`useProjectStore()`)
// subscribes its component to the WHOLE store: every `set()` - a dirty flag
// flipping, a loading-progress tick, an autosave state change, the undo
// availability after each edit - re-renders it, whether or not it reads the
// field that changed. The tree carried 87 such calls, including the app root and
// the map canvas, next to the documented fix (src/hooks/useProject.ts).
//
// Flags, for a callee named `use<Name>Store`:
//   - a call with no arguments:                 useProjectStore()
//   - an identity selector, bare or shallow:    useUIStore((s) => s)
//                                               useUIStore(useShallow((s) => s))
// and zustand's generic hook with no selector:  useStore(projectStore)
//
// The fix: select the fields the component reads -
//   const project = useProjectStore((s) => s.project);
//   const { a, b } = useUIStore(useShallow((s) => ({ a: s.a, b: s.b })));
// Store actions are stable, so selecting them costs no re-renders. A getter
// action that reads state through get() during render (isShotFrozen) needs the
// state it reads selected too, or the component stops re-rendering when it
// changes.
//
// Not flagged: `useXStore.getState()`, `.setState()`, `.subscribe()` (no
// subscription through React), and any call with a real selector.
//
// Pinned by scripts/check-eslint.test.mjs.

const STORE_HOOK = /^use[A-Z]\w*Store$/;

const calleeName = (call) => (call.callee.type === 'Identifier' ? call.callee.name : null);

// `(s) => s`, `s => s`, `function (s) { return s; }`.
function isIdentitySelector(node) {
  if (node?.type !== 'ArrowFunctionExpression' && node?.type !== 'FunctionExpression') return false;
  const [param] = node.params;
  if (node.params.length !== 1 || param.type !== 'Identifier') return false;
  let body = node.body;
  if (body.type === 'BlockStatement') {
    if (body.body.length !== 1 || body.body[0].type !== 'ReturnStatement') return false;
    body = body.body[0].argument;
  }
  return body?.type === 'Identifier' && body.name === param.name;
}

const isShallowIdentity = (node) =>
  node?.type === 'CallExpression' &&
  calleeName(node) === 'useShallow' &&
  node.arguments.length === 1 &&
  isIdentitySelector(node.arguments[0]);

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require a selector on every zustand store hook call' },
    schema: [],
    messages: {
      noSelector:
        '`{{hook}}()` subscribes to the whole store, so every store update re-renders this component. ' +
        'Select the fields it reads: {{hook}}((s) => s.field), or useShallow((s) => ({ a: s.a, b: s.b })) for several.',
      identity:
        '`{{hook}}` with an identity selector subscribes to the whole store, the same as no selector. ' +
        'Select the fields it reads instead.',
      genericNoSelector:
        '`useStore(store)` without a selector subscribes to the whole store. Pass a selector as the second argument.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (!name) return;
        if (name === 'useStore') {
          if (node.arguments.length === 1) context.report({ node, messageId: 'genericNoSelector' });
          return;
        }
        if (!STORE_HOOK.test(name)) return;
        if (node.arguments.length === 0) {
          context.report({ node, messageId: 'noSelector', data: { hook: name } });
          return;
        }
        const [selector] = node.arguments;
        if (isIdentitySelector(selector) || isShallowIdentity(selector)) {
          context.report({ node, messageId: 'identity', data: { hook: name } });
        }
      },
    };
  },
};
