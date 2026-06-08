import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type Section, type Shot, type Station } from '../../types/project';
import { useProjectStore } from '../../store/projectStore';
import { useActiveStations } from '../../hooks/useActiveStations';
import { useUIStore, type Selection } from '../../store/uiStore';
import { useShallow } from 'zustand/react/shallow';
import { EditableTable } from '../common/Table';
import { SpreadsheetGrid } from '../common/SpreadsheetGrid';
import { Select, type SelectOption } from '../common/Select';
import { EntityBlob } from '../common/EntityBlob';
import { ChevronDownIcon, DotIcon, LinkIcon } from '../common/icons';
import type { ProjectWarning } from '../../types/commands';
import { formatShotId } from '../../utils/formatters';
import { formatFixed, formatNumber, getNumberFormatLocale } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { setSource } from '../../utils/telemetry';
import { buildShotColumns } from './dataTableShotColumns';
import { buildShotUpdates, buildShotUpdateBatch } from './dataTableEdits';
import type { CellEdit } from '../common/SpreadsheetGrid/types';

interface DataTableProps {
  sections: Section[];
}

export default function DataTable({ sections }: DataTableProps) {
  const { t } = useTranslation();
  const precision = useDecimalPrecision();
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    sections[0]?.id ?? null
  );
  const [tableView, setTableView] = useState<'shots' | 'stations'>('shots');
  // Track key for scrolling to a row (set when external selection changes)
  const [scrollToKey, setScrollToKey] = useState<number | null>(null);
  const [stationScrollToKey, setStationScrollToKey] = useState<number | null>(null);
  // Track previous selection to only react to actual selection changes
  const prevSelectionRef = useRef<Selection | null>(null);
  // Flag to skip scroll when selection originated from within the table
  const internalSelectionRef = useRef(false);

  const { updateShot, warnings, isShotFrozen, stations, updateStationComment, executeBatch } = useProjectStore();
  // Coordinate columns follow the active geometry (adjusted in the read-only
  // closure-adjusted view); `stations` stays measured for counts/editing.
  const activeStations = useActiveStations();
  // Closure-adjusted view is read-only: cell editing and the reference toggle are disabled.
  const geometryReadOnly = useUIStore((s) => s.geometryMode === 'closureAdjusted');
  const {
    selection,
    setSelection,
    setHoveredShot,
    triggerPanToShot,
    dataTableOpen,
    toggleDataTable,
    dataTableHeight,
    announceSelection,
    setHoveredSectionId,
    triggerCenterOnStation,
    setHoveredStation,
    hoveredStation,
  } = useUIStore(useShallow((s) => ({
    selection: s.selection,
    setSelection: s.setSelection,
    setHoveredShot: s.setHoveredShot,
    hoveredShot: s.hoveredShot,
    triggerPanToShot: s.triggerPanToShot,
    dataTableOpen: s.dataTableOpen,
    toggleDataTable: s.toggleDataTable,
    dataTableHeight: s.dataTableHeight,
    announceSelection: s.announceSelection,
    setHoveredSectionId: s.setHoveredSectionId,
    triggerCenterOnStation: s.triggerCenterOnStation,
    setHoveredStation: s.setHoveredStation,
    hoveredStation: s.hoveredStation,
  })));

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

    // Skip scroll/view-switch for selections made from within the table
    if (internalSelectionRef.current) {
      internalSelectionRef.current = false;
      return;
    }

    if (!selection) {
      // No selection - clear scroll target but keep current dropdown
      if (dataTableOpen) {
        setScrollToKey(null);
      }
      return;
    }

    if (selection.type === 'shot' && selection.sectionId !== undefined && selection.shotId !== undefined) {
      // Shot selected externally - switch to shots view, switch dropdown, and scroll to row
      if (selection.sectionId !== selectedSectionId) {
        setSelectedSectionId(selection.sectionId);
      }
      if (tableView !== 'shots') setTableView('shots');
      // Only scroll if DataTable is open
      if (dataTableOpen) {
        setScrollToKey(selection.shotId);
      }
    } else if (selection.type === 'station' && selection.stationRef) {
      const { section_id, station_index } = selection.stationRef;
      const section = sections.find((s) => s.id === section_id);
      if (section) {
        // Switch section if needed
        if (section_id !== selectedSectionId) {
          setSelectedSectionId(section_id);
        }
        // Switch to stations view and scroll to station
        if (tableView !== 'stations') setTableView('stations');
        if (dataTableOpen) {
          setStationScrollToKey(station_index);
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
  }, [selection, selectedSectionId, sections, dataTableOpen, tableView]);

  // Clear scrollToKey after it's been consumed (to allow re-scrolling to same row)
  useEffect(() => {
    if (scrollToKey === null) return;
    const timer = setTimeout(() => setScrollToKey(null), 100);
    return () => clearTimeout(timer);
  }, [scrollToKey]);

  useEffect(() => {
    if (stationScrollToKey === null) return;
    const timer = setTimeout(() => setStationScrollToKey(null), 100);
    return () => clearTimeout(timer);
  }, [stationScrollToKey]);

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

  // Shot cell-editing, selection, pan, hover and context-menu are now handled by
  // SpreadsheetGrid via the onShot* handlers defined below.

  // Section dropdown manual change - select the new section
  // Note: Select component with controlled value doesn't call onChange when value changes
  // programmatically, only on user interaction, so no feedback loop prevention needed
  const handleSectionChange = useCallback(
    (value: string) => {
      const newSectionId = Number(value);
      // Manual dropdown change - select the section and clear any shot selection
      setSelectedSectionId(newSectionId);
      setSource('data-table');
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

  // --- Station view data ---

  type StationRow = Station & { id: number };

  const sectionStations = useMemo((): StationRow[] => {
    if (tableView !== 'stations' || selectedSectionId === null) return [];
    // X/Y/Z columns follow the active geometry so they match the map; the row
    // refs/comments are unchanged, so comment editing still targets measured data.
    return activeStations
      .filter((s) => s.station_ref.section_id === selectedSectionId)
      .map((s) => ({ ...s, id: s.station_ref.station_index }));
  }, [activeStations, selectedSectionId, tableView]);

  const highlightedStationIndex = useMemo((): number | null => {
    if (tableView !== 'stations') return null;
    if (!selection || selection.type !== 'station') return null;
    if (selection.stationRef?.section_id !== selectedSectionId) return null;
    return selection.stationRef.station_index;
  }, [selection, selectedSectionId, tableView]);

  const stationColumns = useMemo(() => [
    {
      key: 'id',
      header: t('dataTable.stationColumns.index'),
      width: '60px',
      render: (row: StationRow) =>
        <span className="px-2 py-1 inline-block">
          <EntityBlob entity="station" className="relative -top-0.5">{row.station_ref.section_id}.{row.station_ref.station_index}</EntityBlob>
        </span>,
    },
    {
      key: '_x',
      header: t('dataTable.stationColumns.x'),
      width: '90px',
      align: 'right' as const,
      render: (row: StationRow) =>
        <span className="px-2 py-1 inline-block">{formatFixed(row.coordinates.x, undefined, precision.coordinates)}</span>,
    },
    {
      key: '_y',
      header: t('dataTable.stationColumns.y'),
      width: '90px',
      align: 'right' as const,
      render: (row: StationRow) =>
        <span className="px-2 py-1 inline-block">{formatFixed(row.coordinates.y, undefined, precision.coordinates)}</span>,
    },
    {
      key: '_depth',
      header: t('dataTable.stationColumns.depth'),
      width: '90px',
      align: 'right' as const,
      render: (row: StationRow) =>
        <span className="px-2 py-1 inline-block">{formatFixed(row.coordinates.z, undefined, precision.depth)}</span>,
    },
    {
      key: '_zeroDatum',
      header: t('dataTable.stationColumns.zeroDatum'),
      width: '40px',
      align: 'center' as const,
      render: (row: StationRow) =>
        row.is_zero_datum
          ? <span className="px-2 py-1 flex items-center justify-center"><DotIcon size={20} /></span>
          : '',
    },
    {
      key: '_connections',
      header: t('dataTable.stationColumns.connections'),
      width: '60px',
      align: 'center' as const,
      render: (row: StationRow) => {
        const mergeCount = row.merged_with?.length ?? 0;
        const closureCount = row.closures_with?.length ?? 0;
        const total = mergeCount + closureCount;
        if (total === 0) return '';
        const tooltipParts: string[] = [];
        if (mergeCount > 0) {
          tooltipParts.push(`Merges: ${row.merged_with.map((m) => `${m.section_id}.${m.station_index}`).join(', ')}`);
        }
        if (closureCount > 0) {
          tooltipParts.push(`Closures: ${closureCount}`);
        }
        return (
          <span className="px-2 py-1 inline-flex items-center justify-center gap-1" title={tooltipParts.join('\n')}>
            <LinkIcon size={12} />{total}
          </span>
        );
      },
    },
    {
      key: 'comment',
      header: t('dataTable.stationColumns.comment'),
      inputMode: 'textarea' as const,
    },
  ], [t, precision.coordinates, precision.depth]);

  // Station interaction handlers
  const handleStationRowClick = useCallback(
    (row: StationRow, _index: number) => {
      internalSelectionRef.current = true;
      setSource('data-table');
      setSelection({ type: 'station', stationRef: row.station_ref });
    },
    [setSelection]
  );

  const handleStationRowDoubleClick = useCallback(
    (row: StationRow, _index: number) => {
      setSource('data-table');
      triggerCenterOnStation(row.station_ref);
    },
    [triggerCenterOnStation]
  );

  const handleStationRowHover = useCallback(
    (row: StationRow | null, _index: number | null) => {
      if (row) {
        setHoveredStation(row.station_ref);
      } else {
        setHoveredStation(null);
      }
    },
    [setHoveredStation]
  );

  const handleStationCellEdit = useCallback(
    async (row: StationRow, key: string, value: unknown) => {
      if (geometryReadOnly || key !== 'comment') return;
      const comment = typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
      await updateStationComment(row.station_ref, comment);
    },
    [updateStationComment, geometryReadOnly]
  );

  // View toggle options
  const viewOptions: SelectOption[] = useMemo(() => [
    { value: 'shots', label: t('dataTable.viewShots') },
    { value: 'stations', label: t('dataTable.viewStations') },
  ], [t]);

  const handleViewChange = useCallback((value: string) => {
    setTableView(value as 'shots' | 'stations');
  }, []);


  // --- Shots view (SpreadsheetGrid) ----------------------------------------
  // The effective number locale (never the 'locale'/'system' sentinel) so the
  // grid parses numbers with the same separators it displays them in.
  const numberLocale = getNumberFormatLocale();

  const selectShotRow = useCallback(
    (shot: Shot) => {
      if (!selectedSection) return;
      internalSelectionRef.current = true;
      setSource('data-table');
      setSelection({ type: 'shot', sectionId: selectedSection.id, shotId: shot.id });
    },
    [selectedSection, setSelection]
  );

  // Single edit → one update_shot (one undo). Values are already coerced by the
  // column; the virtual azimuth-average expands to in/out via buildShotUpdates.
  const onShotEdit = useCallback(
    (rowIndex: number, colKey: string, value: unknown) => {
      if (!selectedSection || geometryReadOnly) return;
      const shot = selectedSection.shots[rowIndex];
      if (!shot) return;
      selectShotRow(shot);
      const updates = buildShotUpdates(shot, [{ colKey, value }]);
      if (Object.keys(updates).length > 0) void updateShot(selectedSection.id, shot.id, updates);
    },
    [selectedSection, geometryReadOnly, selectShotRow, updateShot]
  );

  // Multi-cell paste/fill → one execute_batch (one undo).
  const onShotBatchEdit = useCallback(
    (edits: CellEdit[]) => {
      if (!selectedSection || geometryReadOnly) return;
      setSource('data-table');
      const commands = buildShotUpdateBatch(edits, selectedSection.shots, selectedSection.id);
      if (commands.length > 0) void executeBatch(commands);
    },
    [selectedSection, geometryReadOnly, executeBatch]
  );

  const onShotActiveCellChange = useCallback(
    (rowIndex: number) => {
      const shot = selectedSection?.shots[rowIndex];
      if (shot) selectShotRow(shot);
    },
    [selectedSection, selectShotRow]
  );

  const onShotRowHover = useCallback(
    (rowIndex: number | null) => {
      if (rowIndex === null || !selectedSection) {
        setHoveredShot(null);
        return;
      }
      const shot = selectedSection.shots[rowIndex];
      setHoveredShot(shot ? { sectionId: selectedSection.id, shotId: shot.id } : null);
    },
    [selectedSection, setHoveredShot]
  );

  const handleToggleReference = useCallback(
    (shot: Shot) => {
      if (selectedSection && !geometryReadOnly) {
        void updateShot(selectedSection.id, shot.id, { is_reference: !shot.is_reference });
      }
    },
    [selectedSection, geometryReadOnly, updateShot]
  );

  const handlePanToShot = useCallback(
    (shot: Shot) => {
      if (selectedSection) {
        setSource('data-table');
        triggerPanToShot(selectedSection.id, shot.id);
      }
    },
    [selectedSection, triggerPanToShot]
  );

  const shotColumns = useMemo(
    () =>
      buildShotColumns({
        t,
        precision,
        sectionId: selectedSectionId,
        geometryReadOnly,
        isShotFrozen,
        getShotWarnings,
        onToggleReference: handleToggleReference,
        onPanToShot: handlePanToShot,
      }),
    // getShotWarnings reads shotWarningsMap (derived from `warnings`); rebuild when
    // warnings change so frozen/warning icons stay current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, precision, selectedSectionId, geometryReadOnly, isShotFrozen, warnings, handleToggleReference, handlePanToShot]
  );

  const shotScrollToRow = useMemo(() => {
    if (scrollToKey === null || !selectedSection) return null;
    const idx = selectedSection.shots.findIndex((s) => s.id === scrollToKey);
    return idx >= 0 ? idx : null;
  }, [scrollToKey, selectedSection]);

  // Grid height inside the panel body (panel header ≈ 49, grid toolbar ≈ 30,
  // status bar ≈ 24 sit outside the scroll area).
  const gridHeight = Math.max(120, dataTableHeight - 110);

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
            <Select
              value={tableView}
              onChange={handleViewChange}
              options={viewOptions}
              className="min-w-[100px]"
              data-testid="data-table-view-select"
            />
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
            ({tableView === 'stations'
              ? t('dataTable.stationCount', {
                  countFormatted: formatNumber(
                    stations.filter((s) => s.station_ref.section_id === selectedSectionId).length
                  ),
                })
              : t('dataTable.shotCount', {
                  count: selectedSection.shots.length,
                  countFormatted: formatNumber(selectedSection.shots.length),
                })
            })
          </span>
        )}
      </div>

      {/* Table - only render when open for performance */}
      {dataTableOpen && (
        <div className="flex-1 overflow-auto">
          {selectedSection ? (
            tableView === 'shots' ? (
              <SpreadsheetGrid<Shot>
                columns={shotColumns}
                rows={selectedSection.shots}
                rowKey={(s) => s.id}
                locale={numberLocale}
                height={gridHeight}
                onEdit={onShotEdit}
                onBatchEdit={onShotBatchEdit}
                onActiveCellChange={onShotActiveCellChange}
                onRowHover={onShotRowHover}
                scrollToRow={shotScrollToRow}
              />
            ) : (
              <EditableTable<StationRow>
                columns={stationColumns}
                data={sectionStations}
                keyField="id"
                onCellEdit={handleStationCellEdit}
                editableColumns={geometryReadOnly ? [] : ['comment']}
                selectedKey={highlightedStationIndex}
                hoveredKey={
                  hoveredStation?.section_id === selectedSectionId
                    ? hoveredStation.station_index
                    : null
                }
                scrollToKey={stationScrollToKey}
                onRowClick={handleStationRowClick}
                onRowDoubleClick={handleStationRowDoubleClick}
                onRowHover={handleStationRowHover}
                emptyMessage={t('dataTable.stationsEmpty')}
                rowClassName={(_row: StationRow, isSelected, isHovered) => {
                  const classes: string[] = [];
                  if (isSelected) {
                    classes.push('bg-accent-20');
                  } else if (isHovered) {
                    classes.push('bg-accent-10');
                  }
                  classes.push('cursor-pointer');
                  return classes.join(' ');
                }}
              />
            )
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
