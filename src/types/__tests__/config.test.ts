/**
 * Unit tests for config types and defaultConfig.
 * Tests that TypeScript config structure matches expected values.
 */

import { describe, it, expect } from 'vitest';
import {
  defaultConfig,
  type Config,
  type StationConfig,
  type ShotConfig,
  type MapSnapConfig,
  type DebugConfig,
  type MapDebugConfig,
  type AppearanceConfig,
  type ThemeMode,
} from '../config';

describe('defaultConfig structure', () => {
  describe('top-level structure', () => {
    it('has all required top-level keys', () => {
      expect(defaultConfig).toHaveProperty('general');
      expect(defaultConfig).toHaveProperty('units');
      expect(defaultConfig).toHaveProperty('display');
      expect(defaultConfig).toHaveProperty('section_colors');
      expect(defaultConfig).toHaveProperty('map');
      expect(defaultConfig).toHaveProperty('validation');
      expect(defaultConfig).toHaveProperty('export');
      expect(defaultConfig).toHaveProperty('logging');
      expect(defaultConfig).toHaveProperty('shortcuts');
      expect(defaultConfig).toHaveProperty('panels');
      expect(defaultConfig).toHaveProperty('cache');
      expect(defaultConfig).toHaveProperty('debug');
      expect(defaultConfig).toHaveProperty('appearance');
    });
  });

  describe('map.station defaults', () => {
    it('has correct station default values', () => {
      expect(defaultConfig.map.station.radius).toBe(4.0);
      expect(defaultConfig.map.station.hit_area).toBe(10.0);
    });

    it('station is a valid StationConfig', () => {
      const station: StationConfig = defaultConfig.map.station;
      expect(typeof station.radius).toBe('number');
      expect(typeof station.hit_area).toBe('number');
    });
  });

  describe('map.shot defaults', () => {
    it('has correct shot default values', () => {
      expect(defaultConfig.map.shot.width).toBe(2.0);
      expect(defaultConfig.map.shot.hit_area).toBe(8.0);
    });

    it('shot is a valid ShotConfig', () => {
      const shot: ShotConfig = defaultConfig.map.shot;
      expect(typeof shot.width).toBe('number');
      expect(typeof shot.hit_area).toBe('number');
    });
  });

  describe('map.snap defaults', () => {
    it('has correct snap default values', () => {
      expect(defaultConfig.map.snap.threshold).toBe(10.0);
      expect(defaultConfig.map.snap.enabled_draw).toBe(true);
      expect(defaultConfig.map.snap.enabled_merge).toBe(true);
      expect(defaultConfig.map.snap.enabled_measure).toBe(true);
    });

    it('snap is a valid MapSnapConfig', () => {
      const snap: MapSnapConfig = defaultConfig.map.snap;
      expect(typeof snap.threshold).toBe('number');
      expect(typeof snap.enabled_draw).toBe('boolean');
      expect(typeof snap.enabled_merge).toBe('boolean');
      expect(typeof snap.enabled_measure).toBe('boolean');
    });
  });

  describe('debug defaults', () => {
    it('has correct debug.map default values', () => {
      expect(defaultConfig.debug.map.show_hitboxes).toBe(false);
      expect(defaultConfig.debug.map.log_hit_detection).toBe(false);
    });

    it('debug is a valid DebugConfig', () => {
      const debug: DebugConfig = defaultConfig.debug;
      expect(debug).toHaveProperty('map');
    });

    it('debug.map is a valid MapDebugConfig', () => {
      const mapDebug: MapDebugConfig = defaultConfig.debug.map;
      expect(typeof mapDebug.show_hitboxes).toBe('boolean');
      expect(typeof mapDebug.log_hit_detection).toBe('boolean');
    });
  });

  describe('map structure', () => {
    it('has all map nested configs', () => {
      expect(defaultConfig.map).toHaveProperty('station');
      expect(defaultConfig.map).toHaveProperty('shot');
      expect(defaultConfig.map).toHaveProperty('snap');
      expect(defaultConfig.map).toHaveProperty('controls');
      expect(defaultConfig.map).toHaveProperty('satellite_gps_origin');
    });

    it('has correct zoom defaults', () => {
      expect(defaultConfig.map.zoom_default).toBe(15);
      expect(defaultConfig.map.zoom_min).toBe(0);
      expect(defaultConfig.map.zoom_max).toBe(22);
      expect(defaultConfig.map.zoom_step).toBe(1.0);
    });

    it('has correct satellite defaults', () => {
      expect(defaultConfig.map.satellite_provider).toBe('esri');
      expect(defaultConfig.map.satellite_enabled).toBe(false);
    });
  });

  describe('general config', () => {
    it('has correct general defaults', () => {
      expect(defaultConfig.general.auto_save).toBe(true);
      expect(defaultConfig.general.auto_save_interval_seconds).toBe(30);
      expect(defaultConfig.general.recent_projects_max).toBe(20);
      expect(defaultConfig.general.undo_history_limit).toBe(100);
      expect(defaultConfig.general.undo_persist_limit).toBe(20);
    });
  });

  describe('units config', () => {
    it('has correct units defaults', () => {
      expect(defaultConfig.units.length).toBe('meters');
      expect(defaultConfig.units.depth).toBe('meters');
      expect(defaultConfig.units.angle).toBe('degrees');
      expect(defaultConfig.units.decimal_precision).toBe(1);
    });
  });

  describe('validation config', () => {
    it('has correct validation defaults', () => {
      expect(defaultConfig.validation.warn_shot_length_min).toBe(0.1);
      expect(defaultConfig.validation.warn_shot_length_max).toBe(50.0);
      expect(defaultConfig.validation.warn_depth_change_per_shot_max).toBe(10.0);
      expect(defaultConfig.validation.warn_azimuth_deviation_max).toBe(30.0);
      expect(defaultConfig.validation.azimuth_diff_threshold).toBe(10.0);
      expect(defaultConfig.validation.pitch_diff_threshold).toBe(5.0);
    });
  });

  describe('panels config', () => {
    it('has correct panel defaults', () => {
      expect(defaultConfig.panels.sections_panel_width).toBe(250);
      expect(defaultConfig.panels.detail_panel_width).toBe(300);
      expect(defaultConfig.panels.data_table_height).toBe(200);
    });
  });

  describe('cache config', () => {
    it('has correct cache defaults', () => {
      expect(defaultConfig.cache.tile_cache_enabled).toBe(true);
      expect(defaultConfig.cache.tile_cache_max_mb).toBe(500);
      expect(defaultConfig.cache.tile_ttl_days).toBe(30);
    });
  });

  describe('appearance config', () => {
    it('has correct appearance defaults', () => {
      expect(defaultConfig.appearance.theme).toBe('dark');
    });

    it('appearance is a valid AppearanceConfig', () => {
      const appearance: AppearanceConfig = defaultConfig.appearance;
      expect(typeof appearance.theme).toBe('string');
    });

    it('theme is a valid ThemeMode', () => {
      const theme: ThemeMode = defaultConfig.appearance.theme;
      expect(['dark', 'light', 'auto']).toContain(theme);
    });
  });
});

describe('Config type safety', () => {
  it('defaultConfig satisfies Config type', () => {
    // This test verifies that defaultConfig is a valid Config at compile time
    const config: Config = defaultConfig;
    expect(config).toBeDefined();
  });

  it('allows creating custom config with modified values', () => {
    // Verify Config type allows overriding values
    const customConfig: Config = {
      ...defaultConfig,
      map: {
        ...defaultConfig.map,
        station: {
          radius: 8.0,
          hit_area: 16.0,
          hover_radius: 10.0,
          selection_radius: 9.0,
        },
        shot: {
          width: 4.0,
          hit_area: 12.0,
          hover_width: 6.0,
          selection_width: 5.0,
        },
      },
    };

    expect(customConfig.map.station.radius).toBe(8.0);
    expect(customConfig.map.station.hit_area).toBe(16.0);
    expect(customConfig.map.shot.width).toBe(4.0);
    expect(customConfig.map.shot.hit_area).toBe(12.0);
  });

  it('allows modifying debug config', () => {
    const customConfig: Config = {
      ...defaultConfig,
      debug: {
        map: {
          show_hitboxes: true,
          log_hit_detection: true,
        },
      },
    };

    expect(customConfig.debug.map.show_hitboxes).toBe(true);
    expect(customConfig.debug.map.log_hit_detection).toBe(true);
  });
});

describe('Config value consistency', () => {
  it('station hit_area >= station radius in defaults', () => {
    expect(defaultConfig.map.station.hit_area).toBeGreaterThanOrEqual(
      defaultConfig.map.station.radius
    );
  });

  it('shot hit_area >= shot width in defaults', () => {
    expect(defaultConfig.map.shot.hit_area).toBeGreaterThanOrEqual(
      defaultConfig.map.shot.width
    );
  });

  it('station values are within valid bounds (1-50)', () => {
    expect(defaultConfig.map.station.radius).toBeGreaterThanOrEqual(1);
    expect(defaultConfig.map.station.radius).toBeLessThanOrEqual(50);
    expect(defaultConfig.map.station.hit_area).toBeGreaterThanOrEqual(1);
    expect(defaultConfig.map.station.hit_area).toBeLessThanOrEqual(50);
  });

  it('shot values are within valid bounds (0.5-20)', () => {
    expect(defaultConfig.map.shot.width).toBeGreaterThanOrEqual(0.5);
    expect(defaultConfig.map.shot.width).toBeLessThanOrEqual(20);
    expect(defaultConfig.map.shot.hit_area).toBeGreaterThanOrEqual(0.5);
    expect(defaultConfig.map.shot.hit_area).toBeLessThanOrEqual(20);
  });

  it('snap threshold is within valid bounds (1-50)', () => {
    expect(defaultConfig.map.snap.threshold).toBeGreaterThanOrEqual(1);
    expect(defaultConfig.map.snap.threshold).toBeLessThanOrEqual(50);
  });
});
