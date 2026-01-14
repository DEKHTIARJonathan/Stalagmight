import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import type { StationRef } from '../../types/project';

export default function ConfirmDialog() {
  const { closeDialog, dialogData, clearSelection } = useUIStore();
  const { deleteShot, deleteSection } = useProjectStore();

  const type = dialogData.type as 'station' | 'shot' | 'section' | undefined;
  const message = dialogData.message as string | undefined;
  const stationRef = dialogData.stationRef as StationRef | undefined;
  const sectionId = dialogData.sectionId as number | undefined;
  const shotId = dialogData.shotId as number | undefined;

  const handleConfirm = async () => {
    if (type === 'shot' && sectionId !== undefined && shotId !== undefined) {
      await deleteShot(sectionId, shotId);
      clearSelection();
    } else if (type === 'section' && sectionId !== undefined) {
      await deleteSection(sectionId);
      clearSelection();
    } else if (type === 'station' && stationRef) {
      // Deleting a station requires deleting connected shots
      // For now, show a message that this is not directly supported
      // The user should delete the shots instead
    }
    closeDialog();
  };

  const getTitle = () => {
    switch (type) {
      case 'station':
        return 'Delete Station';
      case 'shot':
        return 'Delete Shot';
      case 'section':
        return 'Delete Section';
      default:
        return 'Confirm';
    }
  };

  const getDefaultMessage = () => {
    switch (type) {
      case 'station':
        return 'Deleting a station will delete all connected shots. Are you sure?';
      case 'shot':
        return 'Are you sure you want to delete this shot?';
      case 'section':
        return 'Are you sure you want to delete this section and all its shots?';
      default:
        return 'Are you sure?';
    }
  };

  return (
    <DialogWrapper title={getTitle()} onClose={closeDialog}>
      <div className="space-y-4">
        <p className="text-text-secondary">{message ?? getDefaultMessage()}</p>

        {type === 'station' && (
          <div className="p-3 bg-warning/10 border border-warning/20 rounded text-warning text-sm">
            Note: To delete a station, delete the shots connected to it instead.
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="danger" onClick={handleConfirm} disabled={type === 'station'}>
            Delete
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}

interface DialogWrapperProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

function DialogWrapper({ title, onClose, children }: DialogWrapperProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-panel border border-border rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-medium">{title}</h2>
          <button
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary text-xl"
          >
            x
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
