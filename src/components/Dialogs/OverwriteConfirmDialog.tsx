import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { useProject } from '../../hooks/useProject';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete } from '../../utils/telemetry';
import { surfaceSaveFailure } from '../../utils/saveFeedback';
import { isPermissionError } from '../../utils/saveErrors';

export default function OverwriteConfirmDialog() {
  const { closeDialog, dialogData, openDialog: showDialog } = useUIStore();
  const { saveProject } = useProjectStore();
  const { handleCloseProject } = useProject();
  const [isLoading, setIsLoading] = useState(false);

  const path = dialogData.path as string | undefined;
  const fileName = dialogData.fileName as string | undefined;
  // "Save and Close" defers here when the chosen file exists; once the overwrite
  // saves, finish the close it started (otherwise the close half is dropped).
  const closeAfterSave = dialogData.closeAfterSave === true;

  const handleConfirm = async () => {
    if (!path) {
      trackDialogComplete('confirm-overwrite');
      closeDialog();
      return;
    }

    setIsLoading(true);
    try {
      const result = await saveProject(path);
      if (result && !result.success && result.error) {
        // On a permission error, saveProject has already opened the folder-access
        // guidance dialog; don't close it, stack a generic error, or record the
        // overwrite as completed (it was superseded by the guidance dialog).
        if (isPermissionError(result.error)) {
          return;
        }
        trackDialogComplete('confirm-overwrite');
        closeDialog();
        surfaceSaveFailure(result.error, showDialog);
      } else {
        // Save succeeded.
        trackDialogComplete('confirm-overwrite');
        closeDialog();
        if (closeAfterSave) {
          // Project is now saved (not dirty), so this closes straight to GlobalView.
          void handleCloseProject();
        }
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DialogWrapper title="Overwrite File?" onClose={closeDialog} size="md" data-testid="overwrite-confirm-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary">
          A file named <span className="font-medium text-text-primary">{fileName}</span> already exists.
          Do you want to replace it?
        </p>

        <div className="p-3 bg-warning-10 border border-warning-20 rounded text-warning text-sm">
          This will overwrite the existing file. This action cannot be undone.
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={isLoading} data-primary-action="">
            {isLoading ? 'Saving...' : 'Overwrite'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
