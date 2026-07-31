import { getMapThemeColors } from './themeColors';
import type { ExportImageOptions } from '../types/commands';

/**
 * Stamp the live theme's depth-gradient endpoints onto an export options object.
 *
 * The backend cannot resolve these itself: #332 made every theme declare its own
 * `--cc-depth-shallow` / `--cc-depth-deep`, so the constants in `image.rs` match
 * the dark theme alone (#360). Anything that renders survey geometry through
 * `ExportImageOptions` has to send what the document currently resolves.
 *
 * BOTH commands that take these options must go through here - `export_image`
 * writes the file, `preview_svg_export` draws the dialog's WYSIWYG preview, and
 * the preview's whole promise is that it cannot drift from the file. `format`
 * (not the returned markup) is what decides whether colour is emitted, so a
 * preview of a PNG/PDF export *is* coloured and would otherwise show the dark
 * ramp beside a themed export.
 *
 * Read per call, never cached: the theme can change between two exports.
 * Returns a new object; the caller's own options are left untouched.
 *
 * This relies on `getComputedStyle().getPropertyValue()` handing back a custom
 * property's token as authored rather than normalising it - the Rust side takes
 * `#rrggbb` only, and falls back silently otherwise. Verified in Chromium
 * (returns `#a89060` for `--cc-depth-shallow`, not `rgb(...)`); jsdom agreeing
 * would not have been evidence for the shipped webview. `tokens.test.ts` pins
 * the other half, that every theme declares those two as hex in the first place.
 */
export function withThemeDepthRamp(options: ExportImageOptions): ExportImageOptions {
  const { depthShallow, depthDeep } = getMapThemeColors();
  return { ...options, depth_shallow: depthShallow, depth_deep: depthDeep };
}
