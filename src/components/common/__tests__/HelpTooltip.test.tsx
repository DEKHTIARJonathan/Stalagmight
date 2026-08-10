/**
 * HelpTooltip keyboard access (#532): the trigger must be reachable by Tab,
 * show its content on focus, hide on blur or Escape, and a click while
 * already hovered must never hide it (the pin/unpin bug from the issue).
 *
 * `.tsx` so vitest runs it under jsdom.
 */
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HelpTooltip } from '../HelpTooltip';

describe('HelpTooltip', () => {
  it('is focusable and exposes button semantics with an aria-label', () => {
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" />);
    const trigger = screen.getByTestId('help-icon');
    expect(trigger).toHaveAttribute('tabIndex', '0');
    expect(trigger).toHaveAttribute('role', 'button');
    expect(trigger).toHaveAttribute('aria-label', 'Zero datum explained');
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

  it('does not hide the tooltip when clicked while already shown from hover', () => {
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />);
    const trigger = screen.getByTestId('help-icon');

    fireEvent.mouseEnter(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();
  });

  it('shows the tooltip on click and keeps it after the pointer leaves (pinned)', () => {
    render(<HelpTooltip text="Zero datum explained" iconTestId="help-icon" tooltipTestId="help-tooltip" />);
    const trigger = screen.getByTestId('help-icon');

    fireEvent.click(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.getByTestId('help-tooltip')).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByTestId('help-tooltip')).not.toBeInTheDocument();
  });
});
