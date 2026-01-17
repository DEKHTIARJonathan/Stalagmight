import { useState, useEffect, useRef, useCallback, Fragment, KeyboardEvent } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import { DialogWrapper } from './DialogWrapper';
import type { DmpFile, DmpShot } from '../../types/commands';
import { getNextSectionColor } from '../../utils/colors';

/**
 * Maximum comment length before truncation is applied.
 */
const MAX_COMMENT_LENGTH = 50;

/**
 * Normalize DMP sentinel value (0.0 means "not measured") to null.
 * DMP files use 0.0 as a sentinel for "not measured", but we store null internally.
 */
function normalizeDmpValue(value: number | undefined | null): number | null {
  if (value === undefined || value === null || value === 0) return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

/**
 * Format pitch for display in the preview table.
 * - Both values present: shows average
 * - One value present: shows that value
 * - Zero/null values: shows "-" (indicates "not measured")
 */
function formatPitch(shot: DmpShot): string {
  const pitchIn = Number.isFinite(shot.pitch_in) ? shot.pitch_in : 0;
  const pitchOut = Number.isFinite(shot.pitch_out) ? shot.pitch_out : 0;

  if (pitchIn === 0 && pitchOut === 0) return '-';
  if (pitchIn === 0) return pitchOut.toFixed(1);
  if (pitchOut === 0) return pitchIn.toFixed(1);

  return ((pitchIn + pitchOut) / 2).toFixed(1);
}

/**
 * Props for the TruncatedComment component.
 */
interface TruncatedCommentProps {
  comment: string | undefined;
  sectionIndex: number;
  shotIndex: number;
}

/**
 * A component that displays a comment with truncation and expand/collapse functionality.
 * - Short comments (<=50 chars) display in full
 * - Long comments are truncated with "..." and an expand button
 * - Keyboard accessible: Tab to focus, Enter/Space to toggle
 */
function TruncatedComment({ comment, sectionIndex, shotIndex }: TruncatedCommentProps) {
  const [expanded, setExpanded] = useState(false);

  // No comment - show empty cell
  if (!comment) {
    return <span>-</span>;
  }

  const needsTruncation = comment.length > MAX_COMMENT_LENGTH;

  // Short comment - display in full
  if (!needsTruncation) {
    return <span>{comment}</span>;
  }

  const handleToggle = () => {
    setExpanded(!expanded);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleToggle();
    }
  };

  return (
    <div className="flex items-start gap-1">
      <span className={expanded ? '' : 'break-all'}>
        {expanded ? comment : `${comment.slice(0, MAX_COMMENT_LENGTH)}...`}
      </span>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse comment' : 'Expand comment'}
        onClick={handleToggle}
        onKeyDown={handleKeyDown}
        data-testid={`comment-expand-${sectionIndex}-${shotIndex}`}
        className="text-text-secondary hover:text-text-primary transition-colors focus:outline-none focus:ring-1 focus:ring-accent rounded flex-shrink-0"
      >
        {expanded ? '▼' : '▶'}
      </button>
    </div>
  );
}

interface DmpImportDialogProps {
  filePath?: string;
}

export default function DmpImportDialog({ filePath: initialPath }: DmpImportDialogProps) {
  const { closeDialog, dialogData, setView, triggerFitToBounds } = useUIStore();
  const { importDmp, createSection, createProject, project } = useProjectStore();

  const [filePath, setFilePath] = useState<string>(initialPath ?? (dialogData.filePath as string) ?? '');
  const [dmpFile, setDmpFile] = useState<DmpFile | null>(null);
  const [selectedSections, setSelectedSections] = useState<Set<number>>(new Set());
  const [expandedSections, setExpandedSections] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createNewProject, setCreateNewProject] = useState(!project);
  const [newProjectName, setNewProjectName] = useState('');

  // Track auto-populated project name for isDirty calculation
  const autoPopulatedProjectName = useRef<string>('');

  // Track if auto-load has been attempted for initial path
  const autoLoadAttempted = useRef(false);

  const handleLoadFile = useCallback(async (path: string) => {
    if (!path) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await importDmp(path);
      setDmpFile(result);
      // Select only sections that have shots by default (empty sections unselected and grayed)
      const nonEmptyIndices = result.sections
        .map((section, index) => ({
          index,
          hasShots: section.shots.filter((s) => s.shot_type === 'Standard').length > 0,
        }))
        .filter((s) => s.hasShots)
        .map((s) => s.index);
      setSelectedSections(new Set(nonEmptyIndices));
      // Use filename as default project name
      const fileName = path.split(/[/\\]/).pop()?.replace('.dmp', '') ?? 'Imported';
      setNewProjectName(fileName);
      autoPopulatedProjectName.current = fileName;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to parse DMP file');
      setDmpFile(null);
    } finally {
      setIsLoading(false);
    }
  }, [importDmp]);

  // Auto-load if file path provided on mount
  useEffect(() => {
    if (filePath && !dmpFile && !autoLoadAttempted.current) {
      autoLoadAttempted.current = true;
      handleLoadFile(filePath);
    }
  }, [filePath, dmpFile, handleLoadFile]);

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
        setExpandedSections(new Set());
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to open file dialog');
    }
  };

  const handleToggleSection = (index: number) => {
    setSelectedSections((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleToggleExpand = (index: number) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
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
        // Extract date part (format: "YYYY-MM-DD" or null)
        // Handle both "2016-10-03T18:42:00" and "2016-10-03 18:42:00" formats
        const dateStr = section.date?.split(/[T ]/)[0] ?? null;

        console.log(`[DmpImport] Creating section ${section.name} with ${standardShots.length} shots, date: ${dateStr}`);

        const sectionData = {
          name: section.name,
          surveyor: null,
          date: dateStr ?? null,
          color,
          shots: standardShots.map((shot) => ({
            azimuth_in: shot.heading_in,
            azimuth_out: shot.heading_out,
            length: shot.length,
            depth_in: shot.depth_in,
            depth_out: shot.depth_out,
            pitch_in: normalizeDmpValue(shot.pitch_in),
            pitch_out: normalizeDmpValue(shot.pitch_out),
            left: normalizeDmpValue(shot.left),
            right: normalizeDmpValue(shot.right),
            up: normalizeDmpValue(shot.up),
            down: normalizeDmpValue(shot.down),
            comment: shot.comment ?? null,
            is_virtual: false,
            marker_index: shot.marker_index ?? null,
            temperature: shot.temperature ?? null,
          })),
        };

        console.log('[DmpImport] Section data:', JSON.stringify(sectionData, null, 2));

        const result = await createSection(sectionData);
        console.log('[DmpImport] Result:', result);

        if (!result.success) {
          throw new Error(result.error ?? `Failed to create section ${section.name}`);
        }
      }

      setView('single');
      triggerFitToBounds();
      closeDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to import sections');
    } finally {
      setIsLoading(false);
    }
  };

  // Track if form has user changes (exclude auto-loaded file and auto-populated project name)
  const userModifiedProjectName = newProjectName !== '' && newProjectName !== autoPopulatedProjectName.current;
  const isDirty = userModifiedProjectName || (dmpFile !== null && selectedSections.size > 0);

  return (
    <DialogWrapper title="Import DMP File" onClose={closeDialog} size="2xl" isDirty={isDirty} data-testid="import-dmp-dialog">
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
              className="flex-1"
              placeholder="/path/to/survey.dmp"
              readOnly
            />
            <Button onClick={handleBrowse}>Browse...</Button>
          </div>
        </div>

        {filePath && !dmpFile && (
          <Button onClick={() => handleLoadFile(filePath)} disabled={isLoading}>
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
                  <button type="button" onClick={handleSelectAll} className="text-accent">
                    All
                  </button>
                  <button type="button" onClick={handleSelectNone} className="text-accent">
                    None
                  </button>
                </div>
              }
            >
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr>
                      <th className="w-8"></th>
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
                      const hasShots = standardShots.length > 0;
                      const isExpanded = expandedSections.has(index);
                      return (
                        <Fragment key={index}>
                          <tr
                            className={`${!hasShots ? 'opacity-50' : 'cursor-pointer'} ${selectedSections.has(index) ? 'bg-accent/10' : ''}`}
                            onClick={hasShots ? () => handleToggleExpand(index) : undefined}
                          >
                            <td onClick={(e) => e.stopPropagation()}>
                              <input
                                type="checkbox"
                                checked={selectedSections.has(index)}
                                onChange={() => handleToggleSection(index)}
                              />
                            </td>
                            <td>
                              {hasShots && (
                                <button
                                  type="button"
                                  data-testid={`section-expand-${index}`}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleToggleExpand(index);
                                  }}
                                  className="text-text-secondary hover:text-text-primary transition-colors"
                                  aria-label={isExpanded ? 'Collapse section' : 'Expand section'}
                                >
                                  {isExpanded ? '▼' : '▶'}
                                </button>
                              )}
                            </td>
                            <td>{section.name}</td>
                            <td>{section.date?.split(/[T ]/)[0] ?? '-'}</td>
                            <td>{section.direction}</td>
                            <td className="text-right">{standardShots.length}</td>
                          </tr>
                          {isExpanded && hasShots && (
                            <tr>
                              <td colSpan={6} className="p-0">
                                <div className="ml-8 my-1 border-l-2 border-border pl-2">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="text-text-secondary">
                                        <th className="text-left py-1 px-1">Index</th>
                                        <th className="text-right py-1 px-1">L</th>
                                        <th className="text-right py-1 px-1">R</th>
                                        <th className="text-right py-1 px-1">U</th>
                                        <th className="text-right py-1 px-1">D</th>
                                        <th className="text-right py-1 px-1">Pitch</th>
                                        <th className="text-left py-1 px-1">Comment</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {standardShots.map((shot, shotIndex) => (
                                        <tr
                                          key={shotIndex}
                                          data-testid={`shot-row-${index}-${shotIndex}`}
                                          className="hover:bg-background/30"
                                        >
                                          <td className="py-0.5 px-1">{shotIndex + 1}</td>
                                          <td
                                            className="text-right py-0.5 px-1"
                                            data-testid={`lrud-left-${index}-${shotIndex}`}
                                          >
                                            {shot.left ? shot.left.toFixed(1) : '-'}
                                          </td>
                                          <td
                                            className="text-right py-0.5 px-1"
                                            data-testid={`lrud-right-${index}-${shotIndex}`}
                                          >
                                            {shot.right ? shot.right.toFixed(1) : '-'}
                                          </td>
                                          <td
                                            className="text-right py-0.5 px-1"
                                            data-testid={`lrud-up-${index}-${shotIndex}`}
                                          >
                                            {shot.up ? shot.up.toFixed(1) : '-'}
                                          </td>
                                          <td
                                            className="text-right py-0.5 px-1"
                                            data-testid={`lrud-down-${index}-${shotIndex}`}
                                          >
                                            {shot.down ? shot.down.toFixed(1) : '-'}
                                          </td>
                                          <td
                                            className="text-right py-0.5 px-1"
                                            data-testid={`pitch-${index}-${shotIndex}`}
                                          >
                                            {formatPitch(shot)}
                                          </td>
                                          <td
                                            className="text-left py-0.5 px-1"
                                            data-testid={`comment-${index}-${shotIndex}`}
                                          >
                                            <TruncatedComment
                                              comment={shot.comment}
                                              sectionIndex={index}
                                              shotIndex={shotIndex}
                                            />
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
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
