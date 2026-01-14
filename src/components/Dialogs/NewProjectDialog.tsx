import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';

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
            filters: [{ name: 'CaveChef Project', extensions: ['cvproj'] }],
            defaultPath: `${name.replace(/[^a-zA-Z0-9]/g, '_')}.cvproj`,
          });

          if (path) {
            await saveProject(path);
          }
        }

        // Switch to single system view
        setView('single');
        closeDialog();
      } else {
        setError(result.error ?? 'Failed to create project');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'An error occurred');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <DialogWrapper title="New Project" onClose={closeDialog}>
      <div className="space-y-4">
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
            autoFocus
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
          />
        </div>

        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="saveImmediately"
            checked={saveImmediately}
            onChange={(e) => setSaveImmediately(e.target.checked)}
            className="rounded"
          />
          <label htmlFor="saveImmediately" className="text-sm">
            Save project file immediately
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isCreating}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleCreate}
            disabled={isCreating || !name.trim()}
          >
            {isCreating ? 'Creating...' : 'Create Project'}
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
            ×
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
