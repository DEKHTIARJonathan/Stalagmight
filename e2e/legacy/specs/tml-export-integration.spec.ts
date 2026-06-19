/**
 * WebdriverIO E2E Tests: TML/TMLU Export Integration
 *
 * These tests run against the full Tauri application with real backend
 * to validate TML/TMLU export workflows. Imports survey data first,
 * then exports to TML (ZIP) and TMLU (plain XML) and validates output.
 *
 * Test fixtures used for import:
 * - test_synthetic.tmlu: Small TMLU with 2 sections
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  waitForAppReady,
  resetAppState,
  createNewProject,
  importTmlViaStore,
  exportTmlFile,
  parseTmlFile,
  getProjectSections,
  waitForUiIdle,
} from '../helpers/app';

// Get absolute path to fixtures directory
const FIXTURES_DIR = path.resolve(process.cwd(), 'e2e', 'fixtures');

// Temp directory for export files
let tempDir: string;

describe('TML Export Integration', () => {
  beforeEach(async () => {
    await waitForAppReady();
    await resetAppState();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stalagmight-tml-export-'));
  });

  afterEach(async () => {
    try {
      if (tempDir && fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  /**
   * Test: should export project as TMLU (plain XML)
   *
   * Validates TMLU export:
   * - Creates file with valid XML
   * - Contains CaveFile root element
   * - Contains Data and SRVD elements
   */
  it('should export project as TMLU (plain XML)', async () => {
    await createNewProject('TMLU Export Test');

    // Import data first
    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const importResult = await importTmlViaStore(tmluPath);
    expect(importResult.success).toBe(true);

    const sections = await getProjectSections();
    expect(sections.length).toBeGreaterThan(0);

    // Export as TMLU
    const exportPath = path.join(tempDir, 'exported.tmlu');
    const exportResult = await exportTmlFile(exportPath);

    expect(exportResult.success).toBe(true);
    expect(exportResult.error).toBeUndefined();

    await waitForUiIdle(500);

    // Verify file exists
    expect(fs.existsSync(exportPath)).toBe(true);

    // Validate XML content
    const content = fs.readFileSync(exportPath, 'utf-8');
    expect(content).toContain('<?xml');
    expect(content).toContain('<CaveFile>');
    expect(content).toContain('<Data>');
    expect(content).toContain('<SRVD>');
    expect(content).toContain('</CaveFile>');

    // Verify shot data elements are present
    expect(content).toContain('<AZ>');
    expect(content).toContain('<LG>');
    expect(content).toContain('<DP>');
  });

  /**
   * Test: should export project as TML (ZIP)
   *
   * Validates TML ZIP export:
   * - Creates a valid ZIP file (PK magic bytes)
   * - File is non-trivially sized
   */
  it('should export project as TML (ZIP)', async () => {
    await createNewProject('TML ZIP Export Test');

    // Import data first
    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const importResult = await importTmlViaStore(tmluPath);
    expect(importResult.success).toBe(true);

    // Export as TML (ZIP)
    const exportPath = path.join(tempDir, 'exported.tml');
    const exportResult = await exportTmlFile(exportPath);

    expect(exportResult.success).toBe(true);
    expect(exportResult.error).toBeUndefined();

    await waitForUiIdle(500);

    // Verify file exists
    expect(fs.existsSync(exportPath)).toBe(true);

    // Validate ZIP magic bytes (PK\x03\x04)
    const content = fs.readFileSync(exportPath);
    expect(content[0]).toBe(0x50); // P
    expect(content[1]).toBe(0x4b); // K
    expect(content[2]).toBe(0x03);
    expect(content[3]).toBe(0x04);

    // File should be non-trivially sized
    expect(content.length).toBeGreaterThan(100);
  });

  /**
   * Test: should round-trip TMLU (import then export then re-parse)
   *
   * Validates data integrity through export:
   * - Import a TMLU file
   * - Export to a new TMLU file
   * - Re-parse the exported file
   * - Verify sections and shots are preserved
   */
  it('should round-trip TMLU (import then export then re-parse)', async () => {
    await createNewProject('TMLU Round Trip Test');

    // Import original
    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const importResult = await importTmlViaStore(tmluPath);
    expect(importResult.success).toBe(true);

    // Get section count for comparison
    const originalSections = await getProjectSections();
    expect(originalSections.length).toBeGreaterThan(0);

    // Export
    const exportPath = path.join(tempDir, 'roundtrip.tmlu');
    const exportResult = await exportTmlFile(exportPath);
    expect(exportResult.success).toBe(true);

    await waitForUiIdle(500);

    // Re-parse the exported file
    const reparse = await parseTmlFile(exportPath);
    expect(reparse.error).toBeUndefined();
    expect(reparse.tmlFile).toBeDefined();

    const reparsed = reparse.tmlFile as {
      cave_name: string;
      sections: Array<{ name: string; shots: unknown[] }>;
    };

    // Verify sections are preserved
    expect(reparsed.sections.length).toBe(originalSections.length);

    // Verify each section has shots
    for (const section of reparsed.sections) {
      expect(section.shots.length).toBeGreaterThan(0);
    }
  });

  /**
   * Test: should round-trip TML ZIP (import then export then re-parse)
   *
   * Same as TMLU round-trip but through ZIP format:
   * - Import TMLU, export as TML (ZIP), re-parse
   */
  it('should round-trip TML ZIP (import then export then re-parse)', async () => {
    await createNewProject('TML ZIP Round Trip Test');

    // Import
    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const importResult = await importTmlViaStore(tmluPath);
    expect(importResult.success).toBe(true);

    const originalSections = await getProjectSections();

    // Export as ZIP
    const exportPath = path.join(tempDir, 'roundtrip.tml');
    const exportResult = await exportTmlFile(exportPath);
    expect(exportResult.success).toBe(true);

    await waitForUiIdle(500);

    // Re-parse the exported ZIP file
    const reparse = await parseTmlFile(exportPath);
    expect(reparse.error).toBeUndefined();
    expect(reparse.tmlFile).toBeDefined();

    const reparsed = reparse.tmlFile as {
      sections: Array<{ name: string; shots: unknown[] }>;
    };

    expect(reparsed.sections.length).toBe(originalSections.length);
  });

  /**
   * Test: should preserve section names through export
   *
   * Validates that section names survive the import/export cycle:
   * - Import known fixture with named sections
   * - Export and re-parse
   * - Section names match
   */
  it('should preserve section names through export', async () => {
    await createNewProject('Section Names Export Test');

    const tmluPath = path.join(FIXTURES_DIR, 'test_synthetic.tmlu');
    const importResult = await importTmlViaStore(tmluPath);
    expect(importResult.success).toBe(true);

    // Get original section names
    const originalSections = await getProjectSections();
    const originalNames = originalSections.map(s => s.name).sort();

    // Export
    const exportPath = path.join(tempDir, 'names.tmlu');
    const exportResult = await exportTmlFile(exportPath);
    expect(exportResult.success).toBe(true);

    await waitForUiIdle(500);

    // Re-parse and verify names
    const reparse = await parseTmlFile(exportPath);
    expect(reparse.tmlFile).toBeDefined();

    const reparsed = reparse.tmlFile as {
      sections: Array<{ name: string }>;
    };
    const exportedNames = reparsed.sections.map(s => s.name).sort();

    expect(exportedNames).toEqual(originalNames);
  });
});
