/**
 * Component test (#161) — Section Adjust dialog accepts negative / partial input.
 *
 * Regression for the controlled-number-input bug: dx/dy were a numeric
 * `value={dx}` coerced with `parseFloat(e.target.value) || 0`, so every
 * intermediate keystroke ('-', '', '.') collapsed to 0 and the controlled
 * re-render wiped it — negatives were impossible and a leading 0 couldn't be
 * cleared. The fix backs the inputs with string state.
 *
 * `userEvent.type` simulates real per-keystroke entry, which is what exercises
 * the bug. (Playwright's `.fill()` sets the value atomically and never hits the
 * buggy intermediate state — which is why the existing e2e `dyInput.fill('-3.2')`
 * passed while the bug was live. So this guard lives at the component tier.)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../utils/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/telemetry')>()),
  trackDialogComplete: vi.fn(),
}));

import SectionAdjustDialog from './SectionAdjustDialog';
import { useProjectStore } from '../../store/projectStore';
import { useUIStore } from '../../store/uiStore';
import type { Project, SectionId } from '../../types/project';
import type { CommandResult } from '../../types/commands';

const SECTION_ID = 1 as SectionId;

let moveSection: ReturnType<typeof vi.fn>;

beforeEach(() => {
  moveSection = vi.fn(async (): Promise<CommandResult> => ({ success: true, error: null }) as CommandResult);
  useProjectStore.setState({
    // The dialog only reads project.sections and section.id/name.
    project: { sections: [{ id: SECTION_ID, name: 'Main Passage' }] } as unknown as Project,
    moveSection,
    getConnectedSectionIds: vi.fn(async (): Promise<number[]> => [SECTION_ID]),
  });
  useUIStore.setState({
    closeDialog: vi.fn(),
    dialogData: { sectionId: SECTION_ID },
  });
});

describe('SectionAdjustDialog negative / partial input (#161)', () => {
  it('accepts a typed negative decimal in dx', async () => {
    render(<SectionAdjustDialog />);
    const dx = await screen.findByTestId('dx-input');

    await userEvent.clear(dx);
    await userEvent.type(dx, '-2.5');

    expect(dx).toHaveValue('-2.5');
  });

  it('can clear the field instead of snapping back to a pinned 0', async () => {
    render(<SectionAdjustDialog />);
    const dy = await screen.findByTestId('dy-input');

    await userEvent.clear(dy);
    expect(dy).toHaveValue(''); // the bug pinned this to '0'

    // and a fresh number has no clinging leading zero
    await userEvent.type(dy, '7');
    expect(dy).toHaveValue('7');
  });
});
