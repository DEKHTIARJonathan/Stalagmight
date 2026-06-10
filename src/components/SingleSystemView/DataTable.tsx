import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { type Section, type Shot, type ShotData, type Station } from '../../types/project';
import { useProjectStore } from '../../store/projectStore';
import { useActiveStations } from '../../hooks/useActiveStations';
import { useUIStore, type Selection } from '../../store/uiStore';
import { useShallow } from 'zustand/react/shallow';
import { EditableTable } from '../common/Table';
import { SpreadsheetGrid } from '../common/SpreadsheetGrid';
import { EntityBlob } from '../common/EntityBlob';
import { DotIcon, EyeIcon, LinkIcon } from '../common/icons';
import type { ProjectWarning } from '../../types/commands';
import { formatShotId } from '../../utils/formatters';
import { formatFixed, getNumberFormatLocale } from '../../i18n/format';
import { useDecimalPrecision } from '../../hooks/useDecimalPrecision';
import { setSource } from '../../utils/telemetry';
import { buildShotColumns } from './dataTableShotColumns';
import { buildShotUpdates, buildShotUpdateBatch, AZIMUTH_AVG_KEY, PITCH_AVG_KEY } from './dataTableEdits';
import type { CellEdit } from '../common/SpreadsheetGrid/types';

interface DataTableProps {
  sections: Section[];
}

/** Column keys per angle family and mode (the Avg column and the In+Out pair
 *  swap into each other's slot when the mode changes). */
/** Sentinel id of the draft "new shot" row appended to the grid. */
const DRAFT_SHOT_ID = -1;

/** Header right-click hide targets: the clicked column's display name and the
 *  key group it hides with (L/R/U/D hide together as LRUD). */
const HEADER_HIDE_GROUPS: Record<string, { nameKey: string; keys: string[] }> = {
  _warnings: { nameKey: 'warnings', keys: ['_warnings'] },
  length: { nameKey: 'length', keys: ['length'] },
  depth_in: { nameKey: 'depthIn', keys: ['depth_in'] },
  depth_out: { nameKey: 'depthOut', keys: ['depth_out'] },
  left: { nameKey: 'lrud', keys: ['left', 'right', 'up', 'down'] },
  right: { nameKey: 'lrud', keys: ['left', 'right', 'up', 'down'] },
  up: { nameKey: 'lrud', keys: ['left', 'right', 'up', 'down'] },
  down: { nameKey: 'lrud', keys: ['left', 'right', 'up', 'down'] },
  is_reference: { nameKey: 'reference', keys: ['is_reference'] },
  comment: { nameKey: 'comment', keys: ['comment'] },
  section_id: { nameKey: 'sectionId', keys: ['section_id'] },
  shot_id: { nameKey: 'shotId', keys: ['shot_id'] },
};

const ANGLE_FAMILY_KEYS = {
  azimuth: { avg: [AZIMUTH_AVG_KEY], inout: ['azimuth_in', 'azimuth_out'] },
  inclination: { avg: [PITCH_AVG_KEY], inout: ['pitch_in', 'pitch_out'] },
} as const;

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

  const { updateShot, warnings, isShotFrozen, updateStationComment, executeBatch, createShot } = useProjectStore();
  // Coordinate columns follow the active geometry (adjusted in the read-only
  // closure-adjusted view); row refs/comments stay measured for editing.
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
    dataTableHeight,
    announceSelection,
    setHoveredSectionId,
    openDialog,
    triggerCenterOnStation,
    setHoveredStation,
    hoveredStation,
    showToast,
  } = useUIStore(useShallow((s) => ({
    selection: s.selection,
    setSelection: s.setSelection,
    setHoveredShot: s.setHoveredShot,
    hoveredShot: s.hoveredShot,
    triggerPanToShot: s.triggerPanToShot,
    dataTableOpen: s.dataTableOpen,
    dataTableHeight: s.dataTableHeight,
    announceSelection: s.announceSelection,
    setHoveredSectionId: s.setHoveredSectionId,
    openDialog: s.openDialog,
    triggerCenterOnStation: s.triggerCenterOnStation,
    setHoveredStation: s.setHoveredStation,
    hoveredStation: s.hoveredStation,
    showToast: s.showToast,
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

  // Clicking the header's section pill selects the section app-wide (map/panels
  // follow), mirroring the section pills elsewhere in the app.
  const handleSectionPillClick = useCallback(() => {
    if (selectedSectionId === null) return;
    setSource('data-table');
    setSelection({ type: 'section', sectionId: selectedSectionId });
  }, [selectedSectionId, setSelection]);

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

  const handleViewChange = useCallback((value: 'shots' | 'stations') => {
    setTableView(value);
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
  // Column visibility (session-local). Azimuth/inclination are tri-state —
  // the average column, the in/out leg pair, or neither; the raw ID columns
  // start hidden; L/R/U/D toggle as one LRUD group.
  const [azimuthMode, setAzimuthMode] = useState<'avg' | 'inout' | 'off'>('avg');
  const [inclinationMode, setInclinationMode] = useState<'avg' | 'inout' | 'off'>('off');
  const [hiddenShotCols, setHiddenShotCols] = useState<ReadonlySet<string>>(
    () => new Set(['section_id', 'shot_id'])
  );
  const [colMenuOpen, setColMenuOpen] = useState(false);
  // Right-click on a column header: hide it / switch the angle family's mode.
  const [headerMenu, setHeaderMenu] = useState<{ x: number; y: number; colKey: string } | null>(null);
  useEffect(() => {
    if (!headerMenu) return undefined;
    const close = () => setHeaderMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setHeaderMenu(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [headerMenu]);
  // Open the dropdown toward the larger free space — the data table sits at
  // the bottom of the window, so this usually means upward.
  const [colMenuUp, setColMenuUp] = useState(false);

  const shotHiddenColumns = useMemo(() => {
    const hidden = [...hiddenShotCols];
    if (azimuthMode !== 'avg') hidden.push(AZIMUTH_AVG_KEY);
    if (azimuthMode !== 'inout') hidden.push('azimuth_in', 'azimuth_out');
    if (inclinationMode !== 'avg') hidden.push(PITCH_AVG_KEY);
    if (inclinationMode !== 'inout') hidden.push('pitch_in', 'pitch_out');
    return hidden;
  }, [hiddenShotCols, azimuthMode, inclinationMode]);

  // Toggle a column (or a whole group, e.g. LRUD): visible iff none of its
  // keys are hidden, so a mixed group resolves to "show all" first.
  const toggleShotCols = useCallback((keys: string[]) => {
    setHiddenShotCols((prev) => {
      const next = new Set(prev);
      const visible = keys.every((k) => !prev.has(k));
      for (const k of keys) {
        if (visible) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);


  useEffect(() => {
    if (!colMenuOpen) return undefined;
    const close = () => setColMenuOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setColMenuOpen(false);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [colMenuOpen]);

  // --- Draft "new shot" row -------------------------------------------------
  // The grid always shows one extra editable row at the end. Its values live
  // here until length, both depths and an azimuth are present, then it commits
  // as a real shot via create_shot (a missing azimuth leg duplicates the other;
  // inclination stays optional).
  const [draftShot, setDraftShot] = useState<Partial<ShotData>>({});
  useEffect(() => setDraftShot({}), [selectedSectionId]);
  const draftRow = useMemo(
    (): Shot => ({
      id: DRAFT_SHOT_ID,
      azimuth_in: (draftShot.azimuth_in ?? NaN) as number,
      azimuth_out: (draftShot.azimuth_out ?? NaN) as number,
      length: (draftShot.length ?? NaN) as number,
      depth_in: (draftShot.depth_in ?? NaN) as number,
      depth_out: (draftShot.depth_out ?? NaN) as number,
      pitch_in: draftShot.pitch_in ?? null,
      pitch_out: draftShot.pitch_out ?? null,
      left: draftShot.left ?? null,
      right: draftShot.right ?? null,
      up: draftShot.up ?? null,
      down: draftShot.down ?? null,
      comment: draftShot.comment ?? null,
      is_reference: draftShot.is_reference ?? false,
      marker_index: null,
      temperature: null,
    }),
    [draftShot]
  );
  const applyDraftEdit = useCallback((colKey: string, value: unknown) => {
    setDraftShot((prev) => {
      const d: Record<string, unknown> = { ...prev };
      if (colKey === AZIMUTH_AVG_KEY) {
        d.azimuth_in = value;
        d.azimuth_out = value;
      } else if (colKey === PITCH_AVG_KEY) {
        d.pitch_in = value;
        d.pitch_out = value;
      } else {
        d[colKey] = value;
      }
      return d as Partial<ShotData>;
    });
  }, []);
  // Once the draft has ANY value, the still-missing required fields surface:
  // visible columns tint their draft cell red; hidden ones tint the columns
  // (eye) button and their dropdown row instead, until shown or filled.
  const draftMissing = useMemo(() => {
    const cells = new Set<string>();
    const hiddenProblems = new Set<string>();
    const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    if (Object.keys(draftShot).length === 0) return { cells, hiddenProblems };
    const need = (colKey: string, menuKey: string) => {
      if (hiddenShotCols.has(colKey)) hiddenProblems.add(menuKey);
      else cells.add(colKey);
    };
    if (!fin(draftShot.length)) need('length', 'length');
    if (!fin(draftShot.depth_in)) need('depth_in', 'depthIn');
    if (!fin(draftShot.depth_out)) need('depth_out', 'depthOut');
    if (!fin(draftShot.azimuth_in) && !fin(draftShot.azimuth_out)) {
      if (azimuthMode === 'avg') cells.add(AZIMUTH_AVG_KEY);
      else if (azimuthMode === 'inout') {
        cells.add('azimuth_in');
        cells.add('azimuth_out');
      } else {
        hiddenProblems.add('azimuth');
      }
    }
    return { cells, hiddenProblems };
  }, [draftShot, hiddenShotCols, azimuthMode]);

  const shotCellClassName = useCallback(
    (shot: Shot, _rowIndex: number, colKey: string) =>
      shot.id === DRAFT_SHOT_ID && draftMissing.cells.has(colKey) ? 'sg-cell-missing' : undefined,
    [draftMissing]
  );

  // Commit the draft once the required fields are present.
  const draftCommitting = useRef(false);
  useEffect(() => {
    if (!selectedSection || draftCommitting.current) return;
    const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
    const azimuth = fin(draftShot.azimuth_in) ? draftShot.azimuth_in : draftShot.azimuth_out;
    const complete =
      fin(draftShot.length) && draftShot.length > 0 &&
      fin(draftShot.depth_in) && fin(draftShot.depth_out) && fin(azimuth);
    if (!complete) return;
    const data: ShotData = {
      azimuth_in: fin(draftShot.azimuth_in) ? draftShot.azimuth_in : (azimuth as number),
      azimuth_out: fin(draftShot.azimuth_out) ? draftShot.azimuth_out : (azimuth as number),
      length: draftShot.length as number,
      depth_in: draftShot.depth_in as number,
      depth_out: draftShot.depth_out as number,
      pitch_in: draftShot.pitch_in ?? null,
      pitch_out: draftShot.pitch_out ?? null,
      left: draftShot.left ?? null,
      right: draftShot.right ?? null,
      up: draftShot.up ?? null,
      down: draftShot.down ?? null,
      comment: draftShot.comment ?? null,
      is_reference: draftShot.is_reference ?? false,
      marker_index: null,
      temperature: null,
    };
    const lastShot = selectedSection.shots[selectedSection.shots.length - 1];
    draftCommitting.current = true;
    setSource('data-table');
    void createShot(selectedSection.id, data, lastShot?.id)
      .then(() => setDraftShot({}))
      .finally(() => {
        draftCommitting.current = false;
      });
  }, [draftShot, selectedSection, createShot]);


  const onShotEdit = useCallback(
    (rowIndex: number, colKey: string, value: unknown) => {
      if (!selectedSection || geometryReadOnly) return;
      if (rowIndex >= selectedSection.shots.length) {
        applyDraftEdit(colKey, value);
        return;
      }
      const shot = selectedSection.shots[rowIndex];
      if (!shot) return;
      selectShotRow(shot);
      const updates = buildShotUpdates(shot, [{ colKey, value }]);
      if (Object.keys(updates).length > 0) void updateShot(selectedSection.id, shot.id, updates);
    },
    [selectedSection, geometryReadOnly, selectShotRow, updateShot, applyDraftEdit]
  );

  // Multi-cell paste/fill → one execute_batch (one undo).
  const onShotBatchEdit = useCallback(
    (edits: CellEdit[]) => {
      if (!selectedSection || geometryReadOnly) return;
      setSource('data-table');
      // Edits landing on the draft row (paste/fill into the last row) feed the
      // draft; the rest commit as one batch.
      const draftEdits = edits.filter((e) => e.row >= selectedSection.shots.length);
      const commands = buildShotUpdateBatch(edits, selectedSection.shots, selectedSection.id);
      if (commands.length > 0) void executeBatch(commands);
      for (const e of draftEdits) applyDraftEdit(e.colKey, e.value);
    },
    [selectedSection, geometryReadOnly, executeBatch, applyDraftEdit]
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

  // Map → grid hover tint (the reverse of onShotRowHover; purely visual, so the
  // pair can't feed back into each other).
  const shotHoveredRow = useMemo(() => {
    if (!selectedSection || hoveredShot?.sectionId !== selectedSectionId) return null;
    const idx = selectedSection.shots.findIndex((s) => s.id === hoveredShot.shotId);
    return idx >= 0 ? idx : null;
  }, [hoveredShot, selectedSection, selectedSectionId]);

  const shotRowClassName = useCallback(
    (shot: Shot, rowIndex: number) => {
      if (shot.id === DRAFT_SHOT_ID) return 'sg-row-draft';
      return selectedSectionId !== null && isShotFrozen(selectedSectionId, rowIndex)
        ? 'sg-row-frozen'
        : undefined;
    },
    [selectedSectionId, isShotFrozen]
  );

  // Surface partially-applied pastes (only the non-zero parts).
  const onShotPasteReport = useCallback(
    ({ written, clipped, skipped }: { written: number; clipped: number; skipped: number }) => {
      const parts: string[] = [];
      if (written > 0) parts.push(t('dataTable.pasteReport.written', { count: written }));
      if (clipped > 0) parts.push(t('dataTable.pasteReport.clipped', { count: clipped }));
      if (skipped > 0) parts.push(t('dataTable.pasteReport.skipped', { count: skipped }));
      if (parts.length > 0) showToast(parts.join(' · '), 'data-table-paste');
    },
    [t, showToast]
  );

  // Delete on a gutter-selected row (or the context menu's "Delete rows"):
  // route a single row to the existing shot-delete confirm dialog (it owns the
  // split/last-shot handling); multi-shot delete has no safe backend flow yet.
  const onShotDeleteRows = useCallback(
    (fromRow: number, toRow: number) => {
      if (!selectedSection || geometryReadOnly) return;
      setSource('data-table');
      if (fromRow !== toRow) {
        showToast(t('dataTable.multiDeleteUnsupported'), 'data-table-delete');
        return;
      }
      const shot = selectedSection.shots[fromRow];
      if (!shot) return;
      openDialog('confirm-delete', {
        type: 'shot',
        sectionId: selectedSection.id,
        shotId: shot.id,
      });
    },
    [selectedSection, geometryReadOnly, showToast, t, openDialog]
  );

  const handleToggleReference = useCallback(
    (shot: Shot) => {
      if (!selectedSection || geometryReadOnly) return;
      if (shot.id === DRAFT_SHOT_ID) {
        applyDraftEdit('is_reference', !shot.is_reference);
        return;
      }
      void updateShot(selectedSection.id, shot.id, { is_reference: !shot.is_reference });
    },
    [selectedSection, geometryReadOnly, updateShot, applyDraftEdit]
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
      }),
    // getShotWarnings reads shotWarningsMap (derived from `warnings`); rebuild when
    // warnings change so frozen/warning icons stay current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t, precision, selectedSectionId, geometryReadOnly, isShotFrozen, warnings, handleToggleReference]
  );

  // The grid's context menus speak in shots, not rows.
  const shotNoun = useCallback((count: number) => t('dataTable.shotNoun', { count }), [t]);

  // Rows handed to the grid: the section's shots plus the draft row (hidden in
  // the read-only closure-adjusted view).
  const gridShotRows = useMemo(
    () => (selectedSection ? (geometryReadOnly ? selectedSection.shots : [...selectedSection.shots, draftRow]) : []),
    [selectedSection, geometryReadOnly, draftRow]
  );

  const shotScrollToRow = useMemo(() => {
    if (scrollToKey === null || !selectedSection) return null;
    const idx = selectedSection.shots.findIndex((s) => s.id === scrollToKey);
    return idx >= 0 ? idx : null;
  }, [scrollToKey, selectedSection]);

  // The grid's name-box content, lifted into the condensed panel header:
  // "<column> <row>" for a single cell, "3R × 2C" for a range.
  const [gridSel, setGridSel] = useState<{
    rows: number;
    cols: number;
    activeRow: number;
    activeColKey: string;
  } | null>(null);
  const selectionIndicator = useMemo(() => {
    if (!gridSel || !dataTableOpen || tableView !== 'shots' || !selectedSection) return null;
    if (gridSel.rows > 1 || gridSel.cols > 1) return `${gridSel.rows}R × ${gridSel.cols}C`;
    const header = shotColumns.find((c) => c.key === gridSel.activeColKey)?.header ?? gridSel.activeColKey;
    return `${header} ${gridSel.activeRow + 1}`;
  }, [gridSel, dataTableOpen, tableView, selectedSection, shotColumns]);

  // Gutter shows the shot's ID pill (replaces the old ID column); double-click
  // pans the map to the shot, as it did on the column's pill.
  const shotRowLabel = useCallback(
    (shot: Shot, rowIndex: number) => {
      // The draft row earns its pill only once it becomes a real shot.
      if (shot.id === DRAFT_SHOT_ID) return <span className="opacity-50">+</span>;
      return selectedSectionId !== null ? (
        <span onDoubleClick={() => handlePanToShot(shot)}>
          <EntityBlob entity="shot">{formatShotId(selectedSectionId, rowIndex + 1)}</EntityBlob>
        </span>
      ) : (
        rowIndex + 1
      );
    },
    [selectedSectionId, handlePanToShot]
  );

  // Column order is view state (drag a selected column header to move it);
  // session-local for now, not persisted in config. Empty = declaration order.
  const [shotColumnOrder, setShotColumnOrder] = useState<string[]>([]);


  // The grid must fit the panel body EXACTLY: taller and the wrapper clips it
  // (occluded horizontal scrollbar) or grows a second scrollbar. Measure the
  // body instead of hand-summing chrome heights; the observer also tracks the
  // panel's resize drag and its open/close height transition.
  const gridBodyRef = useRef<HTMLDivElement | null>(null);
  const [gridBodyHeight, setGridBodyHeight] = useState<number | null>(null);
  useEffect(() => {
    const el = gridBodyRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => setGridBodyHeight(el.clientHeight));
    ro.observe(el);
    setGridBodyHeight(el.clientHeight);
    return () => ro.disconnect();
  }, [dataTableOpen]);
  const gridHeight = gridBodyHeight ?? Math.max(120, dataTableHeight - 28);

  // Unconditional hide (header right-click) — unlike the menu checkbox toggle.
  const hideShotCols = useCallback((keys: string[]) => {
    setHiddenShotCols((prev) => new Set([...prev, ...keys]));
  }, []);

  // Switch an angle family's mode, putting the newly shown columns in the slot
  // of the ones they replace (Avg ↔ In+Out swap in place). Transitions through
  // Off keep every slot — hidden columns remember their position in the order.
  const changeAngleMode = useCallback(
    (family: 'azimuth' | 'inclination', next: 'avg' | 'inout' | 'off') => {
      const current = family === 'azimuth' ? azimuthMode : inclinationMode;
      if (next === current) return;
      if (current !== 'off' && next !== 'off') {
        const prevKeys: readonly string[] = ANGLE_FAMILY_KEYS[family][current];
        const nextKeys: readonly string[] = ANGLE_FAMILY_KEYS[family][next];
        setShotColumnOrder((prev) => {
          const base = prev.length ? [...prev] : shotColumns.map((c) => c.key);
          for (const c of shotColumns) if (!base.includes(c.key)) base.push(c.key);
          const without = base.filter((k) => !nextKeys.includes(k));
          const anchor = without.indexOf(prevKeys[0]!);
          without.splice(anchor < 0 ? without.length : anchor, 0, ...nextKeys);
          return without;
        });
      }
      (family === 'azimuth' ? setAzimuthMode : setInclinationMode)(next);
    },
    [azimuthMode, inclinationMode, shotColumns]
  );

  // Items of the header right-click menu: angle-family columns get a mode
  // switch and Off; everything else gets a plain hide.
  const headerMenuItems = useMemo(() => {
    if (!headerMenu) return [];
    const key = headerMenu.colKey;
    const family = (['azimuth', 'inclination'] as const).find((f) => {
      const fam = ANGLE_FAMILY_KEYS[f];
      return (fam.avg as readonly string[]).includes(key) || (fam.inout as readonly string[]).includes(key);
    });
    const items: { label: string; onClick: () => void }[] = [];
    if (family) {
      const onAvg = (ANGLE_FAMILY_KEYS[family].avg as readonly string[]).includes(key);
      items.push({
        label: onAvg ? t('dataTable.headerMenu.showInOut') : t('dataTable.headerMenu.showAverage'),
        onClick: () => changeAngleMode(family, onAvg ? 'inout' : 'avg'),
      });
      items.push({
        label: t('dataTable.headerMenu.hide', { name: t(`dataTable.columnsMenu.${family}`) }),
        onClick: () => changeAngleMode(family, 'off'),
      });
    } else {
      const group = HEADER_HIDE_GROUPS[key] ?? { nameKey: null, keys: [key] };
      const name = group.nameKey
        ? t(`dataTable.columnsMenu.${group.nameKey}`)
        : shotColumns.find((c) => c.key === key)?.header ?? key;
      items.push({
        label: t('dataTable.headerMenu.hide', { name }),
        onClick: () => hideShotCols(group.keys),
      });
    }
    return items;
  }, [headerMenu, t, changeAngleMode, hideShotCols, shotColumns]);

  // Rows of the column-visibility menu: a checkbox per column (or group — the
  // LRUD keys toggle together), and a tri-state Avg / In+Out / Off control for
  // the azimuth and inclination column families.
  const colCheckRow = (keys: string[], label: string, className = '', problem = false) => (
    <label
      key={keys[0]}
      className={`flex cursor-pointer items-center gap-2 rounded px-2 py-0.5 hover:bg-accent-10 ${
        problem ? 'text-error' : ''
      } ${className}`}
    >
      <input
        type="checkbox"
        checked={keys.every((k) => !hiddenShotCols.has(k))}
        onChange={() => toggleShotCols(keys)}
        data-testid={`col-vis-${keys[0]}`}
      />
      {label}
    </label>
  );
  const angleModeRow = (
    label: string,
    mode: 'avg' | 'inout' | 'off',
    setMode: (m: 'avg' | 'inout' | 'off') => void,
    testId: string,
    problem = false,
  ) => (
    <div className="flex items-center justify-between gap-2 px-2 py-0.5">
      <span className={problem ? 'text-error' : undefined}>{label}</span>
      <span className="flex overflow-hidden rounded border border-border">
        {(['avg', 'inout', 'off'] as const).map((m) => (
          <button
            key={m}
            className={`px-1.5 py-0.5 ${
              mode === m ? 'bg-accent-20 text-text' : 'text-text-secondary hover:bg-accent-10'
            }`}
            onClick={() => setMode(m)}
            data-testid={`${testId}-${m}`}
          >
            {m === 'avg'
              ? t('dataTable.columnsMenu.avg')
              : m === 'inout'
                ? t('dataTable.columnsMenu.inOut')
                : t('dataTable.columnsMenu.off')}
          </button>
        ))}
      </span>
    </div>
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
      {/* Condensed header: title + selection indicator | section pill | view toggle + collapse */}
      <div className="relative flex items-center gap-3 px-3 py-1 border-b border-border shrink-0 text-xs">
        <span className="font-medium">{t('dataTable.title')}</span>
        {selectionIndicator && (
          <span className="text-text-secondary tabular-nums" data-testid="data-table-selection-indicator">
            {selectionIndicator}
          </span>
        )}
        {selectedSection && (
          <button
            className="absolute left-1/2 -translate-x-1/2 cursor-pointer"
            onClick={handleSectionPillClick}
            onMouseEnter={() => handleSectionHover(String(selectedSection.id))}
            onMouseLeave={() => handleSectionHover(null)}
            title={t('dataTable.selectSectionPill')}
            data-testid="data-table-section-pill"
          >
            <EntityBlob entity="section">
              {selectedSection.name ?? t('sections.defaultName', { id: selectedSection.id })}
            </EntityBlob>
          </button>
        )}
        <div
          className="ml-auto flex items-center rounded border border-border overflow-hidden"
          role="radiogroup"
          aria-label={t('dataTable.title')}
          data-testid="data-table-view-select"
        >
          {(['shots', 'stations'] as const).map((view) => (
            <button
              key={view}
              role="radio"
              aria-checked={tableView === view}
              className={`px-2 py-0.5 ${
                tableView === view ? 'bg-accent-20 text-text' : 'text-text-secondary hover:bg-accent-10'
              }`}
              onClick={() => handleViewChange(view)}
              data-testid={`data-table-view-${view}`}
            >
              {view === 'shots' ? t('dataTable.viewShots') : t('dataTable.viewStations')}
            </button>
          ))}
        </div>
        {/* Column-visibility menu; inside clicks must not reach the window
            mousedown listener that closes it. */}
        <div className="relative" onMouseDown={(e) => e.stopPropagation()}>
          <button
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setColMenuUp(r.top > window.innerHeight - r.bottom);
              setColMenuOpen((v) => !v);
            }}
            className={
              draftMissing.hiddenProblems.size > 0
                ? 'text-error'
                : colMenuOpen
                  ? 'text-text'
                  : 'text-text-secondary hover:text-text'
            }
            title={t('dataTable.columnsMenu.button')}
            data-testid="data-table-columns-menu"
          >
            <EyeIcon size={14} />
          </button>
          {colMenuOpen && (
            <div
              className={`absolute right-0 z-50 w-56 rounded border border-border bg-panel p-1 shadow-lg ${
                colMenuUp ? 'bottom-full mb-1' : 'top-full mt-1'
              }`}
              data-testid="data-table-columns-dropdown"
            >
              {colCheckRow(['_warnings'], t('dataTable.columnsMenu.warnings'))}
              {colCheckRow(['section_id'], t('dataTable.columnsMenu.sectionId'))}
              {colCheckRow(['shot_id'], t('dataTable.columnsMenu.shotId'))}
              {colCheckRow(['length'], t('dataTable.columnsMenu.length'), '', draftMissing.hiddenProblems.has('length'))}
              {angleModeRow(t('dataTable.columnsMenu.azimuth'), azimuthMode, (m) => changeAngleMode('azimuth', m), 'col-azimuth', draftMissing.hiddenProblems.has('azimuth'))}
              {angleModeRow(t('dataTable.columnsMenu.inclination'), inclinationMode, (m) => changeAngleMode('inclination', m), 'col-inclination')}
              <div className="flex">
                {colCheckRow(['depth_in'], t('dataTable.columnsMenu.depthIn'), 'flex-1', draftMissing.hiddenProblems.has('depthIn'))}
                {colCheckRow(['depth_out'], t('dataTable.columnsMenu.depthOut'), 'flex-1', draftMissing.hiddenProblems.has('depthOut'))}
              </div>
              {colCheckRow(['left', 'right', 'up', 'down'], t('dataTable.columnsMenu.lrud'))}
              {colCheckRow(['is_reference'], t('dataTable.columnsMenu.reference'))}
              {colCheckRow(['comment'], t('dataTable.columnsMenu.comment'))}
            </div>
          )}
        </div>
      </div>

      {/* Table - only render when open for performance. The shots grid scrolls
          internally and is sized to this body exactly, so the wrapper must
          never scroll alongside it (double scrollbars). */}
      {dataTableOpen && (
        <div ref={gridBodyRef} className={`flex-1 ${tableView === 'shots' ? 'overflow-hidden' : 'overflow-auto'}`}>
          {selectedSection ? (
            tableView === 'shots' ? (
              <SpreadsheetGrid<Shot>
                key={selectedSectionId ?? 'none'}
                columns={shotColumns}
                rows={gridShotRows}
                rowKey={(s) => s.id}
                locale={numberLocale}
                height={gridHeight}
                onEdit={onShotEdit}
                onBatchEdit={onShotBatchEdit}
                onActiveCellChange={onShotActiveCellChange}
                onRowHover={onShotRowHover}
                onPasteReport={onShotPasteReport}
                selectedRow={shotScrollToRow}
                hoveredRow={shotHoveredRow}
                rowClassName={shotRowClassName}
                cellClassName={shotCellClassName}
                rowLabel={shotRowLabel}
                rowNoun={shotNoun}
                gutterWidth={72}
                showToolbar={false}
                onSelectionChange={setGridSel}
                onHeaderContextMenu={(colKey, pos) => setHeaderMenu({ ...pos, colKey })}
                onDeleteRows={onShotDeleteRows}
                hiddenColumns={shotHiddenColumns}
                columnOrder={shotColumnOrder}
                onColumnOrderChange={setShotColumnOrder}
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
      {headerMenu && (
        <div
          className="fixed z-50 w-44 rounded border border-border bg-panel p-1 text-xs shadow-lg"
          style={{ left: headerMenu.x, top: headerMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          data-testid="data-table-header-menu"
        >
          {headerMenuItems.map((item) => (
            <button
              key={item.label}
              className="block w-full rounded px-2 py-0.5 text-left hover:bg-accent-10"
              onClick={() => {
                item.onClick();
                setHeaderMenu(null);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
