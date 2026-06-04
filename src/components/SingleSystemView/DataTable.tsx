import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type Section, type Shot, type ShotUpdates, type Station } from '../../types/project';
import { useProjectStore } from '../../store/projectStore';
import { useActiveStations } from '../../hooks/useActiveStations';
import { useUIStore, type Selection } from '../../store/uiStore';
import { useShallow } from 'zustand/react/shallow';
import { EditableTable } from '../common/Table';
import { Select, type SelectOption } from '../common/Select';
import { AlertCircleIcon, AlertTriangleIcon, ChevronDownIcon, DotIcon, LinkIcon, LockIcon } from '../common/icons';
import type { ProjectWarning } from '../../types/commands';
import { circularMeanDegrees, normalizeAngle } from '../../utils/angles';
import { formatShotId } from '../../utils/formatters';
import { formatFixed, formatNumber } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { setSource } from '../../utils/telemetry';

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

  const { updateShot, warnings, isShotFrozen, stations, updateStationComment } = useProjectStore();
  // Coordinate columns follow the active geometry (adjusted in the read-only
  // closure-adjusted view); `stations` stays measured for counts/editing.
  const activeStations = useActiveStations();
  // Closure-adjusted view is read-only: cell editing and the reference toggle are disabled.
  const geometryReadOnly = useUIStore((s) => s.geometryMode === 'closureAdjusted');
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
    openDialog: s.openDialog,
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

  const GEOMETRY_COLUMNS = ['length', '_azimuth_avg', 'depth_in', 'depth_out'];

  const handleCellEdit = async (
    shot: Shot,
    key: string,
    value: unknown,
    index: number
  ) => {
    if (!selectedSection || geometryReadOnly) return;

    // When entering cell edit mode, set selection to this shot
    internalSelectionRef.current = true;
    setSource('data-table');
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
        internalSelectionRef.current = true;
        setSource('data-table');
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
        setSource('data-table');
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

      setSource('data-table');

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
        <span className="px-2 py-1 inline-block">{row.station_ref.section_id}.{row.station_ref.station_index}</span>,
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

  const columns = [
    {
      key: '_warnings',
      header: t('dataTable.columns.warningsShort'),
      width: '30px',
      align: 'center' as const,
      render: (shot: Shot, index: number) => {
        if (selectedSectionId === null) return null;
        const frozen = isShotFrozen(selectedSectionId, index);
        const shotWarnings = getShotWarnings(selectedSectionId, shot.id).filter((w) => !w.isResolved);
        if (shotWarnings.length === 0 && !frozen) return null;
        const hasError = shotWarnings.some((w) => w.severity === 'error');
        const tooltipText = [
          ...(frozen ? [t('dataTable.frozen')] : []),
          ...shotWarnings.map((w) => w.message),
        ].join('\n');
        return (
          <span
            data-testid={frozen ? `frozen-${selectedSectionId}-${shot.id}` : `warning-${selectedSectionId}-${shot.id}`}
            className={hasError ? 'text-error' : frozen && shotWarnings.length === 0 ? 'text-text-secondary' : 'text-warning'}
            title={tooltipText}
          >
            {frozen && shotWarnings.length === 0
              ? <LockIcon size={13} />
              : hasError ? <AlertCircleIcon size={14} /> : <AlertTriangleIcon size={14} />}
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
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? formatFixed(value, undefined, precision.length)
          : '',
      inputType: 'number' as const,
      inputStep: '0.01',
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
          ? formatFixed(value, undefined, precision.azimuth)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    {
      key: 'depth_in',
      header: t('dataTable.columns.depthIn'),
      width: '80px',
      align: 'right' as const,
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? formatFixed(value, undefined, precision.depth)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    {
      key: 'depth_out',
      header: t('dataTable.columns.depthOut'),
      width: '95px',
      align: 'right' as const,
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? formatFixed(value, undefined, precision.depth)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    {
      key: 'left',
      header: t('dataTable.columns.leftShort'),
      width: '50px',
      align: 'right' as const,
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? formatFixed(value, undefined, precision.length)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    {
      key: 'right',
      header: t('dataTable.columns.rightShort'),
      width: '50px',
      align: 'right' as const,
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? formatFixed(value, undefined, precision.length)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    {
      key: 'up',
      header: t('dataTable.columns.upShort'),
      width: '50px',
      align: 'right' as const,
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? formatFixed(value, undefined, precision.length)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    {
      key: 'down',
      header: t('dataTable.columns.downShort'),
      width: '50px',
      align: 'right' as const,
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? formatFixed(value, undefined, precision.length)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    {
      key: 'is_reference',
      header: t('dataTable.columns.referenceShort'),
      width: '40px',
      align: 'center' as const,
      render: (shot: Shot) => (
        <span
          className={`px-2 py-1 flex items-center justify-center ${geometryReadOnly ? 'cursor-default opacity-60' : 'cursor-pointer'}`}
          onClick={(e) => {
            e.stopPropagation();
            if (geometryReadOnly) return;
            if (selectedSectionId !== null) {
              updateShot(selectedSectionId, shot.id, { is_reference: !shot.is_reference });
            }
          }}
          title={shot.is_reference ? t('detailPanel.shot.markPermanent') : t('detailPanel.shot.markReference')}
        >
          {shot.is_reference ? <DotIcon size={20} /> : <span className="opacity-0 hover:opacity-30"><DotIcon size={20} /></span>}
        </span>
      ),
    },
    { key: 'comment', header: t('dataTable.columns.comment'), inputMode: 'textarea' as const },
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

  const isRowEditable = useCallback(
    (shot: Shot, _index: number) => {
      if (selectedSectionId === null) return true;
      const index = selectedSection?.shots.indexOf(shot) ?? -1;
      return index < 0 || !isShotFrozen(selectedSectionId, index);
    },
    [selectedSectionId, selectedSection, isShotFrozen]
  );

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
              <EditableTable<Shot>
                columns={columns}
                data={selectedSection.shots}
                keyField="id"
                onCellEdit={handleCellEdit}
                editableColumns={geometryReadOnly ? [] : editableColumns}
                isRowEditable={isRowEditable}
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
                rowClassName={(shot: Shot, isSelected, isHovered) => {
                  const index = selectedSection?.shots.indexOf(shot) ?? -1;
                  const frozen = selectedSectionId !== null && index >= 0 && isShotFrozen(selectedSectionId, index);
                  const classes: string[] = [];
                  if (isSelected) {
                    classes.push('bg-accent-20');
                  } else if (isHovered) {
                    classes.push('bg-accent-10');
                  } else if (frozen) {
                    classes.push('bg-warning-5');
                  }
                  classes.push('cursor-pointer');
                  return classes.join(' ');
                }}
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
