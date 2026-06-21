pub mod csv;
pub mod depth_colors;
pub mod image;
pub mod json;
pub mod tml;

pub use csv::*;
pub use depth_colors::{
    get_depth_color, get_depth_preset_colors, ColorStop, DepthPreset, DepthPresetColors,
};
pub use image::*;
pub use json::*;
pub use tml::*;

use serde::{Deserialize, Serialize};

/// Common export options
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportOptions {
    /// Include section names
    pub include_section_names: bool,
    /// Include station labels
    pub include_station_labels: bool,
    /// Include shot data (azimuth, length, depth)
    pub include_shot_data: bool,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            include_section_names: true,
            include_station_labels: true,
            include_shot_data: false,
        }
    }
}
