/**
 * Shared form component for editing section metadata (name, surveyor, date, color, direction).
 * Used by EditSectionDialog and DmpSectionConfigDialog.
 */
import { DatePicker } from './DatePicker';
import { Select } from './Select';

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
    <div className="space-y-3" data-testid="section-metadata-form">
      {/* Name field - full width */}
      <div>
        <label className="block text-sm text-text-secondary mb-1">Name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          className="w-full px-3 py-2 bg-background border border-border rounded"
          placeholder="Section name"
          disabled={disabled}
          data-testid="section-name-input"
        />
      </div>

      {/* Surveyor field - full width */}
      <div>
        <label className="block text-sm text-text-secondary mb-1">Surveyor</label>
        <input
          type="text"
          value={surveyor}
          onChange={(e) => onSurveyorChange(e.target.value)}
          className="w-full px-3 py-2 bg-background border border-border rounded"
          placeholder="Surveyor name"
          disabled={disabled}
          data-testid="section-surveyor-input"
        />
      </div>

      {/* Date, Direction, and Color row */}
      <div className="flex gap-3 items-end justify-between">
        {/* Date and Direction - left aligned */}
        <div className="flex gap-3 items-end">
          <div className="w-32">
            <label className="block text-sm text-text-secondary mb-1">Date</label>
            <DatePicker
              value={date}
              onChange={onDateChange}
              disabled={disabled}
              data-testid="section-date-input"
            />
          </div>

          {showDirection && (
            <div className="w-16">
              <label className="block text-sm text-text-secondary mb-1">Dir</label>
              <Select
                value={direction}
                onChange={(v) => onDirectionChange?.(v as 'in' | 'out')}
                options={[
                  { value: 'in', label: 'In' },
                  { value: 'out', label: 'Out' },
                ]}
                disabled={disabled}
                data-testid="section-direction-select"
              />
            </div>
          )}
        </div>

        {/* Color - right aligned */}
        <div className="flex-shrink-0">
          <label className="block text-sm text-text-secondary mb-1">Color</label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              value={color}
              onChange={(e) => onColorChange(e.target.value)}
              className="w-8 h-8 rounded cursor-pointer border border-border"
              disabled={disabled}
              data-testid="section-color-picker"
            />
            <input
              type="text"
              value={color}
              onChange={(e) => onColorChange(e.target.value)}
              className="w-20 px-2 py-1.5 bg-background border border-border rounded text-sm"
              placeholder="#hex"
              disabled={disabled}
              data-testid="section-color-hex-input"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
