import { type FC, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import type { ProjectMetadata } from '../../types/project';
import { ResizablePanel } from '../common/Panel';
import { Button } from '../common/Button';
import { formatDate, formatFixed, formatNumber } from '../../i18n/format';

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
  const { t } = useTranslation();

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
      await invoke('plugin:opener|reveal_item_in_dir', { path: singleProject.file_path });
    } catch (error) {
      console.error('Failed to show in folder:', error);
      // Fallback: try to open the directory
      try {
        const dirPath = singleProject.file_path.substring(0, singleProject.file_path.lastIndexOf('/'));
        await invoke('plugin:opener|open_path', { path: dirPath });
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
    return `${formatFixed(Math.abs(lat), undefined, 6)}${latDir}, ${formatFixed(Math.abs(lng), undefined, 6)}${lngDir}`;
  };

  // Format length for display
  const formatLength = (length: number | null | undefined): string => {
    if (length === null || length === undefined) return `0 ${t('common.units.meters')}`;
    if (length >= 1000) {
      return `${formatFixed(length / 1000, undefined, 2)} ${t('common.units.kilometers')}`;
    }
    return `${formatFixed(length, undefined, 1)} ${t('common.units.meters')}`;
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
                {t('globalView.metadata.multiSelected', { count: formatNumber(projects.length) })}
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
                    <div key={p.file_path} className="truncate" title={p.name}>
                      {p.name}
                    </div>
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
              {/* Project Name */}
              <MetadataField
                label={t('globalView.metadata.fields.name')}
                value={singleProject.name}
                testId="metadata-name"
              />

              {/* Location */}
              <MetadataField
                label={t('globalView.metadata.fields.location')}
                value={singleProject.location || t('globalView.metadata.notSet')}
                testId="metadata-location"
              />

              {/* File Path */}
              <MetadataField
                label={t('globalView.metadata.fields.file')}
                value={singleProject.file_path}
                testId="metadata-file-path"
                truncate
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
                    north: formatFixed(singleProject.gps_bounds.north, undefined, 4),
                    south: formatFixed(singleProject.gps_bounds.south, undefined, 4),
                    east: formatFixed(singleProject.gps_bounds.east, undefined, 4),
                    west: formatFixed(singleProject.gps_bounds.west, undefined, 4),
                  })}
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

interface MetadataFieldProps {
  label: string;
  value: string;
  testId: string;
  truncate?: boolean;
}

/**
 * A single metadata field with label and value.
 */
const MetadataField: FC<MetadataFieldProps> = ({ label, value, testId, truncate }) => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-xs text-text-secondary font-medium">{label}</dt>
    <dd
      className={`text-sm text-text-primary ${truncate ? 'truncate' : ''}`}
      data-testid={testId}
      title={truncate ? value : undefined}
    >
      {value}
    </dd>
  </div>
);

export default MetadataPanel;
