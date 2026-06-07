import { type FC, useState, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invokeIpc } from '../../utils/ipc';
import type { ProjectMetadata } from '../../types/project';
import { ResizablePanel } from '../common/Panel';
import { ElidedPath } from '../common/ElidedPath';
import { MarqueeText } from '../common/MarqueeText';
import { Button } from '../common/Button';
import { Toggle } from '../common/Toggle';
import { PencilIcon, CheckIcon, CloseIcon } from '../common/icons';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { formatDate, formatFixed, formatNumber } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';

interface MetadataPanelProps {
  /** The selected project metadata to display (legacy single-selection) */
  project?: ProjectMetadata | null;
  /** Array of selected projects for multi-selection support */
  selectedProjects?: ProjectMetadata[];
  /** Callback when the user clicks Open Project */
  onOpenProject: (filePath: string) => void;
  /** Callback when the user clicks Delete (remove from recent) */
  onRemoveFromRecent: (filePath: string) => void;
  /** Whether the panel is collapsed */
  collapsed?: boolean;
  /** Callback when the panel collapse state changes */
  onCollapseChange?: (collapsed: boolean) => void;
}

/**
 * MetadataPanel displays details about a selected project in GlobalView.
 * It is a resizable, collapsible panel that shows project metadata and actions.
 */
const MetadataPanel: FC<MetadataPanelProps> = ({
  project,
  selectedProjects,
  onOpenProject,
  onRemoveFromRecent,
  collapsed = false,
  onCollapseChange,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(collapsed);
  const [collabBusy, setCollabBusy] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameBusy, setNameBusy] = useState(false);
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  const setCollabEnabledForPath = useProjectStore((s) => s.setCollabEnabledForPath);
  const setProjectNameForPath = useProjectStore((s) => s.setProjectNameForPath);
  const loadRecentProjects = useProjectStore((s) => s.loadRecentProjects);
  const showToast = useUIStore((s) => s.showToast);

  // Normalize selection: prefer selectedProjects if non-empty, fallback to project
  const projects = selectedProjects?.length ? selectedProjects : (project ? [project] : []);
  const isMultiSelection = projects.length > 1;
  const singleProject = projects.length === 1 ? projects[0] : null;

  const handleCollapseToggle = useCallback(() => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    onCollapseChange?.(newState);
  }, [isCollapsed, onCollapseChange]);

  const handleShowInFolder = useCallback(async () => {
    if (!singleProject?.file_path) return;
    try {
      // Use Tauri shell plugin to reveal in file explorer
      // Note: This command opens the parent folder with the file selected
      await invokeIpc(
        'plugin:opener|reveal_item_in_dir',
        { path: singleProject.file_path },
        { purpose: 'reveal project in folder', fields: { path: singleProject.file_path } }
      );
    } catch (error) {
      console.error('Failed to show in folder:', error);
      // Fallback: try to open the directory
      try {
        const dirPath = singleProject.file_path.substring(0, singleProject.file_path.lastIndexOf('/'));
        await invokeIpc(
          'plugin:opener|open_path',
          { path: dirPath },
          { purpose: 'open project folder after reveal failed', fields: { path: dirPath } }
        );
      } catch (fallbackError) {
        console.error('Fallback also failed:', fallbackError);
      }
    }
  }, [singleProject?.file_path]);

  const handleOpenProject = useCallback(() => {
    if (singleProject?.file_path) {
      onOpenProject(singleProject.file_path);
    }
  }, [singleProject?.file_path, onOpenProject]);

  const handleRemoveFromRecent = useCallback(() => {
    if (singleProject?.file_path) {
      onRemoveFromRecent(singleProject.file_path);
    }
  }, [singleProject?.file_path, onRemoveFromRecent]);

  // Toggle Ariane collaboration for the selected (not-necessarily-open) project.
  // Mutates the `.stalx` on disk by path, then refreshes the list so the panel
  // reflects the new state.
  const handleCollabToggle = useCallback(
    async (next: boolean) => {
      if (!singleProject?.file_path) return;
      setCollabBusy(true);
      try {
        const result = await setCollabEnabledForPath(singleProject.file_path, next);
        if (!result.success) {
          showToast(
            result.error ?? t('detailPanel.collaboration.toggleFailed', 'Failed to change collaboration mode'),
            'collab-toggle'
          );
        } else {
          await loadRecentProjects();
        }
      } catch (e) {
        showToast(String(e), 'collab-toggle');
      } finally {
        setCollabBusy(false);
      }
    },
    [singleProject?.file_path, setCollabEnabledForPath, loadRecentProjects, showToast, t]
  );

  // Rename the selected (not-necessarily-open) project's display name.
  const startEditName = useCallback(() => {
    if (!singleProject) return;
    setNameDraft(singleProject.name);
    setEditingName(true);
  }, [singleProject]);

  const cancelEditName = useCallback(() => {
    setEditingName(false);
  }, []);

  // Leave edit mode when the selection changes so a stale draft can't apply to
  // a different project.
  useEffect(() => {
    setEditingName(false);
  }, [singleProject?.file_path]);

  const commitName = useCallback(async () => {
    if (!singleProject?.file_path) return;
    const next = nameDraft.trim();
    if (!next) return; // also guarded by the disabled Save button
    if (next === singleProject.name) {
      setEditingName(false);
      return;
    }
    setNameBusy(true);
    try {
      const result = await setProjectNameForPath(singleProject.file_path, next);
      if (!result.success) {
        showToast(result.error ?? t('globalView.metadata.rename.failed'), 'rename');
      } else {
        setEditingName(false);
        await loadRecentProjects();
      }
    } catch (e) {
      showToast(String(e), 'rename');
    } finally {
      setNameBusy(false);
    }
  }, [singleProject, nameDraft, setProjectNameForPath, showToast, loadRecentProjects, t]);

  // Format date for display
  const formatProjectDate = (isoDate: string | null | undefined): string => {
    if (!isoDate) return t('globalView.metadata.unknown');
    try {
      const date = new Date(isoDate);
      return formatDate(date, undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return t('globalView.metadata.unknown');
    }
  };

  // Format GPS coordinates for display
  const formatGps = (center: [number, number] | null): string => {
    if (!center) return t('globalView.metadata.notSet');
    const [lng, lat] = center;
    const latDir = lat >= 0 ? 'N' : 'S';
    const lngDir = lng >= 0 ? 'E' : 'W';
    return `${formatFixed(Math.abs(lat), undefined, precision.gps)}${latDir}, ${formatFixed(Math.abs(lng), undefined, precision.gps)}${lngDir}`;
  };

  // Format length for display
  const formatLength = (length: number | null | undefined): string => {
    if (length === null || length === undefined) return `0 ${t('common.units.meters')}`;
    if (length >= 1000) {
      return `${formatFixed(length / 1000, undefined, precision.length)} ${t('common.units.kilometers')}`;
    }
    return `${formatFixed(length, undefined, precision.length)} ${t('common.units.meters')}`;
  };

  if (isCollapsed) {
    return (
      <aside
        role="complementary"
        aria-label={t('globalView.metadata.panelCollapsedAria')}
        data-testid="metadata-panel-collapsed"
        className="flex-shrink-0 w-10 bg-panel border-l border-border flex flex-col items-center py-2"
      >
        <button
          onClick={handleCollapseToggle}
          className="p-2 hover:bg-background-50 rounded"
          aria-label={t('globalView.metadata.expandAria')}
          aria-expanded="false"
          data-testid="metadata-panel-expand-button"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
      </aside>
    );
  }

  return (
    <ResizablePanel
      direction="horizontal"
      handlePosition="start"
      minSize={200}
      maxSize={400}
      defaultSize={280}
    >
      <aside
        role="complementary"
        aria-label={t('globalView.metadata.panelAria')}
        data-testid="metadata-panel"
        className="h-full bg-panel border-l border-border flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <h2 className="font-medium text-text-primary" id="metadata-panel-title">
            {t('globalView.metadata.title')}
          </h2>
          <button
            onClick={handleCollapseToggle}
            className="p-1 hover:bg-background-50 rounded"
            aria-label={t('globalView.metadata.collapseAria')}
            aria-expanded="true"
            data-testid="metadata-panel-collapse-button"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>

        {/* Content */}
        {isMultiSelection ? (
          <div className="flex-1 overflow-auto" data-testid="metadata-multi-selection">
            {/* Multi-selection aggregate stats */}
            <div className="p-3 space-y-3" aria-labelledby="metadata-panel-title">
              {/* Selection count header */}
              <div className="text-lg font-semibold text-text-primary" data-testid="metadata-multi-count">
                {t('globalView.metadata.multiSelected', {
                  count: projects.length,
                  countFormatted: formatNumber(projects.length),
                })}
              </div>

              {/* Aggregate stats */}
              <MetadataField
                label={t('globalView.metadata.fields.combinedLength')}
                value={formatLength(projects.reduce((sum, p) => sum + (p.total_length ?? 0), 0))}
                testId="metadata-multi-length"
              />

              <MetadataField
                label={t('globalView.metadata.fields.totalStations')}
                value={formatNumber(projects.reduce((sum, p) => sum + (p.station_count ?? 0), 0))}
                testId="metadata-multi-stations"
              />

              {/* List of selected systems */}
              <div className="pt-2 border-t border-border">
                <dt className="text-xs text-text-secondary font-medium mb-1">{t('globalView.metadata.selectedSystems')}</dt>
                <dd className="text-sm text-text-primary space-y-1">
                  {projects.map((p) => (
                    <MarqueeText key={p.file_path} text={p.name} />
                  ))}
                </dd>
              </div>
            </div>

            {/* Multi-selection actions */}
            <div className="p-3 border-t border-border">
              <p className="text-xs text-text-secondary text-center">
                {t('globalView.metadata.multiHint')}
              </p>
            </div>
          </div>
        ) : singleProject ? (
          <div className="flex-1 overflow-auto">
            {/* Metadata fields */}
            <div className="p-3 space-y-3" aria-labelledby="metadata-panel-title">
              {/* Project Name (inline editable) */}
              <div className="flex flex-col gap-0.5">
                <dt className="text-xs text-text-secondary font-medium">
                  {t('globalView.metadata.fields.name')}
                </dt>
                {editingName ? (
                  <div className="flex items-center gap-1">
                    <input
                      autoFocus
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          // Stop the global GlobalView shortcut handler from also
                          // reacting: committing unmounts this input, so its
                          // "ignore inputs" focus guard would miss the bubbled event.
                          e.preventDefault();
                          e.stopPropagation();
                          void commitName();
                        } else if (e.key === 'Escape') {
                          e.preventDefault();
                          e.stopPropagation();
                          cancelEditName();
                        }
                      }}
                      disabled={nameBusy}
                      aria-label={t('globalView.metadata.rename.inputAria')}
                      data-testid="metadata-name-input"
                      className="flex-1 min-w-0 bg-background border border-border rounded px-2 py-1 text-sm focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    />
                    <button
                      onClick={() => void commitName()}
                      disabled={nameBusy || nameDraft.trim().length === 0}
                      aria-label={t('globalView.metadata.rename.save')}
                      title={t('globalView.metadata.rename.save')}
                      data-testid="metadata-name-save"
                      className="p-1 text-text-secondary hover:text-accent disabled:opacity-40"
                    >
                      <CheckIcon size={16} />
                    </button>
                    <button
                      onClick={cancelEditName}
                      disabled={nameBusy}
                      aria-label={t('globalView.metadata.rename.cancel')}
                      title={t('globalView.metadata.rename.cancel')}
                      data-testid="metadata-name-cancel"
                      className="p-1 text-text-secondary hover:text-text"
                    >
                      <CloseIcon size={16} />
                    </button>
                  </div>
                ) : (
                  <dd className="text-sm text-text-primary flex items-center gap-1" data-testid="metadata-name">
                    <MarqueeText text={singleProject.name} className="min-w-0 flex-1" />
                    <button
                      onClick={startEditName}
                      aria-label={t('globalView.metadata.rename.editAria', { name: singleProject.name })}
                      title={t('globalView.metadata.rename.editAria', { name: singleProject.name })}
                      data-testid="metadata-name-edit"
                      className="p-0.5 text-text-secondary hover:text-accent flex-shrink-0"
                    >
                      <PencilIcon size={14} />
                    </button>
                  </dd>
                )}
              </div>

              {/* Location */}
              <MetadataField
                label={t('globalView.metadata.fields.location')}
                value={singleProject.location || t('globalView.metadata.notSet')}
                testId="metadata-location"
              />

              {/* File Path — abbreviated to fit; scrolls in full on hover. */}
              <MetadataField
                label={t('globalView.metadata.fields.file')}
                value={singleProject.file_path}
                testId="metadata-file-path"
                path
              />

              {/* Modified Date */}
              <MetadataField
                label={t('globalView.metadata.fields.lastModified')}
                value={formatProjectDate(singleProject.modified_at)}
                testId="metadata-modified"
              />

              {/* Section Count */}
              <MetadataField
                label={t('globalView.metadata.fields.sections')}
                value={formatNumber(singleProject.section_count)}
                testId="metadata-sections"
              />

              {/* Total Length */}
              <MetadataField
                label={t('globalView.metadata.fields.totalLength')}
                value={formatLength(singleProject.total_length)}
                testId="metadata-length"
              />

              {/* GPS Center */}
              <MetadataField
                label={t('globalView.metadata.fields.gpsCenter')}
                value={formatGps(singleProject.gps_center)}
                testId="metadata-gps"
              />

              {/* GPS Bounds (if available) */}
              {singleProject.gps_bounds && (
                <div className="text-xs text-text-secondary">
                  <span className="font-medium">{t('globalView.metadata.fields.bounds')}:</span>{' '}
                  {t('globalView.metadata.boundsValue', {
                    north: formatFixed(singleProject.gps_bounds.north, undefined, precision.gps),
                    south: formatFixed(singleProject.gps_bounds.south, undefined, precision.gps),
                    east: formatFixed(singleProject.gps_bounds.east, undefined, precision.gps),
                    west: formatFixed(singleProject.gps_bounds.west, undefined, precision.gps),
                  })}
                </div>
              )}
            </div>

            {/* Collaboration toggle (per-project Ariane .tml round-trip) */}
            <div
              className="p-3 border-t border-border space-y-2"
              data-testid="metadata-collaboration"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-text-primary">
                    {t('detailPanel.collaboration.enable', 'Ariane collaboration')}
                  </div>
                  <div className="text-xs text-text-secondary mt-0.5">
                    {t(
                      'detailPanel.collaboration.help',
                      'Saves a companion Ariane file (.tml) on every save and merges external Ariane edits when you reopen the project.'
                    )}
                  </div>
                </div>
                <Toggle
                  checked={singleProject.collab_enabled}
                  onChange={handleCollabToggle}
                  disabled={collabBusy}
                  aria-label={t('detailPanel.collaboration.aria', 'Toggle Ariane collaboration mode')}
                  data-testid="metadata-toggle-collaboration"
                />
              </div>
              {singleProject.collab_enabled && (
                <div
                  className="text-xs text-text-tertiary"
                  data-testid="metadata-collaboration-sibling"
                >
                  {t('detailPanel.collaboration.companion', 'Companion file')}:{' '}
                  <code className="break-all">{deriveSiblingName(singleProject.file_path)}</code>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="p-3 border-t border-border space-y-2">
              <Button
                onClick={handleOpenProject}
                className="w-full"
                data-testid="metadata-open-button"
                aria-label={t('globalView.metadata.actions.openProjectAria', { name: singleProject.name })}
              >
                {t('globalView.metadata.actions.openProject')}
              </Button>
              <Button
                onClick={handleShowInFolder}
                variant="secondary"
                className="w-full"
                data-testid="metadata-show-folder-button"
                aria-label={t('globalView.metadata.actions.showInFolderAria', { name: singleProject.name })}
              >
                {t('globalView.metadata.actions.showInFolder')}
              </Button>
              <Button
                onClick={handleRemoveFromRecent}
                variant="danger"
                className="w-full"
                data-testid="metadata-remove-button"
                aria-label={t('globalView.metadata.actions.removeFromRecentAria', { name: singleProject.name })}
              >
                {t('globalView.metadata.actions.removeFromRecent')}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="flex-1 flex items-center justify-center p-4"
            data-testid="metadata-panel-empty"
          >
            <p className="text-text-secondary text-center text-sm">
              {t('globalView.metadata.empty')}
            </p>
          </div>
        )}
      </aside>
    </ResizablePanel>
  );
};

/** Derive `<stem>.tml` from a project's `.stalx` path for display. */
function deriveSiblingName(filePath: string | null | undefined): string | null {
  if (!filePath) return null;
  const base = filePath.replace(/^.*[\\/]/, '');
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return `${stem}.tml`;
}

interface MetadataFieldProps {
  label: string;
  value: string;
  testId: string;
  truncate?: boolean;
  /** Render the value as a file path: abbreviated to fit, scrolled in full on hover. */
  path?: boolean;
}

/**
 * A single metadata field with label and value.
 */
const MetadataField: FC<MetadataFieldProps> = ({ label, value, testId, truncate, path }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-text-secondary font-medium">{label}</dt>
    {path ? (
      <dd>
        <ElidedPath path={value} data-testid={testId} className="text-sm text-text-primary" />
      </dd>
    ) : (
      <dd
        className={`text-sm text-text-primary ${truncate ? 'truncate' : ''}`}
        data-testid={testId}
        title={truncate ? value : undefined}
      >
        {value}
      </dd>
    )}
  </div>
);

export default MetadataPanel;
