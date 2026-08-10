import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { importButtonLabel } from './importButtonLabel';

const t = ((k: string) => k) as TFunction;
const keys = {
  importingKey: 'importing',
  checkingKey: 'checking',
  defaultKey: 'default',
};

describe('importButtonLabel', () => {
  it('prefers the importing label when an import is in flight, even mid hash-check', () => {
    expect(
      importButtonLabel(t, { isImporting: true, hashChecked: false, ...keys }),
    ).toBe('importing');
  });

  it('shows the checking label while the hash round trip is outstanding', () => {
    expect(
      importButtonLabel(t, { isImporting: false, hashChecked: false, ...keys }),
    ).toBe('checking');
  });

  it('falls back to the default label once the hash check has settled', () => {
    expect(
      importButtonLabel(t, { isImporting: false, hashChecked: true, ...keys }),
    ).toBe('default');
  });
});
