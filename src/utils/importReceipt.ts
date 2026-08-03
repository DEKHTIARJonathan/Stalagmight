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
