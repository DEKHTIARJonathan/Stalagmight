//! Depth color presets and interpolation for export visualization.
//!
//! Provides preset color gradients for depth-based visualization of cave survey data.
//! Colors are interpolated using RGB interpolation with multi-stop support.

use serde::{Deserialize, Serialize};

/// Depth color preset enum with default implementation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum DepthPreset {
    /// Blue to red gradient with multiple stops (5 stops)
    #[default]
    Thermal,
    /// Cyan to dark blue gradient (2 stops)
    Ocean,
    /// Green to brown gradient (2 stops)
    Terrain,
    /// White to black gradient (2 stops)
    Grayscale,
    /// Purple to yellow gradient - colorblind-friendly (2 stops)
    Accessible,
}

/// A single color stop in a gradient.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColorStop {
    /// Position in the gradient (0.0 to 1.0)
    pub position: f64,
    /// Hex color string (e.g., "#ff4444")
    pub color: String,
}

/// Preset colors as a list of color stops.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DepthPresetColors {
    /// Full list of color stops for the gradient
    pub stops: Vec<ColorStop>,
}

impl DepthPreset {
    /// Returns the color stops for this preset.
    pub fn colors(&self) -> DepthPresetColors {
        match self {
            Self::Thermal => DepthPresetColors {
                stops: vec![
                    ColorStop {
                        position: 0.0,
                        color: "#00bfff".into(),
                    },
                    ColorStop {
                        position: 0.25,
                        color: "#00ffaa".into(),
                    },
                    ColorStop {
                        position: 0.5,
                        color: "#44ff00".into(),
                    },
                    ColorStop {
                        position: 0.75,
                        color: "#ffff00".into(),
                    },
                    ColorStop {
                        position: 1.0,
                        color: "#ff4444".into(),
                    },
                ],
            },
            Self::Ocean => DepthPresetColors {
                stops: vec![
                    ColorStop {
                        position: 0.0,
                        color: "#00ffff".into(),
                    },
                    ColorStop {
                        position: 1.0,
                        color: "#0000aa".into(),
                    },
                ],
            },
            Self::Terrain => DepthPresetColors {
                stops: vec![
                    ColorStop {
                        position: 0.0,
                        color: "#00ff00".into(),
                    },
                    ColorStop {
                        position: 1.0,
                        color: "#8b4513".into(),
                    },
                ],
            },
            Self::Grayscale => DepthPresetColors {
                stops: vec![
                    ColorStop {
                        position: 0.0,
                        color: "#ffffff".into(),
                    },
                    ColorStop {
                        position: 1.0,
                        color: "#000000".into(),
                    },
                ],
            },
            Self::Accessible => DepthPresetColors {
                stops: vec![
                    ColorStop {
                        position: 0.0,
                        color: "#7c3aed".into(),
                    },
                    ColorStop {
                        position: 1.0,
                        color: "#fde047".into(),
                    },
                ],
            },
        }
    }
}

/// Get the interpolated color for a depth value.
///
/// # Arguments
/// * `depth` - The depth value to get color for
/// * `min_depth` - Minimum depth in the range
/// * `max_depth` - Maximum depth in the range
/// * `preset` - The color preset to use
///
/// # Returns
/// A hex color string (e.g., "#ff4444")
pub fn get_depth_color(depth: f64, min_depth: f64, max_depth: f64, preset: DepthPreset) -> String {
    // CRITICAL: Check for NaN/infinite values
    if !depth.is_finite() || !min_depth.is_finite() || !max_depth.is_finite() {
        return preset.colors().stops.first().map_or("#000000".to_string(), |s| s.color.clone());
    }

    // Handle flat depth range (all stations at same depth)
    if (max_depth - min_depth).abs() < f64::EPSILON {
        return preset.colors().stops.first().map_or("#000000".to_string(), |s| s.color.clone());
    }

    // Normalize depth to 0.0-1.0 range and clamp
    let t = ((depth - min_depth) / (max_depth - min_depth)).clamp(0.0, 1.0);

    interpolate_stops(t, &preset.colors().stops)
}

/// Interpolate between color stops at position t.
///
/// # Arguments
/// * `t` - Position in gradient (0.0 to 1.0)
/// * `stops` - Sorted list of color stops
///
/// # Returns
/// Interpolated hex color string
fn interpolate_stops(t: f64, stops: &[ColorStop]) -> String {
    // CRITICAL: Safety guards for edge cases
    if stops.is_empty() {
        return "#000000".to_string(); // Fallback black
    }
    if stops.len() == 1 {
        return stops[0].color.clone();
    }

    // Clamp t to valid range
    let t = t.clamp(0.0, 1.0);

    // Find the two stops that bracket t
    for i in 0..stops.len() - 1 {
        if t >= stops[i].position && t <= stops[i + 1].position {
            // Handle equal positions (avoid divide by zero)
            if (stops[i + 1].position - stops[i].position).abs() < f64::EPSILON {
                return stops[i].color.clone();
            }
            let local_t = (t - stops[i].position) / (stops[i + 1].position - stops[i].position);
            return interpolate_rgb(&stops[i].color, &stops[i + 1].color, local_t);
        }
    }

    // If we somehow didn't find a bracket (shouldn't happen with valid stops), return last color
    stops.last().map_or("#000000".to_string(), |s| s.color.clone())
}

/// Parse a hex color string to RGB components.
fn hex_to_rgb(hex: &str) -> (u8, u8, u8) {
    let hex = hex.trim_start_matches('#');
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
    (r, g, b)
}

/// Interpolate between two hex colors using RGB interpolation.
fn interpolate_rgb(color1: &str, color2: &str, t: f64) -> String {
    let (r1, g1, b1) = hex_to_rgb(color1);
    let (r2, g2, b2) = hex_to_rgb(color2);

    let r = (r1 as f64 + (r2 as f64 - r1 as f64) * t).round() as u8;
    let g = (g1 as f64 + (g2 as f64 - g1 as f64) * t).round() as u8;
    let b = (b1 as f64 + (b2 as f64 - b1 as f64) * t).round() as u8;

    format!("#{:02x}{:02x}{:02x}", r, g, b)
}

/// Get preset colors for a depth preset.
pub fn get_depth_preset_colors(preset: DepthPreset) -> DepthPresetColors {
    preset.colors()
}

#[cfg(test)]
mod tests {
    use super::*;

    // === DepthPreset tests ===

    #[test]
    fn test_depth_preset_default_is_thermal() {
        assert_eq!(DepthPreset::default(), DepthPreset::Thermal);
    }

    #[test]
    fn test_thermal_has_five_stops() {
        let colors = DepthPreset::Thermal.colors();
        assert_eq!(colors.stops.len(), 5);
    }

    #[test]
    fn test_ocean_has_two_stops() {
        let colors = DepthPreset::Ocean.colors();
        assert_eq!(colors.stops.len(), 2);
    }

    #[test]
    fn test_terrain_has_two_stops() {
        let colors = DepthPreset::Terrain.colors();
        assert_eq!(colors.stops.len(), 2);
    }

    #[test]
    fn test_grayscale_has_two_stops() {
        let colors = DepthPreset::Grayscale.colors();
        assert_eq!(colors.stops.len(), 2);
    }

    #[test]
    fn test_accessible_has_two_stops() {
        let colors = DepthPreset::Accessible.colors();
        assert_eq!(colors.stops.len(), 2);
    }

    #[test]
    fn test_preset_serde_lowercase() {
        let json = serde_json::to_string(&DepthPreset::Thermal).unwrap();
        assert_eq!(json, r#""thermal""#);

        let parsed: DepthPreset = serde_json::from_str(r#""ocean""#).unwrap();
        assert_eq!(parsed, DepthPreset::Ocean);
    }

    // === Color interpolation tests ===

    #[test]
    fn test_get_depth_color_at_min_depth() {
        let color = get_depth_color(0.0, 0.0, 100.0, DepthPreset::Ocean);
        assert_eq!(color, "#00ffff"); // First stop color
    }

    #[test]
    fn test_get_depth_color_at_max_depth() {
        let color = get_depth_color(100.0, 0.0, 100.0, DepthPreset::Ocean);
        assert_eq!(color, "#0000aa"); // Last stop color
    }

    #[test]
    fn test_get_depth_color_midpoint() {
        let color = get_depth_color(50.0, 0.0, 100.0, DepthPreset::Grayscale);
        // Grayscale: white (#ffffff) to black (#000000)
        // At 50%, should be gray (#808080 or close)
        let (r, g, b) = hex_to_rgb(&color);
        assert!(r >= 127 && r <= 129); // Allow for rounding
        assert!(g >= 127 && g <= 129);
        assert!(b >= 127 && b <= 129);
    }

    #[test]
    fn test_get_depth_color_thermal_multi_stop() {
        // Test that thermal uses multi-stop interpolation
        // At t=0.25, should be exactly the second stop color
        let color = get_depth_color(25.0, 0.0, 100.0, DepthPreset::Thermal);
        assert_eq!(color, "#00ffaa");

        // At t=0.5, should be exactly the third stop color
        let color = get_depth_color(50.0, 0.0, 100.0, DepthPreset::Thermal);
        assert_eq!(color, "#44ff00");
    }

    // === Edge case tests ===

    #[test]
    fn test_get_depth_color_nan_returns_first_stop() {
        let color = get_depth_color(f64::NAN, 0.0, 100.0, DepthPreset::Ocean);
        assert_eq!(color, "#00ffff"); // First stop
    }

    #[test]
    fn test_get_depth_color_infinite_returns_first_stop() {
        let color = get_depth_color(f64::INFINITY, 0.0, 100.0, DepthPreset::Ocean);
        assert_eq!(color, "#00ffff"); // First stop
    }

    #[test]
    fn test_get_depth_color_min_nan_returns_first_stop() {
        let color = get_depth_color(50.0, f64::NAN, 100.0, DepthPreset::Ocean);
        assert_eq!(color, "#00ffff"); // First stop
    }

    #[test]
    fn test_get_depth_color_max_nan_returns_first_stop() {
        let color = get_depth_color(50.0, 0.0, f64::NAN, DepthPreset::Ocean);
        assert_eq!(color, "#00ffff"); // First stop
    }

    #[test]
    fn test_get_depth_color_equal_min_max_returns_first_stop() {
        let color = get_depth_color(50.0, 50.0, 50.0, DepthPreset::Ocean);
        assert_eq!(color, "#00ffff"); // First stop (flat depth range)
    }

    #[test]
    fn test_get_depth_color_depth_below_min_clamps() {
        let color = get_depth_color(-10.0, 0.0, 100.0, DepthPreset::Ocean);
        assert_eq!(color, "#00ffff"); // Clamped to first stop
    }

    #[test]
    fn test_get_depth_color_depth_above_max_clamps() {
        let color = get_depth_color(150.0, 0.0, 100.0, DepthPreset::Ocean);
        assert_eq!(color, "#0000aa"); // Clamped to last stop
    }

    // === interpolate_stops tests ===

    #[test]
    fn test_interpolate_stops_empty_returns_black() {
        let color = interpolate_stops(0.5, &[]);
        assert_eq!(color, "#000000");
    }

    #[test]
    fn test_interpolate_stops_single_element_returns_that_color() {
        let stops = vec![ColorStop {
            position: 0.5,
            color: "#ff0000".into(),
        }];
        let color = interpolate_stops(0.5, &stops);
        assert_eq!(color, "#ff0000");
    }

    #[test]
    fn test_interpolate_stops_equal_positions_returns_first() {
        let stops = vec![
            ColorStop {
                position: 0.5,
                color: "#ff0000".into(),
            },
            ColorStop {
                position: 0.5,
                color: "#00ff00".into(),
            },
        ];
        let color = interpolate_stops(0.5, &stops);
        assert_eq!(color, "#ff0000");
    }

    // === hex_to_rgb tests ===

    #[test]
    fn test_hex_to_rgb_with_hash() {
        assert_eq!(hex_to_rgb("#ff0000"), (255, 0, 0));
        assert_eq!(hex_to_rgb("#00ff00"), (0, 255, 0));
        assert_eq!(hex_to_rgb("#0000ff"), (0, 0, 255));
    }

    #[test]
    fn test_hex_to_rgb_without_hash() {
        assert_eq!(hex_to_rgb("ff0000"), (255, 0, 0));
    }

    #[test]
    fn test_hex_to_rgb_mixed_case() {
        assert_eq!(hex_to_rgb("#FF00ff"), (255, 0, 255));
    }

    // === interpolate_rgb tests ===

    #[test]
    fn test_interpolate_rgb_at_zero() {
        let color = interpolate_rgb("#ff0000", "#0000ff", 0.0);
        assert_eq!(color, "#ff0000");
    }

    #[test]
    fn test_interpolate_rgb_at_one() {
        let color = interpolate_rgb("#ff0000", "#0000ff", 1.0);
        assert_eq!(color, "#0000ff");
    }

    #[test]
    fn test_interpolate_rgb_at_midpoint() {
        let color = interpolate_rgb("#000000", "#ffffff", 0.5);
        // Should be close to #808080
        let (r, g, b) = hex_to_rgb(&color);
        assert!(r >= 127 && r <= 129);
        assert!(g >= 127 && g <= 129);
        assert!(b >= 127 && b <= 129);
    }

    // === Tauri command test ===

    #[test]
    fn test_get_depth_preset_colors_command() {
        let colors = get_depth_preset_colors(DepthPreset::Thermal);
        assert_eq!(colors.stops.len(), 5);
        assert_eq!(colors.stops[0].position, 0.0);
        assert_eq!(colors.stops[4].position, 1.0);
    }
}
