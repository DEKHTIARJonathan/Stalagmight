import { useState, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import type { DmpFile } from '../../types/commands';
import { getNextSectionColor } from '../../utils/colors';

interface DmpImportDialogProps {
  filePath?: string;
}

export default function DmpImportDialog({ filePath: initialPath }: DmpImportDialogProps) {
  const { closeDialog, dialogData } = useUIStore();
  const { importDmp, createSection, createProject, project } = useProjectStore();
  const { setView } = useUIStore();

  const [filePath, setFilePath] = useState<string>(initialPath ?? (dialogData.filePath as string) ?? '');
  const [dmpFile, setDmpFile] = useState<DmpFile | null>(null);
  const [selectedSections, setSelectedSections] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createNewProject, setCreateNewProject] = useState(!project);
  const [newProjectName, setNewProjectName] = useState('');

  // Auto-load if file path provided
  useEffect(() => {
    if (filePath && !dmpFile) {
      handleLoadFile();
    }
  }, []);

  const handleBrowse = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const path = await open({
        title: 'Select DMP File',
        filters: [{ name: 'mNemo DMP Files', extensions: ['dmp', 'DMP'] }],
      });

      if (path && typeof path === 'string') {
        setFilePath(path);
        setDmpFile(null);
        setSelectedSections(new Set());
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open file dialog');
    }
  };

  const handleLoadFile = async () => {
    if (!filePath) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await importDmp(filePath);
      setDmpFile(result);
      // Select all sections by default
      setSelectedSections(new Set(result.sections.map((_, i) => i)));
      // Use filename as default project name
      const fileName = filePath.split(/[/\\]/).pop()?.replace('.dmp', '') ?? 'Imported';
      setNewProjectName(fileName);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse DMP file');
      setDmpFile(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggleSection = (index: number) => {
    const newSelected = new Set(selectedSections);
    if (newSelected.has(index)) {
      newSelected.delete(index);
    } else {
      newSelected.add(index);
    }
    setSelectedSections(newSelected);
  };

  const handleSelectAll = () => {
    if (dmpFile) {
      setSelectedSections(new Set(dmpFile.sections.map((_, i) => i)));
    }
  };

  const handleSelectNone = () => {
    setSelectedSections(new Set());
  };

  const handleImport = async () => {
    if (!dmpFile || selectedSections.size === 0) return;

    setIsLoading(true);
    setError(null);

    try {
      // Create new project if needed
      if (createNewProject || !project) {
        const result = await createProject(newProjectName || 'Imported Project');
        if (!result.success) {
          setError(result.error ?? 'Failed to create project');
          return;
        }
      }

      // Get existing colors to avoid duplicates
      const usedColors = project?.sections.map((s) => s.color) ?? [];

      // Import selected sections
      for (const index of Array.from(selectedSections).sort()) {
        const section = dmpFile.sections[index];
        if (!section) continue;

        // Get next available color
        const color = getNextSectionColor(usedColors);
        usedColors.push(color);

        // Convert DMP section to our format
        const standardShots = section.shots.filter((s) => s.shot_type === 'Standard');
        const dateStr = section.date?.split(' ')[0];
        await createSection({
          name: section.name,
          surveyor: null,
          date: dateStr ?? null, // Extract date part
          color,
          shots: standardShots.map((shot) => ({
            azimuth_in: shot.heading_in,
            azimuth_out: shot.heading_out,
            length: shot.length,
            depth_in: shot.depth_in,
            depth_out: shot.depth_out,
            pitch_in: shot.pitch_in,
            pitch_out: shot.pitch_out,
            left: shot.left,
            right: shot.right,
            up: shot.up,
            down: shot.down,
            is_virtual: false,
            marker_index: shot.marker_index,
            temperature: shot.temperature,
          })),
        });
      }

      setView('single');
      closeDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import sections');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <DialogWrapper title="Import DMP File" onClose={closeDialog}>
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm">
            {error}
          </div>
        )}

        {/* File selection */}
        <div>
          <label className="block text-sm text-text-secondary mb-1">
            DMP File
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              className="flex-1"
              placeholder="/path/to/survey.dmp"
              readOnly
            />
            <Button onClick={handleBrowse}>Browse...</Button>
          </div>
        </div>

        {filePath && !dmpFile && (
          <Button onClick={handleLoadFile} disabled={isLoading}>
            {isLoading ? 'Loading...' : 'Load File'}
          </Button>
        )}

        {/* File info */}
        {dmpFile && (
          <>
            <div className="text-sm text-text-secondary">
              Version {dmpFile.version} • {dmpFile.sections.length} sections •{' '}
              {dmpFile.sections.reduce((acc, s) => acc + s.shots.filter(sh => sh.shot_type === 'Standard').length, 0)} shots
            </div>

            {/* Project options */}
            <div className="space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={!createNewProject && !!project}
                  onChange={() => setCreateNewProject(false)}
                  disabled={!project}
                />
                <span className={!project ? 'text-text-secondary' : ''}>
                  Add to current project{project ? ` (${project.name})` : ' (no project open)'}
                </span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={createNewProject || !project}
                  onChange={() => setCreateNewProject(true)}
                />
                <span>Create new project</span>
              </label>
              {(createNewProject || !project) && (
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  className="w-full ml-6"
                  placeholder="Project name"
                />
              )}
            </div>

            {/* Section selection */}
            <Panel
              title={`Sections (${selectedSections.size}/${dmpFile.sections.length} selected)`}
              headerActions={
                <div className="flex gap-2 text-sm">
                  <button onClick={handleSelectAll} className="text-accent">
                    All
                  </button>
                  <button onClick={handleSelectNone} className="text-accent">
                    None
                  </button>
                </div>
              }
            >
              <div className="max-h-48 overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="w-8"></th>
                      <th className="text-left">Name</th>
                      <th className="text-left">Date</th>
                      <th className="text-left">Dir</th>
                      <th className="text-right">Shots</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dmpFile.sections.map((section, index) => {
                      const standardShots = section.shots.filter(
                        (s) => s.shot_type === 'Standard'
                      );
                      return (
                        <tr
                          key={index}
                          className={selectedSections.has(index) ? 'bg-accent/10' : ''}
                        >
                          <td>
                            <input
                              type="checkbox"
                              checked={selectedSections.has(index)}
                              onChange={() => handleToggleSection(index)}
                            />
                          </td>
                          <td>{section.name}</td>
                          <td>{section.date?.split(' ')[0] ?? '-'}</td>
                          <td>{section.direction}</td>
                          <td className="text-right">{standardShots.length}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={handleImport}
            disabled={isLoading || !dmpFile || selectedSections.size === 0}
          >
            {isLoading ? 'Importing...' : `Import ${selectedSections.size} Section${selectedSections.size !== 1 ? 's' : ''}`}
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
      <div className="relative bg-panel border border-border rounded-lg shadow-xl max-w-2xl w-full mx-4 max-h-[90vh] overflow-auto">
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
