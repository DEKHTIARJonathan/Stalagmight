import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

export default function UnsavedChangesDialog() {
  const { closeDialog, setView } = useUIStore();
  const { closeProject } = useProjectStore();

  const handleDiscard = async () => {
    // Concurrency guard is handled at store level (store.isClosing)
    // This prevents double-click and race conditions with Back button
    closeDialog();
    const result = await closeProject();
    if (result.success) {
      setView('global');
    }
  };

  const handleCancel = () => {
    closeDialog();
  };

  return (
    <DialogWrapper title="Unsaved Changes" onClose={handleCancel} size="md" data-testid="unsaved-changes-dialog">
      <div className="space-y-4">
        <p>You have unsaved changes. Are you sure you want to go back?</p>
        <p className="text-text-secondary text-sm">Your changes will be lost.</p>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleCancel}>Cancel</Button>
          <Button variant="danger" onClick={handleDiscard}>
            Discard Changes
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
