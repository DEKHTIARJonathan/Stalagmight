import { useEffect, useRef } from 'react';
import { Select } from '../../common/Select';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import type { LengthUnit, AngleUnit } from '../../../types/config';

/**
 * Units settings category content.
 * Maps to config.units: length, depth, angle, decimal_precision.
 */
export function UnitsSettings({
  config,
  onChange,
  changedFields,
  onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  // Validation state
  const hasErrorRef = useRef(false);

  // Validate on mount and when config changes
  useEffect(() => {
    const errors: string[] = [];

    // Validate decimal_precision
    if (config.units.decimal_precision < 0 || config.units.decimal_precision > 6) {
      errors.push('Decimal precision must be between 0 and 6');
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('units', hasError);
    }
  }, [config.units, onValidationError]);

  const handleLengthChange = (value: string) => {
    onChange({
      units: {
        ...config.units,
        length: value as LengthUnit,
      },
    });
  };

  const handleDepthChange = (value: string) => {
    onChange({
      units: {
        ...config.units,
        depth: value as LengthUnit,
      },
    });
  };

  const handleAngleChange = (value: string) => {
    onChange({
      units: {
        ...config.units,
        angle: value as AngleUnit,
      },
    });
  };

  const handleDecimalPrecisionChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        units: {
          ...config.units,
          decimal_precision: num,
        },
      });
    }
  };

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'units')}
      aria-labelledby={getTabId(panelIdBase, 'units')}
      data-testid="settings-panel-units"
    >
      <h2 className="text-lg font-medium mb-4">Units</h2>

      <SettingsSection title="Measurement Units" data-testid="section-measurement">
        <SettingRow
          label="Length unit"
          helpText="Unit for horizontal distances (shot lengths, etc.)"
          isChanged={isFieldChanged(changedFields, 'units.length')}
          data-testid="setting-length-unit"
        >
          <Select
            value={config.units.length}
            onChange={handleLengthChange}
            options={[
              { value: 'meters', label: 'Meters' },
              { value: 'feet', label: 'Feet' },
            ]}
            className="w-32"
            aria-label="Length unit"
            data-testid="select-length-unit"
          />
        </SettingRow>

        <SettingRow
          label="Depth unit"
          helpText="Unit for vertical depth measurements"
          isChanged={isFieldChanged(changedFields, 'units.depth')}
          data-testid="setting-depth-unit"
        >
          <Select
            value={config.units.depth}
            onChange={handleDepthChange}
            options={[
              { value: 'meters', label: 'Meters' },
              { value: 'feet', label: 'Feet' },
            ]}
            className="w-32"
            aria-label="Depth unit"
            data-testid="select-depth-unit"
          />
        </SettingRow>

        <SettingRow
          label="Angle unit"
          helpText="Unit for azimuth and pitch angles"
          isChanged={isFieldChanged(changedFields, 'units.angle')}
          data-testid="setting-angle-unit"
        >
          <Select
            value={config.units.angle}
            onChange={handleAngleChange}
            options={[
              { value: 'degrees', label: 'Degrees' },
              { value: 'gradians', label: 'Gradians' },
            ]}
            className="w-32"
            aria-label="Angle unit"
            data-testid="select-angle-unit"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Display Precision" data-testid="section-precision">
        <SettingRow
          label="Decimal places"
          helpText="Number of decimal places for numeric values (0-6)"
          isChanged={isFieldChanged(changedFields, 'units.decimal_precision')}
          data-testid="setting-decimal-precision"
        >
          <input
            type="number"
            min={0}
            max={6}
            value={config.units.decimal_precision}
            onChange={(e) => handleDecimalPrecisionChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label="Decimal precision"
            data-testid="input-decimal-precision"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
