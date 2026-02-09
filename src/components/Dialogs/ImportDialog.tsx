import { useState, useRef, useCallback } from 'react';
import { useUIStore } from '../../store/uiStore';
import { useProjectStore } from '../../store/projectStore';
import { Button, IconButton } from '../common/Button';
import { Panel } from '../common/Panel';
import { CloseIcon } from '../common/icons';
import { DialogWrapper } from './DialogWrapper';
import type { ShotData, SectionData } from '../../types/project';
import { getNextSectionColor } from '../../utils/colors';

/** Editable column keys in display order (without LRUD). */
const BASE_COLS: EditableField[] = ['length', 'azimuth', 'depth_in', 'depth_out'];
const LRUD_COLS: EditableField[] = ['left', 'right', 'up', 'down'];

type EditableField =
  | 'length'
  | 'azimuth'
  | 'depth_in'
  | 'depth_out'
  | 'left'
  | 'right'
  | 'up'
  | 'down';

function validateField(field: EditableField, raw: string): string | null {
  if (field === 'left' || field === 'right' || field === 'up' || field === 'down') {
    if (raw.trim() === '') return null; // empty is valid (→ null)
    const v = parseFloat(raw);
    if (!Number.isFinite(v) || v < 0) return 'Must be ≥ 0 or empty';
    return null;
  }
  const v = parseFloat(raw);
  if (!Number.isFinite(v)) return 'Must be a number';
  if (field === 'length' && v <= 0) return 'Must be > 0';
  if (field === 'azimuth' && (v < 0 || v >= 360)) return 'Must be [0, 360)';
  return null;
}

export default function ImportDialog() {
  const { closeDialog } = useUIStore();
  const { createSection, project } = useProjectStore();

  // Form state
  const [name, setName] = useState<string>('');
  const [surveyor, setSurveyor] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [shots, setShots] = useState<ShotData[]>([createEmptyShot()]);
  const [showLrud, setShowLrud] = useState(false);

  // Validation state
  const [cellErrors, setCellErrors] = useState<Record<string, string>>({});
  const previousValues = useRef<Record<string, string>>({});

  // Input refs: inputRefs.current[rowIndex][colIndex]
  const inputRefs = useRef<(HTMLInputElement | null)[][]>([]);

  // Get next available color
  const usedColors = project?.sections.map((s) => s.color) ?? [];
  const [color, setColor] = useState<string>(getNextSectionColor(usedColors));

  const editableCols = showLrud ? [...BASE_COLS, ...LRUD_COLS] : BASE_COLS;

  const cellKey = (row: number, field: string) => `${row}-${field}`;

  const setRef = useCallback(
    (rowIndex: number, colIndex: number, el: HTMLInputElement | null) => {
      if (!inputRefs.current[rowIndex]) {
        inputRefs.current[rowIndex] = [];
      }
      inputRefs.current[rowIndex]![colIndex] = el;
    },
    [],
  );

  const handleAddShot = useCallback(() => {
    setShots((prev) => {
      const last = prev[prev.length - 1];
      const shot = createEmptyShot();
      if (last) {
        shot.depth_in = last.depth_out;
      }
      return [...prev, shot];
    });
  }, []);

  const handleRemoveShot = (index: number) => {
    setShots(shots.filter((_, i) => i !== index));
    // Clean up errors for removed row and re-key rows after it
    setCellErrors((prev) => {
      const next: Record<string, string> = {};
      for (const [key, val] of Object.entries(prev)) {
        const dashIdx = key.indexOf('-');
        const rowStr = key.slice(0, dashIdx);
        const field = key.slice(dashIdx + 1);
        const row = parseInt(rowStr, 10);
        if (row === index) continue;
        const newRow = row > index ? row - 1 : row;
        next[`${newRow}-${field}`] = val;
      }
      return next;
    });
  };

  const handleShotChange = (index: number, field: keyof ShotData, value: unknown) => {
    const newShots = [...shots];
    const shot = newShots[index];
    if (shot) {
      (shot as unknown as Record<string, unknown>)[field] = value;
      setShots(newShots);
    }
  };

  /** Handle change for an editable field, including azimuth → both azi fields. */
  const handleFieldChange = (rowIndex: number, field: EditableField, raw: string) => {
    if (field === 'azimuth') {
      const v = parseFloat(raw) || 0;
      handleShotChange(rowIndex, 'azimuth_in', v);
      handleShotChange(rowIndex, 'azimuth_out', v);
    } else if (field === 'left' || field === 'right' || field === 'up' || field === 'down') {
      const v = raw.trim() === '' ? null : parseFloat(raw) || 0;
      handleShotChange(rowIndex, field, v);
    } else {
      handleShotChange(rowIndex, field, parseFloat(raw) || 0);
    }
  };

  const getFieldValue = (shot: ShotData, field: EditableField): string => {
    if (field === 'azimuth') return String(shot.azimuth_in);
    if (field === 'left' || field === 'right' || field === 'up' || field === 'down') {
      const v = shot[field];
      return v === null || v === undefined ? '' : String(v);
    }
    return String(shot[field]);
  };

  // --- Focus / validation helpers ---

  const handleFocus = (rowIndex: number, field: EditableField, input: HTMLInputElement) => {
    const key = cellKey(rowIndex, field);
    previousValues.current[key] = input.value;
  };

  const doValidate = (
    rowIndex: number,
    field: EditableField,
    input: HTMLInputElement,
  ): boolean => {
    const raw = input.value;
    const error = validateField(field, raw);
    const key = cellKey(rowIndex, field);
    if (error) {
      setCellErrors((prev) => ({ ...prev, [key]: error }));
      setTimeout(() => input.focus(), 0);
      return false;
    }
    setCellErrors((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    handleFieldChange(rowIndex, field, raw);
    return true;
  };

  const handleBlur = (rowIndex: number, field: EditableField, input: HTMLInputElement) => {
    doValidate(rowIndex, field, input);
  };

  const focusCell = (rowIndex: number, colIndex: number) => {
    const row = inputRefs.current[rowIndex];
    const el = row?.[colIndex];
    if (el) {
      el.focus();
    }
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    rowIndex: number,
    colIndex: number,
    field: EditableField,
  ) => {
    const input = e.currentTarget;
    const key = cellKey(rowIndex, field);

    if (e.key === 'Escape') {
      // Restore previous value if cell is in error
      if (cellErrors[key]) {
        const prev = previousValues.current[key];
        if (prev !== undefined) {
          input.value = prev;
          handleFieldChange(rowIndex, field, prev);
        }
        setCellErrors((prevErrors) => {
          const next = { ...prevErrors };
          delete next[key];
          return next;
        });
        input.blur();
      }
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      // Validate first — if invalid, block
      if (!doValidate(rowIndex, field, input)) return;

      const isLastRow = rowIndex === shots.length - 1;

      if (isLastRow) {
        // Create new row and focus Length (first column)
        handleAddShot();
        setTimeout(() => focusCell(rowIndex + 1, 0), 0);
      } else {
        // Move down to same column in next row
        focusCell(rowIndex + 1, colIndex);
      }
    }
  };

  /** Enter on non-editable cells (Virtual, ✕) creates a new row or moves down. */
  const handleRowKeyDown = (e: React.KeyboardEvent, rowIndex: number) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const isLastRow = rowIndex === shots.length - 1;
      if (isLastRow) {
        handleAddShot();
        setTimeout(() => focusCell(rowIndex + 1, 0), 0);
      } else {
        focusCell(rowIndex + 1, 0);
      }
    }
  };

  const handleSubmit = async () => {
    const sectionData: SectionData = {
      name: name || null,
      surveyor: surveyor || null,
      date: date || null,
      color,
      direction: null,
      quality: 1.0,
      shots: shots.filter((s) => s.length > 0),
    };

    await createSection(sectionData);
    closeDialog();
  };

  // Track if form has been modified
  const isDirty =
    name !== '' || surveyor !== '' || date !== '' || shots.some((s) => s.length > 0);

  return (
    <DialogWrapper
      title="Import / Create Section"
      onClose={closeDialog}
      size="2xl"
      isDirty={isDirty}
      data-testid="import-section-dialog"
    >
      <div className="space-y-4">
        {/* Metadata */}
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm text-text-secondary mb-1">Section Name</label>
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
            <label className="block text-sm text-text-secondary mb-1">Surveyor</label>
            <input
              type="text"
              value={surveyor}
              onChange={(e) => setSurveyor(e.target.value)}
              className="w-full"
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
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              className="w-full h-9"
            />
          </div>
        </div>

        {/* Shots table */}
        <Panel
          title="Shots"
          headerActions={
            <button onClick={handleAddShot} className="text-accent text-sm">
              + Add Row
            </button>
          }
        >
          {/* LRUD toggle */}
          <div className="px-3 py-2 border-b border-border">
            <label className="flex items-center gap-2 text-sm text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={showLrud}
                onChange={(e) => setShowLrud(e.target.checked)}
              />
              Include LRUD
            </label>
          </div>

          <div className="overflow-auto max-h-64 pb-1">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="text-center" style={{ width: '40px' }}>#</th>
                  <th className="text-right" style={{ width: '100px' }}>Length</th>
                  <th className="text-right" style={{ width: '70px' }}>Azimuth</th>
                  <th className="text-right" style={{ width: '80px' }}>Depth In</th>
                  <th className="text-right" style={{ width: '95px' }}>Depth Out</th>
                  {showLrud && (
                    <>
                      <th className="text-right" style={{ width: '50px' }}>L</th>
                      <th className="text-right" style={{ width: '50px' }}>R</th>
                      <th className="text-right" style={{ width: '50px' }}>U</th>
                      <th className="text-right" style={{ width: '50px' }}>D</th>
                    </>
                  )}
                  <th className="text-center" style={{ width: '40px' }}>Virt</th>
                  <th style={{ width: '30px' }}></th>
                </tr>
              </thead>
              <tbody>
                {shots.map((shot, rowIndex) => (
                  <tr key={rowIndex}>
                    <td className="p-0 text-center">
                      <span className="px-2 py-1 inline-block">{rowIndex + 1}</span>
                    </td>
                    {editableCols.map((field, colIndex) => {
                      const key = cellKey(rowIndex, field);
                      const hasError = !!cellErrors[key];
                      const isLrud =
                        field === 'left' ||
                        field === 'right' ||
                        field === 'up' ||
                        field === 'down';
                      return (
                        <td key={field} className="p-0 text-right">
                          <input
                            ref={(el) => setRef(rowIndex, colIndex, el)}
                            type="number"
                            value={getFieldValue(shot, field)}
                            onChange={(e) => handleFieldChange(rowIndex, field, e.target.value)}
                            onFocus={(e) => handleFocus(rowIndex, field, e.currentTarget)}
                            onBlur={(e) => handleBlur(rowIndex, field, e.currentTarget)}
                            onKeyDown={(e) => handleKeyDown(e, rowIndex, colIndex, field)}
                            className={`w-full px-2 py-1 bg-transparent border-none focus:bg-panel text-right tabular-nums ${hasError ? 'relative z-10 ring-2 ring-error' : ''}`}
                            step="0.1"
                            title={cellErrors[key] ?? undefined}
                            placeholder={isLrud ? '—' : undefined}
                          />
                        </td>
                      );
                    })}
                    <td className="p-0 text-center">
                      <span className="px-2 py-1 flex items-center justify-center">
                        <input
                          type="checkbox"
                          checked={shot.is_virtual ?? false}
                          onChange={(e) =>
                            handleShotChange(rowIndex, 'is_virtual', e.target.checked)
                          }
                          onKeyDown={(e) => handleRowKeyDown(e, rowIndex)}
                        />
                      </span>
                    </td>
                    <td className="p-0 text-center">
                      <IconButton
                        onClick={() => handleRemoveShot(rowIndex)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleRowKeyDown(e, rowIndex);
                          }
                        }}
                        icon={<CloseIcon size={12} />}
                        size="sm"
                        variant="ghost"
                        aria-label="Remove shot"
                        className="text-error hover:text-error-80"
                      />
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
            Create Section
          </Button>
        </div>
      </div>
    </DialogWrapper>
  );
}

function createEmptyShot(): ShotData {
  return {
    azimuth_in: 0,
    azimuth_out: 0,
    length: 0,
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
    marker_index: null,
    temperature: null,
  };
}
