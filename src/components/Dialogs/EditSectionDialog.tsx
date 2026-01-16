import { useState, useEffect } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import type { Shot, ShotData } from '../../types/project';

interface EditableShot extends Omit<Shot, 'marker_index' | 'temperature'> {
  isNew?: boolean;
  isDeleted?: boolean;
  tempId?: number;
}

export default function EditSectionDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { updateSection, createShot, updateShot, deleteShot, project } = useProjectStore();

  const sectionId = dialogData.sectionId as number | undefined;
  const section = project?.sections.find((s) => s.id === sectionId);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [surveyor, setSurveyor] = useState('');
  const [date, setDate] = useState('');
  const [color, setColor] = useState('#4ecdc4');

  // Shots state
  const [shots, setShots] = useState<EditableShot[]>([]);
  const [nextTempId, setNextTempId] = useState(-1);

  // Initialize form with section data
  useEffect(() => {
    if (section) {
      setName(section.name ?? '');
      setSurveyor(section.surveyor ?? '');
      setDate(section.date ?? '');
      setColor(section.color);
      setShots(section.shots.map(s => ({ ...s })));
    }
  }, [section]);

  const handleShotChange = (index: number, field: keyof EditableShot, value: number | string | boolean | null) => {
    setShots(prev => {
      const updated = [...prev];
      const shot = updated[index];
      updated[index] = {
        ...shot,
        [field]: value,
      } as EditableShot;
      return updated;
    });
  };

  const handleAddShot = () => {
    const newShot: EditableShot = {
      id: nextTempId,
      tempId: nextTempId,
      azimuth_in: 0,
      azimuth_out: 0,
      length: 1,
      depth_in: 0,
      depth_out: 0,
      pitch_in: null,
      pitch_out: null,
      left: null,
      right: null,
      up: null,
      down: null,
      comment: null,
      is_virtual: false,
      isNew: true,
    };
    setShots(prev => [...prev, newShot]);
    setNextTempId(prev => prev - 1);
  };

  const handleDeleteShot = (index: number) => {
    setShots(prev => {
      const shot = prev[index];
      if (!shot) return prev;
      if (shot.isNew) {
        // New shot - just remove from array
        return prev.filter((_, i) => i !== index);
      } else {
        // Existing shot - mark as deleted
        const updated = [...prev];
        updated[index] = { ...shot, isDeleted: true } as EditableShot;
        return updated;
      }
    });
  };

  const handleSave = async () => {
    if (!sectionId) return;

    setIsLoading(true);
    setError(null);

    try {
      // Update section metadata
      const sectionResult = await updateSection(sectionId, {
        name: name.trim() || null,
        surveyor: surveyor.trim() || null,
        date: date.trim() || null,
        color,
      });

      if (!sectionResult.success) {
        setError(sectionResult.error ?? 'Failed to update section');
        return;
      }

      // Process shot changes
      const originalShots = section?.shots ?? [];

      // Delete removed shots (in reverse order to avoid index issues)
      const deletedShots = shots.filter(s => s.isDeleted && !s.isNew);
      for (const shot of deletedShots.reverse()) {
        const result = await deleteShot(sectionId, shot.id);
        if (!result.success) {
          setError(result.error ?? 'Failed to delete shot');
          return;
        }
      }

      // Update existing shots
      for (const shot of shots.filter(s => !s.isNew && !s.isDeleted)) {
        const original = originalShots.find(o => o.id === shot.id);
        if (original && hasChanges(original, shot)) {
          const result = await updateShot(sectionId, shot.id, {
            azimuth_in: shot.azimuth_in,
            azimuth_out: shot.azimuth_out,
            length: shot.length,
            depth_in: shot.depth_in,
            depth_out: shot.depth_out,
            pitch_in: shot.pitch_in,
            pitch_out: shot.pitch_out,
            left: shot.left,
            right: shot.right,
            up: shot.up,
            down: shot.down,
            comment: shot.comment,
            is_virtual: shot.is_virtual,
          });
          if (!result.success) {
            setError(result.error ?? 'Failed to update shot');
            return;
          }
        }
      }

      // Create new shots
      const newShots = shots.filter(s => s.isNew && !s.isDeleted);
      for (const shot of newShots) {
        const shotData: ShotData = {
          azimuth_in: shot.azimuth_in,
          azimuth_out: shot.azimuth_out,
          length: shot.length,
          depth_in: shot.depth_in,
          depth_out: shot.depth_out,
          pitch_in: shot.pitch_in,
          pitch_out: shot.pitch_out,
          left: shot.left,
          right: shot.right,
          up: shot.up,
          down: shot.down,
          comment: shot.comment,
          is_virtual: shot.is_virtual,
        };
        const result = await createShot(sectionId, shotData);
        if (!result.success) {
          setError(result.error ?? 'Failed to create shot');
          return;
        }
      }

      closeDialog();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update section');
    } finally {
      setIsLoading(false);
    }
  };

  // Track if form has been modified
  const isDirty = section ? (
    name !== (section.name ?? '') ||
    surveyor !== (section.surveyor ?? '') ||
    date !== (section.date ?? '') ||
    color !== section.color ||
    shots.some(s => s.isNew || s.isDeleted) ||
    shots.some(s => {
      const original = section.shots.find(o => o.id === s.id);
      return original && hasChanges(original, s);
    })
  ) : false;

  if (!section) {
    return (
      <DialogWrapper title="Edit Section" onClose={closeDialog} size="5xl" data-testid="edit-section-dialog">
        <div className="text-error">Section not found</div>
      </DialogWrapper>
    );
  }

  const visibleShots = shots.filter(s => !s.isDeleted);

  return (
    <DialogWrapper title="Edit Section" onClose={closeDialog} size="5xl" isDirty={isDirty} data-testid="edit-section-dialog">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm">
            {error}
          </div>
        )}

        {/* Section metadata */}
        <div className="grid grid-cols-4 gap-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full"
              placeholder="Section name"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Surveyor</label>
            <input
              type="text"
              value={surveyor}
              onChange={(e) => setSurveyor(e.target.value)}
              className="w-full"
              placeholder="Surveyor name"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Date</label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="w-full"
            />
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1">Color</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer"
              />
              <input
                type="text"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="flex-1"
                placeholder="#4ecdc4"
              />
            </div>
          </div>
        </div>

        {/* Shots table */}
        <div className="border-t border-border pt-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium">Shots ({visibleShots.length})</h3>
            <Button size="sm" onClick={handleAddShot}>
              + Add Shot
            </Button>
          </div>

          <div className="max-h-64 overflow-auto border border-border rounded">
            <table className="w-full text-sm">
              <thead className="bg-background sticky top-0">
                <tr className="border-b border-border">
                  <th className="px-2 py-1 text-left">#</th>
                  <th className="px-2 py-1 text-left">Az In</th>
                  <th className="px-2 py-1 text-left">Az Out</th>
                  <th className="px-2 py-1 text-left">Length</th>
                  <th className="px-2 py-1 text-left">Depth In</th>
                  <th className="px-2 py-1 text-left">Depth Out</th>
                  <th className="px-2 py-1 text-left">Pitch In</th>
                  <th className="px-2 py-1 text-left">Pitch Out</th>
                  <th className="px-2 py-1 text-left">L</th>
                  <th className="px-2 py-1 text-left">R</th>
                  <th className="px-2 py-1 text-left">U</th>
                  <th className="px-2 py-1 text-left">D</th>
                  <th className="px-2 py-1 text-left">Virtual</th>
                  <th className="px-2 py-1 text-left">Comment</th>
                  <th className="px-2 py-1"></th>
                </tr>
              </thead>
              <tbody>
                {visibleShots.map((shot, idx) => {
                  const actualIndex = shots.findIndex(s => s === shot || (s.id === shot.id && s.tempId === shot.tempId));
                  return (
                    <tr key={shot.tempId ?? shot.id} className="border-b border-border last:border-0 hover:bg-background/50">
                      <td className="px-2 py-1 text-text-secondary">{idx + 1}</td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.azimuth_in}
                          onChange={(e) => handleShotChange(actualIndex, 'azimuth_in', parseFloat(e.target.value) || 0)}
                          className="w-14 text-xs px-1 py-0.5"
                          step="0.1"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.azimuth_out}
                          onChange={(e) => handleShotChange(actualIndex, 'azimuth_out', parseFloat(e.target.value) || 0)}
                          className="w-14 text-xs px-1 py-0.5"
                          step="0.1"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.length}
                          onChange={(e) => handleShotChange(actualIndex, 'length', parseFloat(e.target.value) || 0)}
                          className="w-14 text-xs px-1 py-0.5"
                          step="0.1"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.depth_in}
                          onChange={(e) => handleShotChange(actualIndex, 'depth_in', parseFloat(e.target.value) || 0)}
                          className="w-14 text-xs px-1 py-0.5"
                          step="0.1"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.depth_out}
                          onChange={(e) => handleShotChange(actualIndex, 'depth_out', parseFloat(e.target.value) || 0)}
                          className="w-14 text-xs px-1 py-0.5"
                          step="0.1"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.pitch_in ?? ''}
                          onChange={(e) => handleShotChange(actualIndex, 'pitch_in', e.target.value === '' ? null : parseFloat(e.target.value))}
                          className="w-12 text-xs px-1 py-0.5"
                          step="0.1"
                          placeholder="-"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.pitch_out ?? ''}
                          onChange={(e) => handleShotChange(actualIndex, 'pitch_out', e.target.value === '' ? null : parseFloat(e.target.value))}
                          className="w-12 text-xs px-1 py-0.5"
                          step="0.1"
                          placeholder="-"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.left ?? ''}
                          onChange={(e) => handleShotChange(actualIndex, 'left', e.target.value === '' ? null : parseFloat(e.target.value))}
                          className="w-10 text-xs px-1 py-0.5"
                          step="0.1"
                          placeholder="-"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.right ?? ''}
                          onChange={(e) => handleShotChange(actualIndex, 'right', e.target.value === '' ? null : parseFloat(e.target.value))}
                          className="w-10 text-xs px-1 py-0.5"
                          step="0.1"
                          placeholder="-"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.up ?? ''}
                          onChange={(e) => handleShotChange(actualIndex, 'up', e.target.value === '' ? null : parseFloat(e.target.value))}
                          className="w-10 text-xs px-1 py-0.5"
                          step="0.1"
                          placeholder="-"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="number"
                          value={shot.down ?? ''}
                          onChange={(e) => handleShotChange(actualIndex, 'down', e.target.value === '' ? null : parseFloat(e.target.value))}
                          className="w-10 text-xs px-1 py-0.5"
                          step="0.1"
                          placeholder="-"
                        />
                      </td>
                      <td className="px-1 py-1 text-center">
                        <input
                          type="checkbox"
                          checked={shot.is_virtual}
                          onChange={(e) => handleShotChange(actualIndex, 'is_virtual', e.target.checked)}
                          className="w-4 h-4"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <input
                          type="text"
                          value={shot.comment ?? ''}
                          onChange={(e) => handleShotChange(actualIndex, 'comment', e.target.value || null)}
                          className="w-20 text-xs px-1 py-0.5"
                          placeholder="-"
                        />
                      </td>
                      <td className="px-1 py-1">
                        <button
                          onClick={() => handleDeleteShot(actualIndex)}
                          className="text-error hover:text-error/80 text-xs px-1"
                          title="Delete shot"
                        >
                          x
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {visibleShots.length === 0 && (
                  <tr>
                    <td colSpan={15} className="px-2 py-4 text-center text-text-secondary">
                      No shots in this section. Click "Add Shot" to create one.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-4 border-t border-border">
          <Button onClick={closeDialog} disabled={isLoading}>
            Cancel
          </Button>
          <Button variant="primary" onClick={handleSave} disabled={isLoading}>
            {isLoading ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}

function hasChanges(original: Shot, current: EditableShot): boolean {
  return (
    original.azimuth_in !== current.azimuth_in ||
    original.azimuth_out !== current.azimuth_out ||
    original.length !== current.length ||
    original.depth_in !== current.depth_in ||
    original.depth_out !== current.depth_out ||
    original.pitch_in !== current.pitch_in ||
    original.pitch_out !== current.pitch_out ||
    original.left !== current.left ||
    original.right !== current.right ||
    original.up !== current.up ||
    original.down !== current.down ||
    original.comment !== current.comment ||
    original.is_virtual !== current.is_virtual
  );
}
