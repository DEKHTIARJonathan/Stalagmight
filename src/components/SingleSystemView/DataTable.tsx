import { useState, useEffect, useMemo } from 'react';
import { type Section, type Shot } from '../../types/project';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { EditableTable } from '../common/Table';
import type { ProjectWarning } from '../../types/commands';

interface DataTableProps {
  sections: Section[];
}

export default function DataTable({ sections }: DataTableProps) {
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    sections[0]?.id ?? null
  );

  const { updateShot, warnings } = useProjectStore();
  const { selection, setSelection, dataTableOpen, toggleDataTable, dataTableHeight } = useUIStore();

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
    if (selectedSection) {
      await updateShot(selectedSection.id, shot.id, { [key]: value });
    }
  };

  // Reserved for future use when row selection is enabled
  void function handleRowClick(shot: Shot) {
    if (selectedSection) {
      setSelection({
        type: 'shot',
        sectionId: selectedSection.id,
        shotId: shot.id,
      });
    }
  };

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
    { key: 'id', header: '#', width: '50px' },
    { key: 'length', header: 'Length (m)', width: '80px', align: 'right' as const },
    { key: 'azimuth_in', header: 'Azi In', width: '70px', align: 'right' as const },
    { key: 'azimuth_out', header: 'Azi Out', width: '70px', align: 'right' as const },
    { key: 'depth_in', header: 'Depth In', width: '80px', align: 'right' as const },
    { key: 'depth_out', header: 'Depth Out', width: '80px', align: 'right' as const },
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
    'azimuth_in',
    'azimuth_out',
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
    >
      {/* Header with section selector and collapse toggle */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border shrink-0">
        <button
          onClick={toggleDataTable}
          className="text-text-secondary hover:text-text transition-transform duration-200"
          style={{ transform: dataTableOpen ? 'rotate(180deg)' : 'rotate(0deg)' }}
          title={dataTableOpen ? 'Collapse (Ctrl+3)' : 'Expand (Ctrl+3)'}
        >
          ▲
        </button>
        <span className="text-sm font-medium">Data Table</span>
        {dataTableOpen && (
          <>
            <span className="text-text-secondary">|</span>
            <label className="text-sm text-text-secondary">Section:</label>
            <select
              value={selectedSectionId ?? ''}
              onChange={(e) => setSelectedSectionId(Number(e.target.value))}
              className="bg-background border border-border rounded px-2 py-1 text-sm"
            >
              {sections.map((section) => (
                <option key={section.id} value={section.id}>
                  {section.name ?? `Section ${section.id}`}
                </option>
              ))}
            </select>
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
