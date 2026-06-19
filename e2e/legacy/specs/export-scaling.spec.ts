/**
 * WebdriverIO E2E Tests: Export Scaling Verification
 *
 * These tests run against the full Tauri application with real backend
 * to validate that SVG/PNG exports have correct element scaling.
 *
 * Visual regression tests for fn-17-ygu.3 to prevent future scaling bugs.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importDmpViaStore,
  waitForUiIdle,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

// Temp directory for test files
let tempDir: string;

/**
 * Helper to read PNG dimensions from file header.
 * PNG IHDR chunk contains width at bytes 16-19 and height at bytes 20-23 (big-endian).
 */
function getPngDimensions(filePath: string): { width: number; height: number } | null {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24) return null;

  // Verify PNG magic bytes
  const magic = buffer.slice(0, 8);
  const expectedMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!magic.equals(expectedMagic)) return null;

  // Read IHDR dimensions
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  return { width, height };
}

/**
 * Helper to extract attribute value from SVG string.
 */
function extractSvgAttribute(svg: string, pattern: string): number | null {
  const idx = svg.indexOf(pattern);
  if (idx === -1) return null;

  const rest = svg.slice(idx + pattern.length);
  const match = rest.match(/^[\d.]+/);
  if (!match) return null;

  return parseFloat(match[0]);
}

describe('Export Scaling Verification', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    // Create unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-scaling-'));
  });

  afterEach(async () => {
    // Cleanup temp directory
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Test: PNG dimensions should scale correctly with DPI
   *
   * Validates that PNG output dimensions match expected values based on DPI:
   * - 72 DPI: base dimensions (~800px)
   * - 150 DPI: ~1667px (800 * 150/72)
   * - 300 DPI: ~3333px (800 * 300/72)
   * - 600 DPI: ~6667px (800 * 600/72)
   */
  it('should export PNG with correct dimensions at different DPI values', async () => {
    // Create a new project
    await createNewProject('PNG DPI Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(0);

    // Test multiple DPI values
    const dpiTests = [
      { dpi: 72, expectedScale: 1.0 },
      { dpi: 150, expectedScale: 150 / 72 },
      { dpi: 300, expectedScale: 300 / 72 },
      { dpi: 600, expectedScale: 600 / 72 },
    ];

    const baseDim = 800; // TARGET_SIZE from Rust backend
    const tolerance = 10; // Allow ±10px for rounding

    for (const { dpi, expectedScale } of dpiTests) {
      const pngPath = path.join(tempDir, `export-${dpi}dpi.png`);

      const exportResult = await browser.executeAsync(
        async (
          exportPath: string,
          dpiValue: number,
          done: (result: { success: boolean; error?: string }) => void
        ) => {
          const e2e = (window as unknown as {
            __E2E_TEST__?: {
              projectStore: {
                getState: () => {
                  exportImage: (
                    path: string,
                    options: {
                      format: string;
                      dpi: number;
                      include_satellite: boolean;
                      include_grid: boolean;
                      include_labels: boolean;
                      include_section_names: boolean;
                      include_shot_data: boolean;
                      color_mode: string;
                      depth_preset: string;
                      include_legend: boolean;
                      depth_unit: string;
                      decimal_precision: number;
                    }
                  ) => Promise<void>;
                };
              };
            };
          }).__E2E_TEST__;

          if (!e2e) {
            done({ success: false, error: 'E2E helpers not found' });
            return;
          }

          try {
            await e2e.projectStore.getState().exportImage(exportPath, {
              format: 'png',
              dpi: dpiValue,
              include_satellite: false,
              include_grid: false,
              include_labels: true,
              include_section_names: true,
              include_shot_data: false,
              color_mode: 'section',
              depth_preset: 'thermal',
              include_legend: false,
              depth_unit: 'm',
              decimal_precision: 1,
            });
            done({ success: true });
          } catch (err) {
            done({ success: false, error: String(err) });
          }
        },
        pngPath,
        dpi
      );

      expect(exportResult.success).toBe(true);
      await browser.pause(200);

      // Verify file exists
      expect(fs.existsSync(pngPath)).toBe(true);

      // Read dimensions and verify
      const dims = getPngDimensions(pngPath);
      expect(dims).not.toBeNull();

      if (dims) {
        const expectedDim = Math.ceil(baseDim * expectedScale);
        const largerDim = Math.max(dims.width, dims.height);

        expect(largerDim).toBeGreaterThanOrEqual(expectedDim - tolerance);
        expect(largerDim).toBeLessThanOrEqual(expectedDim + tolerance);
      }
    }
  });

  /**
   * Test: SVG elements should have properly scaled attributes
   *
   * Validates that SVG export contains correctly scaled element attributes:
   * - Station circles: r attribute for radius
   * - Shot lines: stroke-width
   * - Grid lines: stroke-width (when enabled)
   */
  it('should export SVG with properly scaled element attributes', async () => {
    // Create a new project
    await createNewProject('SVG Scaling Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(0);

    // Export SVG with grid enabled
    const svgPath = path.join(tempDir, 'export-scaling.svg');
    const exportResult = await browser.executeAsync(
      async (
        exportPath: string,
        done: (result: { success: boolean; error?: string }) => void
      ) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                exportImage: (
                  path: string,
                  options: {
                    format: string;
                    dpi: number;
                    include_satellite: boolean;
                    include_grid: boolean;
                    include_labels: boolean;
                    include_section_names: boolean;
                    include_shot_data: boolean;
                    color_mode: string;
                    depth_preset: string;
                    include_legend: boolean;
                    depth_unit: string;
                    decimal_precision: number;
                  }
                ) => Promise<void>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          await e2e.projectStore.getState().exportImage(exportPath, {
            format: 'svg',
            dpi: 300,
            include_satellite: false,
            include_grid: true,
            include_labels: true,
            include_section_names: true,
            include_shot_data: false,
            color_mode: 'section',
            depth_preset: 'thermal',
            include_legend: false,
            depth_unit: 'm',
            decimal_precision: 1,
          });
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      svgPath
    );

    expect(exportResult.success).toBe(true);
    await waitForUiIdle(500);

    // Verify file exists
    expect(fs.existsSync(svgPath)).toBe(true);

    // Read and parse SVG content
    const svgContent = fs.readFileSync(svgPath, 'utf-8');

    // Verify basic SVG structure
    expect(svgContent).toContain('<svg');
    expect(svgContent).toContain('xmlns="http://www.w3.org/2000/svg"');

    // Extract viewBox dimensions to calculate scale
    const viewBoxMatch = svgContent.match(/viewBox="[^"]+\s+[^"]+\s+([\d.]+)\s+([\d.]+)"/);
    expect(viewBoxMatch).not.toBeNull();

    if (viewBoxMatch) {
      const vbWidth = parseFloat(viewBoxMatch[1]);
      const vbHeight = parseFloat(viewBoxMatch[2]);
      const targetSize = 800; // TARGET_SIZE from Rust backend
      const scale = targetSize / Math.max(vbWidth, vbHeight);
      const tolerance = 0.2; // ±0.2px tolerance

      // Verify station radius: r * scale should be ~3px
      // Scope to station circles to avoid matching other r attributes
      const stationRadiusMatch = svgContent.match(/<circle[^>]*class="station"[^>]*r="([\d.]+)"/);
      expect(stationRadiusMatch).not.toBeNull();
      if (stationRadiusMatch) {
        const radius = parseFloat(stationRadiusMatch[1]);
        const pixelRadius = radius * scale;
        expect(pixelRadius).toBeGreaterThan(3 - tolerance);
        expect(pixelRadius).toBeLessThan(3 + tolerance);
      }

      // Verify shot stroke-width: should be ~2px
      const shotStrokeWidth = extractSvgAttribute(svgContent, '.shot { stroke-width: ');
      expect(shotStrokeWidth).not.toBeNull();
      if (shotStrokeWidth !== null) {
        const pixelStroke = shotStrokeWidth * scale;
        expect(pixelStroke).toBeGreaterThan(2 - tolerance);
        expect(pixelStroke).toBeLessThan(2 + tolerance);
      }

      // Verify grid stroke-width: should be ~0.5px
      const gridMatch = svgContent.match(/class="grid"[^>]*stroke-width="([\d.]+)"/);
      expect(gridMatch).not.toBeNull();
      if (gridMatch) {
        const gridStrokeWidth = parseFloat(gridMatch[1]);
        const pixelGridStroke = gridStrokeWidth * scale;
        expect(pixelGridStroke).toBeGreaterThan(0.5 - tolerance);
        expect(pixelGridStroke).toBeLessThan(0.5 + tolerance);
      }
    }
  });

  /**
   * Test: SVG elements should scale consistently across different survey sizes
   *
   * This test would catch the original scaling bug where element sizes
   * varied with survey extent instead of being consistent pixel sizes.
   */
  it('should maintain consistent pixel sizes for SVG elements regardless of survey data', async () => {
    // Create a new project
    await createNewProject('Consistency Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);

    // Export SVG
    const svgPath = path.join(tempDir, 'export-consistency.svg');
    const exportResult = await browser.executeAsync(
      async (
        exportPath: string,
        done: (result: { success: boolean; error?: string }) => void
      ) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                exportImage: (
                  path: string,
                  options: {
                    format: string;
                    dpi: number;
                    include_satellite: boolean;
                    include_grid: boolean;
                    include_labels: boolean;
                    include_section_names: boolean;
                    include_shot_data: boolean;
                    color_mode: string;
                    depth_preset: string;
                    include_legend: boolean;
                    depth_unit: string;
                    decimal_precision: number;
                  }
                ) => Promise<void>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          await e2e.projectStore.getState().exportImage(exportPath, {
            format: 'svg',
            dpi: 300,
            include_satellite: false,
            include_grid: false,
            include_labels: true,
            include_section_names: true,
            include_shot_data: false,
            color_mode: 'section',
            depth_preset: 'thermal',
            include_legend: false,
            depth_unit: 'm',
            decimal_precision: 1,
          });
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      svgPath
    );

    expect(exportResult.success).toBe(true);
    await waitForUiIdle(500);

    const svgContent = fs.readFileSync(svgPath, 'utf-8');

    // Verify SVG has correct structure
    expect(svgContent).toContain('<svg');

    // Extract viewBox dimensions to calculate scale
    const viewBoxMatch = svgContent.match(/viewBox="[^"]+\s+[^"]+\s+([\d.]+)\s+([\d.]+)"/);
    expect(viewBoxMatch).not.toBeNull();

    if (viewBoxMatch) {
      const vbWidth = parseFloat(viewBoxMatch[1]);
      const vbHeight = parseFloat(viewBoxMatch[2]);
      const targetSize = 800; // TARGET_SIZE from Rust backend
      const scale = targetSize / Math.max(vbWidth, vbHeight);
      const tolerance = 0.2; // ±0.2px tolerance

      // Extract CSS values and verify they produce correct pixel sizes when scaled
      const shotStrokeMatch = svgContent.match(/\.shot \{ stroke-width: ([\d.]+);/);
      const stationStrokeMatch = svgContent.match(/\.station \{ stroke: #000000; stroke-width: ([\d.]+);/);
      const labelFontMatch = svgContent.match(/\.label \{ font-family: sans-serif; font-size: ([\d.]+);/);

      expect(shotStrokeMatch).not.toBeNull();
      expect(stationStrokeMatch).not.toBeNull();
      expect(labelFontMatch).not.toBeNull();

      if (shotStrokeMatch && stationStrokeMatch && labelFontMatch) {
        const shotStroke = parseFloat(shotStrokeMatch[1]);
        const stationStroke = parseFloat(stationStrokeMatch[1]);
        const labelFont = parseFloat(labelFontMatch[1]);

        // Verify that value * scale produces the expected pixel size
        // Shot stroke-width should be 2px
        const pixelShotStroke = shotStroke * scale;
        expect(pixelShotStroke).toBeGreaterThan(2 - tolerance);
        expect(pixelShotStroke).toBeLessThan(2 + tolerance);

        // Station stroke-width should be 1px
        const pixelStationStroke = stationStroke * scale;
        expect(pixelStationStroke).toBeGreaterThan(1 - tolerance);
        expect(pixelStationStroke).toBeLessThan(1 + tolerance);

        // Label font-size should be 10px
        const pixelLabelFont = labelFont * scale;
        expect(pixelLabelFont).toBeGreaterThan(10 - tolerance);
        expect(pixelLabelFont).toBeLessThan(10 + tolerance);
      }
    }
  });

  /**
   * Test: Exported SVG should contain station circles with correct class and radius
   */
  it('should export SVG with station circles having correct attributes', async () => {
    await createNewProject('Station Circle Test');

    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpViaStore(dmpPath);
    expect(importResult.success).toBe(true);

    const svgPath = path.join(tempDir, 'export-stations.svg');
    const exportResult = await browser.executeAsync(
      async (
        exportPath: string,
        done: (result: { success: boolean; error?: string }) => void
      ) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                exportImage: (
                  path: string,
                  options: {
                    format: string;
                    dpi: number;
                    include_satellite: boolean;
                    include_grid: boolean;
                    include_labels: boolean;
                    include_section_names: boolean;
                    include_shot_data: boolean;
                    color_mode: string;
                    depth_preset: string;
                    include_legend: boolean;
                    depth_unit: string;
                    decimal_precision: number;
                  }
                ) => Promise<void>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          await e2e.projectStore.getState().exportImage(exportPath, {
            format: 'svg',
            dpi: 300,
            include_satellite: false,
            include_grid: false,
            include_labels: false,
            include_section_names: false,
            include_shot_data: false,
            color_mode: 'section',
            depth_preset: 'thermal',
            include_legend: false,
            depth_unit: 'm',
            decimal_precision: 1,
          });
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      svgPath
    );

    expect(exportResult.success).toBe(true);
    await waitForUiIdle(500);

    const svgContent = fs.readFileSync(svgPath, 'utf-8');

    // Verify station circles exist
    expect(svgContent).toContain('<circle');
    expect(svgContent).toContain('class="station"');

    // Verify circles have r attribute and inline fill style
    expect(svgContent).toMatch(/<circle[^>]*r="[\d.]+"/);
    expect(svgContent).toMatch(/<circle[^>]*style="fill:#[a-fA-F0-9]+"/);

    // Count circles vs inline fills - all circles should have inline fill
    const circleCount = (svgContent.match(/<circle/g) || []).length;
    const inlineFillCount = (svgContent.match(/style="fill:/g) || []).length;

    // All circles should have inline fill
    expect(circleCount).toBe(inlineFillCount);
  });
});
