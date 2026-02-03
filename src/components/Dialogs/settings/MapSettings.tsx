import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';
import type { TileProviderInfo } from '../../../types/tile';

/** Fallback provider option shown when IPC call fails */
const FALLBACK_PROVIDER_OPTION = { value: 'esri', label: 'ESRI World Imagery' };

/**
 * Map settings category content.
 * Maps to config.map: satellite_provider, satellite_enabled, satellite_gps_origin,
 * zoom settings, station, shot, snap, animation configs.
 */
/** Select option type */
interface ProviderOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function MapSettings({
  config,
  onChange,
  changedFields,
  onValidationError,
  panelIdBase,
}: SettingsCategoryProps) {
  const { t } = useTranslation();
  // Validation state
  const hasErrorRef = useRef(false);

  // Provider state - loaded dynamically from backend
  const [providerOptions, setProviderOptions] = useState<ProviderOption[]>([FALLBACK_PROVIDER_OPTION]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  const mountedRef = useRef(true);

  // Load providers from backend on mount
  const loadProviders = useCallback(async () => {
    try {
      const providers = await invoke<TileProviderInfo[]>('get_tile_providers');
      if (mountedRef.current) {
        const options: ProviderOption[] = providers.map((p) => ({
          value: p.name,
          label: p.available
            ? p.display_label
            : t('settings.map.satellite.providerRequiresKey', { provider: p.display_label }),
          disabled: !p.available,
        }));
        // Sort available providers first
        options.sort((a, b) => {
          if (a.disabled && !b.disabled) return 1;
          if (!a.disabled && b.disabled) return -1;
          return a.label.localeCompare(b.label);
        });
        setProviderOptions(options.length > 0 ? options : [FALLBACK_PROVIDER_OPTION]);
        setProvidersLoaded(true);
      }
    } catch (error) {
      console.error('[MapSettings] Failed to load tile providers:', error);
      if (mountedRef.current) {
        // Fall back to ESRI only
        setProviderOptions([FALLBACK_PROVIDER_OPTION]);
        setProvidersLoaded(true);
      }
    }
  }, [t]);

  // Load providers on mount
  useEffect(() => {
    mountedRef.current = true;
    loadProviders();
    return () => {
      mountedRef.current = false;
    };
  }, [loadProviders]);

  // Validate on mount and when config changes
  useEffect(() => {
    const errors: string[] = [];

    // Validate zoom settings
    if (config.map.zoom_min >= config.map.zoom_max) {
      errors.push(t('settings.map.validation.zoomRange'));
    }
    if (
      config.map.zoom_default < config.map.zoom_min ||
      config.map.zoom_default > config.map.zoom_max
    ) {
      errors.push(t('settings.map.validation.zoomDefault'));
    }
    if (config.map.zoom_step < 0.1 || config.map.zoom_step > 5.0) {
      errors.push(t('settings.map.validation.zoomStep'));
    }

    // Validate GPS origin
    if (config.map.satellite_gps_origin.latitude < -90 || config.map.satellite_gps_origin.latitude > 90) {
      errors.push(t('settings.map.validation.latitude'));
    }
    if (config.map.satellite_gps_origin.longitude < -180 || config.map.satellite_gps_origin.longitude > 180) {
      errors.push(t('settings.map.validation.longitude'));
    }

    // Validate station settings
    if (config.map.station.radius < 1 || config.map.station.radius > 50) {
      errors.push(t('settings.map.validation.stationRadius'));
    }
    if (config.map.station.hit_area < config.map.station.radius) {
      errors.push(t('settings.map.validation.stationHitArea'));
    }

    // Validate shot settings
    if (config.map.shot.width < 0.5 || config.map.shot.width > 20) {
      errors.push(t('settings.map.validation.shotWidth'));
    }
    if (config.map.shot.hit_area < config.map.shot.width) {
      errors.push(t('settings.map.validation.shotHitArea'));
    }

    // Validate snap threshold
    if (config.map.snap.threshold < 1 || config.map.snap.threshold > 50) {
      errors.push(t('settings.map.validation.snapThreshold'));
    }

    // Validate animation duration
    if (config.map.animation.duration < 0 || config.map.animation.duration > 2000) {
      errors.push(t('settings.map.validation.animationDuration'));
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('map', hasError);
    }
  }, [config.map, onValidationError, t]);

  // Satellite settings
  const handleProviderChange = (value: string) => {
    onChange({
      map: {
        ...config.map,
        satellite_provider: value,
      },
    });
  };

  const handleSatelliteEnabledChange = (checked: boolean) => {
    onChange({
      map: {
        ...config.map,
        satellite_enabled: checked,
      },
    });
  };

  const handleLatitudeChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          satellite_gps_origin: {
            ...config.map.satellite_gps_origin,
            latitude: num,
          },
        },
      });
    }
  };

  const handleLongitudeChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          satellite_gps_origin: {
            ...config.map.satellite_gps_origin,
            longitude: num,
          },
        },
      });
    }
  };

  // Zoom settings
  const handleZoomDefaultChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({ map: { ...config.map, zoom_default: num } });
    }
  };

  const handleZoomMinChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({ map: { ...config.map, zoom_min: num } });
    }
  };

  const handleZoomMaxChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({ map: { ...config.map, zoom_max: num } });
    }
  };

  const handleZoomStepChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({ map: { ...config.map, zoom_step: num } });
    }
  };

  // Control settings
  const handlePanSpeedChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          controls: { ...config.map.controls, pan_speed: num },
        },
      });
    }
  };

  const handleZoomSpeedChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          controls: { ...config.map.controls, zoom_speed: num },
        },
      });
    }
  };

  const handleInvertScrollChange = (checked: boolean) => {
    onChange({
      map: {
        ...config.map,
        controls: { ...config.map.controls, invert_scroll: checked },
      },
    });
  };

  // Station settings
  const handleStationRadiusChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          station: { ...config.map.station, radius: num },
        },
      });
    }
  };

  const handleStationHitAreaChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          station: { ...config.map.station, hit_area: num },
        },
      });
    }
  };

  const handleStationHoverRadiusChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          station: { ...config.map.station, hover_radius: num },
        },
      });
    }
  };

  const handleStationSelectionRadiusChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          station: { ...config.map.station, selection_radius: num },
        },
      });
    }
  };

  // Shot settings
  const handleShotWidthChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          shot: { ...config.map.shot, width: num },
        },
      });
    }
  };

  const handleShotHitAreaChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          shot: { ...config.map.shot, hit_area: num },
        },
      });
    }
  };

  const handleShotHoverWidthChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          shot: { ...config.map.shot, hover_width: num },
        },
      });
    }
  };

  const handleShotSelectionWidthChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          shot: { ...config.map.shot, selection_width: num },
        },
      });
    }
  };

  // Snap settings
  const handleSnapThresholdChange = (value: string) => {
    const num = parseFloat(value);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          snap: { ...config.map.snap, threshold: num },
        },
      });
    }
  };

  const handleSnapDrawChange = (checked: boolean) => {
    onChange({
      map: {
        ...config.map,
        snap: { ...config.map.snap, enabled_draw: checked },
      },
    });
  };

  const handleSnapMergeChange = (checked: boolean) => {
    onChange({
      map: {
        ...config.map,
        snap: { ...config.map.snap, enabled_merge: checked },
      },
    });
  };

  const handleSnapMeasureChange = (checked: boolean) => {
    onChange({
      map: {
        ...config.map,
        snap: { ...config.map.snap, enabled_measure: checked },
      },
    });
  };

  // Animation settings
  const handleAnimationEnabledChange = (checked: boolean) => {
    onChange({
      map: {
        ...config.map,
        animation: { ...config.map.animation, enabled: checked },
      },
    });
  };

  const handleAnimationDurationChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          animation: { ...config.map.animation, duration: num },
        },
      });
    }
  };

  const handlePointZoomChange = (value: string) => {
    const num = parseInt(value, 10);
    if (!isNaN(num)) {
      onChange({
        map: {
          ...config.map,
          animation: { ...config.map.animation, point_zoom: num },
        },
      });
    }
  };

  return (
    <div
      role="tabpanel"
      id={getPanelId(panelIdBase, 'map')}
      aria-labelledby={getTabId(panelIdBase, 'map')}
      data-testid="settings-panel-map"
    >
      <h2 className="text-lg font-medium mb-4">{t('settings.map.title')}</h2>

      <SettingsSection title={t('settings.map.sections.satellite')} data-testid="section-satellite">
        <SettingRow
          label={t('settings.map.satellite.provider.label')}
          helpText={t('settings.map.satellite.provider.help')}
          isChanged={isFieldChanged(changedFields, 'map.satellite_provider')}
          data-testid="setting-satellite-provider"
        >
          <Select
            value={config.map.satellite_provider}
            onChange={handleProviderChange}
            options={providerOptions}
            className="w-40"
            aria-label={t('settings.map.satellite.provider.aria')}
            data-testid="select-satellite-provider"
            disabled={!providersLoaded}
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.satellite.enabled.label')}
          helpText={t('settings.map.satellite.enabled.help')}
          isChanged={isFieldChanged(changedFields, 'map.satellite_enabled')}
          data-testid="setting-satellite-enabled"
        >
          <Toggle
            checked={config.map.satellite_enabled}
            onChange={handleSatelliteEnabledChange}
            aria-label={t('settings.map.satellite.enabled.aria')}
            data-testid="toggle-satellite-enabled"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.satellite.latitude.label')}
          helpText={t('settings.map.satellite.latitude.help')}
          isChanged={isFieldChanged(changedFields, 'map.satellite_gps_origin.latitude')}
          data-testid="setting-gps-latitude"
        >
          <input
            type="number"
            step={0.01}
            min={-90}
            max={90}
            value={config.map.satellite_gps_origin.latitude}
            onChange={(e) => handleLatitudeChange(e.target.value)}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.satellite.latitude.aria')}
            data-testid="input-gps-latitude"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.satellite.longitude.label')}
          helpText={t('settings.map.satellite.longitude.help')}
          isChanged={isFieldChanged(changedFields, 'map.satellite_gps_origin.longitude')}
          data-testid="setting-gps-longitude"
        >
          <input
            type="number"
            step={0.01}
            min={-180}
            max={180}
            value={config.map.satellite_gps_origin.longitude}
            onChange={(e) => handleLongitudeChange(e.target.value)}
            className="w-24 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.satellite.longitude.aria')}
            data-testid="input-gps-longitude"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.map.sections.zoom')} data-testid="section-zoom">
        <SettingRow
          label={t('settings.map.zoom.default.label')}
          helpText={t('settings.map.zoom.default.help')}
          isChanged={isFieldChanged(changedFields, 'map.zoom_default')}
          data-testid="setting-zoom-default"
        >
          <input
            type="number"
            min={config.map.zoom_min}
            max={config.map.zoom_max}
            value={config.map.zoom_default}
            onChange={(e) => handleZoomDefaultChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.zoom.default.aria')}
            data-testid="input-zoom-default"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.zoom.min.label')}
          helpText={t('settings.map.zoom.min.help')}
          isChanged={isFieldChanged(changedFields, 'map.zoom_min')}
          data-testid="setting-zoom-min"
        >
          <input
            type="number"
            min={0}
            max={config.map.zoom_max - 1}
            value={config.map.zoom_min}
            onChange={(e) => handleZoomMinChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.zoom.min.aria')}
            data-testid="input-zoom-min"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.zoom.max.label')}
          helpText={t('settings.map.zoom.max.help')}
          isChanged={isFieldChanged(changedFields, 'map.zoom_max')}
          data-testid="setting-zoom-max"
        >
          <input
            type="number"
            min={config.map.zoom_min + 1}
            max={24}
            value={config.map.zoom_max}
            onChange={(e) => handleZoomMaxChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.zoom.max.aria')}
            data-testid="input-zoom-max"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.zoom.step.label')}
          helpText={t('settings.map.zoom.step.help')}
          isChanged={isFieldChanged(changedFields, 'map.zoom_step')}
          data-testid="setting-zoom-step"
        >
          <input
            type="number"
            step={0.1}
            min={0.1}
            max={5.0}
            value={config.map.zoom_step}
            onChange={(e) => handleZoomStepChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.zoom.step.aria')}
            data-testid="input-zoom-step"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.map.sections.controls')} data-testid="section-controls">
        <SettingRow
          label={t('settings.map.controls.panSpeed.label')}
          helpText={t('settings.map.controls.panSpeed.help')}
          isChanged={isFieldChanged(changedFields, 'map.controls.pan_speed')}
          data-testid="setting-pan-speed"
        >
          <input
            type="number"
            step={0.1}
            min={0.1}
            max={5.0}
            value={config.map.controls.pan_speed}
            onChange={(e) => handlePanSpeedChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.controls.panSpeed.aria')}
            data-testid="input-pan-speed"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.controls.zoomSpeed.label')}
          helpText={t('settings.map.controls.zoomSpeed.help')}
          isChanged={isFieldChanged(changedFields, 'map.controls.zoom_speed')}
          data-testid="setting-zoom-speed"
        >
          <input
            type="number"
            step={0.1}
            min={0.1}
            max={5.0}
            value={config.map.controls.zoom_speed}
            onChange={(e) => handleZoomSpeedChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.controls.zoomSpeed.aria')}
            data-testid="input-zoom-speed"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.controls.invertScroll.label')}
          helpText={t('settings.map.controls.invertScroll.help')}
          isChanged={isFieldChanged(changedFields, 'map.controls.invert_scroll')}
          data-testid="setting-invert-scroll"
        >
          <Toggle
            checked={config.map.controls.invert_scroll}
            onChange={handleInvertScrollChange}
            aria-label={t('settings.map.controls.invertScroll.aria')}
            data-testid="toggle-invert-scroll"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.map.sections.station')} data-testid="section-station">
        <SettingRow
          label={t('settings.map.station.radius.label')}
          helpText={t('settings.map.station.radius.help')}
          isChanged={isFieldChanged(changedFields, 'map.station.radius')}
          data-testid="setting-station-radius"
        >
          <input
            type="number"
            step={0.5}
            min={1}
            max={50}
            value={config.map.station.radius}
            onChange={(e) => handleStationRadiusChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.station.radius.aria')}
            data-testid="input-station-radius"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.station.hitArea.label')}
          helpText={t('settings.map.station.hitArea.help')}
          isChanged={isFieldChanged(changedFields, 'map.station.hit_area')}
          data-testid="setting-station-hit-area"
        >
          <input
            type="number"
            step={0.5}
            min={config.map.station.radius}
            max={50}
            value={config.map.station.hit_area}
            onChange={(e) => handleStationHitAreaChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.station.hitArea.aria')}
            data-testid="input-station-hit-area"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.station.hoverRadius.label')}
          helpText={t('settings.map.station.hoverRadius.help')}
          isChanged={isFieldChanged(changedFields, 'map.station.hover_radius')}
          data-testid="setting-station-hover-radius"
        >
          <input
            type="number"
            step={0.5}
            min={1}
            max={50}
            value={config.map.station.hover_radius}
            onChange={(e) => handleStationHoverRadiusChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.station.hoverRadius.aria')}
            data-testid="input-station-hover-radius"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.station.selectionRadius.label')}
          helpText={t('settings.map.station.selectionRadius.help')}
          isChanged={isFieldChanged(changedFields, 'map.station.selection_radius')}
          data-testid="setting-station-selection-radius"
        >
          <input
            type="number"
            step={0.5}
            min={1}
            max={50}
            value={config.map.station.selection_radius}
            onChange={(e) => handleStationSelectionRadiusChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.station.selectionRadius.aria')}
            data-testid="input-station-selection-radius"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.map.sections.shot')} data-testid="section-shot">
        <SettingRow
          label={t('settings.map.shot.width.label')}
          helpText={t('settings.map.shot.width.help')}
          isChanged={isFieldChanged(changedFields, 'map.shot.width')}
          data-testid="setting-shot-width"
        >
          <input
            type="number"
            step={0.5}
            min={0.5}
            max={20}
            value={config.map.shot.width}
            onChange={(e) => handleShotWidthChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.shot.width.aria')}
            data-testid="input-shot-width"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.shot.hitArea.label')}
          helpText={t('settings.map.shot.hitArea.help')}
          isChanged={isFieldChanged(changedFields, 'map.shot.hit_area')}
          data-testid="setting-shot-hit-area"
        >
          <input
            type="number"
            step={0.5}
            min={config.map.shot.width}
            max={20}
            value={config.map.shot.hit_area}
            onChange={(e) => handleShotHitAreaChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.shot.hitArea.aria')}
            data-testid="input-shot-hit-area"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.shot.hoverWidth.label')}
          helpText={t('settings.map.shot.hoverWidth.help')}
          isChanged={isFieldChanged(changedFields, 'map.shot.hover_width')}
          data-testid="setting-shot-hover-width"
        >
          <input
            type="number"
            step={0.5}
            min={0.5}
            max={20}
            value={config.map.shot.hover_width}
            onChange={(e) => handleShotHoverWidthChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.shot.hoverWidth.aria')}
            data-testid="input-shot-hover-width"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.shot.selectionWidth.label')}
          helpText={t('settings.map.shot.selectionWidth.help')}
          isChanged={isFieldChanged(changedFields, 'map.shot.selection_width')}
          data-testid="setting-shot-selection-width"
        >
          <input
            type="number"
            step={0.5}
            min={0.5}
            max={20}
            value={config.map.shot.selection_width}
            onChange={(e) => handleShotSelectionWidthChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.shot.selectionWidth.aria')}
            data-testid="input-shot-selection-width"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.map.sections.snap')} data-testid="section-snap">
        <SettingRow
          label={t('settings.map.snap.threshold.label')}
          helpText={t('settings.map.snap.threshold.help')}
          isChanged={isFieldChanged(changedFields, 'map.snap.threshold')}
          data-testid="setting-snap-threshold"
        >
          <input
            type="number"
            step={1}
            min={1}
            max={50}
            value={config.map.snap.threshold}
            onChange={(e) => handleSnapThresholdChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.snap.threshold.aria')}
            data-testid="input-snap-threshold"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.snap.draw.label')}
          helpText={t('settings.map.snap.draw.help')}
          isChanged={isFieldChanged(changedFields, 'map.snap.enabled_draw')}
          data-testid="setting-snap-draw"
        >
          <Toggle
            checked={config.map.snap.enabled_draw}
            onChange={handleSnapDrawChange}
            aria-label={t('settings.map.snap.draw.aria')}
            data-testid="toggle-snap-draw"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.snap.merge.label')}
          helpText={t('settings.map.snap.merge.help')}
          isChanged={isFieldChanged(changedFields, 'map.snap.enabled_merge')}
          data-testid="setting-snap-merge"
        >
          <Toggle
            checked={config.map.snap.enabled_merge}
            onChange={handleSnapMergeChange}
            aria-label={t('settings.map.snap.merge.aria')}
            data-testid="toggle-snap-merge"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.snap.measure.label')}
          helpText={t('settings.map.snap.measure.help')}
          isChanged={isFieldChanged(changedFields, 'map.snap.enabled_measure')}
          data-testid="setting-snap-measure"
        >
          <Toggle
            checked={config.map.snap.enabled_measure}
            onChange={handleSnapMeasureChange}
            aria-label={t('settings.map.snap.measure.aria')}
            data-testid="toggle-snap-measure"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t('settings.map.sections.animation')} data-testid="section-animation">
        <SettingRow
          label={t('settings.map.animation.enabled.label')}
          helpText={t('settings.map.animation.enabled.help')}
          isChanged={isFieldChanged(changedFields, 'map.animation.enabled')}
          data-testid="setting-animation-enabled"
        >
          <Toggle
            checked={config.map.animation.enabled}
            onChange={handleAnimationEnabledChange}
            aria-label={t('settings.map.animation.enabled.aria')}
            data-testid="toggle-animation-enabled"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.animation.duration.label')}
          helpText={t('settings.map.animation.duration.help')}
          isChanged={isFieldChanged(changedFields, 'map.animation.duration')}
          data-testid="setting-animation-duration"
        >
          <input
            type="number"
            step={50}
            min={0}
            max={2000}
            value={config.map.animation.duration}
            onChange={(e) => handleAnimationDurationChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.animation.duration.aria')}
            data-testid="input-animation-duration"
          />
        </SettingRow>

        <SettingRow
          label={t('settings.map.animation.pointZoom.label')}
          helpText={t('settings.map.animation.pointZoom.help')}
          isChanged={isFieldChanged(changedFields, 'map.animation.point_zoom')}
          data-testid="setting-point-zoom"
        >
          <input
            type="number"
            min={config.map.zoom_min}
            max={config.map.zoom_max}
            value={config.map.animation.point_zoom}
            onChange={(e) => handlePointZoomChange(e.target.value)}
            className="w-20 px-2 py-1 bg-background border border-border rounded text-sm text-right"
            aria-label={t('settings.map.animation.pointZoom.aria')}
            data-testid="input-point-zoom"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
