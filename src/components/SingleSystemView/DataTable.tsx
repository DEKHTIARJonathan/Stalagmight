import { useState, useEffect, useMemo, useCallback } from 'react';
import { type Section, type Shot } from '../../types/project';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { EditableTable } from '../common/Table';
import { Select, type SelectOption } from '../common/Select';
import type { ProjectWarning } from '../../types/commands';
import { circularMeanDegrees, normalizeAngle } from '../../utils/angles';
import { formatShotId } from '../../utils/formatters';

interface DataTableProps {
  sections: Section[];
}

export default function DataTable({ sections }: DataTableProps) {
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    sections[0]?.id ?? null
  );

  const { updateShot, warnings } = useProjectStore();
  const {
    selection,
    setSelection,
    setHoveredShot,
    hoveredShot,
    triggerPanToShot,
    dataTableOpen,
    toggleDataTable,
    dataTableHeight,
  } = useUIStore();

  // Create a map of shot warnings for quick lookup
  const shotWarningsMap = useMemo(() => {
    const map = new Map<string, ProjectWarning[]>();
    for (const warning of warnings) {
      const key = `${warning.section_id}:${warning.shot_id}`;
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
      label: section.name ?? `Section ${section.id}`,
    })),
    [sections]
  );

  // Update selected section when sections change (e.g., first load)
  useEffect(() => {
    if (sections.length > 0 && selectedSectionId === null) {
      const firstSection = sections[0];
      if (firstSection) {
        setSelectedSectionId(firstSection.id);
      }
    }
  }, [sections, selectedSectionId]);

  const selectedSection = sections.find((s) => s.id === selectedSectionId);

  const handleCellEdit = async (
    shot: Shot,
    key: string,
    value: unknown,
    _index: number
  ) => {
    if (!selectedSection) return;

    // When entering cell edit mode, set selection to this shot
    setSelection({
      type: 'shot',
      sectionId: selectedSection.id,
      shotId: shot.id,
    });

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

    await updateShot(selectedSection.id, shot.id, { [key]: value });
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

  const columns = [
    {
      key: '_warnings',
      header: '!',
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
            className={hasError ? 'text-red-400' : 'text-yellow-400'}
            title={tooltipText}
          >
            {hasError ? '⛔' : '⚠️'}
          </span>
        );
      },
    },
    {
      key: 'id',
      header: '#',
      width: '60px',
      render: (_shot: Shot, index: number) =>
        selectedSectionId !== null ? formatShotId(selectedSectionId, index + 1) : '',
    },
    { key: 'length', header: 'Length (m)', width: '100px', align: 'right' as const },
    {
      key: '_azimuth_avg',
      header: 'Azi',
      width: '70px',
      align: 'right' as const,
      getValue: (shot: Shot) =>
        circularMeanDegrees(shot.azimuth_in, shot.azimuth_out),
      formatValue: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? value.toFixed(1)
          : '',
      inputType: 'number' as const,
      inputStep: '0.1',
    },
    { key: 'depth_in', header: 'Depth In', width: '80px', align: 'right' as const },
    { key: 'depth_out', header: 'Depth Out', width: '95px', align: 'right' as const },
    { key: 'left', header: 'L', width: '50px', align: 'right' as const },
    { key: 'right', header: 'R', width: '50px', align: 'right' as const },
    { key: 'up', header: 'U', width: '50px', align: 'right' as const },
    { key: 'down', header: 'D', width: '50px', align: 'right' as const },
    {
      key: 'is_virtual',
      header: 'V',
      width: '40px',
      align: 'center' as const,
      render: (shot: Shot) => (shot.is_virtual ? '●' : ''),
    },
    { key: 'comment', header: 'Comment' },
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
          title={dataTableOpen ? 'Collapse (Ctrl+3)' : 'Expand (Ctrl+3)'}
          data-testid="data-table-toggle"
        >
          ▲
        </button>
        <span className="text-sm font-medium">Data Table</span>
        {dataTableOpen && (
          <>
            <span className="text-text-secondary">|</span>
            <label className="text-sm text-text-secondary">Section:</label>
            <Select
              value={String(selectedSectionId ?? '')}
              onChange={(value) => setSelectedSectionId(Number(value))}
              options={sectionOptions}
              data-testid="data-table-section-select"
            />
          </>
        )}
        {!dataTableOpen && selectedSection && (
          <span className="text-sm text-text-secondary ml-auto">
            {selectedSection.name ?? `Section ${selectedSection.id}`} ({selectedSection.shots.length} shots)
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
              selectedKey={
                selection?.type === 'shot' &&
                selection.sectionId === selectedSectionId
                  ? selection.shotId
                  : null
              }
              hoveredKey={
                hoveredShot?.sectionId === selectedSectionId
                  ? hoveredShot.shotId
                  : null
              }
              onRowClick={handleRowClick}
              onRowDoubleClick={handleRowDoubleClick}
              onRowHover={handleRowHover}
              emptyMessage="No shots in this section"
            />
          ) : (
            <div className="flex items-center justify-center h-full text-text-secondary">
              Select a section to view shots
            </div>
          )}
        </div>
      )}
    </div>
  );
}
