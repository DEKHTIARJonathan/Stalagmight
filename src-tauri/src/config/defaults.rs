use super::types::{default_sigma_azimuth_deg, default_sigma_depth_m, default_sigma_length_m};
use super::{
    AngleUnit, AppearanceConfig, CacheConfig, ClosureAdjustmentConfig, Config, DebugConfig,
    DecimalPrecision, DepthGradientConfig, DisplayConfig, ExportConfig, GasConfig, GeneralConfig,
    GlobalViewConfig, GpsOrigin, ImportConfig, LengthUnit, LoggingConfig, MapAnimationConfig,
    MapConfig, MapControlsConfig, MapSnapConfig, PanelsConfig, PlacementSuggestionConfig,
    ProviderCacheConfig, SectionColorsConfig, ShortcutFeedback, ShortcutsConfig, ShotConfig,
    SpeleoDbConfig, StationConfig, SyntacticHighlightingConfig, UnitsConfig, ValidationConfig,
};

#[expect(clippy::derivable_impls)]
impl Default for Config {
    fn default() -> Self {
        Self {
            general: GeneralConfig::default(),
            units: UnitsConfig::default(),
            display: DisplayConfig::default(),
            section_colors: SectionColorsConfig::default(),
            map: MapConfig::default(),
            validation: ValidationConfig::default(),
            closure_adjustment: ClosureAdjustmentConfig::default(),
            export: ExportConfig::default(),
            logging: LoggingConfig::default(),
            shortcuts: ShortcutsConfig::default(),
            panels: PanelsConfig::default(),
            cache: CacheConfig::default(),
            debug: DebugConfig::default(),
            global_view: GlobalViewConfig::default(),
            appearance: AppearanceConfig::default(),
            import: ImportConfig::default(),
            placement_suggestion: PlacementSuggestionConfig::default(),
            syntactic_highlighting: SyntacticHighlightingConfig::default(),
            gas: GasConfig::default(),
            speleodb: SpeleoDbConfig::default(),
            legacy_snap: None,
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
            shortcut_feedback: ShortcutFeedback::default(),
            locale: "system".to_string(),
            number_format: "locale".to_string(),
            date_format: "locale".to_string(),
            splash_screen: false,
            onboarding_enabled: true,
            onboarding_completed_flows: Vec::new(),
            telemetry_enabled: false,
            telemetry_opt_in_shown: false,
        }
    }
}

impl Default for DecimalPrecision {
    fn default() -> Self {
        Self {
            length: 1,
            coordinates: 2,
            depth: 1,
            azimuth: 1,
            inclination: 1,
            gps: 6,
        }
    }
}

impl Default for UnitsConfig {
    fn default() -> Self {
        Self {
            length: LengthUnit::Meters,
            depth: LengthUnit::Meters,
            angle: AngleUnit::Degrees,
            decimal_precision: DecimalPrecision::default(),
        }
    }
}

impl Default for DisplayConfig {
    fn default() -> Self {
        Self {
            default_background: "#1a1a2e".to_string(),
            grid_color: "#333366".to_string(),
            grid_spacing: 10.0,
            font_size: 12,
            font_color: "#f5f5f5".to_string(),
            depth_gradient: DepthGradientConfig::default(),
            measure_path_color: "#22d3ee".to_string(),
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
            satellite_provider: "esri".to_string(),
            satellite_enabled: false,
            satellite_gps_origin: GpsOrigin {
                latitude: 24.55,
                longitude: -81.78,
            },
            zoom_default: 15,
            zoom_min: 0,
            zoom_max: 22,
            zoom_step: 1.0,
            controls: MapControlsConfig::default(),
            station: StationConfig::default(),
            shot: ShotConfig::default(),
            snap: MapSnapConfig::default(),
            animation: MapAnimationConfig::default(),
            highlight_warnings_on_tab_switch: true,
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
            // Flag suspiciously short shots (under 0.3 m by default; configurable
            // via the `[validation]` config). Surfaces as the SHORT_SHOT warning.
            warn_shot_length_min: 0.3,
            warn_shot_length_max: 50.0,
            warn_depth_change_per_shot_max: 10.0,
            warn_azimuth_deviation_max: 30.0,
            azimuth_diff_threshold: 20.0,
            pitch_diff_threshold: 10.0,
            inclination_depth_diff_threshold: 15.0,
        }
    }
}

impl Default for ClosureAdjustmentConfig {
    fn default() -> Self {
        Self {
            base_sigma_length_m: default_sigma_length_m(),
            base_sigma_azimuth_deg: default_sigma_azimuth_deg(),
            base_sigma_depth_m: default_sigma_depth_m(),
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
            // Tools
            select: vec!["S".to_string()],
            pan: vec!["P".to_string()],
            zoom: vec!["Z".to_string()],
            merge: vec!["M".to_string()],
            measure: vec!["R".to_string()],
            move_station: vec!["T".to_string()],
            move_segment: vec!["V".to_string()],
            move_shot: vec!["G".to_string()],
            comment_tool: vec!["C".to_string()],
            move_comment_tool: vec!["Shift+C".to_string()],

            // Edit
            undo: vec!["Ctrl+Z".to_string()],
            redo: vec!["Ctrl+Y".to_string(), "Ctrl+Shift+Z".to_string()],

            // View
            toggle_depth_gradient: vec!["Shift+D".to_string()],
            toggle_grid: vec!["Shift+G".to_string()],
            toggle_satellite: vec!["B".to_string()],
            toggle_station_labels: vec!["L".to_string()],
            toggle_shot_labels: vec!["Shift+L".to_string()],
            toggle_section_labels: vec!["Ctrl+L".to_string()],
            fit_to_bounds: vec!["F".to_string()],
            zoom_in: vec!["Equal".to_string(), "Plus".to_string()],
            zoom_out: vec!["Minus".to_string()],

            // Panels
            toggle_sections_panel: vec!["Ctrl+1".to_string()],
            toggle_detail_panel: vec!["Ctrl+2".to_string()],
            toggle_data_table: vec!["Ctrl+3".to_string()],

            // File
            save: vec!["Ctrl+S".to_string()],
            new_file: vec!["Ctrl+N".to_string()],
            open_file: vec!["Ctrl+O".to_string()],
            save_as: vec!["Ctrl+Shift+S".to_string()],
            import_dmp: vec!["Ctrl+I".to_string()],
            export: vec!["Ctrl+E".to_string()],
            quit: vec!["Ctrl+Q".to_string()],
        }
    }
}

impl Default for PanelsConfig {
    fn default() -> Self {
        Self {
            sections_panel_width: 250,
            detail_panel_width: 300,
            data_table_height: 200,
            data_table_shot_column_order: Vec::new(),
            data_table_shot_hidden_columns: vec!["section_id".to_string(), "shot_id".to_string()],
            data_table_azimuth_mode: "avg".to_string(),
            data_table_inclination_mode: "off".to_string(),
            data_table_station_column_order: Vec::new(),
            data_table_station_hidden_columns: vec![
                "_x".to_string(),
                "_y".to_string(),
                "_lat".to_string(),
                "_long".to_string(),
            ],
            sections_panel_open: true,
            sections_panel_mode: "pin".to_string(),
            detail_panel_open: true,
            detail_panel_mode: "pin".to_string(),
            data_table_open: false,
            data_table_mode: "pin".to_string(),
        }
    }
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            tile_cache_enabled: true,
            tile_cache_max_mb: 500, // per SPEC.md
            tile_ttl_days: 30,
            providers: std::collections::HashMap::from([(
                "esri".to_string(),
                ProviderCacheConfig {
                    offline_caching: false,
                },
            )]),
        }
    }
}
