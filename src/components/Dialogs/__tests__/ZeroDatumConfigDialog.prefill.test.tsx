/**
 * #394 F10: stepping BACK out of the import wizard returns to this dialog, and
 * it must come back holding what the user typed.
 *
 * The wizard withdraws the sections it imported on the way back - the forward
 * pass re-imports from scratch, so keeping them would duplicate - which means
 * the anchor really is configured again from here. Without the carry the user
 * would lose the GPS, the name and every metadata field as well, turning
 * "adjust one field and continue" into "start over"; with an empty GPS box the
 * Confirm button is not even enabled.
 *
 * The oracle is deliberately BOTH ends: the values on screen, and the payload a
 * confirm with no further typing produces. On-screen alone would pass on a
 * prefill that never reached the state the payload is built from.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// jsdom gives the shot grid's virtualizer no layout to measure, so without this
// it renders zero rows. Same shim the grid's own component tests use.
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

// SectionPreview draws on a MapLibre canvas, which jsdom cannot run.
vi.mock('maplibre-gl', () => ({ default: {} }));
vi.mock('../SectionPreview', () => ({ default: () => null }));

// The shot table reads validation settings and decimal precision off the store.
vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ project: null, config: null }),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ZeroDatumConfigDialog, { type ZeroDatumConfigResult } from '../ZeroDatumConfigDialog';
import type { DmpFile, DmpSection, DmpShot } from '../../../types/commands';
import type { DmpSelectionConfig } from '../DmpSelectionDialog';

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
    name: 'FileName',
    direction: 'in',
    date: '2026-01-01',
    shots: Array.from({ length: 3 }, dmpShot),
    content_hash: 'hash-anchor',
  };
  return { version: 1, sections: [section] } as unknown as DmpFile;
}

/** Defaults that differ from every carried value below, so a prefill that
 *  silently fell back to them is visible rather than coincidentally equal. */
const selectionConfig = {
  selectedIndices: new Set([0]),
  defaultSurveyor: 'DefaultSurveyor',
  defaultDate: '2026-01-01',
} as unknown as DmpSelectionConfig;

/** What the user entered before they pressed Back. */
const carried = (): ZeroDatumConfigResult => ({
  sectionIndex: 0,
  stationIndex: 0,
  gps: { latitude: 20.25, longitude: -87.5, depth_reference: 0 },
  metadata: {
    name: 'Typed Name',
    surveyor: 'Typed Surveyor',
    date: '2025-12-24',
    color: '#123456',
    direction: 'out',
    quality: 1,
    reverse: true,
  },
  shots: [],
});

const onConfirm = vi.fn<(result: ZeroDatumConfigResult) => void>();

function renderDialog(initialConfig?: ZeroDatumConfigResult) {
  render(
    <ZeroDatumConfigDialog
      dmpFile={dmpFile()}
      selectionConfig={selectionConfig}
      sectionIndex={0}
      filePath="/tmp/anchor.dmp"
      onCancel={vi.fn()}
      onBack={vi.fn()}
      onConfirm={onConfirm}
      initialConfig={initialConfig}
    />,
  );
}

describe('ZeroDatumConfigDialog prefill after Back (#394 F10)', () => {
  beforeAll(() => {
    // jsdom does not implement scrollIntoView; the Select calls it on open.
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Injection: drop the `initialConfig?...` seeds from the `useState` calls and
   * the GPS box is empty, the name reads "FileName" and the surveyor
   * "DefaultSurveyor".
   */
  it('opens holding the GPS, name and surveyor the user entered', () => {
    renderDialog(carried());

    // Decimal degrees, whatever was originally typed: `gps` is the parsed pair
    // and the source text cannot be re-derived from it.
    expect(screen.getByTestId('zero-datum-gps-input')).toHaveValue('20.25, -87.5');
    // Parsed, not merely echoed - so Confirm is live on arrival.
    expect(screen.getByTestId('zero-datum-gps-parsed')).toBeInTheDocument();
    expect(screen.queryByTestId('zero-datum-gps-error')).not.toBeInTheDocument();

    expect(screen.getByTestId('section-name-input')).toHaveValue('Typed Name');
    expect(screen.getByTestId('section-surveyor-input')).toHaveValue('Typed Surveyor');
    expect(screen.getByTestId('section-reverse-checkbox')).toBeChecked();
  });

  /**
   * The prefill has to reach the STATE the payload is built from, not just the
   * inputs' displayed values.
   *
   * Injection: seed only the GPS and this confirms with the file/selection
   * defaults for colour, direction and date.
   */
  it('confirms with the carried values when nothing is retyped', () => {
    renderDialog(carried());

    fireEvent.click(screen.getByTestId('zero-datum-config-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const result = onConfirm.mock.calls[0]![0];
    expect(result.gps).toMatchObject({ latitude: 20.25, longitude: -87.5 });
    expect(result.metadata).toMatchObject({
      name: 'Typed Name',
      surveyor: 'Typed Surveyor',
      date: '2025-12-24',
      color: '#123456',
      direction: 'out',
      reverse: true,
    });
  });

  /**
   * A first visit has no previous answers, so nothing above may leak into it.
   *
   * Injection: seed unconditionally (drop the `initialConfig ?` guards) and this
   * renders the carried values for a dialog that was never confirmed.
   */
  it('falls back to the file and selection defaults on a first visit', () => {
    renderDialog(undefined);

    expect(screen.getByTestId('zero-datum-gps-input')).toHaveValue('');
    expect(screen.getByTestId('section-name-input')).toHaveValue('FileName');
    expect(screen.getByTestId('section-surveyor-input')).toHaveValue('DefaultSurveyor');
    expect(screen.getByTestId('section-reverse-checkbox')).not.toBeChecked();
  });

  /**
   * A field the user CLEARED stays cleared. `??` per field would resurrect the
   * file/selection default underneath an emptied one, which reads to the user as
   * the dialog undoing their deletion.
   *
   * Injection: write `initialConfig?.metadata.surveyor ?? selectionConfig.defaultSurveyor`
   * and the emptied surveyor comes back as "DefaultSurveyor".
   */
  it('keeps a field the user cleared cleared', () => {
    renderDialog({ ...carried(), metadata: { ...carried().metadata, surveyor: null, date: null } });

    expect(screen.getByTestId('section-surveyor-input')).toHaveValue('');
    expect(screen.getByTestId('section-date-input')).toHaveValue('');
  });
});
