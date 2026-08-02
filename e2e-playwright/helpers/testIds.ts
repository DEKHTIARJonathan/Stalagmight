import type { Page } from '@playwright/test';

export {
  gasCylinderRowTestId,
  missingSystemCardRemoveTestId,
  missingSystemCardTestId,
  missingSystemRowTestId,
  recoveryBackupItemTestId,
  systemCardTestId,
  systemRowTestId,
  warningMessageTestId,
  warningOpenShotTestId,
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

export function gasWaypointRows(page: Page) {
  return qualifiedIndexTestIds(page, 'gas-waypoint-row');
}

export function gasWaypointDownButtons(page: Page) {
  return qualifiedIndexTestIds(page, 'gas-waypoint-down');
}

export function gasWaypointRemoveButtons(page: Page) {
  return qualifiedIndexTestIds(page, 'gas-waypoint-remove');
}

export function gasWaypointUnresolvedIndicators(page: Page) {
  return qualifiedIndexTestIds(page, 'gas-waypoint-unresolved');
}

export function gasMarkedRows(page: Page) {
  return qualifiedIndexTestIds(page, 'gas-marked-row');
}

export function gasMarkedLabelInputs(page: Page) {
  return qualifiedIndexTestIds(page, 'gas-marked-label-input');
}

export function gasMarkedRemoveButtons(page: Page) {
  return qualifiedIndexTestIds(page, 'gas-marked-remove');
}

export function recoveryBackupItems(page: Page) {
  return qualifiedIndexTestIds(page, 'recovery-backup-item');
}

export function warningResolveButtons(page: Page) {
  return page.getByTestId(/^warning-(?!.*-undo-resolve$).*-resolve$/);
}

export function warningMessages(page: Page) {
  return page.getByTestId(/^warning-.*-message$/);
}
