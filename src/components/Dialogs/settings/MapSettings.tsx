import { useEffect, useRef } from 'react';
import { Toggle } from '../../common/Toggle';
import { Select } from '../../common/Select';
import { SettingsSection } from './SettingsSection';
import { SettingRow } from './SettingRow';
import { getPanelId, getTabId } from '../SettingsSidebar';
import type { SettingsCategoryProps } from './types';
import { isFieldChanged } from './types';

const SATELLITE_PROVIDER_OPTIONS = [
  { value: 'openstreetmap', label: 'OpenStreetMap' },
  { value: 'mapbox', label: 'Mapbox' },
  { value: 'google', label: 'Google Maps' },
];

/**
 * Map settings category content.
 * Maps to config.map: satellite_provider, satellite_enabled, satellite_gps_origin,
 * zoom settings, station, shot, snap, animation configs.
 */
export function MapSettings({
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

    // Validate zoom settings
    if (config.map.zoom_min >= config.map.zoom_max) {
      errors.push('Minimum zoom must be less than maximum zoom');
    }
    if (
      config.map.zoom_default < config.map.zoom_min ||
      config.map.zoom_default > config.map.zoom_max
    ) {
      errors.push('Default zoom must be between min and max zoom');
    }
    if (config.map.zoom_step < 0.1 || config.map.zoom_step > 5.0) {
      errors.push('Zoom step must be between 0.1 and 5.0');
    }

    // Validate GPS origin
    if (config.map.satellite_gps_origin.latitude < -90 || config.map.satellite_gps_origin.latitude > 90) {
      errors.push('Latitude must be between -90 and 90');
    }
    if (config.map.satellite_gps_origin.longitude < -180 || config.map.satellite_gps_origin.longitude > 180) {
      errors.push('Longitude must be between -180 and 180');
    }

    // Validate station settings
    if (config.map.station.radius < 1 || config.map.station.radius > 50) {
      errors.push('Station radius must be between 1 and 50');
    }
    if (config.map.station.hit_area < config.map.station.radius) {
      errors.push('Station hit area must be at least as large as radius');
    }

    // Validate shot settings
    if (config.map.shot.width < 0.5 || config.map.shot.width > 20) {
      errors.push('Shot width must be between 0.5 and 20');
    }
    if (config.map.shot.hit_area < config.map.shot.width) {
      errors.push('Shot hit area must be at least as large as width');
    }

    // Validate snap threshold
    if (config.map.snap.threshold < 1 || config.map.snap.threshold > 50) {
      errors.push('Snap threshold must be between 1 and 50');
    }

    // Validate animation duration
    if (config.map.animation.duration < 0 || config.map.animation.duration > 2000) {
      errors.push('Animation duration must be between 0 and 2000 ms');
    }

    const hasError = errors.length > 0;
    if (hasError !== hasErrorRef.current) {
      hasErrorRef.current = hasError;
      onValidationError('map', hasError);
    }
  }, [config.map, onValidationError]);

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
      <h2 className="text-lg font-medium mb-4">Map</h2>

      <SettingsSection title="Satellite" data-testid="section-satellite">
        <SettingRow
          label="Tile provider"
          helpText="Source for satellite imagery tiles"
          isChanged={isFieldChanged(changedFields, 'map.satellite_provider')}
          data-testid="setting-satellite-provider"
        >
          <Select
            value={config.map.satellite_provider}
            onChange={handleProviderChange}
            options={SATELLITE_PROVIDER_OPTIONS}
            className="w-40"
            aria-label="Satellite tile provider"
            data-testid="select-satellite-provider"
          />
        </SettingRow>

        <SettingRow
          label="Enable satellite"
          helpText="Show satellite imagery by default"
          isChanged={isFieldChanged(changedFields, 'map.satellite_enabled')}
          data-testid="setting-satellite-enabled"
        >
          <Toggle
            checked={config.map.satellite_enabled}
            onChange={handleSatelliteEnabledChange}
            aria-label="Enable satellite imagery"
            data-testid="toggle-satellite-enabled"
          />
        </SettingRow>

        <SettingRow
          label="GPS origin latitude"
          helpText="Default latitude for satellite alignment (-90 to 90)"
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
            aria-label="GPS origin latitude"
            data-testid="input-gps-latitude"
          />
        </SettingRow>

        <SettingRow
          label="GPS origin longitude"
          helpText="Default longitude for satellite alignment (-180 to 180)"
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
            aria-label="GPS origin longitude"
            data-testid="input-gps-longitude"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Zoom" data-testid="section-zoom">
        <SettingRow
          label="Default zoom"
          helpText="Initial zoom level when opening a project"
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
            aria-label="Default zoom level"
            data-testid="input-zoom-default"
          />
        </SettingRow>

        <SettingRow
          label="Minimum zoom"
          helpText="Lowest allowed zoom level (most zoomed out)"
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
            aria-label="Minimum zoom level"
            data-testid="input-zoom-min"
          />
        </SettingRow>

        <SettingRow
          label="Maximum zoom"
          helpText="Highest allowed zoom level (most zoomed in)"
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
            aria-label="Maximum zoom level"
            data-testid="input-zoom-max"
          />
        </SettingRow>

        <SettingRow
          label="Zoom step"
          helpText="Zoom increment for click-to-zoom (0.1-5.0)"
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
            aria-label="Zoom step"
            data-testid="input-zoom-step"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Controls" data-testid="section-controls">
        <SettingRow
          label="Pan speed"
          helpText="Multiplier for panning speed (0.1-5.0)"
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
            aria-label="Pan speed multiplier"
            data-testid="input-pan-speed"
          />
        </SettingRow>

        <SettingRow
          label="Zoom speed"
          helpText="Multiplier for scroll zoom speed (0.1-5.0)"
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
            aria-label="Zoom speed multiplier"
            data-testid="input-zoom-speed"
          />
        </SettingRow>

        <SettingRow
          label="Invert scroll"
          helpText="Reverse scroll wheel zoom direction"
          isChanged={isFieldChanged(changedFields, 'map.controls.invert_scroll')}
          data-testid="setting-invert-scroll"
        >
          <Toggle
            checked={config.map.controls.invert_scroll}
            onChange={handleInvertScrollChange}
            aria-label="Invert scroll direction"
            data-testid="toggle-invert-scroll"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Station Appearance" data-testid="section-station">
        <SettingRow
          label="Station radius"
          helpText="Visual size of station markers (1-50 pixels)"
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
            aria-label="Station radius"
            data-testid="input-station-radius"
          />
        </SettingRow>

        <SettingRow
          label="Station hit area"
          helpText="Clickable area size (must be >= radius)"
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
            aria-label="Station hit area"
            data-testid="input-station-hit-area"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Shot Appearance" data-testid="section-shot">
        <SettingRow
          label="Shot width"
          helpText="Visual thickness of shot lines (0.5-20 pixels)"
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
            aria-label="Shot line width"
            data-testid="input-shot-width"
          />
        </SettingRow>

        <SettingRow
          label="Shot hit area"
          helpText="Clickable area width (must be >= width)"
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
            aria-label="Shot hit area"
            data-testid="input-shot-hit-area"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Snap-to-Station" data-testid="section-snap">
        <SettingRow
          label="Snap threshold"
          helpText="Distance in pixels to snap to stations (1-50)"
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
            aria-label="Snap threshold"
            data-testid="input-snap-threshold"
          />
        </SettingRow>

        <SettingRow
          label="Snap in Draw tool"
          helpText="Enable snap-to-station when drawing"
          isChanged={isFieldChanged(changedFields, 'map.snap.enabled_draw')}
          data-testid="setting-snap-draw"
        >
          <Toggle
            checked={config.map.snap.enabled_draw}
            onChange={handleSnapDrawChange}
            aria-label="Enable snap in Draw tool"
            data-testid="toggle-snap-draw"
          />
        </SettingRow>

        <SettingRow
          label="Snap in Merge tool"
          helpText="Enable snap-to-station when merging"
          isChanged={isFieldChanged(changedFields, 'map.snap.enabled_merge')}
          data-testid="setting-snap-merge"
        >
          <Toggle
            checked={config.map.snap.enabled_merge}
            onChange={handleSnapMergeChange}
            aria-label="Enable snap in Merge tool"
            data-testid="toggle-snap-merge"
          />
        </SettingRow>

        <SettingRow
          label="Snap in Measure tool"
          helpText="Enable snap-to-station when measuring"
          isChanged={isFieldChanged(changedFields, 'map.snap.enabled_measure')}
          data-testid="setting-snap-measure"
        >
          <Toggle
            checked={config.map.snap.enabled_measure}
            onChange={handleSnapMeasureChange}
            aria-label="Enable snap in Measure tool"
            data-testid="toggle-snap-measure"
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title="Animation" data-testid="section-animation">
        <SettingRow
          label="Enable animations"
          helpText="Animate map focus transitions"
          isChanged={isFieldChanged(changedFields, 'map.animation.enabled')}
          data-testid="setting-animation-enabled"
        >
          <Toggle
            checked={config.map.animation.enabled}
            onChange={handleAnimationEnabledChange}
            aria-label="Enable map animations"
            data-testid="toggle-animation-enabled"
          />
        </SettingRow>

        <SettingRow
          label="Animation duration"
          helpText="Duration of focus animations (0-2000 ms)"
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
            aria-label="Animation duration"
            data-testid="input-animation-duration"
          />
        </SettingRow>

        <SettingRow
          label="Point focus zoom"
          helpText="Zoom level when focusing on a single point"
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
            aria-label="Point focus zoom level"
            data-testid="input-point-zoom"
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}
