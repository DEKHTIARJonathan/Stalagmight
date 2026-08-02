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

assert.deepEqual(
  analyzeSource(
    'unique.tsx',
    'const view = rows.map((row) => <button data-testid={`remove-row-${row.id}`}>Remove</button>);',
  ),
  [],
);

console.log('Test-ID gate fixtures passed.');
