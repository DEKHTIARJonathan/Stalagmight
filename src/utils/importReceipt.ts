import type { TFunction } from 'i18next';
import type { ImportReceipt } from '../types/ipc/ImportReceipt';

/**
 * Combine the receipts from several `import_sections` calls made during one
 * logical import (the mNemo DMP wizard batches early/segment/late/pending
 * imports, each a separate backend call) into a single summary. Counts are
 * summed, warnings are concatenated in call order, and the file-level fields
 * (`source_format`, `file_name`, `sections_found`, the first non-null
 * `unit_conversion`) are taken from whichever receipt set them first - they
 * describe the whole file, not a single batch, so summing would be wrong.
 *
 * Returns `undefined` for an empty list so a caller with no receipts (nothing
 * was actually imported) can skip opening the receipt dialog entirely.
 */
export function aggregateImportReceipts(receipts: ImportReceipt[]): ImportReceipt | undefined {
  const [first, ...rest] = receipts;
  if (!first) return undefined;

  return rest.reduce<ImportReceipt>(
    (acc, r) => ({
      source_format: acc.source_format,
      file_name: acc.file_name,
      sections_found: acc.sections_found,
      sections_imported: acc.sections_imported + r.sections_imported,
      shot_count: acc.shot_count + r.shot_count,
      closures_requested: acc.closures_requested + r.closures_requested,
      closures_created: acc.closures_created + r.closures_created,
      unit_conversion: acc.unit_conversion ?? r.unit_conversion,
      warnings: [...acc.warnings, ...r.warnings],
    }),
    first,
  );
}

/**
 * The three "what landed" facts shared by the receipt dialog and the receipt
 * toast (docs/notifications.md): sections imported, shots imported, and loops
 * reconstructed (only when the receipt actually requested a closure). `t` is
 * either the component `useTranslation()` hook's `t`, or `i18n.t` directly
 * when called outside React (the toast path in `saveFeedback.ts`).
 */
export function importReceiptSummaryParts(receipt: ImportReceipt, t: TFunction): string[] {
  return [
    t('dialogs.importReceipt.sections', { count: receipt.sections_imported }),
    t('dialogs.importReceipt.shots', { count: receipt.shot_count }),
    ...(receipt.closures_requested > 0
      ? [t('dialogs.importReceipt.loops', { count: receipt.closures_created })]
      : []),
  ];
}

/**
 * Nothing landed - zero sections AND zero shots. #442's case: an import that
 * silently produces nothing must never be demoted to a toast, even if it
 * happens to carry no `warnings` of its own (the absence of any data IS the
 * thing the user needs to see).
 */
export function isEmptyImportReceipt(receipt: ImportReceipt): boolean {
  return receipt.sections_imported === 0 && receipt.shot_count === 0;
}
