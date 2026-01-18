import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Dialog shown when a user attempts to import a DMP file that has already
 * been imported in the current session. Allows the user to confirm the
 * duplicate import or cancel.
 */
export default function DuplicateImportDialog() {
  const { closeDialog, dialogData, openDialog, setImportContext, addImportedDmpPath } = useUIStore();
  const { importDmp } = useProjectStore();

  const filePath = dialogData.filePath as string | undefined;
  const fileName = filePath?.split(/[/\\]/).pop() ?? 'Unknown';

  const [isLoading, setIsLoading] = useState(false);

  const handleConfirm = async () => {
    if (!filePath) {
      closeDialog();
      return;
    }

    setIsLoading(true);
    try {
      const dmpFile = await importDmp(filePath);
      if (!dmpFile) {
        closeDialog();
        return;
      }

      // Track this file as imported (again)
      addImportedDmpPath(filePath);

      // Close this dialog and open the selection dialog
      closeDialog();
      setImportContext('existing-project');
      openDialog('dmp-selection', {
        dmpFile,
        filePath,
      });
    } catch (e) {
      closeDialog();
      openDialog('error', {
        title: 'Import Failed',
        message: e instanceof Error ? e.message : 'Failed to parse DMP file',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DialogWrapper
      title="Duplicate Import"
      onClose={closeDialog}
      size="md"
      data-testid="duplicate-import-dialog"
    >
      <div className="space-y-4">
        <p className="text-text-secondary">
          The file <span className="font-mono text-text-primary">{fileName}</span> has already been imported
          in this session.
        </p>

        <div className="p-3 bg-warning/10 border border-warning/20 rounded text-warning text-sm">
          Re-importing the same file may create duplicate sections.
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={isLoading}
            data-testid="confirm-duplicate-import-button"
          >
            {isLoading ? 'Loading...' : 'Import Anyway'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
