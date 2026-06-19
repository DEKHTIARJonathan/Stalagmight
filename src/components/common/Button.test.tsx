/**
 * Render smoke for the component-test tier (issue #107).
 *
 * Proves the jsdom + Testing Library harness end-to-end: a real component
 * mounts to the DOM, jest-dom matchers resolve, and user-event drives a
 * handler. `Button` is deliberately dependency-free (no store / i18n / IPC), so
 * this asserts the *harness*, not app wiring — the bug-prone-wiring regression
 * tests (e.g. wizard onComplete → save) land in a follow-up PR.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Button } from './Button';

describe('Button (component-tier harness smoke)', () => {
  it('renders its children into the DOM', () => {
    render(<Button>Save project</Button>);
    expect(screen.getByRole('button', { name: 'Save project' })).toBeInTheDocument();
  });

  it('fires onClick when activated via user-event', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Import</Button>);

    await userEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does not fire onClick while disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Import
      </Button>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Import' }));

    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
    expect(onClick).not.toHaveBeenCalled();
  });

  it('tags the primary variant with data-primary-action (dialog focus heuristic)', () => {
    render(<Button variant="primary">Confirm</Button>);
    expect(screen.getByRole('button', { name: 'Confirm' })).toHaveAttribute('data-primary-action', '');
  });
});
