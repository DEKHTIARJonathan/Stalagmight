import { useState } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { Panel } from '../common/Panel';
import { DialogWrapper } from './DialogWrapper';
import type { ShotData, SectionData } from '../../types/project';
import { getNextSectionColor } from '../../utils/colors';

export default function ImportDialog() {
  const { closeDialog } = useUIStore();
  const { createSection, project } = useProjectStore();

  // Form state
  const [name, setName] = useState<string>('');
  const [surveyor, setSurveyor] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [shots, setShots] = useState<ShotData[]>([createEmptyShot()]);

  // Get next available color
  const usedColors = project?.sections.map((s) => s.color) ?? [];
  const [color, setColor] = useState<string>(getNextSectionColor(usedColors));

  const handleAddShot = () => {
    setShots([...shots, createEmptyShot()]);
  };

  const handleRemoveShot = (index: number) => {
    setShots(shots.filter((_, i) => i !== index));
  };

  const handleShotChange = (index: number, field: keyof ShotData, value: unknown) => {
    const newShots = [...shots];
    const shot = newShots[index];
    if (shot) {
      (shot as unknown as Record<string, unknown>)[field] = value;
      setShots(newShots);
    }
  };

  const handleSubmit = async () => {
    const sectionData: SectionData = {
      name: name || null,
      surveyor: surveyor || null,
      date: date || null,
      color,
      shots: shots.filter((s) => s.length > 0),
    };

    await createSection(sectionData);
    closeDialog();
  };

  // Track if form has been modified
  const isDirty = name !== '' || surveyor !== '' || date !== '' || shots.some(s => s.length > 0);

  return (
    <DialogWrapper title="Import / Create Section" onClose={closeDialog} size="2xl" isDirty={isDirty} data-testid="import-section-dialog">
      <div className="space-y-4">
        {/* Metadata */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              Section Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full"
              placeholder="e.g., Main Line"
              data-testid="section-name-input"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              Surveyor
            </label>
            <input
              type="text"
              value={surveyor}
              onChange={(e) => setSurveyor(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              Date
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full"
            />
          </div>
          <div>
            <label className="block text-sm text-text-secondary mb-1">
              Color
            </label>
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-full h-9"
            />
          </div>
        </div>

        {/* Shots table */}
        <Panel title="Shots" headerActions={
          <button onClick={handleAddShot} className="text-accent text-sm">
            + Add Row
          </button>
        }>
          <div className="overflow-auto max-h-64">
            <table className="w-full text-sm">
              <thead>
                <tr>
                  <th className="w-8">#</th>
                  <th className="!text-right">Length</th>
                  <th className="!text-right">Azi In</th>
                  <th className="!text-right">Azi Out</th>
                  <th className="!text-right">Depth In</th>
                  <th className="!text-right">Depth Out</th>
                  <th className="!text-center">Virtual</th>
                  <th className="w-8"></th>
                </tr>
              </thead>
              <tbody>
                {shots.map((shot, index) => (
                  <tr key={index}>
                    <td className="text-center">{index + 1}</td>
                    <td>
                      <input
                        type="number"
                        value={shot.length}
                        onChange={(e) => handleShotChange(index, 'length', parseFloat(e.target.value) || 0)}
                        className="w-full text-right tabular-nums"
                        step="0.1"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={shot.azimuth_in}
                        onChange={(e) => handleShotChange(index, 'azimuth_in', parseFloat(e.target.value) || 0)}
                        className="w-full text-right tabular-nums"
                        step="0.1"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={shot.azimuth_out}
                        onChange={(e) => handleShotChange(index, 'azimuth_out', parseFloat(e.target.value) || 0)}
                        className="w-full text-right tabular-nums"
                        step="0.1"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={shot.depth_in}
                        onChange={(e) => handleShotChange(index, 'depth_in', parseFloat(e.target.value) || 0)}
                        className="w-full text-right tabular-nums"
                        step="0.1"
                      />
                    </td>
                    <td>
                      <input
                        type="number"
                        value={shot.depth_out}
                        onChange={(e) => handleShotChange(index, 'depth_out', parseFloat(e.target.value) || 0)}
                        className="w-full text-right tabular-nums"
                        step="0.1"
                      />
                    </td>
                    <td className="text-center">
                      <input
                        type="checkbox"
                        checked={shot.is_virtual ?? false}
                        onChange={(e) => handleShotChange(index, 'is_virtual', e.target.checked)}
                      />
                    </td>
                    <td>
                      <button
                        onClick={() => handleRemoveShot(index)}
                        className="text-error hover:text-error/80"
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="primary" onClick={handleSubmit}>
            Import
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}

function createEmptyShot(): ShotData {
  return {
    azimuth_in: 0,
    azimuth_out: 180,
    length: 0,
    depth_in: 0,
    depth_out: 0,
    is_virtual: false,
  };
}
