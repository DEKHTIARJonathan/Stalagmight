import { useState } from 'react';
import { useUIStore, type Selection } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Panel } from '../common/Panel';
import { Button } from '../common/Button';
import type { Station, Shot, Section, Project, ProjectStats as ProjectStatsType } from '../../types/project';
import type { ProjectWarning } from '../../types/commands';

export default function DetailPanel() {
  const { selection, detailPanelTab, setDetailPanelTab, setSelection } = useUIStore();
  const { project, stations, warnings } = useProjectStore();

  const errorCount = warnings.filter((w) => w.severity === 'error').length;
  const totalWarnings = warnings.length;

  return (
    <div className="h-full bg-panel flex flex-col" data-testid="detail-panel">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        <TabButton
          active={detailPanelTab === 'details'}
          onClick={() => setDetailPanelTab('details')}
          testId="detail-tab-details"
        >
          Details
        </TabButton>
        <TabButton
          active={detailPanelTab === 'warnings'}
          onClick={() => setDetailPanelTab('warnings')}
          badge={totalWarnings > 0 ? totalWarnings : undefined}
          badgeType={errorCount > 0 ? 'error' : 'warning'}
          testId="detail-tab-warnings"
        >
          Warnings
        </TabButton>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-auto">
        {detailPanelTab === 'details' ? (
          <DetailsContent
            selection={selection}
            project={project}
            stations={stations}
          />
        ) : (
          <WarningsContent
            warnings={warnings}
            project={project}
            onWarningClick={(warning) => {
              setSelection({
                type: 'shot',
                sectionId: warning.section_id,
                shotId: warning.shot_id,
              });
              setDetailPanelTab('details');
            }}
          />
        )}
      </div>
    </div>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  badge?: number | undefined;
  badgeType?: 'warning' | 'error' | undefined;
  testId?: string;
}

function TabButton({ active, onClick, children, badge, badgeType, testId }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`
        px-4 py-2 text-sm font-medium border-b-2 transition-colors
        ${active
          ? 'border-accent text-text-primary'
          : 'border-transparent text-text-secondary hover:text-text-primary'
        }
      `}
      data-testid={testId}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span
          className={`
            ml-2 px-1.5 py-0.5 text-xs rounded-full
            ${badgeType === 'error' ? 'bg-red-500/20 text-red-400' : 'bg-yellow-500/20 text-yellow-400'}
          `}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

interface DetailsContentProps {
  selection: Selection | null;
  project: Project | null;
  stations: Station[];
}

function DetailsContent({ selection, project, stations }: DetailsContentProps) {
  const { stats } = useProjectStore();

  if (!selection) {
    // Show project stats when nothing is selected
    return <ProjectStats project={project} stats={stats} stations={stations} />;
  }

  if (selection.type === 'station' && selection.stationRef) {
    const station = stations.find(
      (s) =>
        s.station_ref.section_id === selection.stationRef?.section_id &&
        s.station_ref.station_index === selection.stationRef?.station_index
    );

    if (station) {
      return <StationDetail station={station} />;
    }
  }

  if (selection.type === 'shot' && selection.sectionId !== undefined && selection.shotId !== undefined) {
    const section = project?.sections.find((s) => s.id === selection.sectionId);
    const shot = section?.shots.find((s) => s.id === selection.shotId);

    if (section && shot) {
      return <ShotDetail section={section} shot={shot} />;
    }
  }

  if (selection.type === 'section' && selection.sectionId !== undefined) {
    const section = project?.sections.find((s) => s.id === selection.sectionId);

    if (section) {
      return (
        <SectionDetail
          section={section}
          stations={stations}
          totalProjectLength={stats?.total_length ?? 0}
        />
      );
    }
  }

  return (
    <div className="p-4">
      <div className="text-text-secondary">Selection not found</div>
    </div>
  );
}

interface WarningsContentProps {
  warnings: ProjectWarning[];
  project: Project | null;
  onWarningClick: (warning: ProjectWarning) => void;
}

function WarningsContent({ warnings, project, onWarningClick }: WarningsContentProps) {
  const { resolveWarning, unresolveWarning } = useProjectStore();
  const [showResolved, setShowResolved] = useState(false);

  const unresolvedCount = warnings.filter((w) => !w.is_resolved).length;
  const resolvedCount = warnings.filter((w) => w.is_resolved).length;
  const displayedWarnings = showResolved ? warnings : warnings.filter((w) => !w.is_resolved);

  if (warnings.length === 0) {
    return (
      <div className="p-4 text-center text-text-secondary">
        <div className="text-3xl mb-2">✓</div>
        <p>No validation issues found</p>
      </div>
    );
  }

  const getSectionName = (sectionId: number) => {
    const section = project?.sections.find((s) => s.id === sectionId);
    return section?.name ?? `Section ${sectionId}`;
  };

  const handleToggleResolved = (e: React.MouseEvent, warning: ProjectWarning) => {
    e.stopPropagation();
    if (warning.is_resolved) {
      unresolveWarning(warning.section_id, warning.shot_id, warning.code);
    } else {
      resolveWarning(warning.section_id, warning.shot_id, warning.code);
    }
  };

  return (
    <div className="p-2">
      <div className="flex items-center justify-between mb-2 px-2">
        <span className="text-sm text-text-secondary">
          {unresolvedCount} issue{unresolvedCount !== 1 ? 's' : ''}
          {resolvedCount > 0 && ` (${resolvedCount} resolved)`}
        </span>
        {resolvedCount > 0 && (
          <button
            onClick={() => setShowResolved(!showResolved)}
            className="text-xs text-accent hover:underline"
          >
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
        )}
      </div>
      <div className="space-y-1">
        {displayedWarnings.map((warning, index) => (
          <div
            key={`${warning.section_id}-${warning.shot_id}-${warning.code}-${index}`}
            className={`
              p-2 rounded transition-colors
              ${warning.is_resolved ? 'opacity-50' : ''}
              hover:bg-background/50
            `}
          >
            <div className="flex items-start gap-2">
              <button
                onClick={() => onWarningClick(warning)}
                className="flex-1 text-left"
              >
                <div className="flex items-start gap-2">
                  <span className={warning.severity === 'error' ? 'text-red-400' : 'text-yellow-400'}>
                    {warning.is_resolved ? '✓' : (warning.severity === 'error' ? '⛔' : '⚠️')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm ${warning.is_resolved ? 'line-through' : ''}`}>
                      {warning.message}
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      {getSectionName(warning.section_id)} • Shot {warning.shot_index + 1}
                    </div>
                  </div>
                </div>
              </button>
              <button
                onClick={(e) => handleToggleResolved(e, warning)}
                className="text-xs px-2 py-1 rounded bg-background/50 hover:bg-background text-text-secondary"
                title={warning.is_resolved ? 'Mark as unresolved' : 'Mark as resolved'}
              >
                {warning.is_resolved ? 'Undo' : 'Resolve'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StationDetail({ station }: { station: Station }) {
  const { project } = useProjectStore();
  const { openDialog } = useUIStore();
  const section = project?.sections.find(
    (s) => s.id === station.station_ref.section_id
  );

  const handleEdit = () => {
    openDialog('edit-station', { stationRef: station.station_ref });
  };

  return (
    <div className="h-full bg-panel overflow-auto">
      <Panel title="Station">
        <div className="space-y-3">
          <DetailRow
            label="ID"
            value={`${station.station_ref.section_id}:${station.station_ref.station_index}`}
          />
          <DetailRow label="Section" value={section?.name ?? `Section ${station.station_ref.section_id}`} />
          <DetailRow label="X" value={`${station.coordinates.x.toFixed(2)} m`} />
          <DetailRow label="Y" value={`${station.coordinates.y.toFixed(2)} m`} />
          <DetailRow label="Depth" value={`${station.coordinates.z.toFixed(1)} m`} />

          {station.is_zero_datum && (
            <div className="pt-2 border-t border-border">
              <span className="text-warning">★ Zero Datum</span>
              {station.gps_coordinates && (
                <div className="mt-2 text-sm">
                  <DetailRow
                    label="Latitude"
                    value={station.gps_coordinates.latitude.toFixed(6)}
                  />
                  <DetailRow
                    label="Longitude"
                    value={station.gps_coordinates.longitude.toFixed(6)}
                  />
                </div>
              )}
            </div>
          )}

          {station.merged_with.length > 0 && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">Merged with:</span>
              <ul className="mt-1">
                {station.merged_with.map((ref, i) => (
                  <li key={i} className="text-sm">
                    {ref.section_id}:{ref.station_index}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </Panel>

      <div className="p-3 border-t border-border">
        <Button size="sm" className="w-full" onClick={handleEdit}>
          Edit
        </Button>
      </div>
    </div>
  );
}

function ShotDetail({ section, shot }: { section: Section; shot: Shot }) {
  const { setShotVirtual } = useProjectStore();
  const { openDialog } = useUIStore();

  const handleToggleVirtual = async () => {
    await setShotVirtual(section.id, shot.id, !shot.is_virtual);
  };

  const handleDelete = () => {
    openDialog('confirm-delete', {
      type: 'shot',
      sectionId: section.id,
      shotId: shot.id,
      message: 'Are you sure you want to delete this shot?',
    });
  };

  return (
    <div className="h-full bg-panel overflow-auto">
      <Panel title="Shot">
        <div className="space-y-3">
          <DetailRow label="ID" value={`${section.id}:${shot.id}`} />
          <DetailRow label="Section" value={section.name ?? `Section ${section.id}`} />
          <DetailRow label="Length" value={`${shot.length.toFixed(2)} m`} />
          <DetailRow label="Azimuth In" value={`${shot.azimuth_in.toFixed(1)}°`} />
          <DetailRow label="Azimuth Out" value={`${shot.azimuth_out.toFixed(1)}°`} />
          <DetailRow label="Depth In" value={`${shot.depth_in.toFixed(1)} m`} />
          <DetailRow label="Depth Out" value={`${shot.depth_out.toFixed(1)} m`} />

          {(shot.left !== null || shot.right !== null || shot.up !== null || shot.down !== null) && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">LRUD:</span>
              <div className="grid grid-cols-2 gap-2 mt-1 text-sm">
                <DetailRow label="L" value={shot.left?.toFixed(1) ?? '-'} />
                <DetailRow label="R" value={shot.right?.toFixed(1) ?? '-'} />
                <DetailRow label="U" value={shot.up?.toFixed(1) ?? '-'} />
                <DetailRow label="D" value={shot.down?.toFixed(1) ?? '-'} />
              </div>
            </div>
          )}

          {shot.is_virtual && (
            <div className="text-warning text-sm">Virtual shot</div>
          )}

          {shot.comment && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">Comment:</span>
              <p className="text-sm mt-1">{shot.comment}</p>
            </div>
          )}
        </div>
      </Panel>

      <div className="p-3 border-t border-border space-y-2">
        <Button size="sm" className="w-full" onClick={handleToggleVirtual}>
          {shot.is_virtual ? 'Mark as Real' : 'Mark as Virtual'}
        </Button>
        <Button size="sm" variant="danger" className="w-full" onClick={handleDelete}>
          Delete
        </Button>
      </div>
    </div>
  );
}

interface SectionDetailProps {
  section: Section;
  stations: Station[];
  totalProjectLength: number;
}

function SectionDetail({ section, stations, totalProjectLength }: SectionDetailProps) {
  const { openDialog } = useUIStore();

  // Calculate section statistics
  const sectionLength = section.shots.reduce((sum, s) => sum + s.length, 0);
  const shotCount = section.shots.length;
  const virtualCount = section.shots.filter((s) => s.is_virtual).length;
  const avgShotLength = shotCount > 0 ? sectionLength / shotCount : 0;
  const contributionPercent = totalProjectLength > 0
    ? (sectionLength / totalProjectLength) * 100
    : 0;

  // Get stations for this section and calculate depth range
  const sectionStations = stations.filter(
    (s) => s.station_ref.section_id === section.id
  );
  const depths = sectionStations.map((s) => s.coordinates.z);
  const minDepth = depths.length > 0 ? Math.min(...depths) : 0;
  const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;

  const handleEditSection = () => {
    openDialog('edit-section', { sectionId: section.id });
  };

  return (
    <div className="h-full bg-panel overflow-auto">
      <Panel title="Section">
        <div className="space-y-4">
          {/* Section info */}
          <div className="space-y-2">
            <DetailRow label="Name" value={section.name ?? 'Unnamed'} />
            <DetailRow label="Surveyor" value={section.surveyor ?? '-'} />
            <DetailRow label="Date" value={section.date ?? '-'} />
            <DetailRow label="Color" value={
              <div className="flex items-center gap-2">
                <span
                  className="w-4 h-4 rounded"
                  style={{ backgroundColor: section.color }}
                />
                <span>{section.color}</span>
              </div>
            } />
          </div>

          {/* Survey statistics */}
          <div className="space-y-2 pt-2 border-t border-border">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Survey Statistics
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <StatCard label="Total Length" value={`${sectionLength.toFixed(1)} m`} />
              <StatCard label="Shot Count" value={String(shotCount)} />
              <StatCard label="Avg Shot" value={`${avgShotLength.toFixed(2)} m`} />
              {virtualCount > 0 && (
                <StatCard label="Virtual Shots" value={String(virtualCount)} />
              )}
            </div>
          </div>

          {/* Depth range */}
          {sectionStations.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-border">
              <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Depth Range
              </h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <StatCard label="Shallowest" value={`${minDepth.toFixed(1)} m`} />
                <StatCard label="Deepest" value={`${maxDepth.toFixed(1)} m`} />
              </div>
            </div>
          )}

          {/* Contribution */}
          <div className="space-y-2 pt-2 border-t border-border">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Project Contribution
            </h4>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 bg-background rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${Math.min(contributionPercent, 100)}%` }}
                />
              </div>
              <span className="text-sm font-medium w-12 text-right">
                {contributionPercent.toFixed(1)}%
              </span>
            </div>
          </div>
        </div>
      </Panel>

      <div className="p-3 border-t border-border">
        <Button size="sm" className="w-full" onClick={handleEditSection}>
          Edit Section
        </Button>
      </div>
    </div>
  );
}

interface ProjectStatsProps {
  project: Project | null;
  stats: ProjectStatsType | null;
  stations: Station[];
}

function ProjectStats({ project, stats, stations }: ProjectStatsProps) {
  if (!project || !stats) {
    return (
      <div className="p-4 text-center text-text-secondary">
        <p>No project loaded</p>
      </div>
    );
  }

  // Calculate depth range from stations
  const depths = stations.map((s) => s.coordinates.z);
  const minDepth = depths.length > 0 ? Math.min(...depths) : 0;
  const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;

  // Calculate date range from sections
  const dates = project.sections
    .map((s) => s.date)
    .filter((d): d is string => d !== null && d !== undefined)
    .sort();
  const earliestDate = dates.length > 0 ? dates[0] : null;
  const latestDate = dates.length > 0 ? dates[dates.length - 1] : null;

  return (
    <div className="h-full bg-panel overflow-auto">
      <Panel title="Project Statistics">
        <div className="space-y-4">
          {/* Survey overview */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Survey Overview
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <StatCard label="Total Length" value={`${stats.total_length.toFixed(1)} m`} />
              <StatCard label="Penetration" value={`${stats.penetration_distance.toFixed(1)} m`} />
              <StatCard label="Sections" value={String(stats.section_count)} />
              <StatCard label="Shots" value={String(stats.shot_count)} />
              <StatCard label="Stations" value={String(stats.station_count)} />
              {stats.loop_count > 0 && (
                <StatCard label="Loops" value={String(stats.loop_count)} />
              )}
            </div>
          </div>

          {/* Depth information */}
          <div className="space-y-2 pt-2 border-t border-border">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Depth Range
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <StatCard label="Shallowest" value={`${minDepth.toFixed(1)} m`} />
              <StatCard label="Deepest" value={`${maxDepth.toFixed(1)} m`} />
              <StatCard label="Total Depth" value={`${(maxDepth - minDepth).toFixed(1)} m`} />
            </div>
          </div>

          {/* Survey dates */}
          {(earliestDate || latestDate) && (
            <div className="space-y-2 pt-2 border-t border-border">
              <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Survey Dates
              </h4>
              <div className="space-y-1">
                {earliestDate && <DetailRow label="First Survey" value={earliestDate} />}
                {latestDate && earliestDate !== latestDate && (
                  <DetailRow label="Latest Survey" value={latestDate} />
                )}
              </div>
            </div>
          )}

          {/* Merges and datums */}
          <div className="space-y-2 pt-2 border-t border-border">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              Connections
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <StatCard label="Station Merges" value={String(project.station_merges.length)} />
              <StatCard label="Zero Datums" value={String(project.zero_datums.length)} />
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="text-sm">
      <div className="text-text-secondary text-xs">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-text-secondary">{label}:</span>
      <span>{value}</span>
    </div>
  );
}
