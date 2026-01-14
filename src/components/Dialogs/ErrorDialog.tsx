import { useUIStore } from '../../store/uiStore';
import { Button } from '../common/Button';

export default function ErrorDialog() {
  const { closeDialog, dialogData } = useUIStore();

  const message = dialogData.message as string | undefined;
  const title = (dialogData.title as string | undefined) ?? 'Error';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={closeDialog} />
      <div className="relative bg-panel border border-border rounded-lg shadow-xl max-w-md w-full mx-4">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-lg font-medium text-error">{title}</h2>
          <button
            onClick={closeDialog}
            className="text-text-secondary hover:text-text-primary text-xl"
          >
            x
          </button>
        </div>
        <div className="p-4">
          <div className="space-y-4">
            <p className="text-text-secondary">{message ?? 'An error occurred.'}</p>

            <div className="flex justify-end pt-4 border-t border-border">
              <Button onClick={closeDialog}>OK</Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
