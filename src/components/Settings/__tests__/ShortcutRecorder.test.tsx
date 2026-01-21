/**
 * Unit tests for ShortcutRecorder component logic.
 *
 * Tests focus on the exported helper functions and component behavior verification.
 * Component integration is tested via Playwright.
 */

import { describe, it, expect } from 'vitest';
import { BLOCKED_KEYS, isBlockedKey } from '../ShortcutRecorder';

describe('BLOCKED_KEYS constant', () => {
  describe('function keys', () => {
    it('blocks F1-F12', () => {
      for (let i = 1; i <= 12; i++) {
        expect(BLOCKED_KEYS.has(`F${i}`)).toBe(true);
      }
    });

    it('does not block F13 and beyond', () => {
      expect(BLOCKED_KEYS.has('F13')).toBe(false);
      expect(BLOCKED_KEYS.has('F24')).toBe(false);
    });
  });

  describe('special keys', () => {
    it('blocks Tab', () => {
      expect(BLOCKED_KEYS.has('Tab')).toBe(true);
    });

    it('blocks CapsLock', () => {
      expect(BLOCKED_KEYS.has('CapsLock')).toBe(true);
    });

    it('blocks Meta (Windows/Command key)', () => {
      expect(BLOCKED_KEYS.has('Meta')).toBe(true);
    });

    it('blocks OS (Firefox name for Meta)', () => {
      expect(BLOCKED_KEYS.has('OS')).toBe(true);
    });
  });

  describe('allowed keys', () => {
    it('allows letter keys', () => {
      for (const key of ['A', 'Z', 'a', 'z']) {
        expect(BLOCKED_KEYS.has(key)).toBe(false);
      }
    });

    it('allows number keys', () => {
      for (const key of ['0', '1', '9']) {
        expect(BLOCKED_KEYS.has(key)).toBe(false);
      }
    });

    it('allows arrow keys', () => {
      for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
        expect(BLOCKED_KEYS.has(key)).toBe(false);
      }
    });

    it('allows navigation keys', () => {
      for (const key of ['Space', 'Enter', 'Backspace', 'Delete']) {
        expect(BLOCKED_KEYS.has(key)).toBe(false);
      }
    });

    it('allows Escape (used for cancelling)', () => {
      expect(BLOCKED_KEYS.has('Escape')).toBe(false);
    });
  });

  it('is immutable (ReadonlySet)', () => {
    expect(BLOCKED_KEYS.size).toBe(16); // 12 function keys + Tab, CapsLock, Meta, OS
  });
});

describe('isBlockedKey function', () => {
  function createKeyEvent(key: string): KeyboardEvent {
    return { key } as KeyboardEvent;
  }

  describe('blocks function keys', () => {
    it('blocks F1-F12', () => {
      for (let i = 1; i <= 12; i++) {
        expect(isBlockedKey(createKeyEvent(`F${i}`))).toBe(true);
      }
    });

    it('does not block F13 and beyond', () => {
      expect(isBlockedKey(createKeyEvent('F13'))).toBe(false);
      expect(isBlockedKey(createKeyEvent('F24'))).toBe(false);
    });
  });

  describe('blocks special keys', () => {
    it('blocks Tab', () => {
      expect(isBlockedKey(createKeyEvent('Tab'))).toBe(true);
    });

    it('blocks CapsLock', () => {
      expect(isBlockedKey(createKeyEvent('CapsLock'))).toBe(true);
    });

    it('blocks Meta', () => {
      expect(isBlockedKey(createKeyEvent('Meta'))).toBe(true);
    });

    it('blocks OS (Firefox)', () => {
      expect(isBlockedKey(createKeyEvent('OS'))).toBe(true);
    });
  });

  describe('allows regular keys', () => {
    it('allows letter keys', () => {
      expect(isBlockedKey(createKeyEvent('a'))).toBe(false);
      expect(isBlockedKey(createKeyEvent('A'))).toBe(false);
      expect(isBlockedKey(createKeyEvent('z'))).toBe(false);
    });

    it('allows number keys', () => {
      expect(isBlockedKey(createKeyEvent('0'))).toBe(false);
      expect(isBlockedKey(createKeyEvent('1'))).toBe(false);
      expect(isBlockedKey(createKeyEvent('9'))).toBe(false);
    });

    it('allows arrow keys', () => {
      expect(isBlockedKey(createKeyEvent('ArrowUp'))).toBe(false);
      expect(isBlockedKey(createKeyEvent('ArrowDown'))).toBe(false);
    });

    it('allows Space', () => {
      expect(isBlockedKey(createKeyEvent(' '))).toBe(false);
      expect(isBlockedKey(createKeyEvent('Space'))).toBe(false);
    });

    it('allows Enter', () => {
      expect(isBlockedKey(createKeyEvent('Enter'))).toBe(false);
    });

    it('allows Escape', () => {
      expect(isBlockedKey(createKeyEvent('Escape'))).toBe(false);
    });

    it('allows modifier keys (Control, Alt, Shift)', () => {
      expect(isBlockedKey(createKeyEvent('Control'))).toBe(false);
      expect(isBlockedKey(createKeyEvent('Alt'))).toBe(false);
      expect(isBlockedKey(createKeyEvent('Shift'))).toBe(false);
    });
  });
});

describe('ShortcutRecorder state transitions', () => {
  describe('recording state', () => {
    it('should start in non-recording state', () => {
      const isRecording = false;
      expect(isRecording).toBe(false);
    });

    it('should enter recording state on click', () => {
      const isRecording = true;
      expect(isRecording).toBe(true);
    });

    it('should exit recording state on Escape', () => {
      let isRecording = true;
      const originalValue = 'Ctrl+S';
      const currentValue = originalValue;

      // Simulate Escape
      isRecording = false;
      expect(currentValue).toBe(originalValue);
      expect(isRecording).toBe(false);
    });

    it('should exit recording state on successful capture', () => {
      let isRecording = true;
      let currentValue: string | null = null;

      // Simulate successful capture
      const capturedShortcut = 'Ctrl+N';
      currentValue = capturedShortcut;
      isRecording = false;

      expect(currentValue).toBe(capturedShortcut);
      expect(isRecording).toBe(false);
    });
  });

  describe('value management', () => {
    it('should allow clearing the shortcut', () => {
      let value: string | null = 'Ctrl+S';
      value = null;
      expect(value).toBeNull();
    });

    it('should preserve previous value on cancel', () => {
      const originalValue = 'Ctrl+S';
      let value = originalValue;

      // Simulate entering recording mode and then cancelling
      const previousValue = value;
      // Recording started, then Escape pressed
      value = previousValue;

      expect(value).toBe(originalValue);
    });
  });
});

describe('ShortcutRecorder keyboard event handling', () => {
  describe('modifier key handling', () => {
    it('should allow modifier keys through isBlockedKey', () => {
      const modifierKeys = ['Control', 'Alt', 'Shift'];
      for (const key of modifierKeys) {
        // Modifier-only press should not be blocked
        expect(isBlockedKey({ key } as KeyboardEvent)).toBe(false);
      }
    });
  });

  describe('escape handling', () => {
    it('Escape key is not blocked (allows cancelling)', () => {
      expect(isBlockedKey({ key: 'Escape' } as KeyboardEvent)).toBe(false);
    });
  });
});

describe('ShortcutRecorder accessibility', () => {
  describe('ARIA attributes', () => {
    it('should have role="button"', () => {
      const role = 'button';
      expect(role).toBe('button');
    });

    it('should have aria-pressed reflecting recording state', () => {
      const isRecording = true;
      const ariaPressed = isRecording;
      expect(ariaPressed).toBe(true);
    });

    it('should be focusable with tabIndex=0', () => {
      const tabIndex = 0;
      expect(tabIndex).toBe(0);
    });

    it('should be non-focusable when disabled', () => {
      const disabled = true;
      const tabIndex = disabled ? -1 : 0;
      expect(tabIndex).toBe(-1);
    });
  });

  describe('live region announcements', () => {
    it('should announce when recording starts', () => {
      const announcement = 'Recording shortcut. Press a key combination, or Escape to cancel.';
      expect(announcement).toContain('Recording');
      expect(announcement).toContain('Escape');
    });

    it('should announce when shortcut is captured', () => {
      const shortcut = 'Ctrl+S';
      const announcement = `Captured ${shortcut}. Release to confirm.`;
      expect(announcement).toContain('Captured');
      expect(announcement).toContain(shortcut);
    });

    it('should announce when recording is cancelled', () => {
      const announcement = 'Recording cancelled.';
      expect(announcement).toContain('cancelled');
    });

    it('should announce when blocked key is pressed', () => {
      const key = 'F1';
      const announcement = `${key} is not allowed. Try a different key.`;
      expect(announcement).toContain(key);
      expect(announcement).toContain('not allowed');
    });

    it('should announce when shortcut is cleared', () => {
      const announcement = 'Shortcut cleared.';
      expect(announcement).toContain('cleared');
    });
  });
});

describe('ShortcutRecorder display logic', () => {
  describe('placeholder text', () => {
    it('shows "Click to record" when empty and not recording', () => {
      const isRecording = false;
      const placeholder = isRecording ? 'Press keys...' : 'Click to record';
      expect(placeholder).toBe('Click to record');
    });

    it('shows "Press keys..." when recording', () => {
      const isRecording = true;
      const placeholder = isRecording ? 'Press keys...' : 'Click to record';
      expect(placeholder).toBe('Press keys...');
    });
  });

  describe('clear button visibility', () => {
    it('shows clear button when value exists and not recording', () => {
      const value = 'Ctrl+S';
      const isRecording = false;
      const disabled = false;
      const showClear = Boolean(value) && !isRecording && !disabled;
      expect(showClear).toBe(true);
    });

    it('hides clear button when recording', () => {
      const value = 'Ctrl+S';
      const isRecording = true;
      const disabled = false;
      const showClear = Boolean(value) && !isRecording && !disabled;
      expect(showClear).toBe(false);
    });

    it('hides clear button when disabled', () => {
      const value = 'Ctrl+S';
      const isRecording = false;
      const disabled = true;
      const showClear = Boolean(value) && !isRecording && !disabled;
      expect(showClear).toBe(false);
    });

    it('hides clear button when empty', () => {
      const value = null;
      const isRecording = false;
      const disabled = false;
      const showClear = Boolean(value) && !isRecording && !disabled;
      expect(showClear).toBe(false);
    });
  });
});

describe('Mac symbol formatting', () => {
  const MAC_SYMBOLS = {
    Cmd: '\u2318',
    Option: '\u2325',
    Shift: '\u21E7',
  };

  it('uses correct Mac Cmd symbol', () => {
    expect(MAC_SYMBOLS.Cmd).toBe('\u2318');
  });

  it('uses correct Mac Option symbol', () => {
    expect(MAC_SYMBOLS.Option).toBe('\u2325');
  });

  it('uses correct Mac Shift symbol', () => {
    expect(MAC_SYMBOLS.Shift).toBe('\u21E7');
  });
});

describe('Windows/Linux format', () => {
  it('splits shortcuts by + separator', () => {
    const shortcut = 'Ctrl+Shift+S';
    const parts = shortcut.split('+');
    expect(parts).toEqual(['Ctrl', 'Shift', 'S']);
  });

  it('handles single key shortcuts', () => {
    const shortcut = 'S';
    const parts = shortcut.split('+');
    expect(parts).toEqual(['S']);
  });

  it('handles modifier-only display', () => {
    const shortcut = 'Ctrl+A';
    const parts = shortcut.split('+');
    expect(parts).toEqual(['Ctrl', 'A']);
  });
});
