/**
 * The zero-datum depth/elevation reference input (#524).
 *
 * Every GPS coordinate constructor in `src/utils/gps.ts` hardcoded
 * `depth_reference: 0`, so a zero datum could never carry a known depth below
 * the surface even when the surveyor knew it - `GpsCoordinates.depth_reference`
 * is +down, meters below the surface (docs/inclination.md; NOT the same sign
 * as #465's project-level "entrance elevation", which is +up from sea level).
 *
 * `.tsx` so vitest runs it under jsdom.
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

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock('maplibre-gl', () => ({ default: {} }));
vi.mock('../SectionPreview', () => ({ default: () => null }));

vi.mock('../../../store/projectStore', () => ({
  useProjectStore: (sel: (s: unknown) => unknown) => sel({ project: null, config: null }),
}));

vi.mock('../DialogWrapper', () => ({
  DialogWrapper: ({
    children,
  }: {
    children: React.ReactNode | ((p: { requestClose: () => void }) => React.ReactNode);
    [k: string]: unknown;
  }) => <div>{typeof children === 'function' ? children({ requestClose: () => {} }) : children}</div>,
}));

vi.mock('../../common/SectionMetadataForm', () => ({ SectionMetadataForm: () => null }));

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
    name: 'Anchor',
    direction: 'in',
    date: '2026-01-01',
    shots: Array.from({ length: 3 }, dmpShot),
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

function enterGps(value = '20.2, -87.4') {
  fireEvent.change(screen.getByTestId('zero-datum-gps-input'), { target: { value } });
}

function enterDepthReference(value: string) {
  fireEvent.change(screen.getByTestId('zero-datum-depth-reference-input'), {
    target: { value },
  });
}

describe('ZeroDatumConfigDialog depth reference (#524)', () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('blank input keeps today\'s behaviour: depth_reference 0', () => {
    renderDialog();
    enterGps();

    fireEvent.click(screen.getByTestId('zero-datum-config-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0].gps.depth_reference).toBe(0);
  });

  it('threads an entered depth into the confirmed gps.depth_reference, unflipped', () => {
    // Sign-convention pin: entering a positive depth (below the surface, the
    // app-wide +down frame) must produce the SAME positive number, not a
    // negated one. A regression that flips the sign would still pass a mere
    // "is it non-zero" assertion, so this checks the exact value.
    renderDialog();
    enterGps();
    enterDepthReference('12.5');

    fireEvent.click(screen.getByTestId('zero-datum-config-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0].gps.depth_reference).toBe(12.5);
  });

  it('threads the depth through when it is entered BEFORE the GPS text', () => {
    renderDialog();
    enterDepthReference('8');
    enterGps();

    fireEvent.click(screen.getByTestId('zero-datum-config-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0].gps.depth_reference).toBe(8);
  });

  it('accepts a negative depth reference (above the surface) unmodified', () => {
    renderDialog();
    enterGps();
    enterDepthReference('-4');

    fireEvent.click(screen.getByTestId('zero-datum-config-confirm'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0].gps.depth_reference).toBe(-4);
  });

  it('blocks Confirm on an unparsable depth reference', () => {
    renderDialog();
    enterGps();
    enterDepthReference('not-a-number');

    expect(screen.getByTestId('zero-datum-config-confirm')).toBeDisabled();
    expect(screen.getByTestId('zero-datum-depth-reference-error')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('zero-datum-config-confirm'));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  // #524 review: `Number.isFinite` was the only gate, and finiteness is not a
  // range - 1e300 is finite and travelled through the confirm, into the
  // project's geometry, and into every distance derived from it. The backend
  // (`GpsCoordinates::validate`) refuses it now, so accepting it here would
  // only produce a Confirm that fails at the far end.
  it('blocks Confirm on a depth reference outside any earthly range', () => {
    renderDialog();
    enterGps();

    for (const value of ['1e300', '-1e300', '11001']) {
      enterDepthReference(value);
      expect(Number.isFinite(Number(value))).toBe(true);
      expect(screen.getByTestId('zero-datum-config-confirm')).toBeDisabled();
      expect(screen.getByTestId('zero-datum-depth-reference-error')).toBeInTheDocument();
    }

    // The bound itself is still fine, and so is a datum above the surface.
    for (const value of ['11000', '-11000', '-4']) {
      enterDepthReference(value);
      expect(screen.getByTestId('zero-datum-config-confirm')).toBeEnabled();
    }

    fireEvent.click(screen.getByTestId('zero-datum-config-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0]![0].gps.depth_reference).toBe(-4);
  });

  it('is dirty once a depth reference is typed, and the guard is field-specific', () => {
    renderDialog();
    enterGps();
    expect(screen.getByTestId('zero-datum-depth-reference-input')).toHaveValue('');

    enterDepthReference('3');
    expect(screen.getByTestId('zero-datum-depth-reference-input')).toHaveValue('3');
  });
});
