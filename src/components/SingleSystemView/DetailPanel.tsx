import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useUIStore, type Selection } from '../../store/uiStore';
import { useShallow } from 'zustand/react/shallow';
import { useProjectStore } from '../../store/projectStore';
import { Panel } from '../common/Panel';
import { Button } from '../common/Button';
import { AlertCircleIcon, AlertTriangleIcon, CheckCircleIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon, LinkOffIcon } from '../common/icons';
import { DetailLink } from '../common/DetailLink';
import type { Station, Shot, Section, Project, ProjectStats as ProjectStatsType, ClosureRef, LoopClosure } from '../../types/project';
import type { ProjectWarning } from '../../types/commands';
import { formatShotId, formatStationId } from '../../utils/formatters';
import { getDeleteShotDialog } from '../../utils/contextMenuHelpers';
import { formatFixed, formatPercent, formatNumber, formatDate } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { setSource, trackContextMenuAction } from '../../utils/telemetry';

export default function DetailPanel() {
  const { t } = useTranslation();
  const { selection, detailPanelTab, setDetailPanelTab, setSelection } = useUIStore(
    useShallow((s) => ({ selection: s.selection, detailPanelTab: s.detailPanelTab, setDetailPanelTab: s.setDetailPanelTab, setSelection: s.setSelection }))
  );
  const { project, stations, warnings } = useProjectStore();

  const unresolvedWarnings = warnings.filter((w) => !w.isResolved);
  const errorCount = unresolvedWarnings.filter((w) => w.severity === 'error').length;
  const unresolvedCount = unresolvedWarnings.length;

  return (
    <div className="h-full bg-panel flex flex-col" data-testid="detail-panel">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        <TabButton
          active={detailPanelTab === 'details'}
          onClick={() => setDetailPanelTab('details')}
          testId="detail-tab-details"
        >
          {t('detailPanel.tabs.details')}
        </TabButton>
        <TabButton
          active={detailPanelTab === 'warnings'}
          onClick={() => setDetailPanelTab('warnings')}
          badge={unresolvedCount > 0 ? unresolvedCount : undefined}
          badgeType={errorCount > 0 ? 'error' : 'warning'}
          testId="detail-tab-warnings"
        >
          {t('detailPanel.tabs.warnings')}
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
              setSource('detail-panel');
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
            ${badgeType === 'error' ? 'bg-error-10 text-error' : 'bg-warning-10 text-warning'}
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
  const { t } = useTranslation();
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
      <div className="text-text-secondary">{t('detailPanel.selectionNotFound')}</div>
    </div>
  );
}

interface WarningsContentProps {
  warnings: ProjectWarning[];
  project: Project | null;
  onWarningClick: (warning: ProjectWarning) => void;
}

function WarningsContent({ warnings, project, onWarningClick }: WarningsContentProps) {
  const { t } = useTranslation();
  const { resolveWarning, resolveAllWarnings, unresolveWarning } = useProjectStore();
  const [showResolved, setShowResolved] = useState(false);

  const unresolvedCount = warnings.filter((w) => !w.isResolved).length;
  const resolvedCount = warnings.filter((w) => w.isResolved).length;
  const displayedWarnings = showResolved ? warnings : warnings.filter((w) => !w.isResolved);

  if (warnings.length === 0) {
    return (
      <div className="p-4 text-center text-text-secondary">
        <div className="text-3xl mb-2 flex items-center justify-center">
          <CheckCircleIcon size={28} />
        </div>
        <p>{t('detailPanel.warnings.empty')}</p>
      </div>
    );
  }

  const getSectionName = (sectionId: number) => {
    const section = project?.sections.find((s) => s.id === sectionId);
    return section?.name ?? t('sections.defaultName', { id: sectionId });
  };

  const handleDismiss = (e: React.MouseEvent, warning: ProjectWarning) => {
    e.stopPropagation();
    resolveWarning(warning.sectionId, warning.shotId, warning.code);
  };

  const handleUndoResolve = (e: React.MouseEvent, warning: ProjectWarning) => {
    e.stopPropagation();
    unresolveWarning(warning.sectionId, warning.shotId, warning.code);
  };

  return (
    <div className="p-2" data-testid="warnings-content">
      <div className="flex items-center justify-between mb-2 px-2">
        <span className="text-sm text-text-secondary">
          {t('detailPanel.warnings.count', {
            count: unresolvedCount,
            countFormatted: formatNumber(unresolvedCount),
          })}
          {resolvedCount > 0 && ` ${t('detailPanel.warnings.resolvedCount', {
            count: resolvedCount,
            countFormatted: formatNumber(resolvedCount),
          })}`}
        </span>
        <div className="flex items-center gap-2">
          {resolvedCount > 0 && (
            <button
              onClick={() => setShowResolved(!showResolved)}
              className="text-xs text-accent hover:underline"
            >
              {showResolved ? t('detailPanel.warnings.hideResolved') : t('detailPanel.warnings.showResolved')}
            </button>
          )}
          {unresolvedCount > 0 && (
            <button
              onClick={() => resolveAllWarnings()}
              className="text-xs px-2 py-0.5 rounded bg-background-50 hover:bg-background text-text-secondary"
              data-testid="clear-all-warnings"
              title={t('detailPanel.warnings.clearAll')}
            >
              {t('detailPanel.warnings.clearAll')}
            </button>
          )}
        </div>
      </div>
      <div className="space-y-1" role="list" aria-label={t('detailPanel.tabs.warnings')}>
        {displayedWarnings.map((warning, index) => (
          <div
            key={`${warning.sectionId}-${warning.shotId}-${warning.code}-${index}`}
            role="listitem"
            className={`
              p-2 rounded transition-colors
              ${warning.isResolved ? 'opacity-50' : ''}
              hover:bg-background-50
            `}
          >
            <div className="flex items-start gap-2">
              <button
                onClick={() => onWarningClick(warning)}
                className="flex-1 text-left"
              >
                <div className="flex items-start gap-2">
                  <span className={warning.severity === 'error' ? 'text-error' : 'text-warning'}>
                    {warning.isResolved
                      ? <CheckCircleIcon size={14} />
                      : (warning.severity === 'error' ? <AlertCircleIcon size={14} /> : <AlertTriangleIcon size={14} />)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className={`text-sm ${warning.isResolved ? 'line-through' : ''}`}>
                      {warning.message}
                    </div>
                    <div className="text-xs text-text-secondary mt-0.5">
                      {t('detailPanel.warnings.location', {
                        section: getSectionName(warning.sectionId),
                        shot: formatShotId(warning.sectionId, warning.shotIndex + 1),
                      })}
                    </div>
                  </div>
                </div>
              </button>
              {warning.isResolved ? (
                <button
                  onClick={(e) => handleUndoResolve(e, warning)}
                  className="text-xs px-2 py-1 rounded bg-background-50 hover:bg-background text-text-secondary"
                  title={t('detailPanel.warnings.markUnresolved')}
                >
                  {t('common.actions.undo')}
                </button>
              ) : (
                <button
                  onClick={(e) => handleDismiss(e, warning)}
                  className="shrink-0 p-1 rounded text-text-secondary hover:text-text-primary hover:bg-background-50"
                  title={t('detailPanel.warnings.markResolved')}
                  aria-label={t('detailPanel.warnings.markResolved')}
                  data-testid="dismiss-warning"
                >
                  <CloseIcon size={14} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StationDetail({ station }: { station: Station }) {
  const { t } = useTranslation();
  const { project, stations, unmergeStations, unmergeStationPair } = useProjectStore();
  const { openDialog, setSelection, triggerCenterOnStation, announceSelection, setHoveredStation, setHoveredShot, setHoveredSectionId } = useUIStore(
    useShallow((s) => ({ openDialog: s.openDialog, setSelection: s.setSelection, triggerCenterOnStation: s.triggerCenterOnStation, announceSelection: s.announceSelection, setHoveredStation: s.setHoveredStation, setHoveredShot: s.setHoveredShot, setHoveredSectionId: s.setHoveredSectionId }))
  );
  const precision = useDecimalPrecision();
  const [unmergeTargetKey, setUnmergeTargetKey] = useState<string | null>(null);
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
    setSource('detail-panel');
    openDialog('edit-station', { stationRef: station.station_ref });
  };

  const handleSelectPrevShot = () => {
    if (section && prevShotExists) {
      const shot = section.shots[prevShotIndex];
      if (shot) {
        setSource('detail-panel');
        setSelection({ type: 'shot', sectionId, shotId: shot.id });
      }
    }
  };

  const handleSelectNextShot = () => {
    if (section && nextShotExists) {
      const shot = section.shots[nextShotIndex];
      if (shot) {
        setSource('detail-panel');
        setSelection({ type: 'shot', sectionId, shotId: shot.id });
      }
    }
  };

  const handleSelectSection = () => {
    setSource('detail-panel');
    setSelection({ type: 'section', sectionId });
  };

  const handleSelectMergedStation = (ref: { section_id: number; station_index: number }) => {
    setSource('detail-panel');
    setSelection({
      type: 'station',
      stationRef: { section_id: ref.section_id, station_index: ref.station_index },
    });
  };

  const handleCenterOnStation = () => {
    setSource('detail-panel');
    triggerCenterOnStation(station.station_ref);
  };

  const sameStationRef = (a: { section_id: number; station_index: number }, b: { section_id: number; station_index: number }): boolean => {
    return a.section_id === b.section_id && a.station_index === b.station_index;
  };

  const isDirectMerge = (ref: { section_id: number; station_index: number }): boolean => {
    return project?.station_merges.some((merge) => {
      const direct = sameStationRef(merge.station_a, station.station_ref) && sameStationRef(merge.station_b, ref);
      const reverse = sameStationRef(merge.station_a, ref) && sameStationRef(merge.station_b, station.station_ref);
      return direct || reverse;
    }) ?? false;
  };

  const handleUnmergeFromStation = async (ref: { section_id: number; station_index: number }) => {
    trackContextMenuAction('unmerge', 'detail-panel');
    const targetKey = `${ref.section_id}:${ref.station_index}`;
    setUnmergeTargetKey(targetKey);
    try {
      if (isDirectMerge(ref)) {
        await unmergeStationPair(station.station_ref, ref);
      } else {
        await unmergeStations(station.station_ref);
      }
    } finally {
      setUnmergeTargetKey(null);
    }
  };

  // Validate merged station targets exist
  const mergedStationExists = (ref: { section_id: number; station_index: number }): boolean => {
    return stations.some(
      (s) => s.station_ref.section_id === ref.section_id && s.station_ref.station_index === ref.station_index
    );
  };

  const sectionName = section?.name ?? t('detailPanel.section.unnamed');
  const sectionDisplayText = t('detailPanel.section.display', {
    id: sectionId,
    name: sectionName,
  });

  const centerButton = (
    <button
      type="button"
      onClick={handleCenterOnStation}
      className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-background-50 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset"
      aria-label={t('detailPanel.station.center', {
        id: formatStationId(sectionId, stationPosition),
      })}
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
      <Panel title={t('detailPanel.station.title')} headerActions={centerButton}>
        <div className="space-y-3">
          <DetailRow
            label={t('detailPanel.labels.id')}
            value={formatStationId(sectionId, stationPosition)}
          />
          <DetailRow label={t('detailPanel.labels.section')} value={section?.name ?? t('sections.defaultName', { id: sectionId })} />
          <DetailRow label={t('detailPanel.labels.x')} value={`${formatFixed(station.coordinates.x, undefined, precision.coordinates)} ${t('common.units.meters')}`} />
          <DetailRow label={t('detailPanel.labels.y')} value={`${formatFixed(station.coordinates.y, undefined, precision.coordinates)} ${t('common.units.meters')}`} />
          <DetailRow label={t('detailPanel.labels.depth')} value={`${formatFixed(station.coordinates.z, undefined, precision.depth)} ${t('common.units.meters')}`} />

          {station.comment && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">{t('detailPanel.station.comment')}:</span>
              <p className="mt-1 text-sm whitespace-pre-wrap">{station.comment}</p>
            </div>
          )}

          {station.is_zero_datum && (
            <div className="pt-2 border-t border-border">
              <span className="text-warning">&#9733; {t('detailPanel.station.zeroDatum')}</span>
              {station.gps_coordinates && (
                <div className="mt-2 text-sm">
                  <DetailRow
                    label={t('detailPanel.labels.latitude')}
                    value={formatFixed(station.gps_coordinates.latitude, undefined, precision.gps)}
                  />
                  <DetailRow
                    label={t('detailPanel.labels.longitude')}
                    value={formatFixed(station.gps_coordinates.longitude, undefined, precision.gps)}
                  />
                </div>
              )}
            </div>
          )}

          {station.merged_with.length > 0 && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">{t('detailPanel.station.mergedWith')}:</span>
              <ul className="mt-1 space-y-1">
                {station.merged_with.map((ref, i) => (
                  <li key={i} className="text-sm flex items-center justify-between gap-2">
                    <div>
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
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void handleUnmergeFromStation(ref);
                      }}
                      className="p-1 rounded text-text-secondary hover:text-error hover:bg-error-10 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset disabled:opacity-50 disabled:cursor-not-allowed"
                      title="Unmerge Stations"
                      aria-label={`Unmerge station ${formatStationId(ref.section_id, ref.station_index)}`}
                      data-testid={`detail-unmerge-${ref.section_id}-${ref.station_index}`}
                      disabled={unmergeTargetKey === `${ref.section_id}:${ref.station_index}`}
                    >
                      <LinkOffIcon size={14} />
                    </button>
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
              anchorStation={station.station_ref}
              onSelectStation={handleSelectMergedStation}
              onAnnounce={announceSelection}
              onHoverStart={(ref) => setHoveredStation({ section_id: ref.section_id, station_index: ref.station_index })}
              onHoverEnd={() => setHoveredStation(null)}
            />
          )}

          {/* Connected section with hyperlinks */}
          <div className="pt-2 border-t border-border">
            <span className="text-sm text-text-secondary">{t('detailPanel.station.connected')}:</span>
            <div className="mt-1 space-y-1 text-sm">
              {!isFirstStation && (
                <div className="flex justify-between">
                  <span className="text-text-secondary">{t('detailPanel.station.previousShot')}:</span>
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
                  <span className="text-text-secondary">{t('detailPanel.station.nextShot')}:</span>
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
                <span className="text-text-secondary">{t('detailPanel.labels.section')}:</span>
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
          {t('common.actions.edit')}
        </Button>
      </div>
    </div>
  );
}

/**
 * Compute inclination from depth change and shot length.
 * Positive = upward (depth decreases), negative = downward.
 * Returns null if length <= 0.
 */
function computeInclination(depthIn: number, depthOut: number, length: number): number | null {
  if (length <= 0) return null;
  const ratio = (depthIn - depthOut) / length;
  const clamped = Math.max(-1, Math.min(1, ratio));
  return (Math.asin(clamped) * 180) / Math.PI;
}

function ShotDetail({ section, shot, stations }: { section: Section; shot: Shot; stations: Station[] }) {
  const { t } = useTranslation();
  const { setShotReference } = useProjectStore();
  const { openDialog, setSelection, triggerCenterOnShot, announceSelection, setHoveredStation, setHoveredSectionId } = useUIStore(
    useShallow((s) => ({ openDialog: s.openDialog, setSelection: s.setSelection, triggerCenterOnShot: s.triggerCenterOnShot, announceSelection: s.announceSelection, setHoveredStation: s.setHoveredStation, setHoveredSectionId: s.setHoveredSectionId }))
  );
  const precision = useDecimalPrecision();

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

  const handleToggleReference = async () => {
    trackContextMenuAction('toggle-reference', 'detail-panel');
    await setShotReference(section.id, shot.id, !shot.is_reference);
  };

  const handleDelete = () => {
    setSource('detail-panel');
    const totalShots = section.shots.length;
    const isFirst = shotIndex === 0;
    const isLast = shotIndex === totalShots - 1;
    const { dialog, data } = getDeleteShotDialog(
      section.id,
      shot.id,
      isFirst,
      isLast,
      totalShots,
      section.name ?? t('sections.defaultName', { id: section.id }),
    );
    openDialog(dialog, data);
  };

  const handleSelectStartStation = () => {
    setSource('detail-panel');
    setSelection({
      type: 'station',
      stationRef: { section_id: section.id, station_index: startStationIndex },
    });
  };

  const handleSelectEndStation = () => {
    setSource('detail-panel');
    setSelection({
      type: 'station',
      stationRef: { section_id: section.id, station_index: endStationIndex },
    });
  };

  const handleSelectSection = () => {
    setSource('detail-panel');
    setSelection({ type: 'section', sectionId: section.id });
  };

  const handleCenterOnShot = () => {
    setSource('detail-panel');
    triggerCenterOnShot(section.id, shot.id);
  };

  const sectionName = section.name ?? t('detailPanel.section.unnamed');
  const sectionDisplayText = t('detailPanel.section.display', {
    id: section.id,
    name: sectionName,
  });

  const centerButton = (
    <button
      type="button"
      onClick={handleCenterOnShot}
      className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-background-50 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset"
      aria-label={t('detailPanel.shot.center', {
        id: formatShotId(section.id, shotPosition),
      })}
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
      <Panel title={t('detailPanel.shot.title')} headerActions={centerButton}>
        <div className="space-y-3">
          <DetailRow label={t('detailPanel.labels.id')} value={formatShotId(section.id, shotPosition)} />
          <DetailRow label={t('detailPanel.labels.section')} value={section.name ?? t('sections.defaultName', { id: section.id })} />
          <DetailRow label={t('detailPanel.labels.length')} value={`${formatFixed(shot.length, undefined, precision.length)} ${t('common.units.meters')}`} />
          <DetailRow label={t('detailPanel.labels.azimuthIn')} value={`${formatFixed(shot.azimuth_in, undefined, precision.azimuth)}°`} />
          <DetailRow label={t('detailPanel.labels.azimuthOut')} value={`${formatFixed(shot.azimuth_out, undefined, precision.azimuth)}°`} />
          <DetailRow label={t('detailPanel.labels.depthIn')} value={`${formatFixed(shot.depth_in, undefined, precision.depth)} ${t('common.units.meters')}`} />
          <DetailRow label={t('detailPanel.labels.depthOut')} value={`${formatFixed(shot.depth_out, undefined, precision.depth)} ${t('common.units.meters')}`} />

          {(shot.pitch_in !== null || shot.pitch_out !== null || shot.length > 0) && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">{t('detailPanel.shot.inclination')}:</span>
              <div className="mt-1 space-y-1 text-sm">
                {shot.pitch_in !== null && (
                  <DetailRow label={t('detailPanel.labels.pitchIn')} value={`${formatFixed(shot.pitch_in, undefined, precision.inclination)}°`} />
                )}
                {shot.pitch_out !== null && (
                  <DetailRow label={t('detailPanel.labels.pitchOut')} value={`${formatFixed(shot.pitch_out, undefined, precision.inclination)}°`} />
                )}
                {shot.length > 0 && (() => {
                  const incl = computeInclination(shot.depth_in, shot.depth_out, shot.length);
                  return incl !== null ? (
                    <DetailRow label={t('detailPanel.shot.computed')} value={`${formatFixed(incl, undefined, precision.inclination)}°`} />
                  ) : null;
                })()}
              </div>
            </div>
          )}

          {(shot.left !== null || shot.right !== null || shot.up !== null || shot.down !== null) && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">{t('detailPanel.shot.lrud')}:</span>
              <div className="grid grid-cols-2 gap-2 mt-1 text-sm">
                <DetailRow label={t('detailPanel.labels.leftShort')} value={shot.left != null ? formatFixed(shot.left, undefined, precision.length) : t('detailPanel.placeholder.none')} />
                <DetailRow label={t('detailPanel.labels.rightShort')} value={shot.right != null ? formatFixed(shot.right, undefined, precision.length) : t('detailPanel.placeholder.none')} />
                <DetailRow label={t('detailPanel.labels.upShort')} value={shot.up != null ? formatFixed(shot.up, undefined, precision.length) : t('detailPanel.placeholder.none')} />
                <DetailRow label={t('detailPanel.labels.downShort')} value={shot.down != null ? formatFixed(shot.down, undefined, precision.length) : t('detailPanel.placeholder.none')} />
              </div>
            </div>
          )}

          {/* Connected section with hyperlinks */}
          <div className="pt-2 border-t border-border">
            <span className="text-sm text-text-secondary">{t('detailPanel.shot.connected')}:</span>
            <div className="mt-1 space-y-1 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">{t('detailPanel.shot.startStation')}:</span>
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
                <span className="text-text-secondary">{t('detailPanel.shot.endStation')}:</span>
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
                <span className="text-text-secondary">{t('detailPanel.labels.section')}:</span>
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

          {shot.is_reference && (
            <div className="text-warning text-sm">{t('detailPanel.shot.reference')}</div>
          )}

          {shot.comment && (
            <div className="pt-2 border-t border-border">
              <span className="text-sm text-text-secondary">{t('detailPanel.labels.comment')}:</span>
              <p className="text-sm mt-1">{shot.comment}</p>
            </div>
          )}
        </div>
      </Panel>

      <div className="p-3 border-t border-border space-y-2">
        <Button size="sm" className="w-full" onClick={handleToggleReference}>
          {shot.is_reference ? t('detailPanel.shot.markPermanent') : t('detailPanel.shot.markReference')}
        </Button>
        <Button size="sm" variant="danger" className="w-full" onClick={handleDelete}>
          {t('common.actions.delete')}
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
  const { t } = useTranslation();
  const { openDialog, setSelection, triggerZoomToSection, announceSelection, setHoveredStation } = useUIStore(
    useShallow((s) => ({ openDialog: s.openDialog, setSelection: s.setSelection, triggerZoomToSection: s.triggerZoomToSection, announceSelection: s.announceSelection, setHoveredStation: s.setHoveredStation }))
  );
  const precision = useDecimalPrecision();

  // Calculate section statistics
  const sectionLength = section.shots.reduce((sum, s) => sum + s.length, 0);
  const shotCount = section.shots.length;
  const referenceCount = section.shots.filter((s) => s.is_reference).length;
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
    setSource('detail-panel');
    setSelection({
      type: 'station',
      stationRef: { section_id: section.id, station_index: firstStationIndex },
    });
  };

  const handleSelectLastStation = () => {
    setSource('detail-panel');
    setSelection({
      type: 'station',
      stationRef: { section_id: section.id, station_index: lastStationIndex },
    });
  };

  const handleCenterOnSection = () => {
    setSource('detail-panel');
    triggerZoomToSection(section.id);
  };

  const handleEditSection = () => {
    setSource('detail-panel');
    openDialog('edit-section', { sectionId: section.id });
  };

  const sectionDisplayName = section.name ?? t('detailPanel.section.unnamed');

  const centerButton = (
    <button
      type="button"
      onClick={handleCenterOnSection}
      className="p-1 text-text-secondary hover:text-text-primary rounded hover:bg-background-50 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset"
      aria-label={t('detailPanel.section.center', { id: section.id, name: sectionDisplayName })}
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
      <Panel title={t('detailPanel.section.title')} headerActions={centerButton}>
        <div className="space-y-4">
          {/* Section info */}
          <div className="space-y-2">
            <DetailRow label={t('common.labels.name')} value={section.name ?? t('detailPanel.section.unnamed')} />
            <DetailRow label={t('detailPanel.labels.surveyor')} value={section.surveyor ?? t('detailPanel.placeholder.none')} />
            <DetailRow label={t('common.labels.date')} value={section.date ?? t('detailPanel.placeholder.none')} />
            <DetailRow label={t('detailPanel.labels.color')} value={
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
              {t('detailPanel.section.statsTitle')}
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <StatCard label={t('detailPanel.section.totalLength')} value={`${formatFixed(sectionLength, undefined, precision.length)} ${t('common.units.meters')}`} />
              <StatCard label={t('detailPanel.section.shotCount')} value={formatNumber(shotCount)} />
              <StatCard label={t('detailPanel.section.avgShot')} value={`${formatFixed(avgShotLength, undefined, precision.length)} ${t('common.units.meters')}`} />
              {referenceCount > 0 && (
                <StatCard label={t('detailPanel.section.referenceShots')} value={formatNumber(referenceCount)} />
              )}
            </div>
          </div>

          {/* Depth range */}
          {sectionStations.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-border">
              <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                {t('detailPanel.section.depthRange')}
              </h4>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <StatCard label={t('detailPanel.section.shallowest')} value={`${formatFixed(minDepth, undefined, precision.depth)} ${t('common.units.meters')}`} />
                <StatCard label={t('detailPanel.section.deepest')} value={`${formatFixed(maxDepth, undefined, precision.depth)} ${t('common.units.meters')}`} />
              </div>
            </div>
          )}

          {/* Endpoints - first and last station links */}
          {sectionStations.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-border">
              <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                {t('detailPanel.section.endpoints')}
              </h4>
              <div className="space-y-1 text-sm">
                {hasSingleStation ? (
                  // Single station case
                  <div className="flex justify-between">
                    <span className="text-text-secondary">{t('detailPanel.section.onlyStation')}:</span>
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
                      <span className="text-text-secondary">{t('detailPanel.section.firstStation')}:</span>
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
                      <span className="text-text-secondary">{t('detailPanel.section.lastStation')}:</span>
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
              {t('detailPanel.section.contribution')}
            </h4>
            <div className="flex items-center gap-2">
              <div className="flex-1 h-2 bg-background rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent transition-all"
                  style={{ width: `${Math.min(contributionPercent, 100)}%` }}
                />
              </div>
              <span className="text-sm font-medium w-12 text-right">
                {formatPercent(contributionPercent, undefined, 1)}
              </span>
            </div>
          </div>
        </div>
      </Panel>

      <div className="p-3 border-t border-border">
        <Button size="sm" className="w-full" onClick={handleEditSection}>
          {t('detailPanel.section.edit')}
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
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  if (!project || !stats) {
    return (
      <div className="p-4 text-center text-text-secondary">
        <p>{t('detailPanel.projectStats.empty')}</p>
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
      <Panel title={t('detailPanel.projectStats.title')}>
        <div className="space-y-4">
          {/* Survey overview */}
          <div className="space-y-2">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              {t('detailPanel.projectStats.overview')}
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <StatCard label={t('detailPanel.projectStats.totalLength')} value={`${formatFixed(stats.total_length, undefined, precision.length)} ${t('common.units.meters')}`} />
              <StatCard label={t('detailPanel.projectStats.penetration')} value={`${formatFixed(stats.penetration_distance, undefined, precision.length)} ${t('common.units.meters')}`} />
              <StatCard label={t('detailPanel.projectStats.sections')} value={formatNumber(stats.section_count)} />
              <StatCard label={t('detailPanel.projectStats.shots')} value={formatNumber(stats.shot_count)} />
              <StatCard label={t('detailPanel.projectStats.stations')} value={formatNumber(stats.station_count)} />
              {stats.loop_count > 0 && (
                <StatCard label={t('detailPanel.projectStats.loops')} value={formatNumber(stats.loop_count)} />
              )}
            </div>
          </div>

          {/* Depth information */}
          <div className="space-y-2 pt-2 border-t border-border">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              {t('detailPanel.projectStats.depthRange')}
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <StatCard label={t('detailPanel.projectStats.shallowest')} value={`${formatFixed(minDepth, undefined, precision.depth)} ${t('common.units.meters')}`} />
              <StatCard label={t('detailPanel.projectStats.deepest')} value={`${formatFixed(maxDepth, undefined, precision.depth)} ${t('common.units.meters')}`} />
              <StatCard label={t('detailPanel.projectStats.totalDepth')} value={`${formatFixed(maxDepth - minDepth, undefined, precision.depth)} ${t('common.units.meters')}`} />
            </div>
          </div>

          {/* Survey dates */}
          {(earliestDate || latestDate) && (
            <div className="space-y-2 pt-2 border-t border-border">
              <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
                {t('detailPanel.projectStats.surveyDates')}
              </h4>
              <div className="space-y-1">
                {earliestDate && (
                  <DetailRow
                    label={t('detailPanel.projectStats.firstSurvey')}
                    value={formatDate(new Date(earliestDate), undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                  />
                )}
                {latestDate && earliestDate !== latestDate && (
                  <DetailRow
                    label={t('detailPanel.projectStats.latestSurvey')}
                    value={formatDate(new Date(latestDate), undefined, { year: 'numeric', month: 'short', day: 'numeric' })}
                  />
                )}
              </div>
            </div>
          )}

          {/* Merges and datums */}
          <div className="space-y-2 pt-2 border-t border-border">
            <h4 className="text-xs font-medium text-text-secondary uppercase tracking-wide">
              {t('detailPanel.projectStats.connections')}
            </h4>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              <StatCard label={t('detailPanel.projectStats.stationMerges')} value={formatNumber(project.station_merges.length)} />
              <StatCard label={t('detailPanel.projectStats.zeroDatums')} value={formatNumber(project.zero_datums.length)} />
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
  anchorStation: { section_id: number; station_index: number };
  onSelectStation: (ref: { section_id: number; station_index: number }) => void;
  onAnnounce: (message: string) => void;
  onHoverStart: (ref: { section_id: number; station_index: number }) => void;
  onHoverEnd: () => void;
}

function ClosuresSection({
  closures,
  loopClosures,
  stations,
  anchorStation,
  onSelectStation,
  onAnnounce,
  onHoverStart,
  onHoverEnd,
}: ClosuresSectionProps) {
  const { t } = useTranslation();
  const openDialog = useUIStore((s) => s.openDialog);
  const removeLoopClosure = useProjectStore((s) => s.removeLoopClosure);
  const precision = useDecimalPrecision();
  const [expanded, setExpanded] = useState(true);
  const [removingClosureId, setRemovingClosureId] = useState<bigint | null>(null);
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
    const map = new Map<bigint, LoopClosure>();
    for (const lc of loopClosures) {
      map.set(lc.id, lc);
    }
    return map;
  }, [loopClosures]);

  // Group closures by closure_id and sort deterministically
  const sortedGroups = useMemo(() => {
    const grouped = new Map<bigint, ClosureRef[]>();
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
      if (idA < idB) return -1;
      if (idA > idB) return 1;
      return 0;
    });
  }, [closures]);

  const handleRemoveClosure = async (closureId: bigint) => {
    trackContextMenuAction('remove-closure', 'detail-panel');
    setRemovingClosureId(closureId);
    try {
      await removeLoopClosure(closureId);
    } finally {
      setRemovingClosureId(null);
    }
  };

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
        <span className="text-xs">
          {expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
        <span>{t('detailPanel.closures.title')}</span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-2" id={contentId} data-testid="closures-section-content">
          <div>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => { setSource('detail-panel'); openDialog('adjust-closures', { anchorStation }); }}
              data-testid="adjust-closures-button"
            >
              Adjust Closures
            </Button>
          </div>
          {sortedGroups.map(([closureId, refs]) => {
            const closureIdLabel = closureId.toString();
            const closure = closureMap.get(closureId);
            const directRefs = refs.filter((r) => !r.is_transitive);
            const transitiveRefs = refs.filter((r) => r.is_transitive);

            const isTransitiveOnly = directRefs.length === 0 && transitiveRefs.length > 0;

            return (
              <div key={closureIdLabel} className={`space-y-1${isTransitiveOnly ? ' opacity-50' : ''}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1 min-w-0">
                    {directRefs.length > 0 && (
                      <div className="text-sm" data-testid={`closure-direct-${closureIdLabel}`}>
                        <span className="text-text-secondary">{t('detailPanel.closures.direct')} </span>
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
                      <div className="text-sm" data-testid={`closure-transitive-${closureIdLabel}`}>
                        <span className="text-text-secondary">{t('detailPanel.closures.transitive')} </span>
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
                                {t('detailPanel.closures.viaPrefix')}
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
                                {t('detailPanel.closures.viaSuffix')}
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void handleRemoveClosure(closureId);
                    }}
                    className="p-1 rounded text-text-secondary hover:text-error hover:bg-error-10 focus:outline-none focus:ring-2 focus:ring-accent focus:ring-inset disabled:opacity-50 disabled:cursor-not-allowed"
                    title="Remove Closure"
                    aria-label={`Remove closure ${closureIdLabel}`}
                    data-testid={`detail-remove-closure-${closureIdLabel}`}
                    disabled={!closure || removingClosureId === closureId}
                  >
                    <LinkOffIcon size={14} />
                  </button>
                </div>
                {closure ? (
                  <div className="text-xs text-text-secondary" data-testid={`closure-metrics-${closureIdLabel}`}>
                    {t('detailPanel.closures.metrics', {
                      path: `${formatFixed(closure.path_length, undefined, precision.length)}${t('common.units.meters')}`,
                      error: `${formatFixed(closure.misclosure_distance, undefined, precision.length)}${t('common.units.meters')}`,
                      percent: formatPercent(closure.error_percentage, undefined, 2),
                    })}
                  </div>
                ) : (
                  <div className="text-xs text-text-secondary" data-testid={`closure-metrics-${closureId}`}>
                    {t('detailPanel.closures.unavailable')}
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
