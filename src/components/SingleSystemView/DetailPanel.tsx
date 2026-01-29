import { useMemo, useState } from 'react';
import { useUIStore, type Selection } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Panel } from '../common/Panel';
import { Button } from '../common/Button';
import { DetailLink } from '../common/DetailLink';
import type { Station, Shot, Section, Project, ProjectStats as ProjectStatsType, ClosureRef, LoopClosure } from '../../types/project';
import type { ProjectWarning } from '../../types/commands';
import { formatShotId, formatStationId } from '../../utils/formatters';

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
                sectionId: warning.sectionId,
                shotId: warning.shotId,
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
      return <ShotDetail section={section} shot={shot} stations={stations} />;
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

  const unresolvedCount = warnings.filter((w) => !w.isResolved).length;
  const resolvedCount = warnings.filter((w) => w.isResolved).length;
  const displayedWarnings = showResolved ? warnings : warnings.filter((w) => !w.isResolved);

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
    if (warning.isResolved) {
      unresolveWarning(warning.sectionId, warning.shotId, warning.code);
    } else {
      resolveWarning(warning.sectionId, warning.shotId, warning.code);
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
            key={`${warning.sectionId}-${warning.shotId}-${warning.code}-${index}`}
            className={`
              p-2 rounded transition-colors
              ${warning.isResolved ? 'opacity-50' : ''}
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
                    {warning.isResolved ? '✓' : (warning.severity === 'error' ? '⛔' : '⚠️')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm ${warning.isResolved ? 'line-through' : ''}`}>
                      {warning.message}
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      {getSectionName(warning.sectionId)} • Shot {formatShotId(warning.sectionId, warning.shotIndex + 1)}
                    </div>
                  </div>
                </div>
              </button>
              <button
                onClick={(e) => handleToggleResolved(e, warning)}
                className="text-xs px-2 py-1 rounded bg-background/50 hover:bg-background text-text-secondary"
                title={warning.isResolved ? 'Mark as unresolved' : 'Mark as resolved'}
              >
                {warning.isResolved ? 'Undo' : 'Resolve'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StationDetail({ station }: { station: Station }) {
  const { project, stations } = useProjectStore();
  const { openDialog, setSelection, triggerCenterOnStation, announceSelection, setHoveredStation, setHoveredShot, setHoveredSectionId } = useUIStore();
  const section = project?.sections.find(
    (s) => s.id === station.station_ref.section_id
  );

  // Station position is 0-indexed for display
  const stationIndex = station.station_ref.station_index;
  const stationPosition = stationIndex;
  const sectionId = station.station_ref.section_id;

  // Station-to-Shot mapping:
  // Station at station_index has:
  // - Previous shot: section.shots[station_index - 1] (display position = station_index)
  // - Next shot: section.shots[station_index] (display position = station_index + 1)
  const prevShotIndex = stationIndex - 1;
  const nextShotIndex = stationIndex;
  const prevShotPosition = stationIndex; // station_index for display
  const nextShotPosition = stationIndex + 1; // station_index + 1 for display

  // Check if shots exist
  const prevShotExists = section ? prevShotIndex >= 0 && prevShotIndex < section.shots.length : false;
  const nextShotExists = section ? nextShotIndex >= 0 && nextShotIndex < section.shots.length : false;

  // Determine if we should show prev/next shot links
  const isFirstStation = stationIndex === 0;
  const isLastStation = section ? stationIndex >= section.shots.length : true;

  const handleEdit = () => {
    openDialog('edit-station', { stationRef: station.station_ref });
  };

  const handleSelectPrevShot = () => {
    if (section && prevShotExists) {
      const shot = section.shots[prevShotIndex];
      if (shot) {
        setSelection({ type: 'shot', sectionId, shotId: shot.id });
      }
    }
  };

  const handleSelectNextShot = () => {
    if (section && nextShotExists) {
      const shot = section.shots[nextShotIndex];
      if (shot) {
        setSelection({ type: 'shot', sectionId, shotId: shot.id });
      }
    }
  };

  const handleSelectSection = () => {
    setSelection({ type: 'section', sectionId });
  };

  const handleSelectMergedStation = (ref: { section_id: number; station_index: number }) => {
    setSelection({
      type: 'station',
      stationRef: { section_id: ref.section_id, station_index: ref.station_index },
    });
  };

  const handleCenterOnStation = () => {
    triggerCenterOnStation(station.station_ref);
  };

  // Validate merged station targets exist
  const mergedStationExists = (ref: { section_id: number; station_index: number }): boolean => {
    return stations.some(
      (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
    );
  };

  const sectionDisplayText = `${sectionId}: ${section?.name ?? 'Unnamed'}`;

  const centerButton = (
    <button
      type="button"
      onClick={handleCenterOnStation}
      className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-background/50 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset"
      aria-label={`Center map on station ${formatStationId(sectionId, stationPosition)}`}
      data-testid="center-station-button"
    >
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="3" strokeWidth={2} />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>
    </button>
  );

  return (
    <div className="h-full bg-panel overflow-auto" data-testid="station-detail">
      <Panel title="Station" headerActions={centerButton}>
        <div className="space-y-3">
          <DetailRow
            label="ID"
            value={formatStationId(sectionId, stationPosition)}
          />
          <DetailRow label="Section" value={section?.name ?? `Section ${sectionId}`} />
          <DetailRow label="X" value={`${station.coordinates.x.toFixed(2)} m`} />
          <DetailRow label="Y" value={`${station.coordinates.y.toFixed(2)} m`} />
          <DetailRow label="Depth" value={`${station.coordinates.z.toFixed(1)} m`} />

          {station.is_zero_datum && (
            <div className="pt-2 border-t border-border">
              <span className="text-warning">&#9733; Zero Datum</span>
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
              <ul className="mt-1 space-y-1">
                {station.merged_with.map((ref, i) => (
                  <li key={i} className="text-sm">
                    <DetailLink
                      type="station"
                      target={{ sectionId: ref.section_id, position: ref.station_index }}
                      displayText={formatStationId(ref.section_id, ref.station_index)}
                      onSelect={() => handleSelectMergedStation(ref)}
                      isMissing={!mergedStationExists(ref)}
                      onAnnounce={announceSelection}
                      onHoverStart={() => setHoveredStation({ section_id: ref.section_id, station_index: ref.station_index })}
                      onHoverEnd={() => setHoveredStation(null)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {station.closures_with && station.closures_with.length > 0 && (
            <ClosuresSection
              closures={station.closures_with}
              loopClosures={project?.loop_closures ?? []}
              stations={stations}
              onSelectStation={handleSelectMergedStation}
              onAnnounce={announceSelection}
              onHoverStart={(ref) => setHoveredStation({ section_id: ref.section_id, station_index: ref.station_index })}
              onHoverEnd={() => setHoveredStation(null)}
            />
          )}

          {/* Connected section with hyperlinks */}
          <div className="pt-2 border-t border-border">
            <span className="text-sm text-text-secondary">Connected:</span>
            <div className="mt-1 space-y-1 text-sm">
              {!isFirstStation && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">Previous Shot:</span>
                  <DetailLink
                    type="shot"
                    target={{ sectionId, position: prevShotPosition }}
                    displayText={`${sectionId}:${prevShotPosition}`}
                    onSelect={handleSelectPrevShot}
                    isMissing={!prevShotExists}
                    onAnnounce={announceSelection}
                    onHoverStart={() => {
                      const shot = section?.shots[prevShotIndex];
                      if (shot) setHoveredShot({ sectionId, shotId: shot.id });
                    }}
                    onHoverEnd={() => setHoveredShot(null)}
                  />
                </div>
              )}
              {!isLastStation && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">Next Shot:</span>
                  <DetailLink
                    type="shot"
                    target={{ sectionId, position: nextShotPosition }}
                    displayText={`${sectionId}:${nextShotPosition}`}
                    onSelect={handleSelectNextShot}
                    isMissing={!nextShotExists}
                    onAnnounce={announceSelection}
                    onHoverStart={() => {
                      const shot = section?.shots[nextShotIndex];
                      if (shot) setHoveredShot({ sectionId, shotId: shot.id });
                    }}
                    onHoverEnd={() => setHoveredShot(null)}
                  />
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-text-secondary">Section:</span>
                <DetailLink
                  type="section"
                  target={{ sectionId }}
                  displayText={sectionDisplayText}
                  onSelect={handleSelectSection}
                  onAnnounce={announceSelection}
                  onHoverStart={() => setHoveredSectionId(sectionId)}
                  onHoverEnd={() => setHoveredSectionId(null)}
                />
              </div>
            </div>
          </div>
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

function ShotDetail({ section, shot, stations }: { section: Section; shot: Shot; stations: Station[] }) {
  const { setShotVirtual } = useProjectStore();
  const { openDialog, setSelection, triggerCenterOnShot, announceSelection, setHoveredStation, setHoveredSectionId } = useUIStore();

  // Calculate shot index (0-indexed) and positions (1-indexed for display)
  const shotIndex = section.shots.indexOf(shot);
  const shotPosition = shotIndex + 1;

  // Shot-to-Station mapping:
  // Shot at array index i connects:
  // - Start station: station_index = i (display position = i, 0-indexed)
  // - End station: station_index = i + 1 (display position = i + 1, 0-indexed)
  const startStationIndex = shotIndex;
  const endStationIndex = shotIndex + 1;
  const startStationPosition = startStationIndex;
  const endStationPosition = endStationIndex;

  // Validate station targets exist
  const startStationExists = stations.some(
    (s) => s.station_ref.section_id === section.id && s.station_ref.station_index === startStationIndex
  );
  const endStationExists = stations.some(
    (s) => s.station_ref.section_id === section.id && s.station_ref.station_index === endStationIndex
  );

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

  const handleSelectStartStation = () => {
    setSelection({
      type: 'station',
      stationRef: { section_id: section.id, station_index: startStationIndex },
    });
  };

  const handleSelectEndStation = () => {
    setSelection({
      type: 'station',
      stationRef: { section_id: section.id, station_index: endStationIndex },
    });
  };

  const handleSelectSection = () => {
    setSelection({ type: 'section', sectionId: section.id });
  };

  const handleCenterOnShot = () => {
    triggerCenterOnShot(section.id, shot.id);
  };

  const sectionDisplayText = `${section.id}: ${section.name ?? 'Unnamed'}`;

  const centerButton = (
    <button
      type="button"
      onClick={handleCenterOnShot}
      className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-background/50 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset"
      aria-label={`Center map on shot ${section.id}:${shotPosition}`}
      data-testid="center-shot-button"
    >
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="3" strokeWidth={2} />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>
    </button>
  );

  return (
    <div className="h-full bg-panel overflow-auto">
      <Panel title="Shot" headerActions={centerButton}>
        <div className="space-y-3">
          <DetailRow label="ID" value={formatShotId(section.id, shotPosition)} />
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

          {/* Connected section with hyperlinks */}
          <div className="pt-2 border-t border-border">
            <span className="text-sm text-text-secondary">Connected:</span>
            <div className="mt-1 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">Start Station:</span>
                <DetailLink
                  type="station"
                  target={{ sectionId: section.id, position: startStationPosition }}
                  displayText={formatStationId(section.id, startStationPosition)}
                  onSelect={handleSelectStartStation}
                  isMissing={!startStationExists}
                  onAnnounce={announceSelection}
                  onHoverStart={() => setHoveredStation({ section_id: section.id, station_index: startStationIndex })}
                  onHoverEnd={() => setHoveredStation(null)}
                />
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">End Station:</span>
                <DetailLink
                  type="station"
                  target={{ sectionId: section.id, position: endStationPosition }}
                  displayText={formatStationId(section.id, endStationPosition)}
                  onSelect={handleSelectEndStation}
                  isMissing={!endStationExists}
                  onAnnounce={announceSelection}
                  onHoverStart={() => setHoveredStation({ section_id: section.id, station_index: endStationIndex })}
                  onHoverEnd={() => setHoveredStation(null)}
                />
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Section:</span>
                <DetailLink
                  type="section"
                  target={{ sectionId: section.id }}
                  displayText={sectionDisplayText}
                  onSelect={handleSelectSection}
                  onAnnounce={announceSelection}
                  onHoverStart={() => setHoveredSectionId(section.id)}
                  onHoverEnd={() => setHoveredSectionId(null)}
                />
              </div>
            </div>
          </div>

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
  const { openDialog, setSelection, triggerZoomToSection, announceSelection, setHoveredStation } = useUIStore();

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

  // Endpoint stations for navigation links
  // First station: index 0, position 0 (0-indexed)
  // Last station: index = shots.length, position = shots.length (0-indexed)
  const firstStationIndex = 0;
  const firstStationPosition = 0;
  const lastStationIndex = section.shots.length; // Number of shots = last station index
  const lastStationPosition = lastStationIndex;

  // Single station case: when there are 0 shots, there's only station 0 (position 1)
  const hasSingleStation = section.shots.length === 0;

  // Validate station targets exist
  const firstStationExists = stations.some(
    (s) => s.station_ref.section_id === section.id && s.station_ref.station_index === firstStationIndex
  );
  const lastStationExists = stations.some(
    (s) => s.station_ref.section_id === section.id && s.station_ref.station_index === lastStationIndex
  );

  const handleSelectFirstStation = () => {
    setSelection({
      type: 'station',
      stationRef: { section_id: section.id, station_index: firstStationIndex },
    });
  };

  const handleSelectLastStation = () => {
    setSelection({
      type: 'station',
      stationRef: { section_id: section.id, station_index: lastStationIndex },
    });
  };

  const handleCenterOnSection = () => {
    triggerZoomToSection(section.id);
  };

  const handleEditSection = () => {
    openDialog('edit-section', { sectionId: section.id });
  };

  const sectionDisplayName = section.name ?? 'Unnamed';

  const centerButton = (
    <button
      type="button"
      onClick={handleCenterOnSection}
      className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-background/50 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset"
      aria-label={`Center map on section ${section.id}: ${sectionDisplayName}`}
      data-testid="center-section-button"
    >
      <svg
        className="w-4 h-4"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <circle cx="12" cy="12" r="3" strokeWidth={2} />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 2v4M12 18v4M2 12h4M18 12h4" />
      </svg>
    </button>
  );

  return (
    <div className="h-full bg-panel overflow-auto" data-testid="section-detail">
      <Panel title="Section" headerActions={centerButton}>
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

          {/* Endpoints - first and last station links */}
          {sectionStations.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-border">
              <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                Endpoints
              </h4>
              <div className="space-y-1 text-sm">
                {hasSingleStation ? (
                  // Single station case
                  <div className="flex justify-between">
                    <span className="text-text-secondary">Only Station:</span>
                    <DetailLink
                      type="station"
                      target={{ sectionId: section.id, position: firstStationPosition }}
                      displayText={formatStationId(section.id, firstStationPosition)}
                      onSelect={handleSelectFirstStation}
                      isMissing={!firstStationExists}
                      onAnnounce={announceSelection}
                      onHoverStart={() => setHoveredStation({ section_id: section.id, station_index: firstStationIndex })}
                      onHoverEnd={() => setHoveredStation(null)}
                    />
                  </div>
                ) : (
                  // Multiple stations case
                  <>
                    <div className="flex justify-between">
                      <span className="text-text-secondary">First Station:</span>
                      <DetailLink
                        type="station"
                        target={{ sectionId: section.id, position: firstStationPosition }}
                        displayText={formatStationId(section.id, firstStationPosition)}
                        onSelect={handleSelectFirstStation}
                        isMissing={!firstStationExists}
                        onAnnounce={announceSelection}
                        onHoverStart={() => setHoveredStation({ section_id: section.id, station_index: firstStationIndex })}
                        onHoverEnd={() => setHoveredStation(null)}
                      />
                    </div>
                    <div className="flex justify-between">
                      <span className="text-text-secondary">Last Station:</span>
                      <DetailLink
                        type="station"
                        target={{ sectionId: section.id, position: lastStationPosition }}
                        displayText={formatStationId(section.id, lastStationPosition)}
                        onSelect={handleSelectLastStation}
                        isMissing={!lastStationExists}
                        onAnnounce={announceSelection}
                        onHoverStart={() => setHoveredStation({ section_id: section.id, station_index: lastStationIndex })}
                        onHoverEnd={() => setHoveredStation(null)}
                      />
                    </div>
                  </>
                )}
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

interface ClosuresSectionProps {
  closures: ClosureRef[];
  loopClosures: LoopClosure[];
  stations: Station[];
  onSelectStation: (ref: { section_id: number; station_index: number }) => void;
  onAnnounce: (message: string) => void;
  onHoverStart: (ref: { section_id: number; station_index: number }) => void;
  onHoverEnd: () => void;
}

function ClosuresSection({
  closures,
  loopClosures,
  stations,
  onSelectStation,
  onAnnounce,
  onHoverStart,
  onHoverEnd,
}: ClosuresSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const contentId = 'closures-section-content';

  // Precompute station existence set for O(1) lookups
  const stationKeySet = useMemo(() => {
    const keys = new Set<string>();
    for (const s of stations) {
      keys.add(`${s.station_ref.section_id}:${s.station_ref.station_index}`);
    }
    return keys;
  }, [stations]);

  const stationExists = (ref: { section_id: number; station_index: number }): boolean => {
    return stationKeySet.has(`${ref.section_id}:${ref.station_index}`);
  };

  // Precompute loop closures map for O(1) lookups
  const closureMap = useMemo(() => {
    const map = new Map<number, LoopClosure>();
    for (const lc of loopClosures) {
      map.set(lc.id, lc);
    }
    return map;
  }, [loopClosures]);

  // Group closures by closure_id and sort deterministically
  const sortedGroups = useMemo(() => {
    const grouped = new Map<number, ClosureRef[]>();
    for (const c of closures) {
      const existing = grouped.get(c.closure_id);
      if (existing) {
        existing.push(c);
      } else {
        grouped.set(c.closure_id, [c]);
      }
    }

    // Sort: direct closures first, then transitive; tiebreak by closure_id ascending
    return Array.from(grouped.entries()).sort(([idA, refsA], [idB, refsB]) => {
      const aHasDirect = refsA.some((r) => !r.is_transitive);
      const bHasDirect = refsB.some((r) => !r.is_transitive);
      if (aHasDirect && !bHasDirect) return -1;
      if (!aHasDirect && bHasDirect) return 1;
      return idA - idB;
    });
  }, [closures]);

  return (
    <div className="pt-2 border-t border-border" data-testid="closures-section">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1 text-sm text-text-secondary hover:text-text-primary w-full text-left"
        data-testid="closures-section-toggle"
        aria-expanded={expanded}
        aria-controls={contentId}
      >
        <span className="text-xs">{expanded ? '▼' : '▶'}</span>
        <span>Loop Closures</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-2" id={contentId} data-testid="closures-section-content">
          {sortedGroups.map(([closureId, refs]) => {
            const closure = closureMap.get(closureId);
            const directRefs = refs.filter((r) => !r.is_transitive);
            const transitiveRefs = refs.filter((r) => r.is_transitive);

            return (
              <div key={closureId} className="space-y-1">
                {directRefs.length > 0 && (
                  <div className="text-sm" data-testid={`closure-direct-${closureId}`}>
                    <span className="text-text-secondary">Closure to </span>
                    {directRefs.map((ref, i) => (
                      <span key={i}>
                        {i > 0 && ', '}
                        <DetailLink
                          type="station"
                          target={{ sectionId: ref.station_ref.section_id, position: ref.station_ref.station_index }}
                          displayText={formatStationId(ref.station_ref.section_id, ref.station_ref.station_index)}
                          onSelect={() => onSelectStation(ref.station_ref)}
                          isMissing={!stationExists(ref.station_ref)}
                          onAnnounce={onAnnounce}
                          onHoverStart={() => onHoverStart(ref.station_ref)}
                          onHoverEnd={onHoverEnd}
                        />
                      </span>
                    ))}
                  </div>
                )}
                {transitiveRefs.length > 0 && (
                  <div className="text-sm text-text-tertiary opacity-60" data-testid={`closure-transitive-${closureId}`}>
                    <span>Transitive closure to </span>
                    {transitiveRefs.map((ref, i) => (
                      <span key={i}>
                        {i > 0 && ', '}
                        <DetailLink
                          type="station"
                          target={{ sectionId: ref.station_ref.section_id, position: ref.station_ref.station_index }}
                          displayText={formatStationId(ref.station_ref.section_id, ref.station_ref.station_index)}
                          onSelect={() => onSelectStation(ref.station_ref)}
                          isMissing={!stationExists(ref.station_ref)}
                          onAnnounce={onAnnounce}
                          onHoverStart={() => onHoverStart(ref.station_ref)}
                          onHoverEnd={onHoverEnd}
                        />
                        {ref.via_station && (
                          <span>
                            {' (via '}
                            <DetailLink
                              type="station"
                              target={{ sectionId: ref.via_station.section_id, position: ref.via_station.station_index }}
                              displayText={formatStationId(ref.via_station.section_id, ref.via_station.station_index)}
                              onSelect={() => onSelectStation(ref.via_station!)}
                              isMissing={!stationExists(ref.via_station)}
                              onAnnounce={onAnnounce}
                              onHoverStart={() => onHoverStart(ref.via_station!)}
                              onHoverEnd={onHoverEnd}
                            />
                            {')'}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
                {closure ? (
                  <div className="text-xs text-text-secondary" data-testid={`closure-metrics-${closureId}`}>
                    Path: {closure.path_length.toFixed(1)}m | Error: {closure.misclosure_distance.toFixed(2)}m ({closure.error_percentage.toFixed(2)}%)
                  </div>
                ) : (
                  <div className="text-xs text-text-secondary" data-testid={`closure-metrics-${closureId}`}>
                    Metrics unavailable
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
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
