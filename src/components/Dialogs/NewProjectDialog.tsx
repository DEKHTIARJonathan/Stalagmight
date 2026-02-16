import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { ensureExtension, projectSaveFilters, PROJECT_EXTENSION } from '../../utils/fileDialogs';

export default function NewProjectDialog() {
  const { closeDialog } = useUIStore();
  const { setView } = useUIStore();
  const { createProject, saveProject } = useProjectStore();

  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [saveImmediately, setSaveImmediately] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const result = await createProject(name.trim(), location.trim() || undefined);

      if (result.success) {
        if (saveImmediately) {
          // Open save dialog (use save, not open, to allow entering custom filename)
          const { save } = await import('@tauri-apps/plugin-dialog');
          const path = await save({
            title: 'Save Project',
            filters: projectSaveFilters(),
            defaultPath: `${name.replace(/[^a-zA-Z0-9]/g, '_')}.stalx`,
          });

          if (path) {
            const finalPath = ensureExtension(path, PROJECT_EXTENSION);
            await saveProject(finalPath);
          }
        }

        // Switch to single system view
        setView('single');
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to create project');
      }
    } catch (e) {
      setError(getErrorMessage(e, 'An error occurred'));
    } finally {
      setIsCreating(false);
    }
  };

  // Track if form has been modified
  const isDirty = name.trim() !== '' || location.trim() !== '' || saveImmediately;

  return (
    <DialogWrapper title="New Project" onClose={closeDialog} size="md" isDirty={isDirty} data-testid="new-project-dialog">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error-10 border border-error-20 rounded text-error text-sm">
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
            data-testid="new-project-name-input"
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
            data-testid="new-project-location-input"
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="saveImmediately"
            checked={saveImmediately}
            onChange={(e) => setSaveImmediately(e.target.checked)}
            className="rounded"
            data-testid="new-project-save-immediately"
          />
          <label htmlFor="saveImmediately" className="text-sm">
            Save project file immediately
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isCreating} data-testid="new-project-cancel-button">
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={isCreating || !name.trim()}
            data-testid="new-project-create-button"
          >
            {isCreating ? 'Creating...' : 'Create Project'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}
