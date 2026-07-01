import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore } from '../../store/uiStore';
import { convertToUnmanagedStalx } from '../../utils/projectActions';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * No-permission prompt (#204, fix 10): raised from the red-exclamation status
 * button when the open project is SpeleoDB-managed but the server refused this
 * user access (a 403 - e.g. a managed `.stalx` shared with them as a bare file).
 * There is nothing to view or edit on SpeleoDB, so the only offer is converting it
 * to a plain unmanaged local `.stalx` they can keep and edit (Save-As + unlink).
 */
export default function SpeleoNoPermissionDialog() {
  const { t } = useTranslation();
  const closeDialog = useUIStore((s) => s.closeDialog);
  const [converting, setConverting] = useState(false);

  const convert = async () => {
    setConverting(true);
    try {
      if (await convertToUnmanagedStalx()) closeDialog();
    } finally {
      setConverting(false);
    }
  };

  return (
    <DialogWrapper
      title={t('speleodb.noPermission.title')}
      onClose={closeDialog}
      size="md"
      data-testid="speleodb-no-permission-dialog"
    >
      <div className="space-y-4">
        <p className="text-sm text-text-secondary">{t('speleodb.noPermission.description')}</p>
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <Button onClick={closeDialog} disabled={converting} data-testid="speleodb-no-permission-cancel">
            {t('common.actions.cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={() => void convert()}
            disabled={converting}
            data-testid="speleodb-no-permission-convert"
          >
            {converting ? t('speleodb.noPermission.converting') : t('speleodb.noPermission.convert')}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
