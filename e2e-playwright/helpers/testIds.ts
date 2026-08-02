import type { Page } from '@playwright/test';

export {
  gasCylinderRowTestId,
  missingSystemCardRemoveTestId,
  missingSystemCardTestId,
  missingSystemRowTestId,
  recoveryBackupItemTestId,
  systemCardTestId,
  systemRowTestId,
  warningResolveTestId,
  warningUndoResolveTestId,
} from '../../src/utils/testId';

export function qualifiedIndexTestIds(page: Page, baseTestId: string) {
  const escaped = baseTestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page.getByTestId(new RegExp(`^${escaped}-\\d+$`));
}

export function gasCylinderRows(page: Page) {
  return qualifiedIndexTestIds(page, 'gas-cylinder-row');
}

export function recoveryBackupItems(page: Page) {
  return qualifiedIndexTestIds(page, 'recovery-backup-item');
}

export function warningResolveButtons(page: Page) {
  return page.getByTestId(/^warning-(?!.*-undo-resolve$).*-resolve$/);
}
