/**
 * Component test (#409) - Settings > Shortcuts must not advertise live-looking
 * rows for tools that are not on the toolbar.
 *
 * With `map.controls.show_navigation_tools` off (the default), the Pan and Zoom
 * tools are hidden and their P/Z presses are inert, so the Shortcuts panel shows
 * those two rows DISABLED with a note pointing at the map-controls setting. The
 * rows are deliberately still rendered and still in the conflict registry: the
 * bindings survive untouched, so flipping the setting back on restores working
 * shortcuts with no migration, and nothing else can quietly claim P or Z in the
 * meantime. Both halves of that contract are asserted below.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import '../../../i18n';
import { ShortcutsSettings } from './ShortcutsSettings';
import { defaultConfig } from '../../../types/config';
import type { Config, ShortcutsConfig } from '../../../types/config';

let onChange: ReturnType<typeof vi.fn>;

function renderPanel(
  showNavigationTools: boolean,
  shortcutOverrides: Partial<ShortcutsConfig> = {}
): Config {
  const config: Config = {
    ...defaultConfig,
    map: {
      ...defaultConfig.map,
      controls: { ...defaultConfig.map.controls, show_navigation_tools: showNavigationTools },
    },
    shortcuts: { ...defaultConfig.shortcuts, ...shortcutOverrides },
  };
  render(
    <ShortcutsSettings
      config={config}
      onChange={onChange}
      changedFields={new Set()}
      onValidationError={vi.fn()}
      panelIdBase="settings"
    />
  );
  return config;
}

/** Drive a full record cycle on a recorder: click, press the key, release it. */
function recordKey(testId: string, key: string, modifiers: { ctrlKey?: boolean } = {}): void {
  fireEvent.click(screen.getByTestId(testId));
  fireEvent.keyDown(window, { key, ...modifiers });
  fireEvent.keyUp(window, { key, ...modifiers });
}

beforeEach(() => {
  onChange = vi.fn();
});

describe('ShortcutsSettings navigation rows while the tools are hidden (#409)', () => {
  it('disables the Pan and Zoom rows and explains where to turn the tools on', () => {
    renderPanel(false);

    for (const action of ['pan', 'zoom']) {
      expect(screen.getByTestId(`shortcut-row-${action}`)).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByTestId(`shortcut-primary-${action}`)).toHaveAttribute(
        'aria-disabled',
        'true'
      );
      expect(screen.getByTestId(`shortcut-secondary-${action}`)).toHaveAttribute(
        'aria-disabled',
        'true'
      );
    }

    const note = screen.getByTestId('shortcut-navigation-note-tools');
    expect(note).toHaveTextContent(/Pan and Zoom are hidden from the toolbar/);
    expect(note).toHaveTextContent(/Show navigation tools/);
    // Directly under the last disabled row, not adrift at the foot of the
    // category where it would read as a note about Move Comment.
    expect(note.previousElementSibling).toBe(screen.getByTestId('shortcut-row-zoom'));
    // The rows point at the note, so a screen reader reaching a disabled row is
    // told why it is disabled.
    expect(screen.getByTestId('shortcut-row-pan')).toHaveAttribute(
      'aria-describedby',
      note.getAttribute('id')
    );

    // Rows for tools that are still on the toolbar are untouched.
    const selectRow = screen.getByTestId('shortcut-row-select');
    expect(selectRow).not.toHaveAttribute('aria-disabled');
    expect(screen.getByTestId('shortcut-primary-select')).toHaveAttribute('aria-disabled', 'false');
  });

  it('keeps the rows live and drops the note once navigation tools are on', () => {
    renderPanel(true);

    for (const action of ['pan', 'zoom']) {
      expect(screen.getByTestId(`shortcut-row-${action}`)).not.toHaveAttribute('aria-disabled');
      expect(screen.getByTestId(`shortcut-primary-${action}`)).toHaveAttribute(
        'aria-disabled',
        'false'
      );
    }
    expect(screen.queryByTestId('shortcut-navigation-note-tools')).toBeNull();
  });

  it('rebinding a disabled row is inert: the recorder never starts recording', () => {
    renderPanel(false);

    const recorder = screen.getByTestId('shortcut-primary-pan');
    recordKey('shortcut-primary-pan', 'W');

    expect(recorder).toHaveAttribute('data-recording', 'false');
    expect(onChange).not.toHaveBeenCalled();
    // The binding itself is untouched, so re-enabling the tools needs no migration.
    expect(recorder).toHaveTextContent('P');
  });

  it('rebinding an enabled row still works (the gate is the flag, not the panel)', () => {
    renderPanel(true);

    recordKey('shortcut-primary-pan', 'W');

    expect(onChange).toHaveBeenCalledWith({
      shortcuts: expect.objectContaining({ pan: ['W'] }),
    });
  });

  it('clearing a disabled row is inert: the recorder offers no clear button', () => {
    renderPanel(false);

    expect(screen.queryByTestId('shortcut-primary-pan-clear')).toBeNull();
    // Control: the same bound recorder does offer one once the tools are on.
    expect(screen.getByTestId('shortcut-primary-select-clear')).toBeInTheDocument();
  });

  it('the per-row reset stays inert on a disabled row, even when it is customised', () => {
    renderPanel(false, { pan: ['Ctrl+Alt+P'] });

    const reset = screen.getByTestId('shortcut-reset-pan');
    expect(reset).toBeDisabled();
    expect(reset).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(reset);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('the per-row reset works on the same customised row once the tools are on', () => {
    renderPanel(true, { pan: ['Ctrl+Alt+P'] });

    const reset = screen.getByTestId('shortcut-reset-pan');
    expect(reset).toBeEnabled();

    fireEvent.click(reset);
    expect(onChange).toHaveBeenCalledWith({
      shortcuts: expect.objectContaining({ pan: ['P'] }),
    });
  });

  it('P stays reserved: a third action cannot take it while Pan is disabled', () => {
    renderPanel(false);

    // Measure is a live row - recording P on it must still hit the Pan conflict.
    recordKey('shortcut-primary-measure', 'P');

    const error = screen.getByTestId('shortcut-error');
    expect(error).toHaveTextContent(/already used by/);
    expect(error).toHaveTextContent(/Pan/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Z stays reserved too', () => {
    renderPanel(false);

    recordKey('shortcut-primary-measure', 'Z');

    expect(screen.getByTestId('shortcut-error')).toHaveTextContent(/already used by/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('rejects Ctrl+= : the UI-zoom keys are reserved, not just displayed as such (#319)', () => {
    renderPanel(false);

    recordKey('shortcut-primary-measure', '=', { ctrlKey: true });

    const error = screen.getByTestId('shortcut-error');
    expect(error).toHaveTextContent(/cannot be assigned/);
    expect(error).toHaveTextContent(/Zoom interface in/);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('hides the note when the search filter leaves no navigation row on screen', () => {
    renderPanel(false);

    fireEvent.change(screen.getByTestId('shortcuts-search'), { target: { value: 'merge' } });

    expect(screen.queryByTestId('shortcut-row-pan')).toBeNull();
    expect(screen.queryByTestId('shortcut-navigation-note-tools')).toBeNull();
  });
});
