import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIN_COL_WIDTH, MAX_COL_WIDTH } from '../../components/common/SpreadsheetGrid/useColumnWidths';
import { PANEL_SIZE_BOUNDS } from '../../components/SingleSystemView/layoutConstants';

/**
 * Cross-language numeric-bounds mirror (issue #357 item 18).
 *
 * Two Rust/TS pairs are mirrored by hand with only a comment holding them
 * together:
 *
 *   - column widths: `MIN_COLUMN_WIDTH`/`MAX_COLUMN_WIDTH` in
 *     src-tauri/src/config/column_widths.rs vs `MIN_COL_WIDTH`/`MAX_COL_WIDTH`
 *     in src/components/common/SpreadsheetGrid/useColumnWidths.ts.
 *   - panel sizes: the three `.clamp(a, b)` calls in
 *     `PanelsConfig::normalize` (src-tauri/src/config/types.rs) vs
 *     `PANEL_SIZE_BOUNDS` in src/components/SingleSystemView/layoutConstants.ts.
 *
 * A one-sided bump gives a SILENT SNAP-BACK: the frontend accepts and saves a
 * value the Rust `normalize()` then clamps back down, and the subsequent
 * `loadConfig()` feeds the clamped value back to the UI with no error
 * anywhere. This test parses the Rust source and compares the numbers
 * against the TS constants (imported normally, not re-parsed) so drift fails
 * loudly here instead of silently in the running app.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../');
const COLUMN_WIDTHS_RS = path.join(REPO_ROOT, 'src-tauri/src/config/column_widths.rs');
const TYPES_RS = path.join(REPO_ROOT, 'src-tauri/src/config/types.rs');

function parseRustConst(source: string, name: string, file: string): number {
  const re = new RegExp(`const ${name}:\\s*u32\\s*=\\s*(\\d+)\\s*;`);
  const match = re.exec(source);
  if (!match) {
    throw new Error(
      `Could not find \`const ${name}: u32 = N;\` in ${file}. ` +
        'If it was renamed, retyped, or reformatted, update this tripwire to match.',
    );
  }
  return Number(match[1]);
}

function parseRustClamp(source: string, field: string, file: string): { min: number; max: number } {
  const re = new RegExp(
    `self\\.${field}\\s*=\\s*self\\.${field}\\.clamp\\((\\d+),\\s*(\\d+)\\)`,
  );
  const match = re.exec(source);
  if (!match) {
    throw new Error(
      `Could not find \`self.${field} = self.${field}.clamp(MIN, MAX)\` in ${file}. ` +
        'If PanelsConfig::normalize was renamed or restructured, update this tripwire to match.',
    );
  }
  return { min: Number(match[1]), max: Number(match[2]) };
}

describe('cross-language numeric bounds mirror (#357 item 18)', () => {
  it('column width bounds agree: MIN/MAX_COLUMN_WIDTH (Rust) vs MIN/MAX_COL_WIDTH (TS)', () => {
    const rustSource = fs.readFileSync(COLUMN_WIDTHS_RS, 'utf8');
    const rustMin = parseRustConst(rustSource, 'MIN_COLUMN_WIDTH', 'column_widths.rs');
    const rustMax = parseRustConst(rustSource, 'MAX_COLUMN_WIDTH', 'column_widths.rs');

    expect(
      rustMin,
      `Column width MIN drift: Rust MIN_COLUMN_WIDTH=${rustMin} but TS MIN_COL_WIDTH=${MIN_COL_WIDTH}. ` +
        'A one-sided bump makes the backend silently clamp a value the frontend just accepted ' +
        '(silent snap-back on the next loadConfig()). Change both together.',
    ).toBe(MIN_COL_WIDTH);
    expect(
      rustMax,
      `Column width MAX drift: Rust MAX_COLUMN_WIDTH=${rustMax} but TS MAX_COL_WIDTH=${MAX_COL_WIDTH}. ` +
        'A one-sided bump makes the backend silently clamp a value the frontend just accepted ' +
        '(silent snap-back on the next loadConfig()). Change both together.',
    ).toBe(MAX_COL_WIDTH);
  });

  it('panel size bounds agree: PanelsConfig::normalize clamps (Rust) vs PANEL_SIZE_BOUNDS (TS)', () => {
    const rustSource = fs.readFileSync(TYPES_RS, 'utf8');
    const rustSections = parseRustClamp(rustSource, 'sections_panel_width', 'types.rs');
    const rustDetail = parseRustClamp(rustSource, 'detail_panel_width', 'types.rs');
    const rustDataTable = parseRustClamp(rustSource, 'data_table_height', 'types.rs');

    expect(
      rustSections,
      `sections_panel_width bounds drift: Rust clamp=${JSON.stringify(rustSections)} but TS ` +
        `PANEL_SIZE_BOUNDS.sections=${JSON.stringify(PANEL_SIZE_BOUNDS.sections)}. Change both together.`,
    ).toEqual(PANEL_SIZE_BOUNDS.sections);
    expect(
      rustDetail,
      `detail_panel_width bounds drift: Rust clamp=${JSON.stringify(rustDetail)} but TS ` +
        `PANEL_SIZE_BOUNDS.detail=${JSON.stringify(PANEL_SIZE_BOUNDS.detail)}. Change both together.`,
    ).toEqual(PANEL_SIZE_BOUNDS.detail);
    expect(
      rustDataTable,
      `data_table_height bounds drift: Rust clamp=${JSON.stringify(rustDataTable)} but TS ` +
        `PANEL_SIZE_BOUNDS['data-table']=${JSON.stringify(PANEL_SIZE_BOUNDS['data-table'])}. Change both together.`,
    ).toEqual(PANEL_SIZE_BOUNDS['data-table']);
  });
});
