use super::*;

impl Default for Config {
    fn default() -> Self {
        Self {
            general: GeneralConfig::default(),
            units: UnitsConfig::default(),
            display: DisplayConfig::default(),
            section_colors: SectionColorsConfig::default(),
            map: MapConfig::default(),
            validation: ValidationConfig::default(),
            export: ExportConfig::default(),
            logging: LoggingConfig::default(),
            shortcuts: ShortcutsConfig::default(),
            snap: SnapConfig::default(),
            panels: PanelsConfig::default(),
            cache: CacheConfig::default(),
        }
    }
}

impl Default for GeneralConfig {
    fn default() -> Self {
        Self {
            auto_save: true,
            auto_save_interval_seconds: 30,
            recent_projects_max: 20,
            recent_projects: Vec::new(),
            undo_history_limit: 100,
            undo_persist_limit: 20,
        }
    }
}

impl Default for UnitsConfig {
    fn default() -> Self {
        Self {
            length: LengthUnit::Meters,
            depth: LengthUnit::Meters,
            angle: AngleUnit::Degrees,
            decimal_precision: 1,
        }
    }
}

impl Default for DisplayConfig {
    fn default() -> Self {
        Self {
            default_background: "#1a1a2e".to_string(),
            grid_color: "#333366".to_string(),
            grid_spacing: 10.0,
            station_size: 6,
            line_thickness: 2,
            font_size: 12,
            font_color: "#f5f5f5".to_string(),
            depth_gradient: DepthGradientConfig::default(),
        }
    }
}

impl Default for DepthGradientConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            shallow_color: "#00bfff".to_string(),
            deep_color: "#ff4444".to_string(),
            shallow_depth: 0.0,
            deep_depth: 50.0,
        }
    }
}

impl Default for SectionColorsConfig {
    fn default() -> Self {
        Self {
            palette: vec![
                "#4ecdc4".to_string(), // Teal
                "#ff6b6b".to_string(), // Coral
                "#95e1d3".to_string(), // Mint
                "#f38181".to_string(), // Salmon
                "#aa96da".to_string(), // Lavender
                "#fcbad3".to_string(), // Pink
                "#a8d8ea".to_string(), // Sky Blue
                "#ffcb77".to_string(), // Peach
            ],
        }
    }
}

impl Default for MapConfig {
    fn default() -> Self {
        Self {
            satellite_provider: "openstreetmap".to_string(),
            satellite_enabled: false,
            satellite_gps_origin: GpsOrigin {
                latitude: 24.55,
                longitude: -81.78,
            },
            snap_threshold_pixels: 10,
            zoom_default: 15,
            zoom_min: 1,
            zoom_max: 22,
            zoom_step: 1.0,
            controls: MapControlsConfig::default(),
        }
    }
}

impl Default for MapControlsConfig {
    fn default() -> Self {
        Self {
            pan_speed: 1.0,
            zoom_speed: 1.0,
            invert_scroll: false,
        }
    }
}

impl Default for ValidationConfig {
    fn default() -> Self {
        Self {
            warn_shot_length_min: 0.1,
            warn_shot_length_max: 50.0,
            warn_depth_change_per_shot_max: 10.0,
            warn_azimuth_deviation_max: 30.0,
            azimuth_diff_threshold: 10.0,
            pitch_diff_threshold: 5.0,
        }
    }
}

impl Default for ExportConfig {
    fn default() -> Self {
        Self {
            default_image_format: "png".to_string(),
            default_dpi: 300,
            default_include_satellite: true,
            default_include_grid: false,
            default_include_labels: true,
        }
    }
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: "info".to_string(),
            max_directory_size_mb: 128,
        }
    }
}

impl Default for ShortcutsConfig {
    fn default() -> Self {
        Self {
            select: "S".to_string(),
            pan: "P".to_string(),
            zoom: "Z".to_string(),
            draw: "D".to_string(),
            delete: "X".to_string(),
            merge: "M".to_string(),
            measure: "R".to_string(),
            move_section: "V".to_string(),
            move_station: "T".to_string(),
            undo: "Ctrl+Z".to_string(),
            redo: "Ctrl+Y".to_string(),
            save: "Ctrl+S".to_string(),
        }
    }
}

impl Default for SnapConfig {
    fn default() -> Self {
        Self {
            enabled_draw: true,
            enabled_merge: true,
            enabled_measure: true,
            threshold_pixels: 10,
        }
    }
}

impl Default for PanelsConfig {
    fn default() -> Self {
        Self {
            sections_panel_width: 250,
            detail_panel_width: 300,
            data_table_height: 200,
        }
    }
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            tile_cache_enabled: true,
            tile_cache_max_mb: 500, // per SPEC.md
            tile_ttl_days: 30,
        }
    }
}
