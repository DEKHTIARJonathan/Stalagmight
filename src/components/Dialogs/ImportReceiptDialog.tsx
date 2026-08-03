import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete } from '../../utils/telemetry';
import type { ImportReceipt } from '../../types/ipc/ImportReceipt';

const MAX_VISIBLE_WARNINGS = 3;

/**
 * Post-import receipt (#391): a short "what landed" summary shown after a
 * foreign-format import (TML/Compass/Walls/GPX/DMP), read from
 * `dialogData.receipt`. Tone is a receipt, not a wizard step - it never blocks
 * the import (everything it describes already happened), it just tells the
 * user what to expect before they go looking in the data table.
 *
 * "N sections not imported" (when `sections_found > sections_imported`) is
 * folded into the warnings list rather than the summary line, since it is bad
 * news the summary's celebratory phrasing shouldn't bury.
 */
export default function ImportReceiptDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const dialogData = useUIStore((s) => s.dialogData);
  const [expanded, setExpanded] = useState(false);

  const receipt = dialogData.receipt as ImportReceipt | undefined;
  if (!receipt) return null;

  const notImportedCount = Math.max(0, receipt.sections_found - receipt.sections_imported);
  const allWarnings = [
    ...(notImportedCount > 0
      ? [t('dialogs.importReceipt.notImported', { count: notImportedCount })]
      : []),
    ...receipt.warnings,
  ];
  const visibleWarnings = allWarnings.slice(0, MAX_VISIBLE_WARNINGS);
  const hiddenWarnings = allWarnings.slice(MAX_VISIBLE_WARNINGS);
  const hasHiddenWarnings = hiddenWarnings.length > 0;

  const summaryParts = [
    t('dialogs.importReceipt.sections', { count: receipt.sections_imported }),
    t('dialogs.importReceipt.shots', { count: receipt.shot_count }),
    ...(receipt.closures_requested > 0
      ? [t('dialogs.importReceipt.loops', { count: receipt.closures_created })]
      : []),
  ];

  const handleContinue = () => {
    trackDialogComplete('import-receipt');
    closeDialog();
  };

  return (
    <DialogWrapper
      title={t('dialogs.importReceipt.title', {
        source: receipt.source_format,
        fileName: receipt.file_name,
      })}
      onClose={closeDialog}
      size="md"
      data-testid="import-receipt-dialog"
    >
      <div className="space-y-3">
        <ul className="space-y-1 text-sm text-text-primary">
          <li data-testid="import-receipt-summary">{summaryParts.join(' - ')}</li>
          {receipt.unit_conversion != null && (
            <li data-testid="import-receipt-unit-conversion">
              {t('dialogs.importReceipt.unitConversion', { conversion: receipt.unit_conversion })}
            </li>
          )}
        </ul>

        {visibleWarnings.length > 0 && (
          <ul className="space-y-1 text-sm text-warning" data-testid="import-receipt-warnings">
            {visibleWarnings.map((w, i) => (
              <li key={i}>&#9888; {w}</li>
            ))}
          </ul>
        )}

        {expanded && hasHiddenWarnings && (
          <ul className="space-y-1 text-sm text-warning" data-testid="import-receipt-warnings-more">
            {hiddenWarnings.map((w, i) => (
              <li key={i}>&#9888; {w}</li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          {hasHiddenWarnings && (
            <Button
              onClick={() => setExpanded((v) => !v)}
              data-testid="import-receipt-details"
            >
              {t('dialogs.importReceipt.viewDetails')}
            </Button>
          )}
          <Button variant="primary" onClick={handleContinue} data-testid="import-receipt-continue">
            {t('dialogs.importReceipt.continue')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
