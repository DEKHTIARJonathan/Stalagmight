import { useEffect, useMemo, useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { getErrorMessage } from '../../utils/ipc';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { ensureExtension, projectSaveFilters, saveDialog, PROJECT_EXTENSION } from '../../utils/fileDialogs';
import type { DmpFile, TmlFile, GpxFile, CompassFile } from '../../types/commands';
import { setSource, trackDialogComplete, peekProjectActionSource, setProjectActionSource } from '../../utils/telemetry';

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
  const compassFile = dialogData.compassFile as CompassFile | undefined;
  const filePath = dialogData.filePath as string | undefined;
  const importType = dialogData.importType as string | undefined;
  const defaultName = (dialogData.defaultName as string) || '';
  const isTml = importType === 'tml' || !!tmlFile;
  const isGpx = importType === 'gpx' || !!gpxFile;
  const isCompass = importType === 'compass' || !!compassFile;

  const [name, setName] = useState(defaultName);
  const [projectLocation, setProjectLocation] = useState('');
  const [savePath, setSavePath] = useState('');
  const [documentsDir, setDocumentsDir] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const normalizedBaseName = useMemo(
    () => (name.trim() || defaultName || 'Project').replace(/[^a-zA-Z0-9]/g, '_'),
    [defaultName, name]
  );

  const joinPath = (base: string, child: string): string => {
    const separator = base.includes('\\') ? '\\' : '/';
    const trimmedBase = base.replace(/[\\/]+$/, '');
    return `${trimmedBase}${separator}${child}`;
  };

  const truncatePathFromLeft = (path: string, maxChars: number): string => {
    if (path.length <= maxChars) {
      return path;
    }
    return `...${path.slice(path.length - (maxChars - 3))}`;
  };

  const resolvedDefaultSavePath = useMemo(() => {
    if (!documentsDir) {
      return null;
    }
    return joinPath(joinPath(documentsDir, 'stalagmight'), `${normalizedBaseName}.stalx`);
  }, [documentsDir, normalizedBaseName]);

  const displayedDefaultSavePath = useMemo(() => {
    if (!resolvedDefaultSavePath) {
      return null;
    }
    return truncatePathFromLeft(resolvedDefaultSavePath, 40);
  }, [resolvedDefaultSavePath]);

  useEffect(() => {
    let active = true;
    const loadDocumentsDir = async () => {
      try {
        const { documentDir, homeDir } = await import('@tauri-apps/api/path');

        try {
          const dir = await documentDir();
          if (active && typeof dir === 'string' && dir.trim()) {
            setDocumentsDir(dir);
            return;
          }
        } catch {
          // Fall through to a best-effort home directory fallback.
        }

        const home = await homeDir();
        if (active && typeof home === 'string' && home.trim()) {
          setDocumentsDir(joinPath(home, 'Documents'));
        }
      } catch {
        // Optional enhancement only; keep path unset if resolution fails.
      }
    };
    void loadDocumentsDir();
    return () => {
      active = false;
    };
  }, []);

  const handleSelectSavePath = async () => {
    try {
      const selected = await saveDialog({
        title: 'Save Project',
        filters: projectSaveFilters(),
        defaultPath: savePath.trim() || resolvedDefaultSavePath || `${normalizedBaseName}.stalx`,
      });
      if (typeof selected === 'string' && selected.trim()) {
        setSavePath(ensureExtension(selected, PROJECT_EXTENSION));
      }
    } catch (e) {
      setError(getErrorMessage(e, 'Failed to open save dialog'));
    }
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Project name is required');
      return;
    }

    if (!filePath || (!dmpFile && !tmlFile && !gpxFile && !compassFile)) {
      setError('Import file data is missing');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      // Capture the entry-point source before createProject: its setView('single')
      // clears the pending project-action source, but the follow-up import command
      // in THIS same flow (import_sections / execute*Import) peeks the SAME source.
      // Re-arm it after the project is created so the import is attributed to the
      // same entry point as create_project_full (the import command clears it).
      const importSource = peekProjectActionSource();
      const result = await createProject(
        name.trim(),
        projectLocation.trim() || undefined,
        savePath.trim() ? { savePath: ensureExtension(savePath.trim(), PROJECT_EXTENSION) } : undefined
      );

      if (result.success) {
        if (importSource) setProjectActionSource(importSource);
        trackDialogComplete('new-project-for-import');
        closeDialog();
        if (isGpx && gpxFile) {
          // Open GPX selection dialog
          setSource('dialog');
          openDialog('gpx-selection', { gpxFile, filePath });
        } else if (isTml && tmlFile) {
          // Open TML import dialog
          setSource('dialog');
          openDialog('tml-import', { tmlFile, filePath });
        } else if (isCompass && compassFile) {
          // Open Compass import dialog
          setSource('dialog');
          openDialog('compass-import', { compassFile, filePath });
        } else if (dmpFile) {
          // Open DMP selection dialog
          setSource('dialog');
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
  const isDirty =
    name.trim() !== defaultName ||
    projectLocation.trim() !== '' ||
    savePath.trim() !== '';

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
        {compassFile && (
          <div className="p-3 bg-accent-10 border border-accent-20 rounded text-sm">
            <div className="font-medium mb-1">Importing from Compass survey:</div>
            <div className="text-text-secondary">
              {compassFile.survey_count} surveys •{' '}
              {compassFile.shot_count} shots
              {compassFile.cave_name ? ` • ${compassFile.cave_name}` : ''}
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
            Project File Path (optional)
          </label>
          <div className="flex gap-2" data-testid="project-save-path-controls">
            <input
              type="text"
              value={savePath}
              onChange={(e) => setSavePath(e.target.value)}
              className="w-full"
              placeholder={displayedDefaultSavePath || `${normalizedBaseName}.stalx`}
              data-testid="project-save-path-input"
            />
            <Button
              onClick={handleSelectSavePath}
              disabled={isCreating}
              data-testid="project-save-path-browse-button"
            >
              Browse...
            </Button>
          </div>
        </div>

        <div>
          <label className="block text-sm text-text-secondary mb-1">
            Cave Location (optional)
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
