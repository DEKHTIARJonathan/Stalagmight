use std::fs;
use std::path::{Path, PathBuf};

use ts_rs::TS;

use stalagmight_lib::commands::cache::{CacheStats, ProviderStats};
use stalagmight_lib::commands::history::{FieldChange, PreviewData, UndoHistoryItem};
use stalagmight_lib::commands::survey_geometry::{GeometryShot, SurveyGeometry, SurveyGeometryError};
use stalagmight_lib::config::{
    AngleUnit, AppearanceConfig, CacheConfig, ClosureAdjustmentConfig, Config, DebugConfig,
    DepthGradientConfig, DisplayConfig, ExportConfig, GeneralConfig, GlobalViewConfig, GpsOrigin,
    LengthUnit, LoggingConfig, MapAnimationConfig, MapConfig, MapControlsConfig, MapDebugConfig,
    MapSnapConfig, PanelsConfig, SectionColorsConfig, ShortcutFeedback, ShortcutsConfig,
    ShotConfig, StationConfig, ThemeMode, UnitsConfig, ValidationConfig,
};
use stalagmight_lib::core::command::{CommandResult, ValidationWarning, WarningSeverity};
use stalagmight_lib::core::loading::{
    CreateProjectFullResult, DisplaySettings, LoadProjectFullResult, LoadingPhase, LoadingProgress,
};
use stalagmight_lib::export::{
    ColorMode, ColorStop, DepthPreset, DepthPresetColors, ExportImageOptions, ImageFormat,
};
use stalagmight_lib::models::{
    ClosurePair, ClosurePreview, ClosureRef, ClosureStrategy, ClosureUpdate, ConnectivityResult,
    Coordinates, DeleteShotImpact, GpsBounds, GpsCoordinates, ImportPlacement, ImportSectionConfig,
    LoopClosure, Project, ProjectMetadata, ProjectStats, ProjectWarning, Section, SectionData,
    SectionRelationships, SectionStats, SectionUpdates, Shot, ShotData, ShotUpdates, Station,
    StationMerge, StationPair, StationRef, SurveyDirection, ZeroDatum,
};
use stalagmight_lib::parsers::dmp::{DmpDirection, DmpFile, DmpSection, DmpShot, DmpShotType};
use stalagmight_lib::tile_providers::TileProviderInfo;

fn export<T: TS + 'static>(out_dir: &Path) {
    T::export_to(out_dir).expect("Failed to export TS type");
}

fn main() {
    let out_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../src/types/ipc");
    fs::create_dir_all(&out_dir).expect("Failed to create ipc types directory");

    // Core command/result types
    export::<CommandResult>(&out_dir);
    export::<ValidationWarning>(&out_dir);
    export::<WarningSeverity>(&out_dir);

    // Loading/progress types
    export::<DisplaySettings>(&out_dir);
    export::<LoadingPhase>(&out_dir);
    export::<LoadingProgress>(&out_dir);
    export::<LoadProjectFullResult>(&out_dir);
    export::<CreateProjectFullResult>(&out_dir);

    // Project/model types
    export::<Project>(&out_dir);
    export::<ProjectMetadata>(&out_dir);
    export::<ProjectStats>(&out_dir);
    export::<Section>(&out_dir);
    export::<SectionData>(&out_dir);
    export::<SectionUpdates>(&out_dir);
    export::<SectionStats>(&out_dir);
    export::<SurveyDirection>(&out_dir);
    export::<ImportSectionConfig>(&out_dir);
    export::<ImportPlacement>(&out_dir);
    export::<Shot>(&out_dir);
    export::<ShotData>(&out_dir);
    export::<ShotUpdates>(&out_dir);
    export::<Station>(&out_dir);
    export::<StationRef>(&out_dir);
    export::<StationMerge>(&out_dir);
    export::<ZeroDatum>(&out_dir);
    export::<LoopClosure>(&out_dir);
    export::<ClosureRef>(&out_dir);
    export::<ClosureStrategy>(&out_dir);
    export::<Coordinates>(&out_dir);
    export::<GpsCoordinates>(&out_dir);
    export::<GpsBounds>(&out_dir);
    export::<SectionRelationships>(&out_dir);
    export::<StationPair>(&out_dir);
    export::<ClosurePair>(&out_dir);
    export::<ClosureUpdate>(&out_dir);
    export::<DeleteShotImpact>(&out_dir);
    export::<ConnectivityResult>(&out_dir);
    export::<ClosurePreview>(&out_dir);
    export::<ProjectWarning>(&out_dir);

    // Undo history
    export::<UndoHistoryItem>(&out_dir);
    export::<PreviewData>(&out_dir);
    export::<FieldChange>(&out_dir);

    // DMP import
    export::<DmpFile>(&out_dir);
    export::<DmpSection>(&out_dir);
    export::<DmpShot>(&out_dir);
    export::<DmpDirection>(&out_dir);
    export::<DmpShotType>(&out_dir);

    // Export/image types
    export::<ExportImageOptions>(&out_dir);
    export::<ImageFormat>(&out_dir);
    export::<ColorMode>(&out_dir);
    export::<DepthPreset>(&out_dir);
    export::<DepthPresetColors>(&out_dir);
    export::<ColorStop>(&out_dir);

    // Cache + tiles
    export::<ProviderStats>(&out_dir);
    export::<CacheStats>(&out_dir);
    export::<TileProviderInfo>(&out_dir);

    // Survey geometry
    export::<GeometryShot>(&out_dir);
    export::<SurveyGeometry>(&out_dir);
    export::<SurveyGeometryError>(&out_dir);

    // Config types
    export::<Config>(&out_dir);
    export::<GeneralConfig>(&out_dir);
    export::<UnitsConfig>(&out_dir);
    export::<DisplayConfig>(&out_dir);
    export::<DepthGradientConfig>(&out_dir);
    export::<SectionColorsConfig>(&out_dir);
    export::<GpsOrigin>(&out_dir);
    export::<StationConfig>(&out_dir);
    export::<ShotConfig>(&out_dir);
    export::<MapSnapConfig>(&out_dir);
    export::<MapAnimationConfig>(&out_dir);
    export::<DebugConfig>(&out_dir);
    export::<MapDebugConfig>(&out_dir);
    export::<MapConfig>(&out_dir);
    export::<MapControlsConfig>(&out_dir);
    export::<ValidationConfig>(&out_dir);
    export::<ClosureAdjustmentConfig>(&out_dir);
    export::<ExportConfig>(&out_dir);
    export::<LoggingConfig>(&out_dir);
    export::<ShortcutsConfig>(&out_dir);
    export::<PanelsConfig>(&out_dir);
    export::<CacheConfig>(&out_dir);
    export::<GlobalViewConfig>(&out_dir);
    export::<AppearanceConfig>(&out_dir);
    export::<LengthUnit>(&out_dir);
    export::<AngleUnit>(&out_dir);
    export::<ShortcutFeedback>(&out_dir);
    export::<ThemeMode>(&out_dir);

    let export_list = [
        "CommandResult",
        "ValidationWarning",
        "WarningSeverity",
        "DisplaySettings",
        "LoadingPhase",
        "LoadingProgress",
        "LoadProjectFullResult",
        "CreateProjectFullResult",
        "Project",
        "ProjectMetadata",
        "ProjectStats",
        "Section",
        "SectionData",
        "SectionUpdates",
        "SectionStats",
        "SurveyDirection",
        "ImportSectionConfig",
        "ImportPlacement",
        "Shot",
        "ShotData",
        "ShotUpdates",
        "Station",
        "StationRef",
        "StationMerge",
        "ZeroDatum",
        "LoopClosure",
        "ClosureRef",
        "ClosureStrategy",
        "Coordinates",
        "GpsCoordinates",
        "GpsBounds",
        "SectionRelationships",
        "StationPair",
        "ClosurePair",
        "ClosureUpdate",
        "DeleteShotImpact",
        "ConnectivityResult",
        "ClosurePreview",
        "ProjectWarning",
        "UndoHistoryItem",
        "PreviewData",
        "FieldChange",
        "DmpFile",
        "DmpSection",
        "DmpShot",
        "DmpDirection",
        "DmpShotType",
        "ExportImageOptions",
        "ImageFormat",
        "ColorMode",
        "DepthPreset",
        "DepthPresetColors",
        "ColorStop",
        "ProviderStats",
        "CacheStats",
        "TileProviderInfo",
        "GeometryShot",
        "SurveyGeometry",
        "SurveyGeometryError",
        "Config",
        "GeneralConfig",
        "UnitsConfig",
        "DisplayConfig",
        "DepthGradientConfig",
        "SectionColorsConfig",
        "GpsOrigin",
        "StationConfig",
        "ShotConfig",
        "MapSnapConfig",
        "MapAnimationConfig",
        "DebugConfig",
        "MapDebugConfig",
        "MapConfig",
        "MapControlsConfig",
        "ValidationConfig",
        "ClosureAdjustmentConfig",
        "ExportConfig",
        "LoggingConfig",
        "ShortcutsConfig",
        "PanelsConfig",
        "CacheConfig",
        "GlobalViewConfig",
        "AppearanceConfig",
        "LengthUnit",
        "AngleUnit",
        "ShortcutFeedback",
        "ThemeMode",
    ];

    let mut generated = String::from(
        "// This file is generated by `pnpm gen:ipc-types`. Do not edit by hand.\n",
    );
    for name in export_list {
        generated.push_str(&format!("export * from './ipc/{}';\n", name));
    }

    let generated_path = out_dir
        .parent()
        .expect("ipc types directory should have a parent")
        .join("ipc.generated.ts");
    fs::write(generated_path, generated).expect("Failed to write ipc.generated.ts");
}
