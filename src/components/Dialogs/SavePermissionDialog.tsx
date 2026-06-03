import { useCallback, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useUIStore } from '../../store/uiStore';
import { isMac } from '../../utils/shortcuts';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete } from '../../utils/telemetry';

// Deep-link to macOS System Settings → Privacy & Security → Files and Folders.
const MAC_PRIVACY_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/**
 * Shown when the OS denies filesystem access to a project file — most often
 * because macOS reset previously-granted folder access after an update. Gives
 * actionable guidance instead of the misleading "corrupted database" / raw OS
 * error the user would otherwise see (#39).
 */
export default function SavePermissionDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const mac = isMac();
  const context = dialogData.context === 'open' ? 'open' : 'save';
  const [opening, setOpening] = useState(false);

  const handleClose = useCallback(() => {
    trackDialogComplete('save-permission');
    closeDialog();
  }, [closeDialog]);

  const handleOpenSettings = useCallback(async () => {
    setOpening(true);
    try {
      await openUrl(MAC_PRIVACY_URL);
    } catch {
      /* best-effort; the written steps still guide the user */
    } finally {
      setOpening(false);
    }
  }, []);

  const action = context === 'open' ? 'open this project' : 'save your changes';

  return (
    <DialogWrapper title="Folder Access Needed" onClose={handleClose} size="md" data-testid="save-permission-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary">
          Stalagmight couldn&apos;t {action} because the system denied access to the folder.
          This usually happens after a macOS or app update, which can reset previously-granted
          folder permissions. <span className="text-text-primary">Your data is not corrupted.</span>
        </p>

        {mac ? (
          <div className="p-3 bg-surface-alt rounded text-sm text-text-secondary space-y-1">
            <p className="text-text-primary font-medium">To fix it:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>
                Open <span className="text-text-primary">System Settings → Privacy &amp; Security → Files and Folders</span>
                {' '}(or Full Disk Access).
              </li>
              <li>
                Enable access for <span className="text-text-primary">Stalagmight</span> to the folder where your
                {' '}<code>.stalx</code> files live (often Downloads or Documents).
              </li>
              <li>Restart Stalagmight and try again.</li>
            </ol>
          </div>
        ) : (
          <div className="p-3 bg-surface-alt rounded text-sm text-text-secondary">
            Check that Stalagmight has permission to read and write the folder where your
            {' '}<code>.stalx</code> files are stored, then restart the app and try again.
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          {mac && (
            <Button onClick={handleOpenSettings} disabled={opening}>
              {opening ? 'Opening…' : 'Open Privacy & Security'}
            </Button>
          )}
          <Button variant="primary" onClick={handleClose}>OK</Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
