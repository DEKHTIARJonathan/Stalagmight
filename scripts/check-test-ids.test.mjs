import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeSource, scan } from './check-test-ids.mjs';

assert.deepEqual(
  analyzeSource('ok.tsx', 'const view = <Button data-testid="save-button">Save</Button>;'),
  [],
);

assert.match(
  analyzeSource('missing.tsx', 'const view = <input value={value} />;')[0]?.message ?? '',
  /has no data-testid/,
);

assert.match(
  analyzeSource(
    'repeated.tsx',
    'const view = rows.map((row) => <button data-testid="remove-row">Remove</button>);',
  )[0]?.message ?? '',
  /include item identity/,
);

assert.match(
  analyzeSource('anchor.tsx', 'const view = <a href="https://example.com">Website</a>;')[0]?.message ?? '',
  /has no data-testid/,
);

assert.match(
  analyzeSource('role.tsx', 'const view = <div role="button" tabIndex={0}>Open</div>;')[0]?.message ?? '',
  /has no data-testid/,
);

assert.match(
  analyzeSource('handler.tsx', 'const view = <div onClick={open}>Open</div>;')[0]?.message ?? '',
  /has no data-testid/,
);

assert.match(
  analyzeSource(
    'repeated-prop.tsx',
    'const view = rows.map((row) => <Button testId="remove-row">Remove</Button>);',
  )[0]?.message ?? '',
  /include item identity/,
);

assert.match(
  analyzeSource(
    'flat-repeated.tsx',
    'const view = rows.flatMap((row) => <button data-testid="remove-row">Remove</button>);',
  )[0]?.message ?? '',
  /include item identity/,
);

assert.match(
  analyzeSource(
    'array-from-repeated.tsx',
    'const view = Array.from({ length: 2 }, (_, index) => <button data-testid="remove-row">Remove</button>);',
  )[0]?.message ?? '',
  /include item identity/,
);

assert.deepEqual(
  analyzeSource(
    'unstable-expression.tsx',
    'const view = rows.map((row) => <button data-testid={sharedTestId}>Remove</button>);',
  ),
  [],
);

assert.match(
  analyzeSource(
    'duplicate-siblings.tsx',
    'const view = <><button data-testid="same">One</button><button data-testid="same">Two</button></>;',
  ).at(-1)?.message ?? '',
  /duplicated in one JSX container/,
);

assert.deepEqual(
  analyzeSource(
    'exclusive-ternary.tsx',
    'const view = <>{flag ? <button data-testid="same">One</button> : <button data-testid="same">Two</button>}</>;',
  ),
  [],
);

assert.deepEqual(
  analyzeSource(
    'exclusive-short-circuit.tsx',
    'const view = <>{flag && <button data-testid="same">One</button>}{!flag && <button data-testid="same">Two</button>}</>;',
  ),
  [],
);

assert.match(
  analyzeSource('summary.tsx', 'const view = <summary>Details</summary>;')[0]?.message ?? '',
  /has no data-testid/,
);

assert.deepEqual(
  analyzeSource(
    'unique.tsx',
    'const view = rows.map((row) => <button data-testid={`remove-row-${row.id}`}>Remove</button>);',
  ),
  [],
);

const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-test-id-root-'));
fs.writeFileSync(path.join(sourceRoot, 'App.tsx'), 'export const App = () => <button>Run</button>;');
assert.match(scan(sourceRoot)[0]?.message ?? '', /has no data-testid/);
fs.rmSync(sourceRoot, { recursive: true, force: true });

console.log('Test-ID gate fixtures passed.');
