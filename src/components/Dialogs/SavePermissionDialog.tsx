import { useCallback, useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useUIStore } from '../../store/uiStore';
import { isMac } from '../../utils/shortcuts';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { trackDialogComplete } from '../../utils/telemetry';

/** The Full Disk Access pane - step 1 of the written remediation below. The
 *  scheme is granted explicitly in `src-tauri/capabilities/default.json`
 *  (`opener:allow-open-url`); without that grant `openUrl` rejects, which the
 *  button surfaces rather than silently no-ops. */
const MACOS_PRIVACY_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/**
 * Shown when the OS denies filesystem access to a project file - most often
 * because macOS reset previously-granted folder access after an update. Gives
 * actionable guidance instead of the misleading "corrupted database" / raw OS
 * error the user would otherwise see (#39).
 *
 * The fix lives outside the app (System Settings), so on macOS the dialog
 * carries a deep-link button - the power user has already left; this button
 * exists for the user who needs their hand held to the right pane.
 */
export default function SavePermissionDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const mac = isMac();
  const context = dialogData.context === 'open' ? 'open' : 'save';

  const handleClose = useCallback(() => {
    trackDialogComplete('save-permission');
    closeDialog();
  }, [closeDialog]);

  const [settingsOpenFailed, setSettingsOpenFailed] = useState(false);
  const handleOpenSettings = useCallback(() => {
    // A user-initiated "take me there" that silently does nothing is worse
    // than no button (same rule as useSpeleoWebLink) - fall back to naming
    // the manual path inline; the numbered steps above it stay authoritative.
    void openUrl(MACOS_PRIVACY_SETTINGS_URL).catch(() => setSettingsOpenFailed(true));
  }, []);

  const action = context === 'open' ? 'open this project' : 'save your changes';

  return (
    <DialogWrapper title="Folder Access Needed" onClose={handleClose} size="md" data-testid="save-permission-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary">
          Stalagmight couldn&apos;t {action} because the system denied access to the folder.
          {' '}
          {mac
            ? 'This usually happens after a macOS or app update, which can reset previously-granted folder permissions.'
            : 'This usually happens when the folder is read-only, is owned by another account, or is held by security software.'}
          {' '}<span className="text-text-primary">Your data is not corrupted.</span>
        </p>

        {mac ? (
          <div className="p-3 bg-surface-alt rounded text-sm text-text-secondary space-y-1">
            <p className="text-text-primary font-medium">To fix it:</p>
            <ol className="list-decimal list-inside space-y-1">
              <li>
                Open <span className="text-text-primary">System Settings → Privacy &amp; Security → Full Disk Access</span>
                {' '}(or Files and Folders).
              </li>
              <li>
                Enable access for <span className="text-text-primary">Stalagmight</span>, including the folder where your
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

        {settingsOpenFailed && (
          <p className="text-sm text-warning" data-testid="save-permission-open-settings-failed">
            Couldn&apos;t open System Settings - open it from the Apple menu, then follow the steps above.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          {mac && (
            <Button onClick={handleOpenSettings} data-testid="save-permission-open-settings">
              Open System Settings
            </Button>
          )}
          <Button variant="primary" onClick={handleClose} data-testid="save-permission-close">OK</Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
