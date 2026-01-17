/**
 * WebdriverIO E2E Tests: Export Integration
 *
 * These tests run against the full Tauri application with real backend
 * to validate complete export workflows for CSV, JSON, and image formats.
 *
 * Test fixtures:
 * - test_v2.dmp: DMP version 2 format with multiple sections
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importDmpFile,
  getProjectSections,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

// Temp directory for test files
let tempDir: string;

describe('Export Integration', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    // Create unique temp directory for each test
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cavechef-export-'));
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
   * Test 16.1: should export project as CSV
   *
   * Validates CSV export workflow:
   * - Create project with imported data
   * - Export to CSV file
   * - Verify file creation
   * - Validate CSV content (headers and data rows)
   */
  it('should export project as CSV', async () => {
    // Create a new project
    await createNewProject('CSV Export Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpFile(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(0);

    // Get sections to verify data exists
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Export to CSV
    const csvPath = path.join(tempDir, 'export-test.csv');
    const exportResult = await browser.executeAsync(
      async (exportPath: string, done: (result: { success: boolean; error?: string }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                exportCsv: (path: string) => Promise<void>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          await e2e.projectStore.getState().exportCsv(exportPath);
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      csvPath
    );

    // Verify export succeeded
    expect(exportResult.success).toBe(true);
    expect(exportResult.error).toBeUndefined();

    // Wait for file to be written
    await browser.pause(500);

    // Verify file exists
    expect(fs.existsSync(csvPath)).toBe(true);

    // Validate CSV content
    const csvContent = fs.readFileSync(csvPath, 'utf-8');

    // Check header row exists with expected columns
    expect(csvContent).toContain('section_id');
    expect(csvContent).toContain('section_name');
    expect(csvContent).toContain('shot_id');
    expect(csvContent).toContain('length');
    expect(csvContent).toContain('azimuth_in');
    expect(csvContent).toContain('azimuth_out');
    expect(csvContent).toContain('depth_in');
    expect(csvContent).toContain('depth_out');

    // Verify data rows exist (more than just header)
    const lines = csvContent.trim().split('\n');
    expect(lines.length).toBeGreaterThan(1);
  });

  /**
   * Test 16.2: should export project as JSON
   *
   * Validates JSON export workflow:
   * - Create project with imported data
   * - Export to JSON file
   * - Verify file creation
   * - Validate JSON structure (project metadata and sections)
   */
  it('should export project as JSON', async () => {
    // Create a new project
    await createNewProject('JSON Export Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpFile(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(0);

    // Get sections to verify data exists
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Export to JSON
    const jsonPath = path.join(tempDir, 'export-test.json');
    const exportResult = await browser.executeAsync(
      async (exportPath: string, done: (result: { success: boolean; error?: string }) => void) => {
        const e2e = (window as unknown as {
          __E2E_TEST__?: {
            projectStore: {
              getState: () => {
                exportJson: (path: string) => Promise<void>;
              };
            };
          };
        }).__E2E_TEST__;

        if (!e2e) {
          done({ success: false, error: 'E2E helpers not found' });
          return;
        }

        try {
          await e2e.projectStore.getState().exportJson(exportPath);
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      jsonPath
    );

    // Verify export succeeded
    expect(exportResult.success).toBe(true);
    expect(exportResult.error).toBeUndefined();

    // Wait for file to be written
    await browser.pause(500);

    // Verify file exists
    expect(fs.existsSync(jsonPath)).toBe(true);

    // Validate JSON content
    const jsonContent = fs.readFileSync(jsonPath, 'utf-8');
    const parsed = JSON.parse(jsonContent);

    // Verify project structure
    expect(parsed).toHaveProperty('project');
    expect(parsed).toHaveProperty('sections');

    // Verify project metadata
    expect(parsed.project).toHaveProperty('name');
    expect(parsed.project.name).toBe('JSON Export Test');
    expect(parsed.project).toHaveProperty('exported_at');

    // Verify sections array
    expect(Array.isArray(parsed.sections)).toBe(true);
    expect(parsed.sections.length).toBeGreaterThan(0);

    // Verify section structure
    const firstSection = parsed.sections[0];
    expect(firstSection).toHaveProperty('id');
    expect(firstSection).toHaveProperty('color');
    expect(firstSection).toHaveProperty('shots');
    expect(Array.isArray(firstSection.shots)).toBe(true);

    // Verify shot structure
    if (firstSection.shots.length > 0) {
      const firstShot = firstSection.shots[0];
      expect(firstShot).toHaveProperty('id');
      expect(firstShot).toHaveProperty('length');
      expect(firstShot).toHaveProperty('azimuth_in');
      expect(firstShot).toHaveProperty('azimuth_out');
      expect(firstShot).toHaveProperty('depth_in');
      expect(firstShot).toHaveProperty('depth_out');
    }
  });

  /**
   * Test 16.3: should export map as SVG image
   *
   * Validates SVG export workflow:
   * - Create project with imported data
   * - Export to SVG file
   * - Verify file creation
   * - Validate SVG content (magic bytes/header and basic structure)
   *
   * Note: PNG export falls back to SVG in backend, so we test SVG directly.
   */
  it('should export map as SVG image', async () => {
    // Create a new project
    await createNewProject('SVG Export Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpFile(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(0);

    // Get sections to verify data exists
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Export to SVG with default options
    const svgPath = path.join(tempDir, 'export-test.svg');
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
          });
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      svgPath
    );

    // Verify export succeeded
    expect(exportResult.success).toBe(true);
    expect(exportResult.error).toBeUndefined();

    // Wait for file to be written
    await browser.pause(500);

    // Verify file exists
    expect(fs.existsSync(svgPath)).toBe(true);

    // Validate SVG content
    const svgContent = fs.readFileSync(svgPath, 'utf-8');

    // Check SVG header/magic
    expect(svgContent).toContain('<?xml');
    expect(svgContent).toContain('<svg');
    expect(svgContent).toContain('xmlns="http://www.w3.org/2000/svg"');

    // Verify SVG contains expected elements
    expect(svgContent).toContain('</svg>');

    // Verify it contains section elements
    expect(svgContent).toContain('class="section"');

    // Verify it contains station circles
    expect(svgContent).toContain('<circle');
  });

  /**
   * Test 16.4: should export with custom options
   *
   * Validates export customization:
   * - Create project with imported data
   * - Export SVG with custom options (grid enabled, labels disabled)
   * - Verify options are reflected in output
   */
  it('should export with custom options', async () => {
    // Create a new project
    await createNewProject('Custom Options Test');

    // Import survey data
    const dmpPath = path.join(FIXTURES_DIR, 'test_v2.dmp');
    const importResult = await importDmpFile(dmpPath);
    expect(importResult.success).toBe(true);
    expect(importResult.sectionCount).toBeGreaterThan(0);

    // Get sections to verify data exists
    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Export to SVG with grid enabled
    const svgWithGridPath = path.join(tempDir, 'export-with-grid.svg');
    const gridExportResult = await browser.executeAsync(
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
          // Export with grid enabled, labels/section names disabled
          await e2e.projectStore.getState().exportImage(exportPath, {
            format: 'svg',
            dpi: 300,
            include_satellite: false,
            include_grid: true,
            include_labels: false,
            include_section_names: false,
            include_shot_data: false,
          });
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      svgWithGridPath
    );

    // Verify export succeeded
    expect(gridExportResult.success).toBe(true);

    // Wait for file to be written
    await browser.pause(500);

    // Verify file exists
    expect(fs.existsSync(svgWithGridPath)).toBe(true);

    // Validate SVG content with grid
    const svgWithGrid = fs.readFileSync(svgWithGridPath, 'utf-8');

    // Verify SVG structure
    expect(svgWithGrid).toContain('<svg');

    // Grid should be present
    expect(svgWithGrid).toContain('class="grid"');

    // Export without grid for comparison
    const svgNoGridPath = path.join(tempDir, 'export-no-grid.svg');
    const noGridExportResult = await browser.executeAsync(
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
          // Export without grid
          await e2e.projectStore.getState().exportImage(exportPath, {
            format: 'svg',
            dpi: 300,
            include_satellite: false,
            include_grid: false,
            include_labels: true,
            include_section_names: true,
            include_shot_data: false,
          });
          done({ success: true });
        } catch (err) {
          done({ success: false, error: String(err) });
        }
      },
      svgNoGridPath
    );

    // Verify export succeeded
    expect(noGridExportResult.success).toBe(true);

    // Wait for file to be written
    await browser.pause(500);

    // Verify file exists
    expect(fs.existsSync(svgNoGridPath)).toBe(true);

    // Validate SVG content without grid
    const svgNoGrid = fs.readFileSync(svgNoGridPath, 'utf-8');

    // Verify SVG structure
    expect(svgNoGrid).toContain('<svg');

    // Grid should NOT be present
    expect(svgNoGrid).not.toContain('class="grid"');

    // Section names should be present (we enabled them)
    expect(svgNoGrid).toContain('class="section-names"');
  });
});
