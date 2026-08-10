/**
 * HelpTooltip keyboard access (#532): the trigger must be reachable by Tab,
 * show its content on focus, hide on blur or Escape, and a click while
 * already hovered must never hide it (the pin/unpin bug from the issue).
 *
 * Review round #2 findings folded in: Escape must not bubble into a host
 * dialog's own Escape-to-close handler; a click that both focuses AND pins
 * the trigger must still deterministically unpin on the second click; a
 * pinned tooltip needs an outside-dismiss so it can't get stuck open.
 *
 * `.tsx` so vitest runs it under jsdom.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HelpTooltip } from '../HelpTooltip';
import { DialogWrapper } from '../../Dialogs/DialogWrapper';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('HelpTooltip', () => {
  it('is focusable and exposes button semantics with a short aria-label (not the full tooltip text)', () => {
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" />);
    const trigger = screen.getByTestId('help-icon');
    expect(trigger).toHaveAttribute('tabIndex', '0');
    expect(trigger).toHaveAttribute('role', 'button');
    // Short generic label - aria-describedby carries the actual content, so
    // a screen reader isn't told the same sentence twice.
    expect(trigger).toHaveAttribute('aria-label', 'common.actions.help');
  });

  it('shows the tooltip on focus and wires aria-describedby to it', () => {
    render(
      <HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />
    );
    const trigger = screen.getByTestId('help-icon');

    expect(screen.queryByTestId('help-tooltip')).not.toBeInTheDocument();

    fireEvent.focus(trigger);

    const tooltip = screen.getByTestId('help-tooltip');
    expect(tooltip).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-describedby', tooltip.id);
  });

  it('hides the tooltip on blur', () => {
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />);
    const trigger = screen.getByTestId('help-icon');

    fireEvent.focus(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    fireEvent.blur(trigger);
    expect(screen.queryByTestId('help-tooltip')).not.toBeInTheDocument();
  });

  it('hides the tooltip on Escape while focused', () => {
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />);
    const trigger = screen.getByTestId('help-icon');

    fireEvent.focus(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByTestId('help-tooltip')).not.toBeInTheDocument();
  });

  it('Escape hides the tooltip AND does not close a host DialogWrapper (#532 review round #2)', () => {
    const onClose = vi.fn();
    render(
      <DialogWrapper title="Host" onClose={onClose} data-testid="host-dialog">
        <HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />
      </DialogWrapper>
    );
    const trigger = screen.getByTestId('help-icon');

    fireEvent.focus(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: 'Escape' });

    expect(screen.queryByTestId('help-tooltip')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does not hide the tooltip when clicked while already shown from hover', async () => {
    const user = userEvent.setup();
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />);
    const trigger = screen.getByTestId('help-icon');

    await user.hover(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();
  });

  it('a real click-focus-click sequence deterministically unpins on the second click (#532 review round #2)', async () => {
    // userEvent, not fireEvent: a real click also focuses the element, which
    // is exactly the sequence that left `isFocused` stuck true and the
    // tooltip un-hideable under the naive isHovered||isFocused||isPinned OR.
    const user = userEvent.setup();
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />);
    const trigger = screen.getByTestId('help-icon');

    await user.click(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    await user.click(trigger);
    expect(screen.queryByTestId('help-tooltip')).not.toBeInTheDocument();
  });

  it('a pinned tooltip survives blur, mouseleave, and Tab-away until dismissed', async () => {
    const user = userEvent.setup();
    render(
      <>
        <HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />
        <button type="button">elsewhere</button>
      </>
    );
    const trigger = screen.getByTestId('help-icon');

    await user.click(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    await user.tab();
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();
  });

  it('a pinned tooltip is dismissed by an outside pointerdown', async () => {
    const user = userEvent.setup();
    render(
      <>
        <HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />
        <button type="button" data-testid="elsewhere">elsewhere</button>
      </>
    );
    const trigger = screen.getByTestId('help-icon');

    await user.click(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    await user.click(screen.getByTestId('elsewhere'));
    expect(screen.queryByTestId('help-tooltip')).not.toBeInTheDocument();
  });

  it('a pinned tooltip is dismissed by Escape from anywhere in the document', async () => {
    const user = userEvent.setup();
    render(
      <>
        <HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />
        <button type="button" data-testid="elsewhere">elsewhere</button>
      </>
    );
    const trigger = screen.getByTestId('help-icon');

    await user.click(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    screen.getByTestId('elsewhere').focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('help-tooltip')).not.toBeInTheDocument();
  });

  it('applies a focus-visible ring and pointer cursor (WCAG 2.4.7)', () => {
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" />);
    const trigger = screen.getByTestId('help-icon');
    expect(trigger.className).toContain('focus-visible:ring-1');
    expect(trigger.className).toContain('focus-visible:ring-accent');
    expect(trigger.className).toContain('cursor-pointer');
  });
});
