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
pub fn export_image(project: &Project, path: &Path, options: &ExportImageOptions) -> Result<()> {
    match options.format {
        ImageFormat::Svg => export_svg(project, path, options),
        ImageFormat::Png => export_png(project, path, options),
        ImageFormat::Pdf => export_pdf(project, path, options),
    }
}

/// Export project as PDF using svg2pdf
fn export_pdf(project: &Project, path: &Path, options: &ExportImageOptions) -> Result<()> {
    // First generate SVG content
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

    // Write PDF file
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

    // Generate SVG content first
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
    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    // Save PNG
    pixmap.save_png(path).context("Failed to save PNG file")?;

    tracing::info!(path = ?path, dpi = options.dpi, width = width, height = height, "Exported PNG");
    Ok(())
}

/// Export project as SVG
fn export_svg(project: &Project, path: &Path, options: &ExportImageOptions) -> Result<()> {
    let svg = generate_svg_string(project, options)?;
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

    let mut svg = String::new();
    // CSS: station and zero-datum classes only define stroke (fill is inline)
    svg.push_str(&format!(
        r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{:.2}" height="{:.2}" viewBox="{:.1} {:.1} {:.1} {:.1}">
<style>
  .shot {{ stroke-width: 2; fill: none; }}
  .station {{ stroke: #000000; stroke-width: 1; }}
  .zero-datum {{ stroke: #000000; stroke-width: 1; }}
  .label {{ font-family: sans-serif; font-size: 10px; fill: #333333; }}
  .section-name {{ font-family: sans-serif; font-size: 12px; font-weight: bold; fill: #333333; }}
</style>
<rect x="{:.1}" y="{:.1}" width="{:.1}" height="{:.1}" fill="#1a1a2e"/>
"##,
        svg_width,
        svg_height,
        min_x - padding,
        -(max_y + padding), // Flip Y
        width,
        height,
        min_x - padding,
        -(max_y + padding),
        width,
        height
    ));

    // Draw grid if enabled
    if options.include_grid {
        svg.push_str(r##"<g class="grid" stroke="#333366" stroke-width="0.5">
"##);
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

            let stroke_style = if is_virtual {
                "stroke-dasharray=\"4,4\" opacity=\"0.5\""
            } else {
                ""
            };

            // Shot stroke color: section color or depth-based (average of endpoints)
            let stroke_color = match options.color_mode {
                ColorMode::Section => section.color.clone(),
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
                    r##"<text class="shot-label" x="{:.2}" y="{:.2}" dx="2" dy="-2" font-size="8" fill="#aaa">{}</text>
"##,
                    mid_x, mid_y, depth_label
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
        let radius = if station.is_zero_datum { 6.0 } else { 4.0 };

        // Fill color: gold for zero-datum, otherwise section or depth color
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
                        .map(|s| s.color.clone())
                        .unwrap_or_else(|| "#ffffff".to_string())
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
                    r#"<text class="label" x="{:.2}" y="{:.2}" dx="8" dy="4">ZD</text>
"#,
                    station.coordinates.x, -station.coordinates.y
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
                            r#"<text class="section-name" x="{:.2}" y="{:.2}" dx="5" dy="-5">{}</text>
"#,
                            station.coordinates.x,
                            -station.coordinates.y,
                            escape_xml(name)
                        ));
                    }
                }
            }
        }
        svg.push_str("</g>\n");
    }

    // Draw depth legend if enabled and in depth mode
    if options.include_legend && options.color_mode == ColorMode::Depth {
        let bounds = Bounds {
            min_x,
            max_x,
            min_y,
            max_y,
        };
        let legend = generate_depth_legend(
            min_depth,
            max_depth,
            options.depth_preset,
            &options.depth_unit,
            options.decimal_precision,
            &bounds,
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

/// Bounds of the survey data in world coordinates.
struct Bounds {
    min_x: f64,
    max_x: f64,
    min_y: f64,
    max_y: f64,
}

impl Bounds {
    /// Width of the bounding box.
    fn width(&self) -> f64 {
        self.max_x - self.min_x
    }

    /// Height of the bounding box.
    fn height(&self) -> f64 {
        self.max_y - self.min_y
    }
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

/// Generate depth legend SVG element using viewBox-relative units.
///
/// Legend is positioned in the top-right corner with dimensions relative to project bounds.
/// Uses multi-stop gradients matching the backend interpolation for all presets.
///
/// # Arguments
/// * `min_depth` - Minimum depth in meters
/// * `max_depth` - Maximum depth in meters
/// * `preset` - Depth color preset
/// * `depth_unit` - Unit string for labels ("m" or "ft")
/// * `precision` - Decimal precision for labels
/// * `bounds` - Project bounds for relative positioning
fn generate_depth_legend(
    min_depth: f64,
    max_depth: f64,
    preset: DepthPreset,
    depth_unit: &str,
    precision: u8,
    bounds: &Bounds,
) -> String {
    // Size relative to project extent (in meters/user units)
    let legend_width = (bounds.width() * 0.02).max(1.0); // 2% of width, min 1m
    let legend_height = (bounds.height() * 0.15).max(5.0); // 15% of height, min 5m
    let font_size = (bounds.height() * 0.02).max(0.8); // Relative font size

    // Position: top-right corner with padding
    let padding = bounds.width() * 0.02;
    let x = bounds.max_x - legend_width - padding;
    let y = -(bounds.max_y - padding); // Note: Y is flipped in SVG

    // Multi-stop gradient for all presets (matches backend interpolation)
    let colors = preset.colors();
    let gradient_stops: String = colors
        .stops
        .iter()
        .map(|stop| {
            format!(
                r#"<stop offset="{}%" stop-color="{}"/>"#,
                stop.position * 100.0,
                stop.color
            )
        })
        .collect::<Vec<_>>()
        .join("\n    ");

    let is_flat = (max_depth - min_depth).abs() < 0.1;
    let flat_suffix = if is_flat { " (Flat)" } else { "" };

    // Use format_depth_label for unit conversion
    let min_label = format_depth_label(min_depth, depth_unit, precision);
    let max_label = format_depth_label(max_depth, depth_unit, precision);

    format!(
        r##"
<defs>
  <linearGradient id="depth-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
    {gradient_stops}
  </linearGradient>
</defs>
<g class="depth-legend" transform="translate({x:.2}, {y:.2})">
  <rect width="{legend_width:.2}" height="{legend_height:.2}" fill="url(#depth-gradient)" stroke="#333" stroke-width="0.1"/>
  <text x="{text_x:.2}" y="-0.3" text-anchor="middle" font-size="{font_size:.2}" fill="#fff">{min_label}{flat_suffix}</text>
  <text x="{text_x:.2}" y="{max_y:.2}" text-anchor="middle" font-size="{font_size:.2}" fill="#fff">{max_label}</text>
</g>"##,
        gradient_stops = gradient_stops,
        x = x,
        y = y,
        legend_width = legend_width,
        legend_height = legend_height,
        text_x = legend_width / 2.0,
        font_size = font_size,
        min_label = min_label,
        flat_suffix = flat_suffix,
        max_y = legend_height + font_size + 0.2,
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
            shots: vec![
                ShotData {
                    azimuth_in: 0.0,
                    azimuth_out: 180.0,
                    length: 10.0,
                    depth_in: 5.0,
                    depth_out: 5.0,
                    ..Default::default()
                },
                ShotData {
                    azimuth_in: 90.0,
                    azimuth_out: 270.0,
                    length: 10.0,
                    depth_in: 5.0,
                    depth_out: 6.0,
                    ..Default::default()
                },
            ],
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

        // CSS .station class should NOT have fill property
        assert!(svg.contains(".station { stroke: #000000; stroke-width: 1; }"),
            "CSS .station should only have stroke properties: {}", svg);
        // CSS .zero-datum class should NOT have fill property
        assert!(svg.contains(".zero-datum { stroke: #000000; stroke-width: 1; }"),
            "CSS .zero-datum should only have stroke properties: {}", svg);
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
        let legend = generate_depth_legend(
            0.0,
            10.0,
            super::super::depth_colors::DepthPreset::Thermal,
            "m",
            1,
            &bounds,
        );

        assert!(legend.contains("linearGradient"), "Legend should contain gradient definition");
        assert!(legend.contains("id=\"depth-gradient\""), "Gradient should have correct id");
    }

    #[test]
    fn test_depth_legend_multi_stop_gradient() {
        let bounds = Bounds {
            min_x: 0.0,
            max_x: 100.0,
            min_y: 0.0,
            max_y: 100.0,
        };
        let legend = generate_depth_legend(
            0.0,
            10.0,
            super::super::depth_colors::DepthPreset::Thermal,
            "m",
            1,
            &bounds,
        );

        // Thermal has 5 stops
        assert!(legend.contains("offset=\"0%\""), "Should have 0% stop");
        assert!(legend.contains("offset=\"25%\""), "Should have 25% stop");
        assert!(legend.contains("offset=\"50%\""), "Should have 50% stop");
        assert!(legend.contains("offset=\"75%\""), "Should have 75% stop");
        assert!(legend.contains("offset=\"100%\""), "Should have 100% stop");
    }

    #[test]
    fn test_depth_legend_labels_with_unit_conversion() {
        let bounds = Bounds {
            min_x: 0.0,
            max_x: 100.0,
            min_y: 0.0,
            max_y: 100.0,
        };
        let legend = generate_depth_legend(0.0, 10.0, super::super::depth_colors::DepthPreset::Ocean, "ft", 1, &bounds);

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
        let legend = generate_depth_legend(5.0, 5.0, super::super::depth_colors::DepthPreset::Ocean, "m", 1, &bounds);

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
}
