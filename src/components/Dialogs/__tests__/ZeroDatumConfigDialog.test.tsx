/**
 * The zero-datum GPS anchor survives a shot-table edit (#24).
 *
 * `stationIndex` is one piece of state written by two pickers and read by the
 * backend config builder, and every shot-table edit renumbers the stations
 * underneath it. Whichever end owns the translation, ONE of the two orderings
 * is wrong unless the pick is re-anchored as the edit happens:
 *
 *   - translating at build time (what this dialog used to do, via
 *     `adjustStationForDeletedShots`) is correct for pick-then-delete and wrong
 *     for delete-then-pick, because the dropdown value is already post-edit;
 *   - a bare clamp at build time simply inverts that - correct for
 *     delete-then-pick, wrong for pick-then-delete.
 *
 * So both orderings are tested here, at the dialog level, against the index the
 * backend actually receives. A one-sided fix fails one of them. There is no
 * warning to catch it downstream: `set_zero_datum` only rejects an out-of-range
 * index, so an anchor one shot down the passage imports silently.
 *
 * `.tsx` so vitest runs it under jsdom.
 *
 * The shot table is a virtualized SpreadsheetGrid, and jsdom gives the
 * virtualizer no layout to measure - so without this mock it renders zero rows
 * and every row-level query below fails. Same shim the grid's own component
 * tests use.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: 33 + index * 33,
        size: 33,
      })),
    getTotalSize: () => count * 33,
    scrollToIndex: () => {},
  }),
}));
import { render, screen, fireEvent } from '@testing-library/react';

// Partial mock: `src/i18n/index.ts` (pulled in by the number formatters) needs
// the real `initReactI18next`.
vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (k: string) => k }),
}));

// SectionPreview draws on a MapLibre canvas, which jsdom cannot run. The pick
// it feeds is exercised through the dropdown instead.
vi.mock('maplibre-gl', () => ({ default: {} }));
vi.mock('../SectionPreview', () => ({ default: () => null }));

// The shot table reads validation settings and decimal precision off the store.
vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ project: null, config: null }),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Date picker and colour swatches are irrelevant here and pull in more DOM.
vi.mock('../../common/SectionMetadataForm', () => ({ SectionMetadataForm: () => null }));

import ZeroDatumConfigDialog, { type ZeroDatumConfigResult } from '../ZeroDatumConfigDialog';
import { buildZeroDatumSectionConfig } from '../../../utils/importSectionConfig';
import type {
  DmpFile,
  DmpSection,
  DmpShot,
  ImportPlacement,
  ImportSectionConfig,
} from '../../../types/commands';
import type { DmpSelectionConfig } from '../DmpSelectionDialog';

/** Ten importable shots, so the dialog offers stations 0..10. */
const SHOT_COUNT = 10;
const PICK = 5;

function dmpShot(): DmpShot {
  return {
    shot_type: 'Standard',
    heading_in: 10,
    heading_out: 10,
    length: 5,
    depth_in: 0,
    depth_out: 0,
    pitch_in: 0,
    pitch_out: 0,
    left: 0,
    right: 0,
    up: 0,
    down: 0,
    temperature: 0,
    hour: 0,
    minute: 0,
    second: 0,
    marker_index: 0,
  };
}

function dmpFile(): DmpFile {
  const section: DmpSection = {
    version: 1,
    name: 'Anchor',
    direction: 'in',
    date: '2026-01-01',
    shots: Array.from({ length: SHOT_COUNT }, dmpShot),
    content_hash: 'hash-anchor',
  };
  return { version: 1, sections: [section] } as unknown as DmpFile;
}

const selectionConfig = {
  selectedIndices: new Set([0]),
  defaultSurveyor: 'S',
  defaultDate: '2026-01-01',
} as unknown as DmpSelectionConfig;

const onConfirm = vi.fn<(result: ZeroDatumConfigResult) => void>();

function renderDialog() {
  render(
    <ZeroDatumConfigDialog
      dmpFile={dmpFile()}
      selectionConfig={selectionConfig}
      sectionIndex={0}
      filePath="/tmp/anchor.dmp"
      onCancel={vi.fn()}
      onBack={vi.fn()}
      onConfirm={onConfirm}
    />,
  );
}

/** Open the station dropdown and choose `Station ${index}`. */
function pickStation(index: number) {
  fireEvent.click(screen.getByRole('combobox'));
  fireEvent.click(screen.getByText(`Station ${index}`));
}

function deleteRow(visibleIndex: number) {
  fireEvent.click(screen.getByTestId(`shot-delete-${visibleIndex}`));
}

function insertBeforeRow(visibleIndex: number) {
  // Insert now goes through the grid's own context menu ("above" = before).
  fireEvent.contextMenu(screen.getByTestId(`shot-editor-cell-${visibleIndex}-length`));
  fireEvent.click(screen.getByTestId('shot-editor-context-insert-above'));
}

/** Confirm the dialog and return the config the backend would receive. */
function confirmedConfig(): ImportSectionConfig {
  fireEvent.change(screen.getByTestId('zero-datum-gps-input'), {
    target: { value: '20.2, -87.4' },
  });
  fireEvent.click(screen.getByTestId('zero-datum-config-confirm'));

  expect(onConfirm).toHaveBeenCalledTimes(1);
  return buildZeroDatumSectionConfig(onConfirm.mock.calls[0]![0]);
}

/** The `station_index` the backend would receive. */
function confirmedStationIndex(): number {
  const placement = confirmedConfig().placement;
  expect(placement.type).toBe('zero_datum');
  return (placement as Extract<ImportPlacement, { type: 'zero_datum' }>).station_index;
}

describe('ZeroDatumConfigDialog station pick', () => {
  beforeAll(() => {
    // jsdom does not implement scrollIntoView; the Select calls it on open.
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers one station per surviving shot, plus the far end', () => {
    renderDialog();
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getAllByRole('option')).toHaveLength(SHOT_COUNT + 1);
  });

  it('keeps the pick on its physical station when a leading shot is deleted after it', () => {
    // Pick-then-delete. Station 5 sits 5 shots along; removing the first shot
    // renumbers it to 4. A build-time clamp alone leaves it at 5, anchoring the
    // GPS fix one shot further down the passage than the user chose.
    renderDialog();
    pickStation(PICK);
    deleteRow(0);
    expect(confirmedStationIndex()).toBe(PICK - 1);
  });

  it('sends a pick made AFTER the delete verbatim', () => {
    // Delete-then-pick. The dropdown is rebuilt from the survivors, so Station 5
    // already means station 5 of the 9 shots being sent. Translating again here
    // is what moved the anchor.
    renderDialog();
    deleteRow(0);
    pickStation(PICK);
    expect(confirmedStationIndex()).toBe(PICK);
  });

  it('keeps the pick on its physical station when a shot is inserted before it', () => {
    // The mirror of the delete case: a new leading shot pushes station 5 to 6.
    renderDialog();
    pickStation(PICK);
    insertBeforeRow(0);
    expect(confirmedStationIndex()).toBe(PICK + 1);
  });

  it('leaves the pick alone when the edit lands past it', () => {
    // Station 5 is upstream of row 7, so nothing it addresses is renumbered.
    renderDialog();
    pickStation(PICK);
    deleteRow(7);
    expect(confirmedStationIndex()).toBe(PICK);
  });

  it('keeps a pick at the far end pinned to the far end when a shot is appended', () => {
    renderDialog();
    pickStation(SHOT_COUNT);
    fireEvent.click(screen.getByTestId('add-shot-button'));
    // Appending extends the section; the old last station keeps its number and
    // the new far end is one beyond it.
    expect(confirmedStationIndex()).toBe(SHOT_COUNT);
  });

  it('does not drop a just-committed field edit when the next gesture is a delete', () => {
    // The mutators derive the new shot array and the re-anchored pick from ONE
    // snapshot, so the two can never disagree - but that means they no longer
    // use a functional `setShots`. Pressing a row's delete button blurs whatever
    // input was focused, so a blur-commit lands immediately before the delete;
    // pin that the commit survives it.
    renderDialog();
    // The grid has one editor overlaying the active cell rather than an input
    // per cell: open it on row 2's length, type, and let the blur commit it.
    fireEvent.doubleClick(screen.getByTestId('shot-editor-cell-2-length'));
    const editor = screen.getByTestId('shot-editor-cell-editor');
    fireEvent.change(editor, { target: { value: '42' } });
    fireEvent.blur(editor);
    deleteRow(0);

    const shots = confirmedConfig().shots;
    expect(shots).toHaveLength(SHOT_COUNT - 1);
    expect(shots[1]?.length).toBe(42);
  });

  it('follows the pick down as the section is emptied out from under it', () => {
    renderDialog();
    pickStation(PICK);
    // Delete the five shots the pick sits beyond, one at a time - the visible
    // row 0 is a different physical shot on each pass.
    for (let i = 0; i < PICK; i++) deleteRow(0);
    expect(confirmedStationIndex()).toBe(0);
  });
});
