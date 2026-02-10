import { useTranslation } from 'react-i18next';
import { DialogWrapper } from './DialogWrapper';
import { Button } from '../common/Button';

interface DmpNewImportDialogProps {
  onCancel: () => void;
  onBack: () => void;
}

/**
 * Placeholder dialog for the new DMP import workflow.
 * Shown when "Use legacy DMP import" is disabled in Advanced settings.
 */
export default function DmpNewImportDialog({ onCancel, onBack }: DmpNewImportDialogProps) {
  const { t } = useTranslation();

  return (
    <DialogWrapper
      title={t('dialogs.dmpNewImport.title')}
      onClose={onCancel}
      size="md"
      data-testid="dmp-new-import-dialog"
    >
      <div className="space-y-4">
        <p className="text-text-secondary">{t('dialogs.dmpNewImport.body')}</p>
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button variant="secondary" onClick={onBack} data-testid="dmp-new-import-back">
            {t('common.actions.back')}
          </Button>
          <Button variant="secondary" onClick={onCancel} data-testid="dmp-new-import-cancel">
            {t('common.actions.cancel')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
