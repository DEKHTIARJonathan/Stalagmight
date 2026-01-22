use anyhow::{Context, Result};
use resvg::tiny_skia;
use serde::{Deserialize, Serialize};
use std::path::Path;
use usvg::{Options, Tree};

use super::depth_colors::{get_depth_color, DepthPreset};
use crate::models::Project;

/// Meters to feet conversion factor.
const METERS_TO_FEET: f64 = 3.28084;

/// Color mode for export visualization.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ColorMode {
    /// Use section colors (default behavior)
    #[default]
    Section,
    /// Use depth gradient colors
    Depth,
}

/// Default depth unit (meters).
fn default_depth_unit() -> String {
    "m".to_string()
}

/// Default decimal precision for depth labels.
fn default_precision() -> u8 {
    1
}

/// Default value for include_legend (true).
fn default_true() -> bool {
    true
}

/// Options for image export
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportImageOptions {
    /// Image format (png, svg, pdf)
    pub format: ImageFormat,
    /// DPI for raster formats
    pub dpi: u32,
    /// Include satellite imagery background
    pub include_satellite: bool,
    /// Include grid overlay
    pub include_grid: bool,
    /// Include station labels
    pub include_labels: bool,
    /// Include section names
    pub include_section_names: bool,
    /// Include shot data (azimuth, length, depth)
    pub include_shot_data: bool,
    /// Color mode for visualization
    #[serde(default)]
    pub color_mode: ColorMode,
    /// Depth color preset (only used when color_mode is Depth)
    #[serde(default)]
    pub depth_preset: DepthPreset,
    /// Include depth legend (only used when color_mode is Depth)
    #[serde(default = "default_true")]
    pub include_legend: bool,
    /// Depth unit from frontend config ("m" or "ft")
    #[serde(default = "default_depth_unit")]
    pub depth_unit: String,
    /// Decimal precision for depth labels
    #[serde(default = "default_precision")]
    pub decimal_precision: u8,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Png,
    Svg,
    Pdf,
}

impl Default for ExportImageOptions {
    fn default() -> Self {
        Self {
            format: ImageFormat::Png,
            dpi: 300,
            include_satellite: true,
            include_grid: false,
            include_labels: true,
            include_section_names: true,
            include_shot_data: false,
            color_mode: ColorMode::Section,
            depth_preset: DepthPreset::Thermal,
            include_legend: true,
            depth_unit: default_depth_unit(),
            decimal_precision: default_precision(),
        }
    }
}

/// Export project as an image
///
/// This is a simplified implementation. Full image export would require
/// rendering the map view, which is done in the frontend. This function
/// generates a basic SVG representation.
///
/// Progress is tracked externally via ProgressEmitter in the command layer
/// using the shared loading-progress event infrastructure.
pub fn export_image(project: &Project, path: &Path, options: &ExportImageOptions) -> Result<()> {
    match options.format {
        ImageFormat::Svg => export_svg(project, path, options),
        ImageFormat::Png => export_png(project, path, options),
        ImageFormat::Pdf => export_pdf(project, path, options),
    }
}

/// Export project as PDF using svg2pdf
fn export_pdf(project: &Project, path: &Path, options: &ExportImageOptions) -> Result<()> {
    // Generate SVG content
    let svg_content = generate_svg_string(project, options)?;

    // Parse SVG using usvg with fonts loaded for text rendering
    let mut opt = Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = Tree::from_str(&svg_content, &opt)
        .context("Failed to parse SVG")?;

    // Convert to PDF
    let pdf = svg2pdf::to_pdf(
        &tree,
        svg2pdf::ConversionOptions::default(),
        svg2pdf::PageOptions::default(),
    ).map_err(|e| anyhow::anyhow!("Failed to convert SVG to PDF: {:?}", e))?;

    // Write file
    std::fs::write(path, pdf).context("Failed to write PDF file")?;

    tracing::info!(path = ?path, "Exported PDF");
    Ok(())
}

/// Maximum dimension for PNG export to prevent out-of-memory errors.
const MAX_PNG_DIMENSION: u32 = 16384;

/// Export project as PNG using resvg rasterization
fn export_png(project: &Project, path: &Path, options: &ExportImageOptions) -> Result<()> {
    // Validate DPI before processing
    if options.dpi == 0 {
        anyhow::bail!("DPI must be at least 1");
    }

    // Generate SVG content
    let svg_content = generate_svg_string(project, options)?;

    // Parse SVG using usvg with fonts loaded for text rendering
    let mut opt = Options::default();
    opt.fontdb_mut().load_system_fonts();
    let tree = Tree::from_str(&svg_content, &opt).context("Failed to parse SVG for PNG conversion")?;

    // Calculate size with DPI scaling, using ceil to avoid clipping edges
    let size = tree.size();
    let scale = options.dpi as f32 / 72.0;
    let width = ((size.width() * scale).ceil() as u32).max(1);
    let height = ((size.height() * scale).ceil() as u32).max(1);

    // Validate size to prevent OOM
    if width > MAX_PNG_DIMENSION || height > MAX_PNG_DIMENSION {
        anyhow::bail!(
            "Export size {}x{} exceeds maximum {}px. Reduce DPI or use SVG/PDF format.",
            width,
            height,
            MAX_PNG_DIMENSION
        );
    }

    // Create pixmap using resvg's re-exported tiny_skia
    let mut pixmap = tiny_skia::Pixmap::new(width, height)
        .ok_or_else(|| anyhow::anyhow!("Failed to create pixmap for {}x{} image", width, height))?;

    // Render SVG to pixmap with scaling transform
    // Note: resvg 0.43's render() returns () and always succeeds if the tree was parsed.
    // Rendering failures (e.g., out-of-bounds) silently produce empty regions.
    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    // Write file
    pixmap.save_png(path).context("Failed to save PNG file")?;

    tracing::info!(path = ?path, dpi = options.dpi, width = width, height = height, "Exported PNG");
    Ok(())
}

/// Export project as SVG
fn export_svg(project: &Project, path: &Path, options: &ExportImageOptions) -> Result<()> {
    // Generate SVG content
    let svg = generate_svg_string(project, options)?;

    // Write file
    std::fs::write(path, svg).context("Failed to write SVG file")?;

    tracing::info!(path = ?path, "Exported SVG");
    Ok(())
}

/// Generate SVG content as string
fn generate_svg_string(project: &Project, options: &ExportImageOptions) -> Result<String> {
    let stations = project.compute_station_coordinates();

    // Calculate bounds
    let mut min_x = f64::MAX;
    let mut max_x = f64::MIN;
    let mut min_y = f64::MAX;
    let mut max_y = f64::MIN;

    for station in &stations {
        min_x = min_x.min(station.coordinates.x);
        max_x = max_x.max(station.coordinates.x);
        min_y = min_y.min(station.coordinates.y);
        max_y = max_y.max(station.coordinates.y);
    }

    // Handle empty project (MUST be before depth range calculation)
    if min_x == f64::MAX {
        min_x = 0.0;
        max_x = 100.0;
        min_y = 0.0;
        max_y = 100.0;
    }

    // Calculate depth range for gradient (only needed for Depth mode)
    // Done after empty check to avoid infinity values
    let (min_depth, max_depth) = if options.color_mode == ColorMode::Depth && !stations.is_empty() {
        // Single-pass min/max without allocation
        let mut min = f64::INFINITY;
        let mut max = f64::NEG_INFINITY;
        for station in &stations {
            let z = station.coordinates.z;
            if z < min {
                min = z;
            }
            if z > max {
                max = z;
            }
        }
        (min, max)
    } else {
        (0.0, 0.0) // Empty project or section mode - treat as flat
    };

    // Add padding
    let padding = 20.0;
    let width = (max_x - min_x) + padding * 2.0;
    let height = (max_y - min_y) + padding * 2.0;

    // Scale to target size (allows both scale-up and scale-down)
    const TARGET_SIZE: f64 = 800.0;
    let scale = TARGET_SIZE / width.max(height);
    // Ensure minimum dimension of 1.0 to produce valid SVG
    let svg_width = (width * scale).max(1.0);
    let svg_height = (height * scale).max(1.0);

    // Pixel-to-world conversion: divide desired pixel size by scale
    // This ensures elements appear at consistent pixel sizes regardless of survey extent
    let px = |pixels: f64| -> f64 { pixels / scale };

    let mut svg = String::new();
    // CSS: station and zero-datum classes only define stroke (fill is inline)
    // All stroke-widths and font-sizes are scaled to achieve consistent pixel sizes
    svg.push_str(&format!(
        r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{svg_width:.2}" height="{svg_height:.2}" viewBox="{vb_x:.1} {vb_y:.1} {vb_w:.1} {vb_h:.1}">
<style>
  .shot {{ stroke-width: {shot_sw}; fill: none; }}
  .station {{ stroke: #000000; stroke-width: {station_sw}; }}
  .zero-datum {{ stroke: #000000; stroke-width: {station_sw}; }}
  .label {{ font-family: sans-serif; font-size: {label_fs}; fill: #333333; }}
  .section-name {{ font-family: sans-serif; font-size: {section_fs}; font-weight: bold; fill: #333333; }}
</style>
<rect x="{vb_x:.1}" y="{vb_y:.1}" width="{vb_w:.1}" height="{vb_h:.1}" fill="#1a1a2e"/>
"##,
        svg_width = svg_width,
        svg_height = svg_height,
        vb_x = min_x - padding,
        vb_y = -(max_y + padding), // Flip Y
        vb_w = width,
        vb_h = height,
        shot_sw = px(2.0),        // 2px shot stroke-width
        station_sw = px(1.0),     // 1px station stroke-width
        label_fs = px(10.0),      // 10px label font-size
        section_fs = px(12.0),    // 12px section-name font-size
    ));

    // Draw grid if enabled
    if options.include_grid {
        svg.push_str(&format!(
            r##"<g class="grid" stroke="#333366" stroke-width="{}">
"##,
            px(0.5) // 0.5px grid stroke-width
        ));
        let grid_step = 10.0; // 10 meter grid
        let grid_min_x = (min_x / grid_step).floor() * grid_step;
        let grid_max_x = (max_x / grid_step).ceil() * grid_step;
        let grid_min_y = (min_y / grid_step).floor() * grid_step;
        let grid_max_y = (max_y / grid_step).ceil() * grid_step;

        let mut x = grid_min_x;
        while x <= grid_max_x {
            svg.push_str(&format!(
                r#"<line x1="{:.1}" y1="{:.1}" x2="{:.1}" y2="{:.1}"/>"#,
                x,
                -grid_min_y,
                x,
                -grid_max_y
            ));
            x += grid_step;
        }

        let mut y = grid_min_y;
        while y <= grid_max_y {
            svg.push_str(&format!(
                r#"<line x1="{:.1}" y1="{:.1}" x2="{:.1}" y2="{:.1}"/>"#,
                grid_min_x, -y, grid_max_x, -y
            ));
            y += grid_step;
        }
        svg.push_str("</g>\n");
    }

    // Draw shots
    for section in &project.sections {
        svg.push_str(&format!(
            r#"<g class="section" id="section-{}">
"#,
            section.id
        ));

        // Find stations for this section
        let section_stations: Vec<_> = stations
            .iter()
            .filter(|s| s.station_ref.section_id == section.id)
            .collect();

        // Draw lines between consecutive stations
        for i in 0..section_stations.len().saturating_sub(1) {
            let from = &section_stations[i];
            let to = &section_stations[i + 1];

            let shot = section.shots.get(i);
            let is_virtual = shot.map(|s| s.is_virtual).unwrap_or(false);

            // Virtual shots: 4px dash, 2px gap (scaled to viewBox units)
            let stroke_style = if is_virtual {
                format!(
                    "stroke-dasharray=\"{},{}\" opacity=\"0.5\"",
                    px(4.0),
                    px(2.0)
                )
            } else {
                String::new()
            };

            // Shot stroke color: section color or depth-based (average of endpoints)
            // Sanitize user-controlled colors to prevent SVG injection
            let stroke_color = match options.color_mode {
                ColorMode::Section => sanitize_color(&section.color).to_string(),
                ColorMode::Depth => {
                    let avg_depth = (from.coordinates.z + to.coordinates.z) / 2.0;
                    get_depth_color(avg_depth, min_depth, max_depth, options.depth_preset)
                }
            };

            svg.push_str(&format!(
                r#"<line class="shot" x1="{:.2}" y1="{:.2}" x2="{:.2}" y2="{:.2}" stroke="{}" {}/>
"#,
                from.coordinates.x,
                -from.coordinates.y, // Flip Y
                to.coordinates.x,
                -to.coordinates.y,
                stroke_color,
                stroke_style
            ));

            // Add shot depth label if enabled
            if options.include_shot_data {
                let avg_depth = (from.coordinates.z + to.coordinates.z) / 2.0;
                let depth_label =
                    format_depth_label(avg_depth, &options.depth_unit, options.decimal_precision);
                // Position label at midpoint of shot
                let mid_x = (from.coordinates.x + to.coordinates.x) / 2.0;
                let mid_y = -(from.coordinates.y + to.coordinates.y) / 2.0;
                svg.push_str(&format!(
                    r##"<text class="shot-label" x="{mid_x:.2}" y="{mid_y:.2}" dx="{dx}" dy="{dy}" font-size="{fs}" fill="#aaa">{label}</text>
"##,
                    mid_x = mid_x,
                    mid_y = mid_y,
                    dx = px(2.0),   // 2px offset
                    dy = px(-2.0),  // -2px offset (negative for upward)
                    fs = px(8.0),   // 8px font-size
                    label = depth_label
                ));
            }
        }

        svg.push_str("</g>\n");
    }

    // Draw stations with inline fill color
    svg.push_str("<g class=\"stations\">\n");
    for station in &stations {
        let class = if station.is_zero_datum {
            "zero-datum"
        } else {
            "station"
        };
        // 3px radius for regular stations, 6px for zero-datum (scaled to viewBox units)
        let radius = if station.is_zero_datum { px(6.0) } else { px(3.0) };

        // Fill color: gold for zero-datum, otherwise section or depth color
        // Sanitize user-controlled colors to prevent SVG injection
        let fill_color = if station.is_zero_datum {
            "#ffd700".to_string() // Gold for zero datum, always
        } else {
            match options.color_mode {
                ColorMode::Section => {
                    // Find the section color for this station
                    project
                        .sections
                        .iter()
                        .find(|s| s.id == station.station_ref.section_id)
                        .map(|s| sanitize_color(&s.color).to_string())
                        .unwrap_or_else(|| DEFAULT_COLOR.to_string())
                }
                ColorMode::Depth => {
                    get_depth_color(
                        station.coordinates.z,
                        min_depth,
                        max_depth,
                        options.depth_preset,
                    )
                }
            }
        };

        // All stations use inline style="fill:..." for consistency
        svg.push_str(&format!(
            r#"<circle class="{}" cx="{:.2}" cy="{:.2}" r="{}" style="fill:{}"/>
"#,
            class,
            station.coordinates.x,
            -station.coordinates.y,
            radius,
            fill_color
        ));
    }
    svg.push_str("</g>\n");

    // Draw labels if enabled
    if options.include_labels {
        svg.push_str("<g class=\"labels\">\n");
        for station in &stations {
            if station.is_zero_datum {
                svg.push_str(&format!(
                    r#"<text class="label" x="{x:.2}" y="{y:.2}" dx="{dx}" dy="{dy}">ZD</text>
"#,
                    x = station.coordinates.x,
                    y = -station.coordinates.y,
                    dx = px(8.0),  // 8px offset
                    dy = px(4.0),  // 4px offset
                ));
            }
        }
        svg.push_str("</g>\n");
    }

    // Draw section names if enabled
    if options.include_section_names {
        svg.push_str("<g class=\"section-names\">\n");
        for section in &project.sections {
            if let Some(name) = &section.name {
                // Find midpoint of section
                let section_stations: Vec<_> = stations
                    .iter()
                    .filter(|s| s.station_ref.section_id == section.id)
                    .collect();

                if !section_stations.is_empty() {
                    let mid = section_stations.len() / 2;
                    if let Some(station) = section_stations.get(mid) {
                        svg.push_str(&format!(
                            r#"<text class="section-name" x="{x:.2}" y="{y:.2}" dx="{dx}" dy="{dy}">{name}</text>
"#,
                            x = station.coordinates.x,
                            y = -station.coordinates.y,
                            dx = px(5.0),   // 5px offset
                            dy = px(-5.0),  // -5px offset (upward)
                            name = escape_xml(name)
                        ));
                    }
                }
            }
        }
        svg.push_str("</g>\n");
    }

    // Draw depth legend if enabled and in depth mode
    if options.include_legend && options.color_mode == ColorMode::Depth {
        // Use viewBox bounds (with padding) for correct legend positioning
        let viewbox_bounds = Bounds {
            min_x: min_x - padding,
            max_x: max_x + padding,
            min_y: min_y - padding,
            max_y: max_y + padding,
        };
        let legend = generate_depth_legend(
            min_depth,
            max_depth,
            options.depth_preset,
            &options.depth_unit,
            options.decimal_precision,
            &viewbox_bounds,
            scale, // Pass scale factor for pixel-stable sizing
        );
        svg.push_str(&legend);
    }

    svg.push_str("</svg>\n");

    Ok(svg)
}

/// Escape special XML characters
fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// Default fallback color when user-provided color is invalid.
const DEFAULT_COLOR: &str = "#808080";

/// Validate and sanitize a color string for safe SVG injection.
///
/// Accepts only valid hex colors (#RGB, #RRGGBB, #RRGGBBAA).
/// Returns the color unchanged if valid, or DEFAULT_COLOR if invalid.
fn sanitize_color(color: &str) -> &str {
    // Must start with #
    if !color.starts_with('#') {
        return DEFAULT_COLOR;
    }

    let hex_part = &color[1..];

    // Must be 3, 6, or 8 hex characters
    let valid_length = hex_part.len() == 3 || hex_part.len() == 6 || hex_part.len() == 8;
    if !valid_length {
        return DEFAULT_COLOR;
    }

    // Must contain only hex digits
    if !hex_part.chars().all(|c| c.is_ascii_hexdigit()) {
        return DEFAULT_COLOR;
    }

    color
}

/// Bounds of the survey data in world coordinates.
struct Bounds {
    #[allow(dead_code)]
    min_x: f64,
    max_x: f64,
    #[allow(dead_code)]
    min_y: f64,
    max_y: f64,
}

/// Maximum allowed decimal precision to prevent DoS via huge strings.
const MAX_DECIMAL_PRECISION: u8 = 6;

/// Format a depth label with unit conversion and XML escaping.
///
/// Converts meters to feet when unit is "ft". Applies decimal precision formatting.
/// The result is XML-escaped to prevent markup injection in SVG output.
///
/// # Arguments
/// * `depth_meters` - Depth value in meters
/// * `unit` - Unit string ("m" or "ft")
/// * `precision` - Decimal places for formatting (clamped to 0-6)
fn format_depth_label(depth_meters: f64, unit: &str, precision: u8) -> String {
    let value = if unit == "ft" {
        depth_meters * METERS_TO_FEET
    } else {
        depth_meters
    };
    // Clamp precision to prevent DoS via huge strings
    let clamped_precision = precision.min(MAX_DECIMAL_PRECISION) as usize;
    // XML-escape the unit to prevent markup injection
    let safe_unit = escape_xml(unit);
    format!("{:.prec$}{}", value, safe_unit, prec = clamped_precision)
}

/// Number of gradient samples for legend to match backend HSL interpolation exactly.
const LEGEND_GRADIENT_SAMPLES: usize = 64;

/// Generate depth legend SVG element with pixel-stable sizing.
///
/// Legend is positioned in the top-right corner with dimensions in pixel units (scaled to viewBox).
/// Gradient is generated by sampling the backend's HSL interpolation to ensure exact color match.
///
/// # Arguments
/// * `min_depth` - Minimum depth in meters
/// * `max_depth` - Maximum depth in meters
/// * `preset` - Depth color preset
/// * `depth_unit` - Unit string for labels ("m" or "ft")
/// * `precision` - Decimal precision for labels
/// * `bounds` - Project bounds for relative positioning
/// * `scale` - Scale factor (pixels per world unit) for pixel-to-viewBox conversion
fn generate_depth_legend(
    min_depth: f64,
    max_depth: f64,
    preset: DepthPreset,
    depth_unit: &str,
    precision: u8,
    bounds: &Bounds,
    scale: f64,
) -> String {
    // Pixel-to-world conversion helper
    let px = |pixels: f64| -> f64 { pixels / scale };

    // Legend dimensions in pixels (then scaled to viewBox units)
    let legend_width = px(16.0);   // 16px bar width
    let legend_height = px(100.0); // 100px bar height
    let font_size = px(10.0);      // 10px font size
    let stroke_width = px(0.5);    // 0.5px stroke

    // Position: top-right corner with padding (in pixels, scaled to viewBox)
    let padding = px(10.0); // 10px padding from edge
    let x = bounds.max_x - legend_width - padding;
    let y = -(bounds.max_y - padding); // Note: Y is flipped in SVG

    // Generate gradient by sampling backend's HSL interpolation to ensure exact color match
    // This avoids visual divergence from SVG's sRGB interpolation
    let gradient_stops: String = (0..=LEGEND_GRADIENT_SAMPLES)
        .map(|i| {
            let t = i as f64 / LEGEND_GRADIENT_SAMPLES as f64;
            let depth = min_depth + t * (max_depth - min_depth);
            let color = get_depth_color(depth, min_depth, max_depth, preset);
            format!(
                r#"<stop offset="{:.2}%" stop-color="{}"/>"#,
                t * 100.0,
                color
            )
        })
        .collect::<Vec<_>>()
        .join("\n    ");

    let is_flat = (max_depth - min_depth).abs() < 0.1;
    let flat_suffix = if is_flat { " (Flat)" } else { "" };

    // Use format_depth_label for unit conversion
    let min_label = format_depth_label(min_depth, depth_unit, precision);
    let max_label = format_depth_label(max_depth, depth_unit, precision);

    // Use unique gradient ID with preset name to avoid collisions
    let gradient_id = format!("depth-gradient-{:?}", preset).to_lowercase();

    // Text offsets (in viewBox units, derived from pixel values)
    let text_y_offset = px(3.0); // 3px above the bar for min label
    let max_text_y = legend_height + font_size + px(2.0); // Below bar + padding

    format!(
        r##"
<defs>
  <linearGradient id="{gradient_id}" x1="0%" y1="0%" x2="0%" y2="100%">
    {gradient_stops}
  </linearGradient>
</defs>
<g class="depth-legend" transform="translate({x:.2}, {y:.2})">
  <rect width="{legend_width:.2}" height="{legend_height:.2}" fill="url(#{gradient_id})" stroke="#333" stroke-width="{stroke_width}"/>
  <text x="{text_x:.2}" y="-{text_y_offset}" text-anchor="middle" font-size="{font_size:.2}" fill="#fff">{min_label}{flat_suffix}</text>
  <text x="{text_x:.2}" y="{max_y:.2}" text-anchor="middle" font-size="{font_size:.2}" fill="#fff">{max_label}</text>
</g>"##,
        gradient_id = gradient_id,
        gradient_stops = gradient_stops,
        x = x,
        y = y,
        legend_width = legend_width,
        legend_height = legend_height,
        stroke_width = stroke_width,
        text_x = legend_width / 2.0,
        text_y_offset = text_y_offset,
        font_size = font_size,
        min_label = min_label,
        flat_suffix = flat_suffix,
        max_y = max_text_y,
        max_label = max_label
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{GpsCoordinates, SectionData, ShotData, StationRef};
    use tempfile::NamedTempFile;

    fn create_test_project() -> Project {
        let mut project = Project::new("Test".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
            direction: None,
            shots: vec![ShotData {
                azimuth_in: 0.0,
                azimuth_out: 180.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 5.0,
                ..Default::default()
            }],
        });
        project
    }

    #[test]
    fn test_export_svg() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("svg");

        let result = export_svg(&project, &path, &ExportImageOptions::default());
        assert!(result.is_ok());

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("<svg"));
        assert!(contents.contains("Main"));

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_escape_xml_replaces_special_chars() {
        let escaped = escape_xml(r#"<tag attr="a&b">'quote'</tag>"#);
        assert_eq!(
            escaped,
            "&lt;tag attr=&quot;a&amp;b&quot;&gt;&apos;quote&apos;&lt;/tag&gt;"
        );
    }

    #[test]
    fn test_generate_svg_string_includes_grid_and_labels() {
        let project = create_test_project();
        let mut options = ExportImageOptions::default();
        options.include_grid = true;
        options.include_labels = true;
        options.include_section_names = true;

        let svg = generate_svg_string(&project, &options).unwrap();
        assert!(svg.contains("class=\"grid\""));
        assert!(svg.contains("class=\"labels\""));
        assert!(svg.contains("class=\"section-names\""));
    }

    #[test]
    fn test_generate_svg_string_excludes_labels_when_disabled() {
        let project = create_test_project();
        let mut options = ExportImageOptions::default();
        options.include_labels = false;
        options.include_section_names = false;

        let svg = generate_svg_string(&project, &options).unwrap();
        assert!(!svg.contains("class=\"labels\""));
        assert!(!svg.contains("class=\"section-names\""));
    }

    #[test]
    fn test_export_png_72_dpi() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("png");

        let options = ExportImageOptions {
            format: ImageFormat::Png,
            dpi: 72,
            ..Default::default()
        };

        let result = export_png(&project, &path, &options);
        assert!(result.is_ok(), "PNG export at 72 DPI failed: {:?}", result.err());
        assert!(path.exists(), "PNG file should exist");

        // Verify it's a valid PNG by checking magic bytes
        let contents = std::fs::read(&path).unwrap();
        assert!(contents.len() > 8, "PNG file too small");
        assert_eq!(&contents[0..8], &[137, 80, 78, 71, 13, 10, 26, 10], "Invalid PNG magic bytes");

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_export_png_150_dpi() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("png");

        let options = ExportImageOptions {
            format: ImageFormat::Png,
            dpi: 150,
            ..Default::default()
        };

        let result = export_png(&project, &path, &options);
        assert!(result.is_ok(), "PNG export at 150 DPI failed: {:?}", result.err());
        assert!(path.exists());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_export_png_300_dpi() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("png");

        let options = ExportImageOptions {
            format: ImageFormat::Png,
            dpi: 300,
            ..Default::default()
        };

        let result = export_png(&project, &path, &options);
        assert!(result.is_ok(), "PNG export at 300 DPI failed: {:?}", result.err());
        assert!(path.exists());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_export_png_600_dpi() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("png");

        let options = ExportImageOptions {
            format: ImageFormat::Png,
            dpi: 600,
            ..Default::default()
        };

        let result = export_png(&project, &path, &options);
        assert!(result.is_ok(), "PNG export at 600 DPI failed: {:?}", result.err());
        assert!(path.exists());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_export_png_size_limit_error() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("png");

        // Use an extremely high DPI to exceed the 16384px limit
        // With our 800px target SVG size, DPI of 2000 would give ~22,222px
        let options = ExportImageOptions {
            format: ImageFormat::Png,
            dpi: 2000,
            ..Default::default()
        };

        let result = export_png(&project, &path, &options);
        assert!(result.is_err(), "PNG export should fail for oversized image");
        let err = result.unwrap_err().to_string();
        assert!(err.contains("16384"), "Error should mention size limit: {}", err);
        assert!(err.contains("Reduce DPI"), "Error should suggest reducing DPI: {}", err);
    }

    #[test]
    fn test_export_image_dispatches_to_png() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("png");

        let options = ExportImageOptions {
            format: ImageFormat::Png,
            dpi: 72,
            ..Default::default()
        };

        let result = export_image(&project, &path, &options);
        assert!(result.is_ok(), "export_image should dispatch to PNG: {:?}", result.err());
        assert!(path.exists());

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_export_png_dpi_zero_error() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("png");

        let options = ExportImageOptions {
            format: ImageFormat::Png,
            dpi: 0,
            ..Default::default()
        };

        let result = export_png(&project, &path, &options);
        assert!(result.is_err(), "PNG export should fail for DPI=0");
        let err = result.unwrap_err().to_string();
        assert!(err.contains("DPI must be at least 1"), "Error should mention DPI requirement: {}", err);
    }

    // === Depth coloring tests ===

    fn create_test_project_with_depths() -> Project {
        let mut project = Project::new("DepthTest".to_string(), None);
        project.add_section(SectionData {
            name: Some("Section1".to_string()),
            surveyor: None,
            date: None,
            color: "#ff0000".to_string(),
            direction: None,
            shots: vec![
                ShotData {
                    azimuth_in: 0.0,
                    azimuth_out: 180.0,
                    length: 10.0,
                    depth_in: 0.0,
                    depth_out: 5.0,
                    ..Default::default()
                },
                ShotData {
                    azimuth_in: 0.0,
                    azimuth_out: 180.0,
                    length: 10.0,
                    depth_in: 5.0,
                    depth_out: 10.0,
                    ..Default::default()
                },
            ],
        });
        project
    }

    #[test]
    fn test_svg_section_mode_uses_section_color() {
        let project = create_test_project();
        let options = ExportImageOptions {
            color_mode: ColorMode::Section,
            ..Default::default()
        };

        let svg = generate_svg_string(&project, &options).unwrap();

        // Stations should have inline style with section color
        assert!(svg.contains("style=\"fill:#4ecdc4\""), "Station should have section color: {}", svg);
        // Shots should use section color
        assert!(svg.contains("stroke=\"#4ecdc4\""), "Shot should have section color stroke: {}", svg);
    }

    #[test]
    fn test_svg_depth_mode_uses_depth_colors() {
        let project = create_test_project_with_depths();
        let options = ExportImageOptions {
            color_mode: ColorMode::Depth,
            depth_preset: super::super::depth_colors::DepthPreset::Grayscale,
            ..Default::default()
        };

        let svg = generate_svg_string(&project, &options).unwrap();

        // Should not contain the section color as fill or stroke
        assert!(!svg.contains("stroke=\"#ff0000\""), "Should not use section color for shots in depth mode");
        // Stations should have inline style="fill:..." (not CSS class fill)
        assert!(svg.contains("style=\"fill:#"), "Stations should have inline fill style: {}", svg);
    }

    #[test]
    fn test_svg_css_station_class_no_fill() {
        let project = create_test_project();
        let options = ExportImageOptions::default();

        let svg = generate_svg_string(&project, &options).unwrap();

        // CSS .station class should NOT have fill property (stroke-width is dynamic)
        assert!(svg.contains(".station { stroke: #000000; stroke-width:"),
            "CSS .station should have stroke properties: {}", svg);
        assert!(!svg.contains(".station { fill:"),
            "CSS .station should NOT have fill property: {}", svg);
        // CSS .zero-datum class should NOT have fill property
        assert!(svg.contains(".zero-datum { stroke: #000000; stroke-width:"),
            "CSS .zero-datum should have stroke properties: {}", svg);
        assert!(!svg.contains(".zero-datum { fill:"),
            "CSS .zero-datum should NOT have fill property: {}", svg);
    }

    #[test]
    fn test_svg_all_stations_have_inline_fill() {
        let project = create_test_project();
        let options = ExportImageOptions::default();

        let svg = generate_svg_string(&project, &options).unwrap();

        // Count circles - all should have style="fill:..."
        let circle_count = svg.matches("<circle").count();
        let inline_fill_count = svg.matches("style=\"fill:").count();
        assert_eq!(circle_count, inline_fill_count,
            "All {} circles should have inline fill style, but only {} have it",
            circle_count, inline_fill_count);
    }

    #[test]
    fn test_svg_zero_datum_always_gold() {
        let mut project = create_test_project();
        // Set a zero datum
        let section_id = project.sections[0].id;
        let gps = GpsCoordinates::new(45.0, -122.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

        // Test in section mode
        let options_section = ExportImageOptions {
            color_mode: ColorMode::Section,
            ..Default::default()
        };
        let svg_section = generate_svg_string(&project, &options_section).unwrap();
        assert!(svg_section.contains("style=\"fill:#ffd700\""),
            "Zero datum should be gold in section mode: {}", svg_section);

        // Test in depth mode
        let options_depth = ExportImageOptions {
            color_mode: ColorMode::Depth,
            ..Default::default()
        };
        let svg_depth = generate_svg_string(&project, &options_depth).unwrap();
        assert!(svg_depth.contains("style=\"fill:#ffd700\""),
            "Zero datum should be gold in depth mode: {}", svg_depth);
    }

    #[test]
    fn test_svg_depth_mode_shot_uses_avg_depth() {
        let project = create_test_project_with_depths();
        let options = ExportImageOptions {
            color_mode: ColorMode::Depth,
            depth_preset: super::super::depth_colors::DepthPreset::Grayscale,
            ..Default::default()
        };

        let svg = generate_svg_string(&project, &options).unwrap();

        // The project has shots with varying depths, so we should have different stroke colors
        // Just verify that we don't use the section color
        assert!(!svg.contains("stroke=\"#ff0000\""),
            "Shot strokes should not use section color in depth mode");
        // Verify shots have strokes (grayscale colors will be #NNNNNN format)
        assert!(svg.contains("stroke=\"#"), "Shots should have stroke colors");
    }

    // === Depth legend tests ===

    #[test]
    fn test_format_depth_label_meters() {
        let label = format_depth_label(10.0, "m", 1);
        assert_eq!(label, "10.0m");
    }

    #[test]
    fn test_format_depth_label_feet_conversion() {
        // 10 meters = 32.8084 feet
        let label = format_depth_label(10.0, "ft", 1);
        assert_eq!(label, "32.8ft");
    }

    #[test]
    fn test_format_depth_label_precision() {
        let label = format_depth_label(10.123, "m", 2);
        assert_eq!(label, "10.12m");

        let label = format_depth_label(10.123, "m", 0);
        assert_eq!(label, "10m");
    }

    #[test]
    fn test_format_depth_label_feet_with_precision() {
        // 3 meters = 9.84252 feet
        let label = format_depth_label(3.0, "ft", 2);
        assert_eq!(label, "9.84ft");
    }

    #[test]
    fn test_depth_legend_contains_gradient() {
        let bounds = Bounds {
            min_x: 0.0,
            max_x: 100.0,
            min_y: 0.0,
            max_y: 100.0,
        };
        // Scale factor for 100m bounds -> 800px target = 8.0
        let scale = 8.0;
        let legend = generate_depth_legend(
            0.0,
            10.0,
            super::super::depth_colors::DepthPreset::Thermal,
            "m",
            1,
            &bounds,
            scale,
        );

        assert!(legend.contains("linearGradient"), "Legend should contain gradient definition");
        // Gradient ID includes preset name for uniqueness
        assert!(legend.contains("id=\"depth-gradient-thermal\""), "Gradient should have preset-specific id");
    }

    #[test]
    fn test_depth_legend_sampled_gradient() {
        let bounds = Bounds {
            min_x: 0.0,
            max_x: 100.0,
            min_y: 0.0,
            max_y: 100.0,
        };
        let scale = 8.0;
        let legend = generate_depth_legend(
            0.0,
            10.0,
            super::super::depth_colors::DepthPreset::Thermal,
            "m",
            1,
            &bounds,
            scale,
        );

        // Gradient now has LEGEND_GRADIENT_SAMPLES+1 stops (65 samples from 0 to 64)
        // Check for first and last stops
        assert!(legend.contains("offset=\"0.00%\""), "Should have 0% stop");
        assert!(legend.contains("offset=\"100.00%\""), "Should have 100% stop");
        // Should have many intermediate stops (64 samples = 65 stops total)
        let stop_count = legend.matches("<stop offset=").count();
        assert_eq!(stop_count, 65, "Should have 65 gradient stops (LEGEND_GRADIENT_SAMPLES+1)");
    }

    #[test]
    fn test_depth_legend_labels_with_unit_conversion() {
        let bounds = Bounds {
            min_x: 0.0,
            max_x: 100.0,
            min_y: 0.0,
            max_y: 100.0,
        };
        let scale = 8.0;
        let legend = generate_depth_legend(0.0, 10.0, super::super::depth_colors::DepthPreset::Ocean, "ft", 1, &bounds, scale);

        // 0m = 0ft, 10m = 32.8ft
        assert!(legend.contains("0.0ft"), "Legend should show min depth in feet");
        assert!(legend.contains("32.8ft"), "Legend should show max depth converted to feet");
    }

    #[test]
    fn test_depth_legend_flat_indicator() {
        let bounds = Bounds {
            min_x: 0.0,
            max_x: 100.0,
            min_y: 0.0,
            max_y: 100.0,
        };
        let scale = 8.0;
        let legend = generate_depth_legend(5.0, 5.0, super::super::depth_colors::DepthPreset::Ocean, "m", 1, &bounds, scale);

        assert!(legend.contains("(Flat)"), "Legend should show flat indicator when min ≈ max");
    }

    #[test]
    fn test_svg_legend_only_in_depth_mode() {
        let project = create_test_project_with_depths();

        // Section mode - no legend
        let options_section = ExportImageOptions {
            color_mode: ColorMode::Section,
            include_legend: true,
            ..Default::default()
        };
        let svg_section = generate_svg_string(&project, &options_section).unwrap();
        assert!(!svg_section.contains("depth-legend"), "Section mode should not have depth legend");

        // Depth mode - has legend
        let options_depth = ExportImageOptions {
            color_mode: ColorMode::Depth,
            include_legend: true,
            ..Default::default()
        };
        let svg_depth = generate_svg_string(&project, &options_depth).unwrap();
        assert!(svg_depth.contains("depth-legend"), "Depth mode with include_legend should have legend");
    }

    #[test]
    fn test_svg_legend_can_be_disabled() {
        let project = create_test_project_with_depths();
        let options = ExportImageOptions {
            color_mode: ColorMode::Depth,
            include_legend: false,
            ..Default::default()
        };
        let svg = generate_svg_string(&project, &options).unwrap();
        assert!(!svg.contains("depth-legend"), "Legend should not appear when include_legend=false");
    }

    #[test]
    fn test_shot_depth_labels_with_include_shot_data() {
        let project = create_test_project_with_depths();
        let options = ExportImageOptions {
            include_shot_data: true,
            depth_unit: "m".to_string(),
            decimal_precision: 1,
            ..Default::default()
        };
        let svg = generate_svg_string(&project, &options).unwrap();

        // Should contain shot-label elements
        assert!(svg.contains("shot-label"), "SVG should contain shot labels when include_shot_data=true");
    }

    #[test]
    fn test_shot_depth_labels_unit_conversion() {
        let project = create_test_project_with_depths();
        let options = ExportImageOptions {
            include_shot_data: true,
            depth_unit: "ft".to_string(),
            decimal_precision: 1,
            ..Default::default()
        };
        let svg = generate_svg_string(&project, &options).unwrap();

        // Shot labels should contain "ft" suffix AND converted numeric values
        // The test project has shots with depths: 0->5m (avg 2.5m) and 5->10m (avg 7.5m)
        // 2.5m * 3.28084 = 8.2ft, 7.5m * 3.28084 = 24.6ft
        assert!(svg.contains("ft</text>"), "Shot labels should show feet when depth_unit=ft");
        assert!(svg.contains("8.2ft"), "Shot label should show 2.5m converted to 8.2ft: {}", svg);
        assert!(svg.contains("24.6ft"), "Shot label should show 7.5m converted to 24.6ft: {}", svg);
    }

    #[test]
    fn test_no_shot_depth_labels_by_default() {
        let project = create_test_project_with_depths();
        let options = ExportImageOptions::default();
        let svg = generate_svg_string(&project, &options).unwrap();

        // Should NOT contain shot-label elements by default
        assert!(!svg.contains("shot-label"), "SVG should not contain shot labels by default");
    }

    // === Safety tests ===

    #[test]
    fn test_format_depth_label_precision_clamped() {
        // Large precision should be clamped to MAX_DECIMAL_PRECISION (6)
        let label = format_depth_label(1.123456789, "m", 255);
        assert_eq!(label, "1.123457m", "Precision should be clamped to 6");
    }

    #[test]
    fn test_format_depth_label_xml_escaping() {
        // Malicious unit string should be escaped
        let label = format_depth_label(10.0, "</text><script>alert('xss')</script>", 1);
        assert!(!label.contains("<script>"), "Script tag should be escaped");
        assert!(label.contains("&lt;"), "< should be escaped to &lt;");
        assert!(label.contains("&gt;"), "> should be escaped to &gt;");
    }

    #[test]
    fn test_sanitize_color_valid_hex6() {
        assert_eq!(sanitize_color("#4ecdc4"), "#4ecdc4");
        assert_eq!(sanitize_color("#FFFFFF"), "#FFFFFF");
        assert_eq!(sanitize_color("#000000"), "#000000");
    }

    #[test]
    fn test_sanitize_color_valid_hex3() {
        assert_eq!(sanitize_color("#fff"), "#fff");
        assert_eq!(sanitize_color("#ABC"), "#ABC");
    }

    #[test]
    fn test_sanitize_color_valid_hex8() {
        assert_eq!(sanitize_color("#4ecdc4ff"), "#4ecdc4ff");
        assert_eq!(sanitize_color("#00000080"), "#00000080");
    }

    #[test]
    fn test_sanitize_color_invalid_returns_default() {
        // Missing hash
        assert_eq!(sanitize_color("4ecdc4"), DEFAULT_COLOR);
        // Wrong length
        assert_eq!(sanitize_color("#4ecd"), DEFAULT_COLOR);
        assert_eq!(sanitize_color("#4ecdc4f"), DEFAULT_COLOR);
        // Non-hex characters
        assert_eq!(sanitize_color("#gggggg"), DEFAULT_COLOR);
        // Empty
        assert_eq!(sanitize_color(""), DEFAULT_COLOR);
        // Injection attempt
        assert_eq!(sanitize_color("#fff\" onclick=\"alert(1)"), DEFAULT_COLOR);
        assert_eq!(sanitize_color("red"), DEFAULT_COLOR);
        assert_eq!(sanitize_color("url(#gradient)"), DEFAULT_COLOR);
    }

    #[test]
    fn test_svg_uses_sanitized_colors() {
        // Create project with invalid color
        let mut project = Project::new("ColorTest".to_string(), None);
        project.add_section(SectionData {
            name: Some("Bad".to_string()),
            surveyor: None,
            date: None,
            color: "red\" onclick=\"alert(1)".to_string(), // Injection attempt
            direction: None,
            shots: vec![ShotData {
                azimuth_in: 0.0,
                azimuth_out: 180.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 5.0,
                ..Default::default()
            }],
        });

        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        // Should not contain the injection
        assert!(!svg.contains("onclick"), "SVG should not contain onclick");
        assert!(!svg.contains("alert"), "SVG should not contain alert");
        // Should use default color instead
        assert!(svg.contains(DEFAULT_COLOR), "SVG should use default color for invalid input");
    }

    #[test]
    fn test_empty_project_depth_mode_no_infinity() {
        let project = Project::new("Empty".to_string(), None);
        let options = ExportImageOptions {
            color_mode: ColorMode::Depth,
            include_legend: true,
            ..Default::default()
        };
        let svg = generate_svg_string(&project, &options).unwrap();

        // Should not contain infinity or NaN in legend
        assert!(!svg.contains("inf"), "Empty project should not have infinity in legend: {}", svg);
        assert!(!svg.contains("NaN"), "Empty project should not have NaN in legend");
        // Should show flat (0.0m to 0.0m)
        assert!(svg.contains("(Flat)"), "Empty project should show flat indicator");
    }

    #[test]
    fn test_empty_project_section_mode_valid() {
        let project = Project::new("Empty".to_string(), None);
        let options = ExportImageOptions {
            color_mode: ColorMode::Section,
            ..Default::default()
        };
        let result = generate_svg_string(&project, &options);
        assert!(result.is_ok(), "Empty project in section mode should generate valid SVG");
    }

    #[test]
    fn test_export_image_pdf_writes_file() {
        let project = create_test_project();
        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("pdf");

        let mut options = ExportImageOptions::default();
        options.format = ImageFormat::Pdf;

        let result = export_image(&project, &path, &options);
        assert!(result.is_ok());

        let metadata = std::fs::metadata(&path).unwrap();
        assert!(metadata.len() > 0);

        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_generate_svg_string_empty_project_defaults_bounds() {
        let project = Project::new("Empty".to_string(), None);
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        assert!(svg.contains("<svg"));
        assert!(svg.contains("<rect"));
        assert!(svg.contains("viewBox"));
    }

    // === Element size scaling tests ===

    /// Helper to extract a numeric attribute value from SVG
    fn extract_attr_value(svg: &str, pattern: &str) -> Option<f64> {
        svg.find(pattern).and_then(|start| {
            let rest = &svg[start + pattern.len()..];
            let end = rest.find(|c: char| !c.is_ascii_digit() && c != '.' && c != '-')?;
            rest[..end].parse().ok()
        })
    }

    #[test]
    fn test_station_radius_scaling() {
        let project = create_test_project();
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        // For the test project (10m shot), dimensions are ~50m x 50m with padding
        // Scale = 800 / 50 = 16.0, so r=3px should become r=0.1875
        // Check that station circles have small radius values (scaled from 3px)
        if let Some(r) = extract_attr_value(&svg, "r=\"") {
            // Scale factor for test project is approximately 800 / (10 + 40) = 16
            // r = 3px / 16 ≈ 0.1875
            assert!(r > 0.0 && r < 1.0, "Station radius should be scaled to viewBox units: {}", r);
        } else {
            panic!("Could not find station radius in SVG");
        }
    }

    #[test]
    fn test_shot_stroke_width_scaling() {
        let project = create_test_project();
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        // CSS .shot stroke-width should be scaled
        if let Some(sw) = extract_attr_value(&svg, ".shot { stroke-width: ") {
            // stroke-width = 2px / 16 ≈ 0.125 (for test project scale)
            assert!(sw > 0.0 && sw < 1.0, "Shot stroke-width should be scaled: {}", sw);
        } else {
            panic!("Could not find shot stroke-width in SVG CSS");
        }
    }

    #[test]
    fn test_grid_stroke_width_scaling() {
        let project = create_test_project();
        let mut options = ExportImageOptions::default();
        options.include_grid = true;

        let svg = generate_svg_string(&project, &options).unwrap();

        // Grid stroke-width should be scaled (0.5px target)
        if let Some(sw) = extract_attr_value(&svg, "class=\"grid\" stroke=\"#333366\" stroke-width=\"") {
            // stroke-width = 0.5px / 16 ≈ 0.03125
            assert!(sw > 0.0 && sw < 0.5, "Grid stroke-width should be scaled: {}", sw);
        } else {
            panic!("Could not find grid stroke-width in SVG");
        }
    }

    #[test]
    fn test_virtual_shot_dasharray_scaling() {
        // Create project with virtual shot
        let mut project = Project::new("VirtualTest".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
            direction: None,
            shots: vec![ShotData {
                azimuth_in: 0.0,
                azimuth_out: 180.0,
                length: 10.0,
                depth_in: 5.0,
                depth_out: 5.0,
                is_virtual: true, // Mark as virtual
                ..Default::default()
            }],
        });

        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        // Virtual shots should have stroke-dasharray with scaled values
        assert!(svg.contains("stroke-dasharray=\""), "Virtual shot should have dasharray");
        // The dasharray values should be small (scaled from 4,2 pixels)
        if let Some(dash) = extract_attr_value(&svg, "stroke-dasharray=\"") {
            assert!(dash > 0.0 && dash < 1.0, "Dash value should be scaled: {}", dash);
        }
    }

    #[test]
    fn test_label_font_size_scaling() {
        let project = create_test_project();
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        // CSS .label font-size should be scaled
        if let Some(fs) = extract_attr_value(&svg, ".label { font-family: sans-serif; font-size: ") {
            // font-size = 10px / 16 ≈ 0.625
            assert!(fs > 0.0 && fs < 2.0, "Label font-size should be scaled: {}", fs);
        } else {
            panic!("Could not find label font-size in SVG CSS");
        }
    }

    #[test]
    fn test_scaling_produces_correct_pixel_values() {
        // This test verifies that viewBox_value * scale ≈ target_pixels
        // For a 100m x 100m survey (with 20m padding on each side = 140m)
        // scale = 800 / 140 ≈ 5.714
        // r = 3px / 5.714 ≈ 0.525, and 0.525 * 5.714 ≈ 3px (verified)

        let mut project = Project::new("ScaleTest".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
            direction: None,
            shots: vec![
                // Create a 100m x 100m survey
                ShotData {
                    azimuth_in: 90.0,
                    azimuth_out: 270.0,
                    length: 100.0,
                    depth_in: 0.0,
                    depth_out: 0.0,
                    ..Default::default()
                },
            ],
        });

        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        // Extract scale from viewBox: scale = 800 / max(width, height)
        // For 100m shot + 40m padding = 140m, scale ≈ 5.714
        let expected_scale = 800.0 / 140.0;
        let tolerance = 0.1;

        // Verify station radius: r * scale ≈ 3px
        if let Some(r) = extract_attr_value(&svg, "r=\"") {
            let pixel_r = r * expected_scale;
            assert!((pixel_r - 3.0).abs() < tolerance,
                "Station radius * scale should be ~3px, got {}px (r={}, scale={})",
                pixel_r, r, expected_scale);
        } else {
            panic!("Could not find station radius in SVG");
        }

        // Verify shot stroke-width: sw * scale ≈ 2px
        if let Some(sw) = extract_attr_value(&svg, ".shot { stroke-width: ") {
            let pixel_sw = sw * expected_scale;
            assert!((pixel_sw - 2.0).abs() < tolerance,
                "Shot stroke-width * scale should be ~2px, got {}px",
                pixel_sw);
        } else {
            panic!("Could not find shot stroke-width in SVG CSS");
        }
    }

    // === Visual regression tests for export scaling (fn-17-ygu.3) ===
    // These tests verify that SVG element sizes scale correctly to achieve
    // consistent pixel sizes regardless of survey extent. They would catch
    // the original 3-4x scaling bug if reverted.

    /// Helper to create a test project with known dimensions for scaling tests
    fn create_scaling_test_project(extent_meters: f64) -> Project {
        let mut project = Project::new("ScalingTest".to_string(), None);
        project.add_section(SectionData {
            name: Some("TestSection".to_string()),
            surveyor: None,
            date: None,
            color: "#ff6b6b".to_string(),
            direction: None,
            shots: vec![ShotData {
                azimuth_in: 90.0,
                azimuth_out: 270.0,
                length: extent_meters,
                depth_in: 0.0,
                depth_out: 0.0,
                is_virtual: true, // Test virtual shot dasharray
                ..Default::default()
            }],
        });
        project
    }

    /// Calculate the expected scale factor for a survey
    fn calculate_scale(extent_meters: f64) -> f64 {
        let padding = 20.0;
        let total_extent = extent_meters + padding * 2.0;
        const TARGET_SIZE: f64 = 800.0;
        TARGET_SIZE / total_extent
    }

    #[test]
    fn test_scaling_regression_station_radius() {
        // Test with known dimensions: 100m extent
        // This catches the original bug where radius was 3.0 instead of px(3.0)
        let project = create_scaling_test_project(100.0);
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        let scale = calculate_scale(100.0);
        let tolerance = 0.1; // ±0.1px tolerance

        // Station radius should be 3px when multiplied by scale
        if let Some(r) = extract_attr_value(&svg, "r=\"") {
            let pixel_value = r * scale;
            assert!(
                (pixel_value - 3.0).abs() < tolerance,
                "Station radius should be 3px (±{}px), got {}px (r={}, scale={})",
                tolerance, pixel_value, r, scale
            );
        } else {
            panic!("Could not find station radius in SVG");
        }
    }

    #[test]
    fn test_scaling_regression_shot_stroke_width() {
        let project = create_scaling_test_project(100.0);
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        let scale = calculate_scale(100.0);
        let tolerance = 0.1;

        // Shot stroke-width should be 2px when multiplied by scale
        if let Some(sw) = extract_attr_value(&svg, ".shot { stroke-width: ") {
            let pixel_value = sw * scale;
            assert!(
                (pixel_value - 2.0).abs() < tolerance,
                "Shot stroke-width should be 2px (±{}px), got {}px",
                tolerance, pixel_value
            );
        } else {
            panic!("Could not find shot stroke-width in SVG CSS");
        }
    }

    #[test]
    fn test_scaling_regression_grid_stroke_width() {
        let project = create_scaling_test_project(100.0);
        let mut options = ExportImageOptions::default();
        options.include_grid = true;

        let svg = generate_svg_string(&project, &options).unwrap();

        let scale = calculate_scale(100.0);
        let tolerance = 0.1;

        // Grid stroke-width should be 0.5px when multiplied by scale
        if let Some(sw) = extract_attr_value(&svg, "class=\"grid\" stroke=\"#333366\" stroke-width=\"") {
            let pixel_value = sw * scale;
            assert!(
                (pixel_value - 0.5).abs() < tolerance,
                "Grid stroke-width should be 0.5px (±{}px), got {}px",
                tolerance, pixel_value
            );
        } else {
            panic!("Could not find grid stroke-width in SVG");
        }
    }

    /// Helper to parse stroke-dasharray="X,Y" and return (dash, gap) values
    fn parse_dasharray(svg: &str) -> Option<(f64, f64)> {
        let marker = "stroke-dasharray=\"";
        let start = svg.find(marker)? + marker.len();
        let end = svg[start..].find('"')? + start;
        let value = &svg[start..end];
        let parts: Vec<&str> = value.split(',').collect();
        if parts.len() != 2 {
            return None;
        }
        let dash = parts[0].parse().ok()?;
        let gap = parts[1].parse().ok()?;
        Some((dash, gap))
    }

    #[test]
    fn test_scaling_regression_virtual_shot_dasharray() {
        let project = create_scaling_test_project(100.0);
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        let scale = calculate_scale(100.0);
        let tolerance = 0.1;

        // Virtual shot dasharray should have 4px dash, 2px gap
        let (dash, gap) = parse_dasharray(&svg)
            .expect("Could not find/parse stroke-dasharray in SVG (is virtual shot present?)");

        let pixel_dash = dash * scale;
        assert!(
            (pixel_dash - 4.0).abs() < tolerance,
            "Virtual shot dash should be 4px (±{}px), got {}px",
            tolerance, pixel_dash
        );

        let pixel_gap = gap * scale;
        assert!(
            (pixel_gap - 2.0).abs() < tolerance,
            "Virtual shot gap should be 2px (±{}px), got {}px",
            tolerance, pixel_gap
        );
    }

    #[test]
    fn test_scaling_regression_label_font_size() {
        let project = create_scaling_test_project(100.0);
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        let scale = calculate_scale(100.0);
        let tolerance = 0.1;

        // Label font-size should be 10px when multiplied by scale
        if let Some(fs) = extract_attr_value(&svg, ".label { font-family: sans-serif; font-size: ") {
            let pixel_value = fs * scale;
            assert!(
                (pixel_value - 10.0).abs() < tolerance,
                "Label font-size should be 10px (±{}px), got {}px",
                tolerance, pixel_value
            );
        } else {
            panic!("Could not find label font-size in SVG CSS");
        }
    }

    #[test]
    fn test_scaling_regression_section_name_font_size() {
        let project = create_scaling_test_project(100.0);
        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();

        let scale = calculate_scale(100.0);
        let tolerance = 0.1;

        // Section-name font-size should be 12px when multiplied by scale
        if let Some(fs) = extract_attr_value(&svg, ".section-name { font-family: sans-serif; font-size: ") {
            let pixel_value = fs * scale;
            assert!(
                (pixel_value - 12.0).abs() < tolerance,
                "Section-name font-size should be 12px (±{}px), got {}px",
                tolerance, pixel_value
            );
        } else {
            panic!("Could not find section-name font-size in SVG CSS");
        }
    }

    #[test]
    fn test_scaling_consistent_across_different_survey_sizes() {
        // Test that pixel sizes remain consistent regardless of survey extent
        // This is the key property that the px() helper provides
        let tolerance = 0.1;

        for extent in [10.0, 50.0, 100.0, 500.0, 1000.0] {
            let project = create_scaling_test_project(extent);
            let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();
            let scale = calculate_scale(extent);

            // Station radius should always be 3px
            if let Some(r) = extract_attr_value(&svg, "r=\"") {
                let pixel_r = r * scale;
                assert!(
                    (pixel_r - 3.0).abs() < tolerance,
                    "Station radius at {}m extent should be 3px (±{}px), got {}px",
                    extent, tolerance, pixel_r
                );
            }

            // Shot stroke-width should always be 2px
            if let Some(sw) = extract_attr_value(&svg, ".shot { stroke-width: ") {
                let pixel_sw = sw * scale;
                assert!(
                    (pixel_sw - 2.0).abs() < tolerance,
                    "Shot stroke-width at {}m extent should be 2px (±{}px), got {}px",
                    extent, tolerance, pixel_sw
                );
            }
        }
    }

    #[test]
    fn test_scaling_zero_datum_larger_radius() {
        // Zero datum stations should have 6px radius (double the normal 3px)
        let mut project = create_scaling_test_project(100.0);
        let section_id = project.sections[0].id;
        let gps = GpsCoordinates::new(45.0, -122.0, 0.0).unwrap();
        project.set_zero_datum(StationRef::new(section_id, 0), gps).unwrap();

        let svg = generate_svg_string(&project, &ExportImageOptions::default()).unwrap();
        let scale = calculate_scale(100.0);
        let tolerance = 0.1;

        // Find zero-datum circle (has class="zero-datum")
        if let Some(pos) = svg.find("class=\"zero-datum\"") {
            let rest = &svg[pos..];
            if let Some(r) = extract_attr_value(rest, "r=\"") {
                let pixel_r = r * scale;
                assert!(
                    (pixel_r - 6.0).abs() < tolerance,
                    "Zero-datum radius should be 6px (±{}px), got {}px",
                    tolerance, pixel_r
                );
            } else {
                panic!("Could not find radius for zero-datum circle");
            }
        } else {
            panic!("Could not find zero-datum circle in SVG");
        }
    }

    #[test]
    fn test_png_dimensions_scale_with_dpi() {
        // Test that PNG dimensions scale correctly with DPI
        // This validates the DPI scaling formula: dim = svg_dim * (dpi / 72)
        let project = create_test_project();

        for (dpi, expected_scale) in [(72u32, 1.0f64), (150, 150.0/72.0), (300, 300.0/72.0), (600, 600.0/72.0)] {
            let file = NamedTempFile::new().unwrap();
            let path = file.path().with_extension("png");

            let options = ExportImageOptions {
                format: ImageFormat::Png,
                dpi,
                ..Default::default()
            };

            let result = export_png(&project, &path, &options);
            assert!(result.is_ok(), "PNG export at {} DPI failed: {:?}", dpi, result.err());

            // Read PNG and check dimensions via header (bytes 16-23 contain width/height)
            let contents = std::fs::read(&path).unwrap();

            // Assert valid PNG: must have at least 24 bytes for header + IHDR chunk
            assert!(contents.len() >= 24, "PNG file too small at {} DPI: {} bytes", dpi, contents.len());

            // Verify PNG magic bytes
            let magic = &contents[0..8];
            assert_eq!(magic, &[137, 80, 78, 71, 13, 10, 26, 10], "Invalid PNG magic at {} DPI", dpi);

            // PNG IHDR chunk: width at bytes 16-19, height at 20-23 (big-endian)
            let width = u32::from_be_bytes([contents[16], contents[17], contents[18], contents[19]]);
            let height = u32::from_be_bytes([contents[20], contents[21], contents[22], contents[23]]);

            // Base dimensions at 72 DPI
            let base_dim = 800.0; // TARGET_SIZE from generate_svg_string
            let expected_dim = (base_dim * expected_scale).ceil() as u32;

            // Allow small tolerance for rounding
            let dim_tolerance = 2;
            let larger_dim = width.max(height);
            assert!(
                larger_dim >= expected_dim.saturating_sub(dim_tolerance) &&
                larger_dim <= expected_dim + dim_tolerance,
                "PNG at {} DPI: expected ~{}px, got {}x{}",
                dpi, expected_dim, width, height
            );

            std::fs::remove_file(&path).ok();
        }
    }
}
