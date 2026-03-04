import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { DmpFile, TmlFile, GpxFile } from '../../types/commands';

/**
 * New Project dialog variant used during the DMP/TML import flow.
 *
 * This dialog is shown when importing a file from the home screen (no project open).
 * After creating the project, it automatically opens the appropriate import dialog
 * to continue the import flow.
 */
export default function NewProjectForImportDialog() {
  const { closeDialog, dialogData, openDialog, setImportContext } = useUIStore();
  const { createProject } = useProjectStore();

  const dmpFile = dialogData.dmpFile as DmpFile | undefined;
  const tmlFile = dialogData.tmlFile as TmlFile | undefined;
  const gpxFile = dialogData.gpxFile as GpxFile | undefined;
  const filePath = dialogData.filePath as string | undefined;
  const importType = dialogData.importType as string | undefined;
  const defaultName = (dialogData.defaultName as string) || '';
  const isTml = importType === 'tml' || !!tmlFile;
  const isGpx = importType === 'gpx' || !!gpxFile;

  const [name, setName] = useState(defaultName);
  const [projectLocation, setProjectLocation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }

    if (!filePath || (!dmpFile && !tmlFile && !gpxFile)) {
      setError('Import file data is missing');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const result = await createProject(name.trim(), projectLocation.trim() || undefined);

      if (result.success) {
        closeDialog();
        if (isGpx && gpxFile) {
          // Open GPX selection dialog
          openDialog('gpx-selection', { gpxFile, filePath });
        } else if (isTml && tmlFile) {
          // Open TML import dialog
          openDialog('tml-import', { tmlFile, filePath });
        } else if (dmpFile) {
          // Open DMP selection dialog
          openDialog('dmp-selection', { dmpFile, filePath });
        }
      } else {
        setError(result.error ?? 'Failed to create project');
      }
    } catch (e) {
      setError(getErrorMessage(e, 'An error occurred'));
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
  const isDirty = name.trim() !== defaultName || projectLocation.trim() !== '';

  return (
    <DialogWrapper
      title="Create Project for Import"
      onClose={handleCancel}
      size="md"
      isDirty={isDirty}
      data-testid="new-project-for-import-dialog"
    >
      <div className="space-y-4">
        {/* Show info about the file being imported */}
        {dmpFile && (
          <div className="p-3 bg-accent-10 border border-accent-20 rounded text-sm">
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
        {tmlFile && (
          <div className="p-3 bg-accent-10 border border-accent-20 rounded text-sm">
            <div className="font-medium mb-1">Importing from Ariane survey:</div>
            <div className="text-text-secondary">
              {tmlFile.sections.length} sections •{' '}
              {tmlFile.sections.reduce((acc, s) => acc + s.shots.length, 0)} shots
              {tmlFile.cave_name ? ` • ${tmlFile.cave_name}` : ''}
            </div>
          </div>
        )}
        {gpxFile && (
          <div className="p-3 bg-accent-10 border border-accent-20 rounded text-sm">
            <div className="font-medium mb-1">Importing from GPX file:</div>
            <div className="text-text-secondary">
              {gpxFile.waypoints.length} waypoints •{' '}
              {gpxFile.tracks.length} tracks •{' '}
              {gpxFile.routes.length} routes
              {gpxFile.name ? ` • ${gpxFile.name}` : ''}
            </div>
          </div>
        )}

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
            data-testid="project-name-input"
          />
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">
            Location (optional)
          </label>
          <input
            type="text"
            value={projectLocation}
            onChange={(e) => setProjectLocation(e.target.value)}
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
