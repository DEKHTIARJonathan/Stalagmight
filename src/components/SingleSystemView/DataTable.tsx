import { useState } from 'react';
import { type Section, type Shot } from '../../types/project';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import { EditableTable } from '../common/Table';

interface DataTableProps {
  sections: Section[];
}

export default function DataTable({ sections }: DataTableProps) {
  const [selectedSectionId, setSelectedSectionId] = useState<number | null>(
    sections[0]?.id ?? null
  );

  const { updateShot } = useProjectStore();
  const { selection, setSelection } = useUIStore();

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
    <div className="h-full flex flex-col bg-panel">
      {/* Header with section selector */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-border">
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
      </div>

      {/* Table */}
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
    </div>
  );
}
