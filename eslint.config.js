// ESLint flat config (#576 D1). The gate is scripts/check-eslint.mjs
// (pnpm lint:eslint): errors fail, warnings are ratcheted per file in
// eslint-baseline.json. Policy and how to extend it: docs/linting.md
// "Frontend: ESLint".
//
// Deliberately small. The parser is typescript-eslint's, with no type-aware
// rules (no `parserOptions.project`), so a run needs no TypeScript program and
// stays fast. The rules are the two React hook rules:
//   - rules-of-hooks (error): a hook behind `||`, a condition or an early return
//     changes the hook order between renders and React throws;
//   - exhaustive-deps (warn, ratcheted): a missing effect/memo dependency can be
//     a stale-closure bug, but the tree carried ~100 findings when this landed,
//     so they are frozen in the baseline rather than fixed in one go.
// An `eslint-disable` for one of these rules needs a reason after ` -- `, and an
// unused or unknown-rule directive is an error (reportUnusedDisableDirectives).
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  // Generated ts-rs output (CLAUDE.md "IPC Types Are Generated"): never hand-written.
  { ignores: ['src/types/ipc/**', 'src/types/ipc.generated.ts'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
];
