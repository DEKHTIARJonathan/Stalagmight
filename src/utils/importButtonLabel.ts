import type { TFunction } from 'i18next';

/**
 * The primary-button label for an import dialog gated on a duplicate-hash
 * check: while the round trip is outstanding the button stays disabled, but
 * with no visible state change - it read as frozen rather than working.
 * Shared across every import dialog that gates on `hashChecked` (Walls,
 * Compass, GPX; TML does not gate - see its own `calculateFileHash` comment).
 */
export function importButtonLabel(
  t: TFunction,
  {
    isImporting,
    hashChecked,
    importingKey,
    checkingKey,
    defaultKey,
  }: {
    isImporting: boolean;
    hashChecked: boolean;
    importingKey: string;
    checkingKey: string;
    defaultKey: string;
  }
): string {
  if (isImporting) return t(importingKey);
  if (!hashChecked) return t(checkingKey);
  return t(defaultKey);
}
