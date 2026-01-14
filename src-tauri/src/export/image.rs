use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use usvg::{Options, Tree};

use crate::models::Project;

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
        ImageFormat::Png => {
            // For PNG, we generate SVG and note that frontend should handle rasterization
            tracing::warn!("PNG export should be handled by frontend for proper map rendering");
            export_svg(project, &path.with_extension("svg"), options)?;
            anyhow::bail!("PNG export requires frontend rendering. SVG exported instead.")
        }
        ImageFormat::Pdf => export_pdf(project, path, options),
    }
}

/// Export project as PDF using svg2pdf
fn export_pdf(project: &Project, path: &Path, options: &ExportImageOptions) -> Result<()> {
    // First generate SVG content
    let svg_content = generate_svg_string(project, options)?;

    // Parse SVG using usvg
    let options_usvg = Options::default();
    let tree = Tree::from_str(&svg_content, &options_usvg)
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

    // Handle empty project
    if min_x == f64::MAX {
        min_x = 0.0;
        max_x = 100.0;
        min_y = 0.0;
        max_y = 100.0;
    }

    // Add padding
    let padding = 20.0;
    let width = (max_x - min_x) + padding * 2.0;
    let height = (max_y - min_y) + padding * 2.0;

    // Scale to reasonable size (min 400px)
    let scale = (400.0 / width.min(height)).max(1.0);
    let svg_width = width * scale;
    let svg_height = height * scale;

    let mut svg = String::new();
    svg.push_str(&format!(
        r##"<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="{:.0}" height="{:.0}" viewBox="{:.1} {:.1} {:.1} {:.1}">
<style>
  .shot {{ stroke-width: 2; fill: none; }}
  .station {{ fill: #ffffff; stroke: #000000; stroke-width: 1; }}
  .zero-datum {{ fill: #ffd700; stroke: #000000; stroke-width: 1; }}
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

            svg.push_str(&format!(
                r#"<line class="shot" x1="{:.2}" y1="{:.2}" x2="{:.2}" y2="{:.2}" stroke="{}" {}/>
"#,
                from.coordinates.x,
                -from.coordinates.y, // Flip Y
                to.coordinates.x,
                -to.coordinates.y,
                section.color,
                stroke_style
            ));
        }

        svg.push_str("</g>\n");
    }

    // Draw stations
    svg.push_str("<g class=\"stations\">\n");
    for station in &stations {
        let class = if station.is_zero_datum {
            "zero-datum"
        } else {
            "station"
        };
        let radius = if station.is_zero_datum { 6.0 } else { 4.0 };

        svg.push_str(&format!(
            r#"<circle class="{}" cx="{:.2}" cy="{:.2}" r="{}"/>
"#,
            class,
            station.coordinates.x,
            -station.coordinates.y,
            radius
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{SectionData, ShotData};
    use tempfile::NamedTempFile;

    #[test]
    fn test_export_svg() {
        let mut project = Project::new("Test".to_string(), None);
        project.add_section(SectionData {
            name: Some("Main".to_string()),
            surveyor: None,
            date: None,
            color: "#4ecdc4".to_string(),
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

        let file = NamedTempFile::new().unwrap();
        let path = file.path().with_extension("svg");

        let result = export_svg(&project, &path, &ExportImageOptions::default());
        assert!(result.is_ok());

        let contents = std::fs::read_to_string(&path).unwrap();
        assert!(contents.contains("<svg"));
        assert!(contents.contains("Main"));

        std::fs::remove_file(&path).ok();
    }
}
