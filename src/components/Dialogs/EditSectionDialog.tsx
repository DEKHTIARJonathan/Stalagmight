import { useState, useEffect, useCallback } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button } from '../common/Button';
import { DialogWrapper } from './DialogWrapper';
import { ShotTableEditor, type EditableShot } from '../common/ShotTableEditor';
import { SectionMetadataForm } from '../common/SectionMetadataForm';
import type { Shot, ShotData } from '../../types/project';

export default function EditSectionDialog() {
  const { closeDialog, dialogData } = useUIStore();
  const { updateSection, createShot, updateShot, deleteShot, project, config } = useProjectStore();

  const sectionId = dialogData.sectionId as number | undefined;
  const section = project?.sections.find((s) => s.id === sectionId);

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [surveyor, setSurveyor] = useState('');
  const [date, setDate] = useState('');
  const [color, setColor] = useState('#4ecdc4');
  const [direction, setDirection] = useState<'in' | 'out'>('in');

  // Shots state
  const [shots, setShots] = useState<EditableShot[]>([]);
  const [nextTempId, setNextTempId] = useState(-1);
  const [selectedRowIndex, setSelectedRowIndex] = useState<number | null>(null);

  // Initialize form with section data
  useEffect(() => {
    if (section) {
      setName(section.name ?? '');
      setSurveyor(section.surveyor ?? '');
      setDate(section.date ?? '');
      setColor(section.color);
      setDirection(section.direction ?? 'in');
      setShots(section.shots.map(s => ({ ...s })));
    }
  }, [section]);

  const handleShotChange = useCallback((index: number, field: keyof EditableShot, value: number | string | boolean | null) => {
    setShots(prev => {
      const updated = [...prev];
      const shot = updated[index];
      if (!shot) return prev;
      updated[index] = {
        ...shot,
        [field]: value,
      } as EditableShot;
      return updated;
    });
  }, []);

  const handleAddShot = useCallback(() => {
    const newShot: EditableShot = {
      id: nextTempId,
      tempId: nextTempId,
      azimuth_in: 0,
      azimuth_out: 180,
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
  }, [nextTempId]);

  const handleDeleteShot = useCallback((index: number) => {
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
    // Clear selection if deleted row was selected
    if (selectedRowIndex === index) {
      setSelectedRowIndex(null);
    }
  }, [selectedRowIndex]);

  const handleInsertBefore = useCallback((index: number) => {
    const newShot: EditableShot = {
      id: nextTempId,
      tempId: nextTempId,
      azimuth_in: 0,
      azimuth_out: 180,
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
    setShots(prev => {
      const updated = [...prev];
      updated.splice(index, 0, newShot);
      return updated;
    });
    setNextTempId(prev => prev - 1);
  }, [nextTempId]);

  const handleInsertAfter = useCallback((index: number) => {
    const newShot: EditableShot = {
      id: nextTempId,
      tempId: nextTempId,
      azimuth_in: 0,
      azimuth_out: 180,
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
    setShots(prev => {
      const updated = [...prev];
      updated.splice(index + 1, 0, newShot);
      return updated;
    });
    setNextTempId(prev => prev - 1);
  }, [nextTempId]);

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
        direction,
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
    direction !== (section.direction ?? 'in') ||
    shots.some(s => s.isNew || s.isDeleted) ||
    shots.some(s => {
      const original = section.shots.find(o => o.id === s.id);
      return original && hasChanges(original, s);
    })
  ) : false;

  // Validation config from app config
  const validationConfig = {
    azimuth_diff_threshold: config?.validation?.azimuth_diff_threshold ?? 10,
    pitch_diff_threshold: config?.validation?.pitch_diff_threshold ?? 5,
  };

  if (!section) {
    return (
      <DialogWrapper title="Edit Section" onClose={closeDialog} size="5xl" data-testid="edit-section-dialog">
        <div className="text-error">Section not found</div>
      </DialogWrapper>
    );
  }

  return (
    <DialogWrapper title="Edit Section" onClose={closeDialog} size="5xl" isDirty={isDirty} data-testid="edit-section-dialog">
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-error/10 border border-error/20 rounded text-error text-sm">
            {error}
          </div>
        )}

        {/* Section metadata */}
        <SectionMetadataForm
          name={name}
          surveyor={surveyor}
          date={date}
          color={color}
          direction={direction}
          onNameChange={setName}
          onSurveyorChange={setSurveyor}
          onDateChange={setDate}
          onColorChange={setColor}
          onDirectionChange={setDirection}
          showDirection={true}
          disabled={isLoading}
        />

        {/* Shots table using ShotTableEditor */}
        <div className="border-t border-border pt-4">
          <ShotTableEditor
            shots={shots}
            onShotChange={handleShotChange}
            onAddShot={handleAddShot}
            onDeleteShot={handleDeleteShot}
            onInsertBefore={handleInsertBefore}
            onInsertAfter={handleInsertAfter}
            validationConfig={validationConfig}
            selectedRowIndex={selectedRowIndex}
            onRowSelect={setSelectedRowIndex}
            maxHeight="16rem"
          />
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
