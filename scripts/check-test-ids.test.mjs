import assert from 'node:assert/strict';
import { analyzeSource } from './check-test-ids.mjs';

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
  /include row identity/,
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
  /include row identity/,
);

assert.deepEqual(
  analyzeSource(
    'unique.tsx',
    'const view = rows.map((row) => <button data-testid={`remove-row-${row.id}`}>Remove</button>);',
  ),
  [],
);

console.log('Test-ID gate fixtures passed.');
