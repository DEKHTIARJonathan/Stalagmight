import { type FC, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ProjectMetadata } from '../../types/project';
import { ResizablePanel } from '../common/Panel';
import { Button } from '../common/Button';

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
  const formatDate = (isoDate: string | null | undefined): string => {
    if (!isoDate) return 'Unknown';
    try {
      const date = new Date(isoDate);
      return date.toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return 'Unknown';
    }
  };

  // Format GPS coordinates for display
  const formatGps = (center: [number, number] | null): string => {
    if (!center) return 'Not set';
    const [lng, lat] = center;
    const latDir = lat >= 0 ? 'N' : 'S';
    const lngDir = lng >= 0 ? 'E' : 'W';
    return `${Math.abs(lat).toFixed(6)}${latDir}, ${Math.abs(lng).toFixed(6)}${lngDir}`;
  };

  // Format length for display
  const formatLength = (length: number | null | undefined): string => {
    if (length === null || length === undefined) return '0 m';
    if (length >= 1000) {
      return `${(length / 1000).toFixed(2)} km`;
    }
    return `${length.toFixed(1)} m`;
  };

  if (isCollapsed) {
    return (
      <aside
        role="complementary"
        aria-label="Project details panel (collapsed)"
        data-testid="metadata-panel-collapsed"
        className="flex-shrink-0 w-10 bg-panel border-l border-border flex flex-col items-center py-2"
      >
        <button
          onClick={handleCollapseToggle}
          className="p-2 hover:bg-background-50 rounded"
          aria-label="Expand project details panel"
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
        aria-label="Project details panel"
        data-testid="metadata-panel"
        className="h-full bg-panel border-l border-border flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-border">
          <h2 className="font-medium text-text-primary" id="metadata-panel-title">
            Project Details
          </h2>
          <button
            onClick={handleCollapseToggle}
            className="p-1 hover:bg-background-50 rounded"
            aria-label="Collapse project details panel"
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
                {projects.length} systems selected
              </div>

              {/* Aggregate stats */}
              <MetadataField
                label="Combined Length"
                value={formatLength(projects.reduce((sum, p) => sum + (p.total_length ?? 0), 0))}
                testId="metadata-multi-length"
              />

              <MetadataField
                label="Total Stations"
                value={String(projects.reduce((sum, p) => sum + (p.station_count ?? 0), 0))}
                testId="metadata-multi-stations"
              />

              {/* List of selected systems */}
              <div className="pt-2 border-t border-border">
                <dt className="text-xs text-text-secondary font-medium mb-1">Selected Systems</dt>
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
                Right-click in the list view to merge selected systems
              </p>
            </div>
          </div>
        ) : singleProject ? (
          <div className="flex-1 overflow-auto">
            {/* Metadata fields */}
            <div className="p-3 space-y-3" aria-labelledby="metadata-panel-title">
              {/* Project Name */}
              <MetadataField
                label="Name"
                value={singleProject.name}
                testId="metadata-name"
              />

              {/* Location */}
              <MetadataField
                label="Location"
                value={singleProject.location || 'Not specified'}
                testId="metadata-location"
              />

              {/* File Path */}
              <MetadataField
                label="File"
                value={singleProject.file_path}
                testId="metadata-file-path"
                truncate
              />

              {/* Modified Date */}
              <MetadataField
                label="Last Modified"
                value={formatDate(singleProject.modified_at)}
                testId="metadata-modified"
              />

              {/* Section Count */}
              <MetadataField
                label="Sections"
                value={String(singleProject.section_count)}
                testId="metadata-sections"
              />

              {/* Total Length */}
              <MetadataField
                label="Total Length"
                value={formatLength(singleProject.total_length)}
                testId="metadata-length"
              />

              {/* GPS Center */}
              <MetadataField
                label="GPS Center"
                value={formatGps(singleProject.gps_center)}
                testId="metadata-gps"
              />

              {/* GPS Bounds (if available) */}
              {singleProject.gps_bounds && (
                <div className="text-xs text-text-secondary">
                  <span className="font-medium">Bounds:</span>{' '}
                  N{singleProject.gps_bounds.north.toFixed(4)}{' '}
                  S{singleProject.gps_bounds.south.toFixed(4)}{' '}
                  E{singleProject.gps_bounds.east.toFixed(4)}{' '}
                  W{singleProject.gps_bounds.west.toFixed(4)}
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="p-3 border-t border-border space-y-2">
              <Button
                onClick={handleOpenProject}
                className="w-full"
                data-testid="metadata-open-button"
                aria-label={`Open project ${singleProject.name}`}
              >
                Open Project
              </Button>
              <Button
                onClick={handleShowInFolder}
                variant="secondary"
                className="w-full"
                data-testid="metadata-show-folder-button"
                aria-label={`Show ${singleProject.name} in file explorer`}
              >
                Show in Folder
              </Button>
              <Button
                onClick={handleRemoveFromRecent}
                variant="danger"
                className="w-full"
                data-testid="metadata-remove-button"
                aria-label={`Remove ${singleProject.name} from recent projects`}
              >
                Remove from Recent
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="flex-1 flex items-center justify-center p-4"
            data-testid="metadata-panel-empty"
          >
            <p className="text-text-secondary text-center text-sm">
              Select a project to view details
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
