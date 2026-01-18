/**
 * Shared form component for editing section metadata (name, surveyor, date, color, direction).
 * Used by EditSectionDialog and DmpSectionConfigDialog.
 */

export interface SectionMetadataFormProps {
  name: string;
  surveyor: string;
  date: string;
  color: string;
  direction?: 'in' | 'out';
  onNameChange: (value: string) => void;
  onSurveyorChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onColorChange: (value: string) => void;
  onDirectionChange?: (value: 'in' | 'out') => void;
  showDirection?: boolean;
  disabled?: boolean;
}

export function SectionMetadataForm({
  name,
  surveyor,
  date,
  color,
  direction = 'in',
  onNameChange,
  onSurveyorChange,
  onDateChange,
  onColorChange,
  onDirectionChange,
  showDirection = false,
  disabled = false,
}: SectionMetadataFormProps) {
  return (
    <div className={`grid gap-4 ${showDirection ? 'grid-cols-5' : 'grid-cols-4'}`} data-testid="section-metadata-form">
      <div>
        <label className="block text-sm text-text-secondary mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="w-full"
          placeholder="Section name"
          disabled={disabled}
          data-testid="section-name-input"
        />
      </div>

      <div>
        <label className="block text-sm text-text-secondary mb-1">Surveyor</label>
        <input
          type="text"
          value={surveyor}
          onChange={(e) => onSurveyorChange(e.target.value)}
          className="w-full"
          placeholder="Surveyor name"
          disabled={disabled}
          data-testid="section-surveyor-input"
        />
      </div>

      <div>
        <label className="block text-sm text-text-secondary mb-1">Date</label>
        <input
          type="date"
          value={date}
          onChange={(e) => onDateChange(e.target.value)}
          className="w-full"
          disabled={disabled}
          data-testid="section-date-input"
        />
      </div>

      <div>
        <label className="block text-sm text-text-secondary mb-1">Color</label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(e) => onColorChange(e.target.value)}
            className="w-8 h-8 rounded cursor-pointer"
            disabled={disabled}
            data-testid="section-color-picker"
          />
          <input
            type="text"
            value={color}
            onChange={(e) => onColorChange(e.target.value)}
            className="flex-1"
            placeholder="#4ecdc4"
            disabled={disabled}
            data-testid="section-color-hex-input"
          />
        </div>
      </div>

      {showDirection && (
        <div>
          <label className="block text-sm text-text-secondary mb-1">Direction</label>
          <select
            value={direction}
            onChange={(e) => onDirectionChange?.(e.target.value as 'in' | 'out')}
            className="w-full bg-surface border border-border rounded px-3 py-1.5"
            disabled={disabled}
            data-testid="section-direction-select"
          >
            <option value="in">In</option>
            <option value="out">Out</option>
          </select>
        </div>
      )}
    </div>
  );
}
