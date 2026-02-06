import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type Section, type Shot, type ShotUpdates } from '../../types/project';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore, type Selection } from '../../store/uiStore';
import { EditableTable } from '../common/Table';
import { Select, type SelectOption } from '../common/Select';
import { AlertCircleIcon, AlertTriangleIcon, ChevronDownIcon, DotIcon } from '../common/icons';
import type { ProjectWarning } from '../../types/commands';
import { circularMeanDegrees, normalizeAngle } from '../../utils/angles';
import { formatShotId } from '../../utils/formatters';
import { formatFixed, formatNumber } from '../../i18n/format';

interface DataTableProps {
  sections: Section[];
}

export default function DataTable({ sections }: DataTableProps) {
  const { t } = useTranslation();
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    sections[0]?.id ?? null
  );
  // Track key for scrolling to a row (set when external selection changes)
  const [scrollToKey, setScrollToKey] = useState<number | null>(null);
  // Track previous selection to only react to actual selection changes
  const prevSelectionRef = useRef<Selection | null>(null);

  const { updateShot, warnings, isShotFrozen } = useProjectStore();
  const {
    selection,
    setSelection,
    setHoveredShot,
    hoveredShot,
    triggerPanToShot,
    dataTableOpen,
    toggleDataTable,
    dataTableHeight,
    announceSelection,
    setHoveredSectionId,
    openDialog,
  } = useUIStore();

  // Create a map of shot warnings for quick lookup
  const shotWarningsMap = useMemo(() => {
    const map = new Map<string, ProjectWarning[]>();
    for (const warning of warnings) {
      const key = `${warning.sectionId}:${warning.shotId}`;
      if (!map.has(key)) {
        map.set(key, []);
      }
      map.get(key)!.push(warning);
    }
    return map;
  }, [warnings]);

  const getShotWarnings = (sectionId: number, shotId: number): ProjectWarning[] => {
    return shotWarningsMap.get(`${sectionId}:${shotId}`) ?? [];
  };

  // Convert sections to SelectOption format
  const sectionOptions: SelectOption[] = useMemo(() =>
    sections.map((section) => ({
      value: String(section.id),
      label: section.name ?? t('sections.defaultName', { id: section.id }),
    })),
    [sections, t]
  );

  // Update selected section when sections change (e.g., first load or section deleted)
  useEffect(() => {
    if (sections.length === 0) {
      // No sections - clear selection
      setSelectedSectionId(null);
      return;
    }

    if (selectedSectionId === null) {
      // No selection yet - select first section
      const firstSection = sections[0];
      if (firstSection) {
        setSelectedSectionId(firstSection.id);
      }
      return;
    }

    // Check if currently selected section still exists
    const sectionExists = sections.some((s) => s.id === selectedSectionId);
    if (!sectionExists) {
      // Section was deleted - switch to first remaining section
      const firstSection = sections[0];
      setSelectedSectionId(firstSection?.id ?? null);
    }
  }, [sections, selectedSectionId]);

  // Sync external selection (from Map, Sections Panel) to DataTable
  // Only react to actual selection changes (not sections data changes)
  useEffect(() => {
    // Check if selection actually changed
    const prevSelection = prevSelectionRef.current;
    const selectionChanged =
      selection !== prevSelection &&
      (selection === null ||
        prevSelection === null ||
        selection.type !== prevSelection.type ||
        selection.sectionId !== prevSelection.sectionId ||
        selection.shotId !== prevSelection.shotId ||
        selection.stationRef?.section_id !== prevSelection.stationRef?.section_id ||
        selection.stationRef?.station_index !== prevSelection.stationRef?.station_index);

    prevSelectionRef.current = selection;

    if (!selectionChanged) return;

    if (!selection) {
      // No selection - clear scroll target but keep current dropdown
      if (dataTableOpen) {
        setScrollToKey(null);
      }
      return;
    }

    if (selection.type === 'shot' && selection.sectionId !== undefined && selection.shotId !== undefined) {
      // Shot selected externally - switch dropdown and scroll to row
      if (selection.sectionId !== selectedSectionId) {
        setSelectedSectionId(selection.sectionId);
      }
      // Only scroll if DataTable is open
      if (dataTableOpen) {
        setScrollToKey(selection.shotId);
      }
    } else if (selection.type === 'station' && selection.stationRef) {
      // Station selected - highlight the shot connected to this station.
      // Shot N connects station N to station N+1, so:
      // - Station 0 is the start of shot 0 (highlight shot 0)
      // - Station N (N >= 1) is the end of shot N-1 (highlight shot N-1)
      const { section_id, station_index } = selection.stationRef;
      const section = sections.find((s) => s.id === section_id);
      if (section) {
        // Switch section if needed
        if (section_id !== selectedSectionId) {
          setSelectedSectionId(section_id);
        }
        // Only scroll if DataTable is open
        if (dataTableOpen) {
          // Compute which shot to highlight/scroll to
          const shotIndex = station_index >= 1 ? station_index - 1 : 0;
          if (shotIndex >= 0 && shotIndex < section.shots.length) {
            const shot = section.shots[shotIndex];
            if (shot) {
              setScrollToKey(shot.id);
            }
          }
        }
      }
    } else if (selection.type === 'section' && selection.sectionId !== undefined) {
      // Section selected externally - switch dropdown, clear row highlight
      if (selection.sectionId !== selectedSectionId) {
        setSelectedSectionId(selection.sectionId);
      }
      if (dataTableOpen) {
        setScrollToKey(null);
      }
    }
  }, [selection, selectedSectionId, sections, dataTableOpen]);

  // Clear scrollToKey after it's been consumed (to allow re-scrolling to same row)
  useEffect(() => {
    if (scrollToKey === null) return;
    const timer = setTimeout(() => setScrollToKey(null), 100);
    return () => clearTimeout(timer);
  }, [scrollToKey]);

  const selectedSection = sections.find((s) => s.id === selectedSectionId);

  // Handle shot deletion - clear selection if selected shot no longer exists
  useEffect(() => {
    if (!selection || selection.type !== 'shot') return;
    if (selection.sectionId !== selectedSectionId) return;
    if (!selectedSection) return;

    // Check if the selected shot still exists in this section
    const shotExists = selectedSection.shots.some((s) => s.id === selection.shotId);
    if (!shotExists) {
      // Shot was deleted - clear selection
      setSelection(null);
    }
  }, [selection, selectedSection, selectedSectionId, setSelection]);

  // Announce shot selection changes to screen readers
  // Uses a ref to track previous selection and only announce actual changes
  const prevAnnouncedSelectionRef = useRef<{ sectionId: number; shotId: number } | null>(null);
  useEffect(() => {
    // Only announce shot selections
    if (!selection || selection.type !== 'shot') {
      prevAnnouncedSelectionRef.current = null;
      return;
    }
    if (selection.sectionId === undefined || selection.shotId === undefined) return;

    // Check if this is actually a new selection
    const prev = prevAnnouncedSelectionRef.current;
    if (prev && prev.sectionId === selection.sectionId && prev.shotId === selection.shotId) {
      return; // Same selection, don't re-announce
    }

    // Find the section for the selection (may differ from selectedSection during transitions)
    const section = sections.find((s) => s.id === selection.sectionId);
    if (!section) return;

    // Find shot position (1-indexed) for announcement
    const shotIndex = section.shots.findIndex((s) => s.id === selection.shotId);
    if (shotIndex === -1) return;

    const shotPosition = shotIndex + 1;
    const message = t('dataTable.announcement.shotSelected', {
      shotId: formatShotId(selection.sectionId, shotPosition),
    });
    announceSelection(message);

    // Update ref with new selection
    prevAnnouncedSelectionRef.current = { sectionId: selection.sectionId, shotId: selection.shotId };
  }, [selection, sections, announceSelection, t]);

  const GEOMETRY_COLUMNS = ['length', '_azimuth_avg', 'depth_in', 'depth_out'];

  const handleCellEdit = async (
    shot: Shot,
    key: string,
    value: unknown,
    index: number
  ) => {
    if (!selectedSection) return;

    // When entering cell edit mode, set selection to this shot
    setSelection({
      type: 'shot',
      sectionId: selectedSection.id,
      shotId: shot.id,
    });

    // Block geometry edits on frozen shots
    if (GEOMETRY_COLUMNS.includes(key) && isShotFrozen(selectedSection.id, index)) {
      return;
    }

    // Handle virtual azimuth column with delta-offset behavior
    if (key === '_azimuth_avg') {
      // Guard against invalid input - must be a finite number
      const newValue = typeof value === 'number' ? value : parseFloat(String(value));
      if (!Number.isFinite(newValue)) {
        // Invalid input - ignore the edit
        return;
      }
      const currentMean = circularMeanDegrees(shot.azimuth_in, shot.azimuth_out);
      const delta = newValue - currentMean;
      const newIn = normalizeAngle(shot.azimuth_in + delta);
      const newOut = normalizeAngle(shot.azimuth_out + delta);
      await updateShot(selectedSection.id, shot.id, {
        azimuth_in: newIn,
        azimuth_out: newOut,
      });
      return;
    }

    await updateShot(selectedSection.id, shot.id, { [key]: value } as ShotUpdates);
  };

  // Row click selects the shot
  const handleRowClick = useCallback(
    (shot: Shot, _index: number) => {
      if (selectedSection) {
        setSelection({
          type: 'shot',
          sectionId: selectedSection.id,
          shotId: shot.id,
        });
      }
    },
    [selectedSection, setSelection]
  );

  // Row double-click pans map to shot midpoint
  const handleRowDoubleClick = useCallback(
    (shot: Shot, _index: number) => {
      if (selectedSection) {
        triggerPanToShot(selectedSection.id, shot.id);
      }
    },
    [selectedSection, triggerPanToShot]
  );

  // Row hover highlights shot on map
  const handleRowHover = useCallback(
    (shot: Shot | null, _index: number | null) => {
      if (shot && selectedSection) {
        setHoveredShot({ sectionId: selectedSection.id, shotId: shot.id });
      } else {
        setHoveredShot(null);
      }
    },
    [selectedSection, setHoveredShot]
  );

  // Row right-click opens context menu
  const handleRowContextMenu = useCallback(
    (shot: Shot, index: number, event: React.MouseEvent) => {
      event.preventDefault();
      if (!selectedSection) return;

      const totalShots = selectedSection.shots.length;
      const isFirst = index === 0;
      const isLast = index === totalShots - 1;

      openDialog('context-menu', {
        target: {
          type: 'datatable-shot',
          sectionId: selectedSection.id,
          shotId: shot.id,
          isFirst,
          isLast,
          totalShots,
          sectionName: selectedSection.name ?? t('sections.defaultName', { id: selectedSection.id }),
        },
        position: { x: event.clientX, y: event.clientY },
      });
    },
    [selectedSection, openDialog, t]
  );

  // Section dropdown manual change - select the new section
  // Note: Select component with controlled value doesn't call onChange when value changes
  // programmatically, only on user interaction, so no feedback loop prevention needed
  const handleSectionChange = useCallback(
    (value: string) => {
      const newSectionId = Number(value);
      // Manual dropdown change - select the section and clear any shot selection
      setSelectedSectionId(newSectionId);
      setSelection({ type: 'section', sectionId: newSectionId });
    },
    [setSelection]
  );

  // Track last hovered section ID for ref-based cleanup (matches SectionsPanel pattern)
  const lastHoveredSectionIdRef = useRef<number | null>(null);

  const handleSectionHover = useCallback(
    (value: string | null) => {
      if (value !== null) {
        const sectionId = Number(value);
        if (!Number.isFinite(sectionId)) {
          lastHoveredSectionIdRef.current = null;
          setHoveredSectionId(null);
          return;
        }
        lastHoveredSectionIdRef.current = sectionId;
        setHoveredSectionId(sectionId);
      } else {
        lastHoveredSectionIdRef.current = null;
        setHoveredSectionId(null);
      }
    },
    [setHoveredSectionId]
  );

  // Clear hoveredSectionId on unmount if it was set by this component
  useEffect(() => {
    return () => {
      if (lastHoveredSectionIdRef.current !== null) {
        const currentHoveredId = useUIStore.getState().hoveredSectionId;
        if (currentHoveredId === lastHoveredSectionIdRef.current) {
          useUIStore.getState().setHoveredSectionId(null);
        }
      }
    };
  }, []);

  // Derive the highlighted shot ID for the table
  // - For shot selection: use the shot ID directly
  // - For station selection: compute the corresponding shot ID
  // - For section selection or no selection: no highlight
  const highlightedShotId = useMemo((): number | null => {
    if (!selection || selection.sectionId !== selectedSectionId) {
      // For station selection, check stationRef.section_id instead
      if (selection?.type === 'station' && selection.stationRef?.section_id === selectedSectionId) {
        const { station_index } = selection.stationRef;
        const section = sections.find((s) => s.id === selectedSectionId);
        if (section) {
          const shotIndex = station_index >= 1 ? station_index - 1 : 0;
          if (shotIndex >= 0 && shotIndex < section.shots.length) {
            return section.shots[shotIndex]?.id ?? null;
          }
        }
      }
      return null;
    }

    if (selection.type === 'shot' && selection.shotId !== undefined) {
      return selection.shotId;
    }

    // Section selection - no row highlight
    return null;
  }, [selection, selectedSectionId, sections]);

  const columns = [
    {
      key: '_warnings',
      header: t('dataTable.columns.warningsShort'),
      width: '30px',
      align: 'center' as const,
      render: (shot: Shot) => {
        if (selectedSectionId === null) return null;
        const shotWarnings = getShotWarnings(selectedSectionId, shot.id);
        if (shotWarnings.length === 0) return null;
        const hasError = shotWarnings.some((w) => w.severity === 'error');
        const tooltipText = shotWarnings.map((w) => w.message).join('\n');
        return (
          <span
            data-testid={`warning-${selectedSectionId}-${shot.id}`}
            className={hasError ? 'text-error' : 'text-warning'}
            title={tooltipText}
          >
            {hasError ? <AlertCircleIcon size={14} /> : <AlertTriangleIcon size={14} />}
          </span>
        );
      },
    },
    {
      key: 'id',
      header: t('dataTable.columns.idShort'),
      width: '60px',
      render: (_shot: Shot, index: number) =>
        selectedSectionId !== null ? formatShotId(selectedSectionId, index + 1) : '',
    },
    {
      key: 'length',
      header: t('dataTable.columns.length', { unit: t('common.units.meters') }),
      width: '100px',
      align: 'right' as const,
    },
    {
      key: '_azimuth_avg',
      header: t('dataTable.columns.azimuthShort'),
      width: '70px',
      align: 'right' as const,
      getValue: (shot: Shot) =>
        circularMeanDegrees(shot.azimuth_in, shot.azimuth_out),
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? formatFixed(value, undefined, 1)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    { key: 'depth_in', header: t('dataTable.columns.depthIn'), width: '80px', align: 'right' as const },
    { key: 'depth_out', header: t('dataTable.columns.depthOut'), width: '95px', align: 'right' as const },
    { key: 'left', header: t('dataTable.columns.leftShort'), width: '50px', align: 'right' as const },
    { key: 'right', header: t('dataTable.columns.rightShort'), width: '50px', align: 'right' as const },
    { key: 'up', header: t('dataTable.columns.upShort'), width: '50px', align: 'right' as const },
    { key: 'down', header: t('dataTable.columns.downShort'), width: '50px', align: 'right' as const },
    {
      key: 'is_virtual',
      header: t('dataTable.columns.virtualShort'),
      width: '40px',
      align: 'center' as const,
      render: (shot: Shot) => (shot.is_virtual ? <DotIcon size={10} /> : ''),
    },
    { key: 'comment', header: t('dataTable.columns.comment') },
  ];

  const editableColumns = [
    'length',
    '_azimuth_avg',
    'depth_in',
    'depth_out',
    'left',
    'right',
    'up',
    'down',
    'comment',
  ];

  return (
    <div
      className="flex flex-col bg-panel border-t border-border transition-all duration-300 ease-in-out"
      style={{
        height: dataTableOpen ? `${dataTableHeight}px` : '40px',
        minHeight: '40px',
      }}
      data-testid="data-table"
      data-open={dataTableOpen ? 'true' : 'false'}
    >
      {/* Header with section selector and collapse toggle */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border shrink-0">
        <button
          onClick={toggleDataTable}
          className="text-text-secondary hover:text-text transition-transform duration-200"
          style={{ transform: dataTableOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
          title={dataTableOpen ? t('dataTable.toggle.collapse') : t('dataTable.toggle.expand')}
          data-testid="data-table-toggle"
        >
          <ChevronDownIcon size={14} />
        </button>
        <span className="text-sm font-medium">{t('dataTable.title')}</span>
        {dataTableOpen && (
          <>
            <span className="text-text-secondary">|</span>
            <label className="text-sm text-text-secondary">{t('common.labels.section')}:</label>
            <Select
              value={String(selectedSectionId ?? '')}
              onChange={handleSectionChange}
              options={sectionOptions}
              onOptionHover={handleSectionHover}
              className="min-w-[220px] w-64"
              data-testid="data-table-section-select"
            />
          </>
        )}
        {!dataTableOpen && selectedSection && (
          <span className="text-sm text-text-secondary ml-auto">
            {selectedSection.name ?? t('sections.defaultName', { id: selectedSection.id })}{' '}
            ({t('dataTable.shotCount', {
              count: selectedSection.shots.length,
              countFormatted: formatNumber(selectedSection.shots.length),
            })})
          </span>
        )}
      </div>

      {/* Table - only render when open for performance */}
      {dataTableOpen && (
        <div className="flex-1 overflow-auto">
          {selectedSection ? (
            <EditableTable<Shot>
              columns={columns}
              data={selectedSection.shots}
              keyField="id"
              onCellEdit={handleCellEdit}
              editableColumns={editableColumns}
              selectedKey={highlightedShotId}
              hoveredKey={
                hoveredShot?.sectionId === selectedSectionId
                  ? hoveredShot.shotId
                  : null
              }
              scrollToKey={scrollToKey}
              onRowClick={handleRowClick}
              onRowDoubleClick={handleRowDoubleClick}
              onRowContextMenu={handleRowContextMenu}
              onRowHover={handleRowHover}
              emptyMessage={t('dataTable.empty')}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-text-secondary">
              {t('dataTable.selectSection')}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
