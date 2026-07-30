import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MapTopLeftOverlay } from './MapTopLeftOverlay';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'map.fitToViewTitle': 'Fit to view',
        'map.geometry.adjustedBadge': 'Closure-adjusted · read-only',
        'map.geometry.computing': 'Computing closures…',
        'map.geometry.computingReadOnly': 'Computing Closures - Read Only',
      })[key] ?? key,
  }),
}));

const baseProps = {
  focused: false,
  onFitOrExitFocus: vi.fn(),
  showSpeleoReadOnly: false,
  showClosureReadOnly: false,
  showClosureComputing: false,
};

describe('MapTopLeftOverlay', () => {
  it('replaces the closure read-only label with a unified computing status', () => {
    render(
      <MapTopLeftOverlay
        {...baseProps}
        showClosureReadOnly
        showClosureComputing
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Computing Closures - Read Only');
    expect(screen.getByTestId('geometry-computing-spinner')).toHaveClass('animate-spin');
    expect(screen.queryByText('Closure-adjusted · read-only')).not.toBeInTheDocument();
    // The role must NOT ride on the chip: the chip is mounted by the very state
    // change it would have to announce, which is the unreliable case.
    expect(screen.getByTestId('geometry-readonly-banner')).not.toHaveAttribute('role');
  });

  it('keeps the status region mounted and empty before a solve starts', () => {
    render(<MapTopLeftOverlay {...baseProps} />);

    // An announcement channel that appears together with its text is unreliably
    // announced, so it has to pre-exist the solve - empty, but present.
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('keeps the static read-only badge when no solve is running', () => {
    render(<MapTopLeftOverlay {...baseProps} showClosureReadOnly />);

    expect(screen.getByTestId('geometry-readonly-banner')).toHaveTextContent(
      'Closure-adjusted · read-only'
    );
    expect(screen.queryByTestId('geometry-computing-spinner')).not.toBeInTheDocument();
  });

  it('shows computing progress without read-only wording in Plan and Export modes', () => {
    render(<MapTopLeftOverlay {...baseProps} showClosureComputing />);

    expect(screen.getByTestId('geometry-computing-banner')).toHaveTextContent(
      'Computing closures…'
    );
    expect(screen.getByRole('status')).not.toHaveTextContent('read-only');
    expect(screen.getByTestId('geometry-computing-spinner')).toHaveClass('animate-spin');
  });

  it('shows no closure status when the map is editable and idle', () => {
    render(<MapTopLeftOverlay {...baseProps} />);

    expect(screen.queryByTestId('geometry-readonly-banner')).not.toBeInTheDocument();
    expect(screen.queryByTestId('geometry-computing-banner')).not.toBeInTheDocument();
  });
});
