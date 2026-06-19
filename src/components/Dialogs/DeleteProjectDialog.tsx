import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';

/**
 * Destructive confirm for permanently deleting a project from disk (#118).
 *
 * Distinct from "Remove from recent" (which only forgets the entry): this hands
 * the project's files to the OS delete — the Trash where the platform provides
 * one, otherwise a permanent remove. Opened via
 * `openDialog('delete-project', { path, name })` from the GlobalView context menu
 * and the metadata panel.
 *
 * Mirrors OverwriteConfirmDialog (literal copy, no i18n) to match the sibling
 * confirm dialogs. Cancel takes default focus (not Delete) since the action is
 * irreversible.
 */
export default function DeleteProjectDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { deleteProject } = useProjectStore();
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const path = dialogData.path as string | undefined;
  // Prefer the display name passed by the opener; fall back to the file stem.
  const name =
    (dialogData.name as string | undefined) ||
    path?.split(/[\\/]/).pop()?.replace(/\.stalx$/i, '') ||
    'this project';

  // Name the actual files the backend will remove, by full path: the .stalx, plus
  // its .tml collab sibling when the project is collab-enabled.
  const collabEnabled = Boolean(dialogData.collabEnabled);
  const tmlPath = path?.replace(/\.stalx$/i, '.tml');
  const fileNames = path
    ? collabEnabled && tmlPath && tmlPath !== path
      ? `${path} and ${tmlPath}`
      : path
    : name;

  const handleConfirm = async () => {
    if (!path) {
      closeDialog();
      return;
    }
    setIsDeleting(true);
    setError(null);
    const result = await deleteProject(path);
    if (result.success) {
      closeDialog();
      return;
    }
    // Keep the dialog open so the user sees why it failed and can retry/cancel.
    setIsDeleting(false);
    setError(result.error ?? 'Failed to delete project.');
  };

  return (
    <DialogWrapper title="Delete Project?" onClose={closeDialog} size="md" data-testid="delete-project-dialog">
      <div className="space-y-4">
        <p className="text-text-secondary">
          Permanently delete <span className="font-medium text-text-primary">{name}</span>?
        </p>

        <div className="p-3 bg-warning-10 border border-warning-20 rounded text-warning text-sm">
          This removes the project files{' '}
          <span className="font-medium break-all">{fileNames}</span> from disk. It cannot be undone.
        </div>

        {error && (
          <div className="text-error text-sm" data-testid="delete-project-error">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isDeleting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            disabled={isDeleting || !path}
            data-testid="delete-project-confirm"
          >
            {isDeleting ? 'Deleting...' : 'Delete Project'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
