import { useUIStore } from '../../store/uiStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

export default function ErrorDialog() {
  const { closeDialog, dialogData } = useUIStore();

  const message = dialogData.message as string | undefined;
  const title = (dialogData.title as string | undefined) ?? 'Error';

  return (
    <DialogWrapper title={title} onClose={closeDialog} size="md" data-testid="error-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary">{message ?? 'An error occurred.'}</p>

        <div className="flex justify-end pt-4 border-t border-border">
          <Button onClick={closeDialog}>OK</Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
