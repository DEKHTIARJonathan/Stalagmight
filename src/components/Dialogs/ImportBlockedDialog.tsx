import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { trackDialogComplete } from '../../utils/telemetry';
import { routeOpenedFile } from '../../utils/openOrImport';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Raised when a DMP import is picked while Plan/Export mode makes the survey
 * read-only (#243, reworded per #407 follow-up). Not an error - the user made a
 * valid request one mode away from working - so it offers the fix instead of
 * reporting a failure: "Switch to Survey" flips the mode and CONTINUES the
 * import of the already-picked file; "Stay in Plan/Export" abandons it.
 *
 * Only the pure mode-blocked case routes here. The other read-only causes
 * (closure-adjusted view, a missing SpeleoDB write lock, and compound states)
 * keep the plain error dialog: their fixes aren't one safe click.
 */
export default function ImportBlockedDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const setAppMode = useUIStore((s) => s.setAppMode);
  const dialogData = useUIStore((s) => s.dialogData);
  const appMode = useUIStore((s) => s.appMode);

  const rawPath = dialogData.path;
  const path = typeof rawPath === 'string' ? rawPath : null;

  const handleSwitch = useCallback(() => {
    // Completing (not cancelling) keeps the entry-point telemetry source alive
    // for the DMP flow the re-route below hands off to.
    trackDialogComplete('import-blocked');
    closeDialog();
    setAppMode('survey');
    // setAppMode restored the pre-Plan/Export survey view, which may be the
    // read-only closure-adjusted one. The user just asked for an import, so
    // silently drop to the measured view instead of bouncing the confirmed
    // import off the next read-only cause (same setter as the DisplayMenu
    // toggle, so the switch persists as the remembered view and clears the
    // geometry-dependent caches).
    const ui = useUIStore.getState();
    if (ui.geometryMode === 'closureAdjusted') ui.setGeometryMode('measured');
    // Re-route the SAME picked file now that mode and view allow it. The
    // router re-checks every guard; the one cause a switch cannot fix (a
    // missing SpeleoDB write lock) surfaces as a TOAST, not a second modal -
    // the user just confirmed intent here, so no further click is owed.
    if (path) void routeOpenedFile(path, 'Import Failed', { residualReadOnlyToast: true });
  }, [closeDialog, setAppMode, path]);

  // Closing without switching abandons the import; closeDialog's cancel hook
  // drops the pending telemetry source.
  const handleStay = useCallback(() => {
    closeDialog();
  }, [closeDialog]);

  const stayLabel =
    appMode === 'export'
      ? t('dialogs.importBlocked.stayInExport')
      : t('dialogs.importBlocked.stayInPlan');

  return (
    <DialogWrapper
      title={t('dialogs.importBlocked.title')}
      onClose={handleStay}
      size="md"
      data-testid="import-blocked-dialog"
    >
      <div className="space-y-4">
        <p className="text-text-secondary">{t('dialogs.importBlocked.body')}</p>
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleStay} data-testid="import-blocked-stay">
            {stayLabel}
          </Button>
          <Button variant="primary" onClick={handleSwitch} data-testid="import-blocked-switch">
            {t('dialogs.importBlocked.switchToSurvey')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
