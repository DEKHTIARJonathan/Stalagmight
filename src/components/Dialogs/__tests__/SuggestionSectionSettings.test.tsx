/**
 * #567 item 2: the suggestion phase's section-metadata form starts collapsed
 * behind a disclosure so it stops crowding the connection card + confidence
 * badge above it. `editState` lives in the parent dialog, not in this
 * component, so collapsing it must never lose in-progress edits.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SuggestionSectionSettings } from '../SuggestionSectionSettings';
import type { SectionEditState } from '../../../utils/batchImportHelpers';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));

const editState = (overrides: Partial<SectionEditState> = {}): SectionEditState => ({
  name: 'Section A',
  surveyor: 'Alice',
  date: '2026-01-01',
  color: '#ffffff',
  direction: 'in',
  quality: 1,
  reverse: false,
  shots: [],
  ...overrides,
});

describe('SuggestionSectionSettings', () => {
  it('starts collapsed, hiding the section-name input', () => {
    // Injection: drop `defaultOpen={false}` (or flip it) on the wrapping
    // Panel -> the input renders on first paint and this goes red.
    render(<SuggestionSectionSettings editState={editState()} onMetadataChange={vi.fn()} />);

    expect(screen.queryByTestId('section-name-input')).not.toBeInTheDocument();
  });

  it('expanding the disclosure reveals the form with the current values', () => {
    // Injection: render the form unconditionally regardless of open state,
    // or wire the header click to something other than toggling open -> the
    // header click stops revealing the input and this goes red.
    render(<SuggestionSectionSettings editState={editState({ name: 'Section B' })} onMetadataChange={vi.fn()} />);

    fireEvent.click(screen.getByTestId('wizard-suggestion-section-settings-header'));

    const nameInput = screen.getByTestId('section-name-input') as HTMLInputElement;
    expect(nameInput.value).toBe('Section B');
  });

  it('collapsing again does not wipe values held by the parent', () => {
    // Injection: if the form's state lived inside this component instead of
    // the parent's editState, a collapse->expand cycle without a re-render
    // would still show the same value here (this test can't tell), but if
    // the component threw away the field content it renders on the next
    // expand (e.g. hard-coding a value on remount) this test goes red.
    const onMetadataChange = vi.fn();
    const { rerender } = render(
      <SuggestionSectionSettings editState={editState({ name: 'Section C' })} onMetadataChange={onMetadataChange} />,
    );

    fireEvent.click(screen.getByTestId('wizard-suggestion-section-settings-header'));
    fireEvent.change(screen.getByTestId('section-name-input'), { target: { value: 'Section C edited' } });
    expect(onMetadataChange).toHaveBeenCalledWith('name', 'Section C edited');

    // Simulate the parent committing the edit into editState, then collapse.
    rerender(
      <SuggestionSectionSettings editState={editState({ name: 'Section C edited' })} onMetadataChange={onMetadataChange} />,
    );
    fireEvent.click(screen.getByTestId('wizard-suggestion-section-settings-header'));
    expect(screen.queryByTestId('section-name-input')).not.toBeInTheDocument();

    // Expand again - the parent-held value survived the collapse.
    fireEvent.click(screen.getByTestId('wizard-suggestion-section-settings-header'));
    expect((screen.getByTestId('section-name-input') as HTMLInputElement).value).toBe('Section C edited');
  });
});
