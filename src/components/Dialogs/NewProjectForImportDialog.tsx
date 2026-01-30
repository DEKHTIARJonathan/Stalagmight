import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { DmpFile } from '../../types/commands';

/**
 * New Project dialog variant used during the DMP import flow.
 *
 * This dialog is shown when importing a DMP file from the home screen (no project open).
 * After creating the project, it automatically opens the DmpSelectionDialog to continue
 * the import flow.
 */
export default function NewProjectForImportDialog() {
  const { closeDialog, dialogData, openDialog, setImportContext } = useUIStore();
  const { createProject } = useProjectStore();

  const dmpFile = dialogData.dmpFile as DmpFile | undefined;
  const filePath = dialogData.filePath as string | undefined;
  const defaultName = (dialogData.defaultName as string) || '';

  const [name, setName] = useState(defaultName);
  const [location, setLocation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }

    if (!dmpFile || !filePath) {
      setError('DMP file data is missing');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const result = await createProject(name.trim(), location.trim() || undefined);

      if (result.success) {
        // Close this dialog and open the DmpSelectionDialog
        closeDialog();
        openDialog('dmp-selection', {
          dmpFile,
          filePath,
        });
      } else {
        setError(result.error ?? 'Failed to create project');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    } finally {
      setIsCreating(false);
    }
  };

  const handleCancel = () => {
    // Clear import context when canceling
    setImportContext(null);
    closeDialog();
  };

  // Track if form has been modified from defaults
  const isDirty = name.trim() !== defaultName || location.trim() !== '';

  return (
    <DialogWrapper
      title="Create Project for Import"
      onClose={handleCancel}
      size="md"
      isDirty={isDirty}
      data-testid="new-project-for-import-dialog"
    >
      <div className="space-y-4">
        {/* Show info about the DMP file being imported */}
        {dmpFile && (
          <div className="p-3 bg-accent/10 border border-accent/20 rounded text-sm">
            <div className="font-medium mb-1">Importing from DMP file:</div>
            <div className="text-text-secondary">
              {dmpFile.sections.length} sections •{' '}
              {dmpFile.sections.reduce(
                (acc, s) => acc + s.shots.filter((sh) => sh.shot_type === 'Standard').length,
                0
              )}{' '}
              shots
            </div>
          </div>
        )}

        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm">
            {error}
          </div>
        )}

        <div>
          <label className="block text-sm text-text-secondary mb-1">
            Project Name *
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full"
            placeholder="e.g., Lechuguilla Cave"
            data-testid="project-name-input"
          />
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">
            Location (optional)
          </label>
          <input
            type="text"
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            className="w-full"
            placeholder="e.g., Carlsbad Caverns National Park, NM"
            data-testid="project-location-input"
          />
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={handleCancel} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={isCreating || !name.trim()}
            data-testid="create-and-continue-button"
          >
            {isCreating ? 'Creating...' : 'Create & Continue'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
