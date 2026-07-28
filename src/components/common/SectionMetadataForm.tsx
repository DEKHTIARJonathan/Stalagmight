/**
 * Shared form component for editing section metadata (name, surveyor, date, color, direction).
 * Used by EditSectionDialog and DMP import flows.
 */
import { DatePicker } from './DatePicker';
import { HelpTooltip } from './HelpTooltip';
import { Select } from './Select';
import { useTranslation } from 'react-i18next';

export interface SectionMetadataFormProps {
  name: string;
  surveyor: string;
  date: string;
  color: string;
  direction?: 'in' | 'out';
  quality?: number;
  /** Import-time reverse toggle (#24). Only meaningful when `showReverse`. */
  reverse?: boolean;
  onNameChange: (value: string) => void;
  onSurveyorChange: (value: string) => void;
  onDateChange: (value: string) => void;
  onColorChange: (value: string) => void;
  onQualityChange?: (value: number) => void;
  onDirectionChange?: (value: 'in' | 'out') => void;
  onReverseChange?: (value: boolean) => void;
  showName?: boolean;
  showDirection?: boolean;
  showQuality?: boolean;
  /**
   * Show the per-section reverse checkbox (#24). Import wizards only - an
   * existing section is reversed through the Reverse Section action instead,
   * which can ask about left/right and is undoable on its own.
   */
  showReverse?: boolean;
  disabled?: boolean;
}

export function SectionMetadataForm({
  name,
  surveyor,
  date,
  color,
  direction = 'in',
  quality = 1.0,
  reverse = false,
  onNameChange,
  onSurveyorChange,
  onDateChange,
  onColorChange,
  onQualityChange,
  onDirectionChange,
  onReverseChange,
  showName = true,
  showDirection = false,
  showQuality = false,
  showReverse = false,
  disabled = false,
}: SectionMetadataFormProps) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3" data-testid="section-metadata-form">
      {showName && (
        <div>
          <label className="block text-sm text-text-secondary mb-1">{t('common.labels.name')}</label>
          <input
            type="text"
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            className="w-full px-3 py-2 bg-background border border-border rounded"
            placeholder={t('sectionMetadata.placeholders.name')}
            disabled={disabled}
            data-testid="section-name-input"
          />
        </div>
      )}

      {/* Surveyor field - full width */}
      <div>
        <label className="block text-sm text-text-secondary mb-1">{t('sectionMetadata.labels.surveyor')}</label>
        <input
          type="text"
          value={surveyor}
          onChange={(e) => onSurveyorChange(e.target.value)}
          className="w-full px-3 py-2 bg-background border border-border rounded"
          placeholder={t('sectionMetadata.placeholders.surveyor')}
          disabled={disabled}
          data-testid="section-surveyor-input"
        />
      </div>

      {showQuality && (
        <div>
          <label className="block text-sm text-text-secondary mb-1">
            <span className="inline-flex items-center gap-1">
              {t('sectionMetadata.labels.quality')}
              <HelpTooltip
                text={t('sectionMetadata.help.quality')}
                iconTestId="section-quality-help-icon"
                tooltipTestId="section-quality-help-tooltip"
              />
            </span>
          </label>
          <input
            type="number" inputMode="decimal"
            min={0.1}
            step={0.1}
            value={quality}
            onChange={(e) => onQualityChange?.(parseFloat(e.target.value) || 1.0)}
            className="w-32 px-3 py-2 bg-background border border-border rounded"
            disabled={disabled}
            data-testid="section-quality-input"
          />
        </div>
      )}

      {showReverse && (
        <div>
          <label className="flex items-start gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={reverse}
              onChange={(e) => onReverseChange?.(e.target.checked)}
              className="mt-0.5"
              disabled={disabled}
              data-testid="section-reverse-checkbox"
            />
            <span>
              <span className="text-text-primary">
                {t('sectionMetadata.labels.reverse')}
              </span>
              <span className="block text-text-tertiary">
                {t('sectionMetadata.help.reverse')}
              </span>
            </span>
          </label>
        </div>
      )}

      {/* Date, Direction, and Color row */}
      <div className="flex gap-3 items-end justify-between">
        {/* Date and Direction - left aligned */}
        <div className="flex gap-3 items-end">
          <div className="w-32">
            <label className="block text-sm text-text-secondary mb-1">{t('common.labels.date')}</label>
            <DatePicker
              value={date}
              onChange={onDateChange}
              disabled={disabled}
              data-testid="section-date-input"
            />
          </div>

          {showDirection && (
            <div className="w-16">
              <label className="block text-sm text-text-secondary mb-1">{t('sectionMetadata.labels.directionShort')}</label>
              <Select
                value={direction}
                onChange={(v) => onDirectionChange?.(v as 'in' | 'out')}
                options={[
                  { value: 'in', label: t('sectionMetadata.direction.in') },
                  { value: 'out', label: t('sectionMetadata.direction.out') },
                ]}
                disabled={disabled}
                data-testid="section-direction-select"
              />
            </div>
          )}
        </div>

        {/* Color - right aligned */}
        <div className="flex-shrink-0">
          <label className="block text-sm text-text-secondary mb-1">{t('sectionMetadata.labels.color')}</label>
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
              placeholder={t('sectionMetadata.placeholders.color')}
              disabled={disabled}
              data-testid="section-color-hex-input"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
