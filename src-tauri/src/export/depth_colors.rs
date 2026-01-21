//! Depth color presets and interpolation for export visualization.
//!
//! Provides preset color gradients for depth-based visualization of cave survey data.
//! Colors are interpolated using HSL interpolation with shortest hue path for multi-stop support.

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
    // Compute colors once to avoid multiple allocations
    let colors = preset.colors();

    // CRITICAL: Check for NaN/infinite values
    if !depth.is_finite() || !min_depth.is_finite() || !max_depth.is_finite() {
        return colors
            .stops
            .first()
            .map_or("#000000".to_string(), |s| s.color.clone());
    }

    // Handle flat depth range (all stations at same depth)
    if (max_depth - min_depth).abs() < f64::EPSILON {
        return colors
            .stops
            .first()
            .map_or("#000000".to_string(), |s| s.color.clone());
    }

    // Normalize depth to 0.0-1.0 range and clamp
    let t = ((depth - min_depth) / (max_depth - min_depth)).clamp(0.0, 1.0);

    interpolate_stops(t, &colors.stops)
}

/// Interpolate between color stops at position t using HSL interpolation.
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
            // Clamp local_t to prevent float edge cases
            let local_t = local_t.clamp(0.0, 1.0);
            return interpolate_hsl(&stops[i].color, &stops[i + 1].color, local_t);
        }
    }

    // If we somehow didn't find a bracket (shouldn't happen with valid stops), return last color
    stops
        .last()
        .map_or("#000000".to_string(), |s| s.color.clone())
}

/// Parse a hex color string to RGB components.
/// Returns (0, 0, 0) for malformed input.
fn hex_to_rgb(hex: &str) -> (u8, u8, u8) {
    let hex = hex.trim_start_matches('#');
    // Validate length to prevent panics on malformed input
    if hex.len() < 6 {
        return (0, 0, 0);
    }
    let r = u8::from_str_radix(&hex[0..2], 16).unwrap_or(0);
    let g = u8::from_str_radix(&hex[2..4], 16).unwrap_or(0);
    let b = u8::from_str_radix(&hex[4..6], 16).unwrap_or(0);
    (r, g, b)
}

/// Convert RGB to HSL color space.
/// Returns (hue: 0-360, saturation: 0-1, lightness: 0-1)
fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let r = r as f64 / 255.0;
    let g = g as f64 / 255.0;
    let b = b as f64 / 255.0;

    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;

    if (max - min).abs() < f64::EPSILON {
        // Achromatic (gray)
        return (0.0, 0.0, l);
    }

    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };

    let h = if (max - r).abs() < f64::EPSILON {
        let mut h = (g - b) / d;
        if g < b {
            h += 6.0;
        }
        h / 6.0
    } else if (max - g).abs() < f64::EPSILON {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };

    (h * 360.0, s, l)
}

/// Convert HSL to RGB color space.
fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    if s.abs() < f64::EPSILON {
        // Achromatic (gray)
        let v = (l * 255.0).round() as u8;
        return (v, v, v);
    }

    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let h = h / 360.0;

    let r = hue_to_rgb(p, q, h + 1.0 / 3.0);
    let g = hue_to_rgb(p, q, h);
    let b = hue_to_rgb(p, q, h - 1.0 / 3.0);

    (
        (r * 255.0).round() as u8,
        (g * 255.0).round() as u8,
        (b * 255.0).round() as u8,
    )
}

/// Helper function for HSL to RGB conversion.
fn hue_to_rgb(p: f64, q: f64, t: f64) -> f64 {
    let t = if t < 0.0 {
        t + 1.0
    } else if t > 1.0 {
        t - 1.0
    } else {
        t
    };

    if t < 1.0 / 6.0 {
        p + (q - p) * 6.0 * t
    } else if t < 1.0 / 2.0 {
        q
    } else if t < 2.0 / 3.0 {
        p + (q - p) * (2.0 / 3.0 - t) * 6.0
    } else {
        p
    }
}

/// Interpolate between two hex colors using HSL interpolation with shortest hue path.
fn interpolate_hsl(color1: &str, color2: &str, t: f64) -> String {
    let (r1, g1, b1) = hex_to_rgb(color1);
    let (r2, g2, b2) = hex_to_rgb(color2);

    let (h1, s1, l1) = rgb_to_hsl(r1, g1, b1);
    let (h2, s2, l2) = rgb_to_hsl(r2, g2, b2);

    // Shortest hue path interpolation
    let mut dh = h2 - h1;
    if dh > 180.0 {
        dh -= 360.0;
    } else if dh < -180.0 {
        dh += 360.0;
    }

    let h = (h1 + dh * t).rem_euclid(360.0);
    let s = s1 + (s2 - s1) * t;
    let l = l1 + (l2 - l1) * t;

    let (r, g, b) = hsl_to_rgb(h, s, l);
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
    fn test_get_depth_color_midpoint_grayscale() {
        let color = get_depth_color(50.0, 0.0, 100.0, DepthPreset::Grayscale);
        // Grayscale: white (#ffffff) to black (#000000)
        // At 50%, should be gray (#808080 or close)
        let (r, g, b) = hex_to_rgb(&color);
        assert!(r >= 127 && r <= 129, "r={}", r); // Allow for rounding
        assert!(g >= 127 && g <= 129, "g={}", g);
        assert!(b >= 127 && b <= 129, "b={}", b);
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

    #[test]
    fn test_hex_to_rgb_malformed_short() {
        // Malformed input should return black, not panic
        assert_eq!(hex_to_rgb("#fff"), (0, 0, 0));
        assert_eq!(hex_to_rgb(""), (0, 0, 0));
        assert_eq!(hex_to_rgb("#"), (0, 0, 0));
    }

    // === HSL conversion tests ===

    #[test]
    fn test_rgb_to_hsl_red() {
        let (h, s, l) = rgb_to_hsl(255, 0, 0);
        assert!((h - 0.0).abs() < 1.0, "h={}", h);
        assert!((s - 1.0).abs() < 0.01, "s={}", s);
        assert!((l - 0.5).abs() < 0.01, "l={}", l);
    }

    #[test]
    fn test_rgb_to_hsl_green() {
        let (h, s, l) = rgb_to_hsl(0, 255, 0);
        assert!((h - 120.0).abs() < 1.0, "h={}", h);
        assert!((s - 1.0).abs() < 0.01, "s={}", s);
        assert!((l - 0.5).abs() < 0.01, "l={}", l);
    }

    #[test]
    fn test_rgb_to_hsl_blue() {
        let (h, s, l) = rgb_to_hsl(0, 0, 255);
        assert!((h - 240.0).abs() < 1.0, "h={}", h);
        assert!((s - 1.0).abs() < 0.01, "s={}", s);
        assert!((l - 0.5).abs() < 0.01, "l={}", l);
    }

    #[test]
    fn test_rgb_to_hsl_gray() {
        let (h, s, l) = rgb_to_hsl(128, 128, 128);
        assert_eq!(h, 0.0); // Achromatic
        assert_eq!(s, 0.0); // Achromatic
        assert!((l - 0.502).abs() < 0.01, "l={}", l);
    }

    #[test]
    fn test_hsl_to_rgb_red() {
        let (r, g, b) = hsl_to_rgb(0.0, 1.0, 0.5);
        assert_eq!(r, 255);
        assert_eq!(g, 0);
        assert_eq!(b, 0);
    }

    #[test]
    fn test_hsl_to_rgb_gray() {
        let (r, g, b) = hsl_to_rgb(0.0, 0.0, 0.5);
        assert!(r >= 127 && r <= 128, "r={}", r);
        assert!(g >= 127 && g <= 128, "g={}", g);
        assert!(b >= 127 && b <= 128, "b={}", b);
    }

    // === HSL interpolation tests ===

    #[test]
    fn test_interpolate_hsl_at_zero() {
        let color = interpolate_hsl("#ff0000", "#0000ff", 0.0);
        assert_eq!(color, "#ff0000");
    }

    #[test]
    fn test_interpolate_hsl_at_one() {
        let color = interpolate_hsl("#ff0000", "#0000ff", 1.0);
        assert_eq!(color, "#0000ff");
    }

    #[test]
    fn test_interpolate_hsl_shortest_path() {
        // Red to blue: shortest path goes through magenta, not through green/yellow/cyan
        let color = interpolate_hsl("#ff0000", "#0000ff", 0.5);
        let (r, g, b) = hex_to_rgb(&color);
        // At midpoint between red (0 deg) and blue (240 deg), shortest path goes through magenta
        // Midpoint hue should be around 300 deg (magenta area)
        assert!(r > 100, "r={} should be high (magenta)", r);
        assert!(g < 50, "g={} should be low (magenta)", g);
        assert!(b > 100, "b={} should be high (magenta)", b);
    }

    #[test]
    fn test_interpolate_hsl_grayscale_midpoint() {
        let color = interpolate_hsl("#000000", "#ffffff", 0.5);
        let (r, g, b) = hex_to_rgb(&color);
        // Should be gray
        assert!(r >= 127 && r <= 129, "r={}", r);
        assert!(g >= 127 && g <= 129, "g={}", g);
        assert!(b >= 127 && b <= 129, "b={}", b);
    }

    // === Tauri command test ===

    #[test]
    fn test_get_depth_preset_colors_command() {
        let colors = get_depth_preset_colors(DepthPreset::Thermal);
        assert_eq!(colors.stops.len(), 5);
        assert_eq!(colors.stops[0].position, 0.0);
        assert_eq!(colors.stops[4].position, 1.0);
    }

    // === Spec-required comprehensive tests ===

    #[test]
    fn test_all_presets_produce_valid_hex_colors() {
        let presets = [
            DepthPreset::Thermal,
            DepthPreset::Ocean,
            DepthPreset::Terrain,
            DepthPreset::Grayscale,
            DepthPreset::Accessible,
        ];

        for preset in presets {
            for depth in [0.0, 25.0, 50.0, 75.0, 100.0] {
                let color = get_depth_color(depth, 0.0, 100.0, preset);
                assert!(color.starts_with('#'), "Preset {:?} at depth {} should produce hex color starting with #", preset, depth);
                assert_eq!(color.len(), 7, "Preset {:?} at depth {} should produce #RRGGBB format, got {}", preset, depth, color);
                // Verify all characters after # are valid hex
                assert!(color[1..].chars().all(|c| c.is_ascii_hexdigit()),
                    "Preset {:?} at depth {} produced invalid hex: {}", preset, depth, color);
            }
        }
    }

    #[test]
    fn test_preset_first_last_stop_colors() {
        // Verify first and last stop colors for all presets match expected values
        let thermal = DepthPreset::Thermal.colors();
        assert_eq!(thermal.stops[0].color, "#00bfff"); // Shallow (cyan-blue)
        assert_eq!(thermal.stops.last().unwrap().color, "#ff4444"); // Deep (red)

        let ocean = DepthPreset::Ocean.colors();
        assert_eq!(ocean.stops[0].color, "#00ffff"); // Shallow (cyan)
        assert_eq!(ocean.stops.last().unwrap().color, "#0000aa"); // Deep (dark blue)

        let terrain = DepthPreset::Terrain.colors();
        assert_eq!(terrain.stops[0].color, "#00ff00"); // Shallow (green)
        assert_eq!(terrain.stops.last().unwrap().color, "#8b4513"); // Deep (brown)

        let grayscale = DepthPreset::Grayscale.colors();
        assert_eq!(grayscale.stops[0].color, "#ffffff"); // Shallow (white)
        assert_eq!(grayscale.stops.last().unwrap().color, "#000000"); // Deep (black)

        let accessible = DepthPreset::Accessible.colors();
        assert_eq!(accessible.stops[0].color, "#7c3aed"); // Shallow (purple)
        assert_eq!(accessible.stops.last().unwrap().color, "#fde047"); // Deep (yellow)
    }

    #[test]
    fn test_thermal_multi_stop_avoids_purple() {
        // Thermal uses multi-stop interpolation (5 stops) which avoids the purple
        // that would occur with shortest-hue-path direct interpolation from blue to red.
        // The stops are: cyan-blue -> cyan-green -> green -> yellow -> red
        // This test verifies the gradient passes through green/yellow, not purple.

        // At 12.5% (between stop 0 and 1), should be in cyan range
        let color_12 = get_depth_color(12.5, 0.0, 100.0, DepthPreset::Thermal);
        let (r12, g12, b12) = hex_to_rgb(&color_12);
        // Should be cyan-ish (high green and blue, low red)
        assert!(g12 > 200, "At 12.5%, green should be high (cyan area): g={}", g12);
        assert!(b12 > 100, "At 12.5%, blue should be present: b={}", b12);

        // At 37.5% (between stop 1 and 2), should be in green range
        let color_37 = get_depth_color(37.5, 0.0, 100.0, DepthPreset::Thermal);
        let (r37, g37, _b37) = hex_to_rgb(&color_37);
        // Should be greenish (high green)
        assert!(g37 > 200, "At 37.5%, green should be high: g={}", g37);
        assert!(r37 < 100, "At 37.5%, red should be low: r={}", r37);

        // At 62.5% (between stop 2 and 3), should be in yellow-green range
        let color_62 = get_depth_color(62.5, 0.0, 100.0, DepthPreset::Thermal);
        let (r62, g62, b62) = hex_to_rgb(&color_62);
        // Should be moving toward yellow (high green, increasing red, low blue)
        assert!(g62 > 200, "At 62.5%, green should still be high: g={}", g62);
        assert!(b62 < 50, "At 62.5%, blue should be low: b={}", b62);

        // At 87.5% (between stop 3 and 4), should be in orange-red range
        let color_87 = get_depth_color(87.5, 0.0, 100.0, DepthPreset::Thermal);
        let (r87, g87, b87) = hex_to_rgb(&color_87);
        // Should be orange/red-ish
        assert!(r87 > 200, "At 87.5%, red should be high: r={}", r87);
        assert!(b87 < 100, "At 87.5%, blue should be low (not purple): b={}", b87);

        // Critically: none of the intermediate colors should be purple (high red AND blue, low green)
        for depth in [12.5, 25.0, 37.5, 50.0, 62.5, 75.0, 87.5] {
            let color = get_depth_color(depth, 0.0, 100.0, DepthPreset::Thermal);
            let (r, g, b) = hex_to_rgb(&color);
            // Purple would be: r > 100 AND b > 100 AND g < 100
            let is_purple = r > 100 && b > 100 && g < 100;
            assert!(!is_purple, "At depth {}, color {} should NOT be purple (r={}, g={}, b={})",
                depth, color, r, g, b);
        }
    }

    #[test]
    fn test_thermal_min_max_clamp() {
        // Test clamping specifically for Thermal preset (as mentioned in spec)
        let shallow = get_depth_color(0.0, 0.0, 100.0, DepthPreset::Thermal);
        assert_eq!(shallow, "#00bfff", "Thermal at min depth should be first stop");

        let deep = get_depth_color(100.0, 0.0, 100.0, DepthPreset::Thermal);
        assert_eq!(deep, "#ff4444", "Thermal at max depth should be last stop");

        let below = get_depth_color(-10.0, 0.0, 100.0, DepthPreset::Thermal);
        assert_eq!(below, "#00bfff", "Thermal below min should clamp to first stop");

        let above = get_depth_color(150.0, 0.0, 100.0, DepthPreset::Thermal);
        assert_eq!(above, "#ff4444", "Thermal above max should clamp to last stop");
    }

    #[test]
    fn test_thermal_nan_returns_shallow() {
        let result = get_depth_color(f64::NAN, 0.0, 100.0, DepthPreset::Thermal);
        assert_eq!(result, "#00bfff", "Thermal with NaN depth should return first stop");
    }

    #[test]
    fn test_thermal_same_min_max_returns_shallow() {
        let result = get_depth_color(50.0, 50.0, 50.0, DepthPreset::Thermal);
        assert_eq!(result, "#00bfff", "Thermal with equal min/max should return first stop");
    }
}
