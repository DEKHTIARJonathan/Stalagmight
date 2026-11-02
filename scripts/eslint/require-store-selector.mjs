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
//   - [#576 RV5-LS-3] a selector that builds a FRESH object or array, with no
//     useShallow and no equality function:     useUIStore((s) => ({ a: s.a }))
//                                               useUIStore((s) => [s.a, s.b])
//                                               useUIStore((s) => s.list.map(f))
//     zustand compares a selector's answers with Object.is, so a new object on
//     every call is a new answer on every store write - a whole-store
//     subscription, exactly like no selector;
//   - [#576 RV5-LS-3] useShallow over a copy of the whole state:
//                                               useUIStore(useShallow((s) => ({ ...s })))
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

// What a one-parameter selector returns: the expression body, or the argument of
// a block body's single `return`. Null for anything else.
function selectorResult(node) {
  if (node?.type !== 'ArrowFunctionExpression' && node?.type !== 'FunctionExpression') return null;
  let body = node.body;
  if (body.type === 'BlockStatement') {
    if (body.body.length !== 1 || body.body[0].type !== 'ReturnStatement') return null;
    body = body.body[0].argument;
  }
  return body ?? null;
}

// Methods and statics that always answer a NEW array.
const FRESH_ARRAY_METHODS = new Set(['map', 'filter', 'flatMap', 'slice', 'concat']);
const FRESH_ARRAY_STATICS = new Set(['keys', 'values', 'entries']);

// [#576 RV5-LS-3] An expression that evaluates to a new object or array on every
// call: a literal, `x.map(...)` and friends, `Object.keys(...)` and friends.
function isFresh(expr) {
  let e = expr;
  while (e?.type === 'TSAsExpression' || e?.type === 'TSNonNullExpression' || e?.type === 'ChainExpression') e = e.expression;
  if (!e) return false;
  if (e.type === 'ObjectExpression' || e.type === 'ArrayExpression') return true;
  // A fallback is fresh only when every answer is: `s.list ?? []` is the stored
  // list whenever there is one (a new `[]` only while it is missing), which is
  // not a whole-store subscription.
  if (e.type === 'LogicalExpression') return isFresh(e.left) && isFresh(e.right);
  if (e.type === 'ConditionalExpression') return isFresh(e.consequent) && isFresh(e.alternate);
  if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && !e.callee.computed) {
    const method = e.callee.property.name;
    if (FRESH_ARRAY_METHODS.has(method)) return true;
    if (e.callee.object.type === 'Identifier' && e.callee.object.name === 'Object' && FRESH_ARRAY_STATICS.has(method)) {
      return true;
    }
  }
  return false;
}

// [#576 RV5-LS-3] `useShallow((s) => ({ ...s }))`: a shallow copy of the whole state.
function isShallowWholeSpread(node) {
  if (node?.type !== 'CallExpression' || calleeName(node) !== 'useShallow' || node.arguments.length !== 1) return false;
  const selector = node.arguments[0];
  const [param] = selector?.params ?? [];
  if (param?.type !== 'Identifier') return false;
  const result = selectorResult(selector);
  return (
    result?.type === 'ObjectExpression' &&
    result.properties.some((p) => p.type === 'SpreadElement' && p.argument.type === 'Identifier' && p.argument.name === param.name)
  );
}

// A selector that builds a fresh value and has nothing to compare it shallowly:
// not under useShallow (that is a call, not a function) and no equality function
// passed after it.
const isFreshUnshallowed = (selector, equalityFn) => equalityFn === undefined && isFresh(selectorResult(selector));

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
      freshSelector:
        '`{{hook}}` with a selector that builds a new object or array re-renders this component on every store ' +
        'update (the answer is never Object.is-equal to the last). Wrap the selector in useShallow(...), or ' +
        'select each field with its own call.',
      shallowSpread:
        '`{{hook}}(useShallow((s) => ({ ...s })))` copies the whole store, so every store update re-renders this ' +
        'component. Select the fields it reads instead.',
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = calleeName(node);
        if (!name) return;
        if (name === 'useStore') {
          if (node.arguments.length === 1) context.report({ node, messageId: 'genericNoSelector' });
          else if (isFreshUnshallowed(node.arguments[1], node.arguments[2])) {
            context.report({ node, messageId: 'freshSelector', data: { hook: name } });
          } else if (isShallowWholeSpread(node.arguments[1])) {
            context.report({ node, messageId: 'shallowSpread', data: { hook: name } });
          }
          return;
        }
        if (!STORE_HOOK.test(name)) return;
        if (node.arguments.length === 0) {
          context.report({ node, messageId: 'noSelector', data: { hook: name } });
          return;
        }
        const [selector, equalityFn] = node.arguments;
        if (isIdentitySelector(selector) || isShallowIdentity(selector)) {
          context.report({ node, messageId: 'identity', data: { hook: name } });
        } else if (isShallowWholeSpread(selector)) {
          context.report({ node, messageId: 'shallowSpread', data: { hook: name } });
        } else if (isFreshUnshallowed(selector, equalityFn)) {
          context.report({ node, messageId: 'freshSelector', data: { hook: name } });
        }
      },
    };
  },
};
