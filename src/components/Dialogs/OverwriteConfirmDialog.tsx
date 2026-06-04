import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete } from '../../utils/telemetry';
import { surfaceSaveFailure } from '../../utils/saveFeedback';

export default function OverwriteConfirmDialog() {
  const { closeDialog, dialogData, openDialog: showDialog } = useUIStore();
  const { saveProject } = useProjectStore();
  const [isLoading, setIsLoading] = useState(false);

  const path = dialogData.path as string | undefined;
  const fileName = dialogData.fileName as string | undefined;

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
        trackDialogComplete('confirm-overwrite');
        closeDialog();
        surfaceSaveFailure(result.error, showDialog);
      } else {
        trackDialogComplete('confirm-overwrite');
        closeDialog();
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
