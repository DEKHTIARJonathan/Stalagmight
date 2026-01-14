import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';

export default function UnsavedChangesDialog() {
  const { closeDialog, setView } = useUIStore();
  const { closeProject } = useProjectStore();

  const handleDiscard = async () => {
    closeDialog();
    await closeProject();
    setView('global');
  };

  const handleCancel = () => {
    closeDialog();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={handleCancel} />
      <div className="relative bg-panel border border-border rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-medium">Unsaved Changes</h2>
          <button
            onClick={handleCancel}
            className="text-text-secondary hover:text-text-primary text-xl"
          >
            x
          </button>
        </div>
        <div className="p-4 space-y-4">
          <p>You have unsaved changes. Are you sure you want to go back?</p>
          <p className="text-text-secondary text-sm">Your changes will be lost.</p>

          <div className="flex justify-end gap-2 pt-4 border-t border-border">
            <Button onClick={handleCancel}>Cancel</Button>
            <Button variant="danger" onClick={handleDiscard}>
              Discard Changes
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
