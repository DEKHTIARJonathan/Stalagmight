//! HSL color interpolation for the export renderer's depth gradient.
//!
//! The image exporter colors shots by depth with a two-color HSL lerp that is
//! byte-identical to the frontend map's gradient (colors.ts). The old
//! DepthPreset gradient feature that once lived here was retired in #275: it
//! had no callers on either side of the IPC boundary.

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
    let r = f64::from(r) / 255.0;
    let g = f64::from(g) / 255.0;
    let b = f64::from(b) / 255.0;

    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = f64::midpoint(max, min);

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
/// Shared with the image exporter's depth gradient (byte-identical to the
/// frontend `interpolateHue`/`hslToHex` math).
pub(crate) fn interpolate_hsl(color1: &str, color2: &str, t: f64) -> String {
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
    format!("#{r:02x}{g:02x}{b:02x}")
}

#[cfg(test)]
#[expect(clippy::float_cmp)]
mod tests {
    use super::*;

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
        assert!((h - 0.0).abs() < 1.0, "h={h}");
        assert!((s - 1.0).abs() < 0.01, "s={s}");
        assert!((l - 0.5).abs() < 0.01, "l={l}");
    }

    #[test]
    fn test_rgb_to_hsl_green() {
        let (h, s, l) = rgb_to_hsl(0, 255, 0);
        assert!((h - 120.0).abs() < 1.0, "h={h}");
        assert!((s - 1.0).abs() < 0.01, "s={s}");
        assert!((l - 0.5).abs() < 0.01, "l={l}");
    }

    #[test]
    fn test_rgb_to_hsl_blue() {
        let (h, s, l) = rgb_to_hsl(0, 0, 255);
        assert!((h - 240.0).abs() < 1.0, "h={h}");
        assert!((s - 1.0).abs() < 0.01, "s={s}");
        assert!((l - 0.5).abs() < 0.01, "l={l}");
    }

    #[test]
    fn test_rgb_to_hsl_gray() {
        let (h, s, l) = rgb_to_hsl(128, 128, 128);
        assert_eq!(h, 0.0); // Achromatic
        assert_eq!(s, 0.0); // Achromatic
        assert!((l - 0.502).abs() < 0.01, "l={l}");
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
        assert!((127..=128).contains(&r), "r={r}");
        assert!((127..=128).contains(&g), "g={g}");
        assert!((127..=128).contains(&b), "b={b}");
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
        assert!(r > 100, "r={r} should be high (magenta)");
        assert!(g < 50, "g={g} should be low (magenta)");
        assert!(b > 100, "b={b} should be high (magenta)");
    }

    #[test]
    fn test_interpolate_hsl_grayscale_midpoint() {
        let color = interpolate_hsl("#000000", "#ffffff", 0.5);
        let (r, g, b) = hex_to_rgb(&color);
        // Should be gray
        assert!((127..=129).contains(&r), "r={r}");
        assert!((127..=129).contains(&g), "g={g}");
        assert!((127..=129).contains(&b), "b={b}");
    }
}
